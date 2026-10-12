// RunClub: Verwaltung der eigenen GitHub-Actions-Runner auf diesem Rechner.
// Läuft im Hauptprozess der App (main.js) oder allein:  node src/backend.js  ->  http://localhost:8770
//
// Linux-Runner: je Repo ein Pool in `runners.json`. Für jeden Job entsteht ein frisches Paar aus
// Runner-Container und eigenem Docker-Daemon; nach dem Job wird es samt Volumes entfernt. Der Docker-Socket
// des Rechners und Windows-Ordner werden nie hineingereicht, die Anmeldung bei GitHub gilt für einen Job.
//
// Was zwischen den Jobs eines Repos bleibt (alles abschaltbar und in der Oberfläche zu leeren):
//   Pakete      Volume, im Runner als NuGet- und npm-Ordner gesetzt. Jobs schreiben hinein.
//   Build-Layer ein Build-Dienst je Repo; einfaches `docker build` nutzt ihn (linux/docker-shim.sh).
//               Jobs schreiben hinein. Wer mit eigenem Builder baut (Veröffentlichen), nutzt ihn nicht.
//   Abbilder    Vorlage für den Docker-Daemon. Dieses Programm merkt sich nach jedem Job nur die Namen der
//               geladenen Abbilder und holt sie selbst von der Registry – kein Job schreibt hinein.
//
// Endet dieses Programm, enden auch die Runner, die es gestartet hat.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createPipelines } = require('./pipeline');
const { createMetrics } = require('./metrics');

const PORT = Number(process.env.RUNCLUB_PORT) || 8770;
const DATA_DIR = process.env.RUNCLUB_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'runners.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'runclub.log');
const IMAGE = 'runclub-runner:latest';
const MARK = 'runclub.runner';
// Was die App um das Backend herum beisteuert: zusätzliche Aufrufe, Angaben für die Oberfläche, das Ende.
const hooks = { actions: {}, status: () => ({}), onExit: () => process.exit(0) };
const HOST = os.hostname();
const TOKEN = crypto.randomBytes(24).toString('hex'); // schützt die ändernden Aufrufe vor fremden Webseiten
const PROCESS_INTERVAL_S = 3;
const GITHUB_INTERVAL_MS = 20000;
const MEASURE_INTERVAL_MS = 2000;
const SAMPLE_EVERY = 3; // jeder dritte Messtakt wird ein Punkt im Verlauf
const SIZES_INTERVAL_MS = 5 * 60000;
const LEARNED_DAYS = 14;
const LEARNED_MAX = 25;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:-]*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastLine = (text) => String(text ?? '').trim().split('\n').pop();

// --- Protokoll ---

const recent = [];
if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1048576) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
function log(text) {
  const line = `${new Date().toLocaleString('de-DE')} ${text}`;
  console.log(line);
  recent.push(line);
  if (recent.length > 60) recent.shift();
  try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* Protokoll ist Beiwerk */ }
}

// --- Einstellungen und Gelerntes ---

function loadConfig() {
  const raw = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  return {
    limits: { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g', ...raw.limits },
    pools: (raw.pools ?? raw.linux ?? []).map((pool) => ({ parallel: 1, cache: true, paused: false, preload: [], ...pool })),
  };
}
const config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
state.learned ??= {};
state.rejected ??= {};
const saveState = () => fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

// --- Hilfen für Prozesse ---

function run(command, args, { input, env, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onLine) { stdout += chunk; return; }
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { onLine(pending.slice(0, end).trim()); pending = pending.slice(end + 1); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

async function gh(args, input) {
  const result = await run('gh', input === undefined ? args : [...args, '--input', '-'], { input });
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || `gh endete mit ${result.code}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const docker = (args, options) => run('docker', args, options);
const dockerList = async (args) => (await docker(args)).stdout.split('\n').map((s) => s.trim()).filter(Boolean);


// --- Linux-Pools ---

const pools = new Map(); // Repo -> { repo, slots, hold, removed, sizes, seeded }
const containerStats = new Map(); // Container-Name -> { cpu (Kerne), memory }
const otherStats = new Map(); // fremde Container in derselben Docker-VM: Name -> { cpu, memory, at }
let dockerCpus = 1;
let dockerMemory = 0;
let linuxReady = false;
let linuxError = null;

const slug = (repo) => repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
const cacheVolume = (repo) => `rc-cache-${slug(repo)}`;
const seedVolume = (repo) => `rc-seed-${slug(repo)}`;
const buildVolume = (repo) => `rc-build-${slug(repo)}`;
const buildService = (repo) => `rc-buildkit-${slug(repo)}`;
const settingsOf = (repo) => config.pools.find((pool) => pool.repo === repo);
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

async function prepareLinux() {
  const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}']);
  if (info.code !== 0) throw new Error('Docker ist nicht erreichbar – läuft Docker Desktop?');
  dockerCpus = Number(info.stdout.trim().split(' ')[0]) || 1;
  dockerMemory = Number(info.stdout.trim().split(' ')[1]) || 0;
  log('Baue das Runner-Abbild (mit dem neuesten Runner von GitHub) …');
  const build = await docker(['build', '--pull', '-q', '-t', IMAGE, path.join(__dirname, '..', 'linux')]);
  if (build.code !== 0) throw new Error(`Das Runner-Abbild ließ sich nicht bauen: ${lastLine(build.stderr)}`);
  await docker(['pull', '-q', 'docker:dind']);
  await docker(['pull', '-q', 'moby/buildkit:latest']);
  await removeLeftovers();
}

// Reste eines früheren Laufs: Paare, ihre Volumes und Netze, bei GitHub angemeldete Runner.
async function removeLeftovers() {
  const containers = await dockerList(['ps', '-aq', '--filter', `label=${MARK}`]);
  if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
  const volumes = await dockerList(['volume', 'ls', '-q', '--filter', `label=${MARK}`]);
  if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
  const networks = await dockerList(['network', 'ls', '-q', '--filter', `label=${MARK}`]);
  for (const network of networks) {
    for (const member of await dockerList(['network', 'inspect', network, '--format', '{{range .Containers}}{{println .Name}}{{end}}'])) await docker(['network', 'disconnect', '-f', network, member]);
    await docker(['network', 'rm', network]);
  }
  for (const pool of config.pools) await removeRegistrations(pool.repo);
}

async function removeRegistrations(repo) {
  try {
    const runners = (await gh(['api', `repos/${repo}/actions/runners?per_page=100`])).runners;
    for (const runner of runners) {
      if (runner.name.startsWith(`${HOST}-linux-`) && !runner.busy) await gh(['api', '-X', 'DELETE', `repos/${repo}/actions/runners/${runner.id}`]);
    }
  } catch (error) { log(`${repo}: Abmelden alter Runner – ${error.message}`); }
}

// Paket-Cache und Build-Dienst eines Repos bereitstellen.
async function prepareCaches(repo) {
  const settings = settingsOf(repo);
  await docker(['rm', '-f', buildService(repo)]);
  if (!settings?.cache) return;
  await docker(['volume', 'create', cacheVolume(repo)]);
  await docker(['run', '--rm', '-v', `${cacheVolume(repo)}:/c`, '--entrypoint', 'sh', 'docker:dind', '-c',
    'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
  await docker(['volume', 'create', buildVolume(repo)]);
  const service = await docker(['run', '-d', '--name', buildService(repo), '--privileged', '--restart', 'no',
    '--cpus', String(config.limits.dockerCpus), '--memory', config.limits.dockerMemory,
    '-v', `${buildVolume(repo)}:/var/lib/buildkit`, 'moby/buildkit:latest', '--addr', 'tcp://0.0.0.0:1234']);
  if (service.code !== 0) log(`${repo}: Build-Dienst startet nicht – ${lastLine(service.stderr)}`);
}

function wantedImages(repo) {
  const fixed = settingsOf(repo)?.preload ?? [];
  const learned = Object.entries(state.learned[repo] ?? {})
    .filter(([, usedAt]) => daysSince(usedAt) <= LEARNED_DAYS)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([image]) => image);
  return [...new Set([...fixed, ...learned])].slice(0, LEARNED_MAX);
}

// Kopieren darf gleichzeitig laufen, auffrischen nur allein.
const seedLocks = new Map();
async function withSeed(repo, exclusive, work) {
  if (!seedLocks.has(repo)) seedLocks.set(repo, { readers: 0, writing: false });
  const lock = seedLocks.get(repo);
  while (lock.writing || (exclusive && lock.readers > 0)) await sleep(500);
  if (exclusive) lock.writing = true; else lock.readers += 1;
  try { return await work(); } finally { if (exclusive) lock.writing = false; else lock.readers -= 1; }
}

function refreshSeed(repo) {
  return withSeed(repo, true, async () => {
    const pool = pools.get(repo);
    const seed = seedVolume(repo);
    const loader = `${seed}-loader`;
    const wanted = wantedImages(repo);
    await docker(['rm', '-f', loader]);
    if (!wanted.length) { await docker(['volume', 'rm', '-f', seed]); if (pool) pool.seeded = new Set(); return; }
    log(`${repo}: frische die Vorlage auf (${wanted.length} Abbilder) …`);
    await docker(['volume', 'create', seed]);
    await docker(['run', '-d', '--name', loader, '--privileged', '-v', `${seed}:/var/lib/docker`, 'docker:dind']);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      ready = (await docker(['exec', loader, 'docker', 'info', '--format', 'ok'])).code === 0;
      if (!ready) await sleep(1000);
    }
    const present = new Set();
    for (const image of wanted) {
      const pull = await docker(['exec', loader, 'docker', 'pull', '-q', image]);
      if (pull.code === 0) { present.add(image); continue; }
      // Was sich nicht laden lässt, hat der Job selbst gebaut oder es ist nicht öffentlich: nicht wieder versuchen.
      log(`${repo}: ${image} kommt nicht in die Vorlage – ${lastLine(pull.stderr)}`);
      (state.rejected[repo] ??= {})[image] = new Date().toISOString();
      delete state.learned[repo]?.[image];
    }
    const existing = await dockerList(['exec', loader, 'docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
    const obsolete = existing.filter((image) => !present.has(image) && IMAGE_NAME.test(image));
    if (obsolete.length) await docker(['exec', loader, 'docker', 'rmi', '-f', ...obsolete]);
    await docker(['exec', loader, 'docker', 'image', 'prune', '-f']);
    await docker(['stop', loader]);
    await docker(['rm', loader]);
    if (pool) pool.seeded = present;
    saveState();
  });
}

// Nach einem Job: die Namen der Abbilder festhalten, die er selbst geladen hat.
const refreshQueued = new Set();
async function learnImages(pool, slot) {
  const listing = await docker(['exec', `${slot.base}-dind`, 'docker', '-H', 'unix:///sock/docker.sock', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  if (listing.code !== 0) return;
  const now = new Date().toISOString();
  const rejected = state.rejected[pool.repo] ?? {};
  let unknown = false;
  for (const image of new Set(listing.stdout.split('\n').map((s) => s.trim()))) {
    if (!IMAGE_NAME.test(image)) continue;
    if (rejected[image] && daysSince(rejected[image]) <= LEARNED_DAYS) continue;
    // Was schon aus der Vorlage kam, kann unbenutzt sein: Sein Datum bleibt, damit es nach einer Frist herausfällt
    // und nur zurückkommt, wenn ein Job es wieder selbst lädt.
    if (slot.copied?.has(image)) continue;
    (state.learned[pool.repo] ??= {})[image] = now;
    if (!pool.seeded.has(image)) unknown = true;
  }
  saveState();
  if (unknown && !refreshQueued.has(pool.repo)) {
    refreshQueued.add(pool.repo);
    refreshSeed(pool.repo).catch((error) => log(`${pool.repo}: Vorlage – ${error.message}`)).finally(() => refreshQueued.delete(pool.repo));
  }
}

// Entfernt ein Paar: Container, Volumes, Netz und – wenn kein Job darauf lief – die Anmeldung bei GitHub.
async function removePair(repo, base, runnerId) {
  await docker(['rm', '-f', '-v', `${base}-runner`, `${base}-dind`, `${base}-seed`]);
  await docker(['network', 'disconnect', '-f', base, buildService(repo)]);
  await docker(['volume', 'rm', '-f', `${base}-work`, `${base}-sock`, `${base}-docker`]);
  await docker(['network', 'rm', base]);
  for (const name of [`${base}-runner`, `${base}-dind`]) containerStats.delete(name);
  if (runnerId) {
    try { await gh(['api', '-X', 'DELETE', `repos/${repo}/actions/runners/${runnerId}`]); } catch { /* schon weg */ }
  }
}

async function teardown(slot) {
  if (!slot.base) return;
  const { base, runnerId, job } = slot;
  await removePair(slot.repo, base, job ? null : runnerId);
  slot.base = null;
  slot.runnerId = null;
}

// Baut ein Paar bis kurz vor die Anmeldung: Netz, Volumes, Kopie der Vorlage, laufender Docker-Daemon.
// Das ist der lange Teil. Er geschieht deshalb im Voraus, als Reserve des Pools
// (`replenish`); der Wechsel zum nächsten Job kostet dann nur noch Anmeldung und Start des Runners.
async function provision(pool, cancelled) {
  const limits = config.limits;
  const id = crypto.randomBytes(3).toString('hex');
  const base = `rc-${slug(pool.repo)}-${id}`;
  const label = ['--label', MARK];
  const pair = { id, base, copied: new Set(), extras: [] };
  const giveUp = async (error) => { await removePair(pool.repo, base, null); if (error) throw error; return null; };

  await docker(['network', 'create', ...label, base]);
  for (const volume of ['work', 'sock', 'docker']) await docker(['volume', 'create', ...label, `${base}-${volume}`]);

  // Kopie der Vorlage in den Speicher des Daemons – in einem eigenen Container, bevor der Daemon startet.
  await withSeed(pool.repo, false, async () => {
    pair.copied = new Set(pool.seeded);
    if (!pair.copied.size || cancelled()) return;
    await docker(['run', '--rm', ...label, '--name', `${base}-seed`, '-v', `${seedVolume(pool.repo)}:/seed:ro`, '-v', `${base}-docker:/var/lib/docker`,
      '--entrypoint', 'sh', 'docker:dind', '-c', 'cp -a /seed/. /var/lib/docker/']);
  });
  if (cancelled()) return giveUp();

  // Der Daemon des Jobs: eigenes Netz, eigener Speicher, erreichbar nur über den geteilten Socket.
  // Der Arbeitsordner liegt in beiden Containern am selben Pfad, damit `docker run -v "$PWD:..."` stimmt.
  const dind = await docker(['run', '-d', ...label, '--name', `${base}-dind`, '--privileged', '--network', base,
    '--cpus', String(limits.dockerCpus), '--memory', limits.dockerMemory,
    '-v', `${base}-work:/home/runner/_work`, '-v', `${base}-sock:/sock`, '-v', `${base}-docker:/var/lib/docker`,
    '--entrypoint', 'sh', 'docker:dind', '-c',
    'chown 1001:1001 /home/runner/_work && exec dockerd-entrypoint.sh dockerd --host=unix:///sock/docker.sock --group=123']);
  if (dind.code !== 0) return giveUp(new Error(`Docker-Daemon startet nicht: ${lastLine(dind.stderr)}`));
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready && !cancelled(); attempt += 1) {
    ready = (await docker(['exec', `${base}-dind`, 'docker', '-H', 'unix:///sock/docker.sock', 'info', '--format', 'ok'])).code === 0;
    if (!ready) await sleep(1000);
  }
  if (cancelled()) return giveUp();
  if (!ready) return giveUp(new Error('Docker-Daemon wurde nicht bereit'));

  if (settingsOf(pool.repo)?.cache) {
    pair.extras.push('-v', `${cacheVolume(pool.repo)}:/opt/rc-cache`, '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm');
    // Der Build-Dienst hängt im Netz des Paars und heißt dort `buildkit`.
    const joined = await docker(['network', 'connect', '--alias', 'buildkit', base, buildService(pool.repo)]);
    if (joined.code === 0) pair.extras.push('-e', 'RC_BUILDER=rc');
  }
  return pair;
}

// Die Reserve eines Pools: fertig vorbereitete Paare ohne Anmeldung. Ein Platz, der frei wird, nimmt eines davon
// und ist nach wenigen Sekunden wieder bereit; die Reserve füllt sich im Hintergrund nach.
const reserveSize = (pool) => settingsOf(pool.repo)?.reserve ?? Math.min(2, settingsOf(pool.repo)?.parallel ?? 0);

function replenish(pool) {
  if (stopping || pool.removed || !linuxReady || poolResting(pool)) return;
  while (pool.reserve.length < reserveSize(pool)) {
    const entry = { cancel: false, ready: false };
    entry.promise = provision(pool, () => entry.cancel || stopping)
      .then((pair) => { entry.ready = Boolean(pair); return pair; })
      .catch((error) => { log(`${pool.repo}: Vorbereitung eines Paars – ${error.message}`); return null; });
    pool.reserve.push(entry);
  }
}

async function discardReserve(pool) {
  const entries = pool.reserve.splice(0);
  for (const entry of entries) entry.cancel = true;
  for (const entry of entries) {
    const pair = await entry.promise;
    if (pair) await removePair(pool.repo, pair.base, null);
  }
}

async function serveOneJob(pool, slot) {
  const limits = config.limits;
  Object.assign(slot, { state: 'startet', job: null, finished: false, error: null, aborted: false, building: true });
  let pair = null;
  try {
    const entry = pool.reserve.shift();
    replenish(pool);
    if (entry) pair = await entry.promise;
    if (!pair) pair = await provision(pool, () => slot.aborted);
  } finally { slot.building = false; }
  if (!pair) return;
  Object.assign(slot, { base: pair.base, name: `${HOST}-linux-${pair.id}`, copied: pair.copied });
  if (slot.aborted) return;

  // Anmeldung für genau einen Job; danach verfällt sie von selbst.
  const jit = await gh(['api', '-X', 'POST', `repos/${pool.repo}/actions/runners/generate-jitconfig`],
    JSON.stringify({ name: slot.name, runner_group_id: 1, labels: ['self-hosted', 'Linux', 'X64'], work_folder: '_work' }));
  slot.runnerId = jit.runner?.id ?? null;
  if (slot.aborted) return;

  // Der Runner teilt das Netz des Daemons: Ports, die ein Job veröffentlicht, liegen für ihn auf localhost.
  const start = 'if [ -n "$RC_BUILDER" ]; then docker buildx create --name "$RC_BUILDER" --driver remote --driver-opt default-load=true tcp://buildkit:1234 >/dev/null 2>&1 || unset RC_BUILDER; fi; exec ./run.sh --jitconfig "$JITCONFIG"';
  const runner = await docker(['run', '--rm', '--label', MARK, '--name', `${pair.base}-runner`, '--network', `container:${pair.base}-dind`,
    '--cpus', String(limits.runnerCpus), '--memory', limits.runnerMemory,
    '-v', `${pair.base}-work:/home/runner/_work`, '-v', `${pair.base}-sock:/sock`, ...pair.extras,
    '-e', 'JITCONFIG', IMAGE, 'bash', '-c', start], {
    env: { JITCONFIG: jit.encoded_jit_config },
    onLine: (line) => {
      const started = line.match(/Running job: (.+)$/);
      const finished = line.match(/Job (.+) completed with result: (\w+)/);
      if (/Listening for Jobs/.test(line) && slot.state === 'startet') slot.state = 'bereit';
      if (started && slot.state !== 'arbeitet') {
        Object.assign(slot, { state: 'arbeitet', job: started[1], jobStartedAt: new Date().toISOString(), meter: metrics.meter() });
        log(`${pool.repo}: Job „${started[1]}“ läuft auf ${slot.name}`);
      }
      if (finished && !slot.finished) {
        if (slot.meter) metrics.recordJob(pool.repo, { job: finished[1], result: finished[2], duration: Math.round((Date.now() - new Date(slot.jobStartedAt)) / 1000), ...slot.meter.finish() });
        slot.meter = null;
        Object.assign(slot, { finished: true, lastResult: `${finished[1]}: ${finished[2]}`, jobs: slot.jobs + 1 });
        log(`${pool.repo}: Job „${finished[1]}“ – ${finished[2]}`);
      }
    },
  });
  if (slot.aborted) return;
  if (!slot.job) throw new Error(`Runner endete ohne Job (${lastLine(runner.stderr) || `Code ${runner.code}`})`);
  await learnImages(pool, slot);
}

const slotWanted = (pool, slot) => !stopping && !pool.removed && !slot.retired;
const poolResting = (pool) => !pool.prepared || pool.hold || settingsOf(pool.repo)?.paused;

async function slotLoop(pool, slot) {
  while (slotWanted(pool, slot)) {
    if (!linuxReady || poolResting(pool)) {
      slot.state = !linuxReady ? 'wartet auf Docker' : settingsOf(pool.repo)?.paused ? 'pausiert' : 'wartet';
      await discardReserve(pool);
      await sleep(1000);
      continue;
    }
    try {
      await serveOneJob(pool, slot);
    } catch (error) {
      if (!slot.aborted) {
        Object.assign(slot, { error: error.message, state: 'gestört' });
        log(`${pool.repo}: ${error.message}`);
        await teardown(slot);
        for (let waited = 0; waited < 60 && slotWanted(pool, slot) && !poolResting(pool); waited += 1) await sleep(1000);
        continue;
      }
    }
    slot.state = 'räumt auf';
    await teardown(slot);
  }
  slot.state = 'aus';
  pool.slots = pool.slots.filter((other) => other !== slot);
}

// Ein Paar ohne Job vorzeitig beenden.
async function abortIdle(slot) {
  if (slot.state === 'arbeitet' || slot.state === 'räumt auf') return;
  slot.aborted = true;
  if (slot.base) await docker(['rm', '-f', `${slot.base}-runner`]);
}

// Die Zahl der Plätze an die Einstellung angleichen.
function reconcile(pool) {
  const wanted = settingsOf(pool.repo)?.parallel ?? 0;
  const active = pool.slots.filter((slot) => !slot.retired);
  for (let index = active.length; index < wanted; index += 1) {
    const slot = { repo: pool.repo, state: 'startet', jobs: 0 };
    pool.slots.push(slot);
    slotLoop(pool, slot);
  }
  for (const slot of active.slice(wanted)) { slot.retired = true; abortIdle(slot); }
}

// Wartet, bis kein Paar des Pools mehr steht: freie Paare und die Reserve werden entfernt, arbeitende laufen zu Ende.
async function quiesce(pool) {
  await Promise.all([discardReserve(pool), ...pool.slots.map((slot) => abortIdle(slot))]);
  while (pool.reserve.length || pool.slots.some((slot) => slot.base || slot.building)) await sleep(500);
}

async function withPoolAtRest(pool, work) {
  while (pool.hold) await sleep(500);
  pool.hold = true;
  try { await quiesce(pool); return await work(); } finally { pool.hold = false; }
}

async function startPool(repo) {
  const pool = { repo, slots: [], reserve: [], hold: false, prepared: false, removed: false, seeded: new Set(), sizes: null };
  pools.set(repo, pool);
  reconcile(pool);
  if (linuxReady) await preparePool(pool);
}

async function preparePool(pool) {
  pool.prepared = false;
  try {
    await prepareCaches(pool.repo);
    await refreshSeed(pool.repo);
  } catch (error) { log(`${pool.repo}: Vorbereitung – ${error.message}`); } finally { pool.prepared = true; }
  measureSizes(pool);
}

async function measureSizes(pool) {
  const existing = new Set(await dockerList(['volume', 'ls', '-q', '--filter', 'name=rc-']));
  const parts = [['packages', cacheVolume(pool.repo)], ['images', seedVolume(pool.repo)], ['build', buildVolume(pool.repo)]].filter(([, volume]) => existing.has(volume));
  const sizes = { packages: 0, images: 0, build: 0 };
  if (parts.length) {
    const mounts = parts.flatMap(([key, volume]) => ['-v', `${volume}:/m/${key}:ro`]);
    const result = await docker(['run', '--rm', ...mounts, '--entrypoint', 'sh', 'docker:dind', '-c', 'du -sm /m/* 2>/dev/null']);
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\d+)\s+\/m\/(\w+)/);
      if (match) sizes[match[2]] = Number(match[1]) * 1048576;
    }
  }
  pool.sizes = sizes;
}

function startStatsFeed() {
  // `docker stats` schreibt fortlaufend; Steuerzeichen für das Neuzeichnen werden entfernt.
  run('docker', ['stats', '--format', '{{json .}}'], {
    onLine: (raw) => {
      const line = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
      if (!line.startsWith('{')) return;
      try {
        const entry = JSON.parse(line);
        const [value, unit] = entry.MemUsage.split('/')[0].trim().match(/^([\d.]+)\s*(\w+)$/).slice(1);
        const factor = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824 }[unit] ?? 1;
        const usage = { cpu: (parseFloat(entry.CPUPerc) || 0) / 100, memory: Number(value) * factor, at: Date.now() };
        if (entry.Name.startsWith('rc-')) containerStats.set(entry.Name, usage); else otherStats.set(entry.Name, usage);
      } catch { /* Kopfzeile oder unvollständige Zeile */ }
    },
  }).then(() => { containerStats.clear(); otherStats.clear(); if (!stopping) setTimeout(startStatsFeed, 5000); });
}

// Docker kann später starten als dieses Programm, oder zwischendurch neu starten.
async function linuxLoop() {
  while (!stopping) {
    if (!linuxReady) {
      try {
        await prepareLinux();
        for (const pool of pools.values()) pool.prepared = false;
        linuxReady = true;
        linuxError = null;
        startStatsFeed();
        for (const pool of pools.values()) await preparePool(pool);
      } catch (error) {
        if (linuxError !== error.message) log(error.message);
        linuxError = error.message;
      }
    } else if ((await docker(['info', '--format', 'ok'])).code !== 0) {
      linuxReady = false;
      log('Docker antwortet nicht mehr – die Linux-Runner warten.');
    }
    await sleep(linuxReady ? 30000 : 15000);
  }
}

// --- GitHub: Runner, laufende und wartende Jobs, letzte Läufe ---

const github = new Map(); // Repo -> { runners, jobs, runs, error }
const pipelines = createPipelines({ gh, dataDir: DATA_DIR });

// --- Messung: Rechner, Docker-VM und der Verbrauch je Job ---

const metrics = createMetrics({ dataDir: DATA_DIR });
const usage = { hostCpu: 0, vmCpu: 0, vmMemory: 0, otherCpu: 0, otherMemory: 0 }; // CPU in Kernen
let hostTicks = null;
let measureRound = 0;

function measure() {
  // Windows: Anteil der Zeit, in der die Kerne nicht im Leerlauf waren.
  const ticks = os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle }), { idle: 0, total: 0 });
  if (hostTicks && ticks.total > hostTicks.total) usage.hostCpu = (1 - (ticks.idle - hostTicks.idle) / (ticks.total - hostTicks.total)) * os.cpus().length;
  hostTicks = ticks;

  // Docker-VM: die eigenen Container und, was sonst darin läuft. Ein beendeter Container meldet sich nicht ab.
  const now = Date.now();
  for (const stats of [containerStats, otherStats]) {
    for (const [name, entry] of stats) if (now - entry.at > 15000) stats.delete(name);
  }
  const sum = (entries, field) => [...entries].reduce((total, entry) => total + entry[field], 0);
  Object.assign(usage, { vmCpu: sum(containerStats.values(), 'cpu'), vmMemory: sum(containerStats.values(), 'memory'), otherCpu: sum(otherStats.values(), 'cpu'), otherMemory: sum(otherStats.values(), 'memory') });

  for (const pool of pools.values()) {
    for (const slot of pool.slots) if (slot.meter && slot.base) slot.meter.add(containerStats.get(`${slot.base}-runner`), containerStats.get(`${slot.base}-dind`));
  }
  measureRound += 1;
  if (measureRound % SAMPLE_EVERY === 0) {
    metrics.sample({ hostCpu: usage.hostCpu, hostMemory: os.totalmem() - os.freemem(), vmCpu: usage.vmCpu + usage.otherCpu, vmMemory: usage.vmMemory + usage.otherMemory });
  }
}
let githubBusy = false;

async function refreshGitHub() {
  if (githubBusy) return;
  githubBusy = true;
  try {
    const repos = config.pools.map((pool) => pool.repo);
    for (const repo of repos) {
      try {
        const runners = (await gh(['api', `repos/${repo}/actions/runners?per_page=100`])).runners;
        const runs = (await gh(['api', `repos/${repo}/actions/runs?per_page=20`])).workflow_runs;
        const jobs = (await pipelines.refresh(repo, runs)).flatMap((pipeline) => pipeline.jobs
          .filter((job) => job.status !== 'completed' && job.status !== 'pending')
          .map((job) => ({ workflow: pipeline.workflow, job: job.name, branch: pipeline.branch, status: job.status, runner: job.runner, startedAt: job.startedAt, url: job.url, estimate: job.estimate, step: job.step })));
        github.set(repo, {
          runners, jobs, error: null,
          runs: runs.slice(0, 20).map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at ?? r.created_at, url: r.html_url, title: r.display_title })),
        });
      } catch (error) {
        github.set(repo, { ...(github.get(repo) ?? { runners: [], jobs: [], runs: [] }), error: error.message });
      }
    }
  } finally { githubBusy = false; }
}

// Repos, für die sich Runner anmelden lassen (Verwaltungsrecht), die zuletzt bewegten zuerst.
let repoList = { at: 0, repos: [] };
async function listRepos() {
  if (Date.now() - repoList.at > 5 * 60000) {
    const repos = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await gh(['api', `user/repos?per_page=100&page=${page}&sort=pushed`]);
      repos.push(...batch.filter((r) => r.permissions?.admin && !r.archived).map((r) => ({ repo: r.full_name, private: r.private, pushedAt: r.pushed_at })));
      if (batch.length < 100) break;
    }
    repoList = { at: Date.now(), repos };
  }
  return repoList.repos.map((r) => ({ ...r, pool: Boolean(settingsOf(r.repo)) }));
}

// --- Was die Oberfläche sieht ---

function status() {
  const waitingOf = (repo) => (github.get(repo)?.jobs ?? []).filter((j) => j.status === 'queued').length;
  const repos = new Map();
  const repoEntry = (repo) => {
    if (!repos.has(repo)) repos.set(repo, { repo, waiting: waitingOf(repo), error: github.get(repo)?.error ?? null, runs: github.get(repo)?.runs ?? [], pool: null, runners: [] });
    return repos.get(repo);
  };

  for (const settings of config.pools) {
    const pool = pools.get(settings.repo);
    const entry = repoEntry(settings.repo);
    entry.pipelines = pipelines.view(settings.repo, settings.paused ? 0 : settings.parallel);
    entry.lastRun = pipelines.lastOf(settings.repo);
    entry.usage = { jobs: metrics.jobsView(settings.repo), wait: pipelines.waitOf(settings.repo) };
    const service = containerStats.get(buildService(settings.repo));
    entry.pool = {
      parallel: settings.parallel, paused: settings.paused, cache: settings.cache, busy: Boolean(pool?.hold),
      reserve: (pool?.reserve ?? []).filter((entry) => entry.ready).length, reserveWanted: pool ? reserveSize(pool) : 0,
      sizes: pool?.sizes ?? null,
      images: [...(pool?.seeded ?? [])].sort(),
      preload: settings.preload,
      buildService: service ? { cpu: service.cpu, memory: service.memory } : null,
    };
    (pool?.slots ?? []).forEach((slot, index) => {
      const parts = slot.base ? [`${slot.base}-runner`, `${slot.base}-dind`].map((name) => containerStats.get(name)).filter(Boolean) : [];
      const remote = github.get(settings.repo) ?? { jobs: [] };
      const job = slot.state === 'arbeitet'
        ? (remote.jobs.find((j) => j.runner === slot.name) ?? { workflow: '', job: slot.job, branch: '', startedAt: slot.jobStartedAt, url: `https://github.com/${settings.repo}/actions` })
        : null;
      entry.runners.push({
        kind: 'Linux', name: slot.base ? slot.name : `Platz ${index + 1}`, state: slot.retired && slot.state !== 'aus' ? `${slot.state}, läuft aus` : slot.state, job,
        cpu: parts.reduce((sum, p) => sum + p.cpu, 0) / dockerCpus * 100, cores: parts.reduce((sum, p) => sum + p.cpu, 0), memory: parts.reduce((sum, p) => sum + p.memory, 0), cpuBase: `${dockerCpus} Kerne der Docker-VM`,
        note: [`Platz ${index + 1}`, `${slot.jobs} Job${slot.jobs === 1 ? '' : 's'} seit dem Start`, slot.lastResult && `zuletzt ${slot.lastResult}`, slot.error && `Fehler: ${slot.error}`].filter(Boolean).join(' · '),
      });
    });
  }

  return {
    at: new Date().toISOString(),
    machine: {
      cores: os.cpus().length, memoryTotal: os.totalmem(), memoryFree: os.freemem(), dockerCpus, dockerMemory, docker: linuxReady ? 'bereit' : (linuxError ?? 'startet'),
      usage, limits: config.limits, series: metrics.series(),
    },
    repos: [...repos.values()],
    log: recent.slice(-25),
    ui: fs.statSync(path.join(__dirname, 'ui.html')).mtimeMs, // die Seite lädt sich neu, wenn sich ihre Datei ändert
    ...hooks.status(),
  };
}

// --- Was die Oberfläche auslösen kann ---

const actions = {
  async 'pool/add'({ repo, parallel }) {
    if (!REPO_NAME.test(String(repo))) throw new Error('Das Repo wird als besitzer/name angegeben.');
    if (settingsOf(repo)) throw new Error('Für dieses Repo gibt es schon einen Pool.');
    const info = await gh(['api', `repos/${repo}`]);
    if (!info.permissions?.admin) throw new Error('Für dieses Repo fehlen dir die Verwaltungsrechte; ohne sie lässt sich kein Runner anmelden.');
    config.pools.push({ repo: info.full_name, parallel: Math.min(4, Math.max(1, Number(parallel) || 1)), cache: true, paused: false, preload: [] });
    saveConfig();
    log(`${info.full_name}: Pool angelegt`);
    startPool(info.full_name);
    refreshGitHub();
  },
  async 'pool/set'({ repo, parallel, paused, cache }) {
    const settings = settingsOf(repo);
    const pool = pools.get(repo);
    if (!settings || !pool) throw new Error('Diesen Pool gibt es nicht.');
    if (parallel !== undefined) settings.parallel = Math.min(4, Math.max(1, Number(parallel) || 1));
    if (paused !== undefined) settings.paused = Boolean(paused);
    saveConfig();
    if (settings.paused) { pool.slots.forEach((slot) => abortIdle(slot)); discardReserve(pool); }
    reconcile(pool);
    if (cache !== undefined && Boolean(cache) !== settings.cache) {
      settings.cache = Boolean(cache);
      saveConfig();
      withPoolAtRest(pool, () => prepareCaches(repo)).catch((error) => log(`${repo}: ${error.message}`));
    }
    log(`${repo}: ${settings.parallel} Platz/Plätze, ${settings.paused ? 'pausiert' : 'aktiv'}, Cache ${settings.cache ? 'an' : 'aus'}`);
  },
  async 'pool/remove'({ repo }) {
    const pool = pools.get(repo);
    if (!settingsOf(repo) || !pool) throw new Error('Diesen Pool gibt es nicht.');
    config.pools = config.pools.filter((settings) => settings.repo !== repo);
    saveConfig();
    pool.removed = true;
    log(`${repo}: Pool wird entfernt`);
    (async () => {
      await quiesce(pool);
      await docker(['rm', '-f', buildService(repo)]);
      await docker(['volume', 'rm', '-f', cacheVolume(repo), seedVolume(repo), buildVolume(repo)]);
      await removeRegistrations(repo);
      delete state.learned[repo];
      delete state.rejected[repo];
      saveState();
      metrics.forget(repo);
      pools.delete(repo);
      log(`${repo}: Pool und seine Caches sind entfernt`);
    })().catch((error) => log(`${repo}: ${error.message}`));
  },
  // Leert, was zwischen den Jobs bleibt. Freie Paare werden dafür beendet, arbeitende laufen erst zu Ende.
  async 'pool/clear'({ repo, what }) {
    const pool = pools.get(repo);
    if (!settingsOf(repo) || !pool) throw new Error('Diesen Pool gibt es nicht.');
    if (!['packages', 'build', 'images', 'all'].includes(what)) throw new Error('Unbekannter Cache.');
    const all = what === 'all';
    log(`${repo}: leere ${{ packages: 'den Paket-Cache', build: 'die Build-Layer', images: 'die gelernten Abbilder', all: 'alle Caches' }[what]} …`);
    withPoolAtRest(pool, async () => {
      if (all || what === 'packages') await docker(['volume', 'rm', '-f', cacheVolume(repo)]);
      if (all || what === 'build') { await docker(['rm', '-f', buildService(repo)]); await docker(['volume', 'rm', '-f', buildVolume(repo)]); }
      if (all || what === 'images') {
        delete state.learned[repo];
        delete state.rejected[repo];
        saveState();
        await docker(['volume', 'rm', '-f', seedVolume(repo)]);
      }
      await prepareCaches(repo);
      await refreshSeed(repo);
      await measureSizes(pool);
      log(`${repo}: geleert; der nächste Lauf füllt wieder auf`);
    }).catch((error) => log(`${repo}: ${error.message}`));
  },
  async 'slot/restart'({ repo, index }) {
    const slot = pools.get(repo)?.slots[Number(index)];
    if (!slot) throw new Error('Diesen Platz gibt es nicht.');
    if (slot.state === 'arbeitet') throw new Error('Auf diesem Platz läuft ein Job; er wird nach dem Job ohnehin neu aufgebaut.');
    await abortIdle(slot);
  },
  async 'run/rerun'({ repo, id, failedOnly }) {
    if (!github.has(repo) || !/^\d+$/.test(String(id))) throw new Error('Diesen Lauf gibt es nicht.');
    await gh(['api', '-X', 'POST', `repos/${repo}/actions/runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`]);
    log(`${repo}: Lauf ${id} erneut angestoßen`);
    setTimeout(refreshGitHub, 3000);
  },
  async shutdown() { setTimeout(shutdown, 100); },
};

// --- Start und Ende ---

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('Beende die Runner …');
  metrics.save();
  await Promise.all([...pools.values()].flatMap((pool) => pool.slots.map((slot) => { slot.aborted = true; return teardown(slot); })));
  for (const settings of config.pools) await docker(['rm', '-f', buildService(settings.repo)]);
  await removeLeftovers();
  log('Beendet.');
  hooks.onExit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);

const PAGE = () => fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8').replace('__TOKEN__', TOKEN);

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 10000) reject(new Error('zu groß')); });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('kein JSON')); } });
  });
}

http.createServer(async (request, response) => {
  const json = (code, data) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
  // Nur der eigene Rechner unter seinem eigenen Namen: hält umgeleitete Namen fremder Seiten draußen.
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(request.headers.host ?? '')) return json(403, { error: 'falscher Host' });
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return response.end(PAGE());
  }
  if (request.method === 'GET' && request.url === '/api/ping') return json(200, { ok: true });
  if (request.method === 'GET' && request.url === '/api/status') return json(200, status());
  if (request.method === 'GET' && request.url === '/api/metrics/day') return json(200, metrics.minutes());
  const font = request.method === 'GET' && request.url.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
  if (font && fs.existsSync(path.join(__dirname, 'fonts', font[1]))) {
    response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' });
    return response.end(fs.readFileSync(path.join(__dirname, 'fonts', font[1])));
  }
  if (request.method === 'GET' && request.url === '/api/repos') {
    try { return json(200, await listRepos()); } catch (error) { return json(502, { error: error.message }); }
  }
  if (request.method === 'POST' && request.url.startsWith('/api/')) {
    const name = request.url.slice(5);
    const action = Object.hasOwn(actions, name) ? actions[name] : Object.hasOwn(hooks.actions, name) ? hooks.actions[name] : null;
    if (!action) return json(404, { error: 'unbekannt' });
    if (request.headers['x-rc-token'] !== TOKEN) return json(403, { error: 'Die Seite ist veraltet – bitte neu laden.' });
    try { await action(await readBody(request)); return json(200, { ok: true }); } catch (error) { return json(400, { error: error.message }); }
  }
  return json(404, { error: 'unbekannt' });
}).listen(PORT, '127.0.0.1', () => log(`Runner-Anzeige: http://localhost:${PORT}`));

refreshGitHub();
setInterval(refreshGitHub, GITHUB_INTERVAL_MS);
setInterval(measure, MEASURE_INTERVAL_MS);
setInterval(() => { if (linuxReady) for (const pool of pools.values()) if (!pool.hold) measureSizes(pool); }, SIZES_INTERVAL_MS);

for (const settings of config.pools) startPool(settings.repo);
linuxLoop();

module.exports = { PORT, DATA_DIR, hooks, status, shutdown, log };
