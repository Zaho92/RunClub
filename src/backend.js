// RunClub: Verwaltung der eigenen GitHub-Actions-Runner auf diesem Rechner.
// Läuft im Hauptprozess der App (main.js) oder allein:  node src/backend.js  ->  http://localhost:8770
//
// Linux-Runner: je Repo ein Pool in `runners.json`. Für jeden Job entsteht ein frisches Paar aus
// Runner-Container und eigenem Docker-Daemon; nach dem Job wird es samt Volumes entfernt. Der Docker-Socket
// des Rechners und Windows-Ordner werden nie hineingereicht, die Anmeldung bei GitHub gilt für einen Job.
//
// Das trennt Jobs voneinander, ist aber keine Sicherheitsgrenze: Der Docker-Daemon eines Jobs läuft privilegiert,
// und wer in einem Job Code ausführt, kann daraus in die Docker-VM ausbrechen. Auf diesen Runnern darf deshalb nur
// Code laufen, dem der Nutzer vertraut – Pools für öffentliche Repos werden nicht angelegt.
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
const { run } = require('./run');
const { createAccess, pageHeaders, newNonce } = require('./access');
const { orphaned } = require('./pairs');
const { readJson, writeJson } = require('./store');
const { permanentPullError, pruneOlder, slug, sameRepo, clashes } = require('./images');
const limitRules = require('./limits');
const { createPipelines } = require('./pipeline');
const { createMetrics } = require('./metrics');
const { createRouting, VARIABLE } = require('./routing');

const PORT = Number(process.env.RUNCLUB_PORT) || 8770;
const DATA_DIR = process.env.RUNCLUB_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'runners.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'runclub.log');
const IMAGE = 'runclub-runner:latest';
// Kennzeichen der eigenen Container, Volumes und Netze. Es trägt den Datenordner in sich, damit eine zweite
// Instanz (zum Ausprobieren, mit eigenem Datenordner) beim Aufräumen nicht die Paare der ersten entfernt.
const MARK = `runclub.runner=${crypto.createHash('sha256').update(path.resolve(DATA_DIR).toLowerCase()).digest('hex').slice(0, 10)}`;
// Was die App um das Backend herum beisteuert: zusätzliche Aufrufe, Angaben für die Oberfläche, das Ende.
const hooks = { actions: {}, status: () => ({}), onExit: () => process.exit(0) };
const HOST = os.hostname();
const TOKEN = crypto.randomBytes(24).toString('hex'); // schützt die ändernden Aufrufe vor fremden Webseiten
const access = createAccess({ port: PORT }); // schützt Seite und Daten vor allem, was nicht das eigene Fenster ist
const KEY_FILE = path.join(DATA_DIR, 'access.key');
const PROCESS_INTERVAL_S = 3;
const GITHUB_INTERVAL_MS = 20000;
const GITHUB_ACTIVE_INTERVAL_MS = 8000; // Repos, in denen gerade ein Job läuft
const MEASURE_INTERVAL_MS = 2000;
const SAMPLE_EVERY = 3; // jeder dritte Messtakt wird ein Punkt im Verlauf
const SIZES_INTERVAL_MS = 5 * 60000;
const LEARNED_DAYS = 14;
const LEARNED_MAX = 25;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const GH_TIMEOUT = MINUTE;
const DOCKER_TIMEOUT = 5 * MINUTE; // gewöhnliche Aufrufe; was länger dauern darf, nennt seine Grenze selbst
const DOCKER_LONG = 30 * MINUTE; // Abbilder bauen, laden, kopieren
const DOCKER_MISSES = 3; // so oft hintereinander muss Docker schweigen, bevor es als weg gilt
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:-]*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastLine = (text) => String(text ?? '').trim().split('\n').map((line) => line.trim()).filter((line) => line && !/^Run '.*--help' for more information/.test(line)).pop() ?? '';

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

function loadJson(file) {
  const { data, broken } = readJson(file, {});
  if (broken) log(`${path.basename(file)} ließ sich nicht lesen und wird neu angelegt. Die alte Datei liegt unter ${broken}.`);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function loadConfig() {
  const raw = loadJson(CONFIG_FILE);
  return {
    limits: { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g', ...raw.limits },
    pools: (raw.pools ?? raw.linux ?? []).map((pool) => ({ parallel: 1, cache: true, paused: false, preload: [], ...pool })),
  };
}
const config = loadConfig();
const saveConfig = () => writeJson(CONFIG_FILE, config);

const state = loadJson(STATE_FILE);
state.learned ??= {};
state.rejected ??= {};
const saveState = () => writeJson(STATE_FILE, state);

// --- Hilfen für Prozesse ---

async function gh(args, input) {
  const result = await run('gh', input === undefined ? args : [...args, '--input', '-'], { input, timeout: GH_TIMEOUT });
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || `gh endete mit ${result.code}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const docker = (args, options) => run('docker', args, { timeout: DOCKER_TIMEOUT, ...options });
const dockerList = async (args) => (await docker(args)).stdout.split('\n').map((s) => s.trim()).filter(Boolean);


// --- Linux-Pools ---

const pools = new Map(); // Repo -> { repo, slots, hold, removed, sizes, seeded }
const containerStats = new Map(); // Container-Name -> { cpu (Kerne), memory }
const otherStats = new Map(); // fremde Container in derselben Docker-VM: Name -> { cpu, memory, at }
let dockerCpus = 1;
let dockerMemory = 0;
let linuxReady = false;
let linuxError = null;
let leftoversRemoved = false;

// Caches, Vorlage und Build-Dienst heißen nach dem Repo. Eine zweite Instanz (anderer Port, eigener Datenordner)
// hängt ihr Kennzeichen an, damit sie der ersten nichts wegnimmt, wenn beide ein Repo gleichen Namens bedienen.
const INSTANCE = PORT === 8770 ? '' : `-${MARK.split('=')[1]}`;
const cacheVolume = (repo) => `rc-cache-${slug(repo)}${INSTANCE}`;
const seedVolume = (repo) => `rc-seed-${slug(repo)}${INSTANCE}`;
const buildVolume = (repo) => `rc-build-${slug(repo)}${INSTANCE}`;
const buildService = (repo) => `rc-buildkit-${slug(repo)}${INSTANCE}`;
const buildNetwork = (repo) => `rc-buildnet-${slug(repo)}${INSTANCE}`;
const settingsOf = (repo) => config.pools.find((pool) => pool.repo === repo);
const limitsOf = (repo) => limitRules.effective(config.limits, settingsOf(repo)?.limits); // eigene Limits des Projekts oder die für alle
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

async function prepareLinux() {
  const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeout: 20 * SECOND });
  if (info.code !== 0) throw new Error('Docker ist nicht erreichbar – läuft Docker Desktop?');
  dockerCpus = Number(info.stdout.trim().split(' ')[0]) || 1;
  dockerMemory = Number(info.stdout.trim().split(' ')[1]) || 0;
  log('Baue das Runner-Abbild (mit dem neuesten Runner von GitHub) …');
  const build = await docker(['build', '--pull', '-q', '-t', IMAGE, path.join(__dirname, '..', 'linux')], { timeout: DOCKER_LONG });
  if (build.code !== 0) throw new Error(`Das Runner-Abbild ließ sich nicht bauen: ${lastLine(build.stderr)}`);
  await docker(['pull', '-q', 'docker:dind'], { timeout: DOCKER_LONG });
  await docker(['pull', '-q', 'moby/buildkit:latest'], { timeout: DOCKER_LONG });
  // Reste gibt es nur vom vorigen Programmlauf. Meldet sich Docker später zurück, räumen die Plätze ihre Paare
  // selbst ab; alles Gekennzeichnete zu entfernen, träfe dann auch Paare, auf denen gerade ein Job läuft.
  if (!leftoversRemoved) { await removeLeftovers(); leftoversRemoved = true; } else await removeOrphans();
}

// Nach einer Unterbrechung von Docker: War Docker beim Abräumen eines Paars nicht erreichbar, sind dessen Container,
// Volumes und Netz liegen geblieben. Entfernt wird nur, was zu keinem stehenden Paar mehr gehört.
const livePairs = new Map(); // Name des Paars -> Repo, vom Beginn des Aufbaus bis zum Abräumen
async function removeOrphans() {
  const live = new Set(livePairs.keys());
  const containers = orphaned(await dockerList(['ps', '-a', '--filter', `label=${MARK}`, '--format', '{{.Names}}']), live);
  if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
  const volumes = orphaned(await dockerList(['volume', 'ls', '-q', '--filter', `label=${MARK}`]), live);
  if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
  for (const network of orphaned(await dockerList(['network', 'ls', '--filter', `label=${MARK}`, '--format', '{{.Name}}']), live)) {
    for (const member of await dockerList(['network', 'inspect', network, '--format', '{{range .Containers}}{{println .Name}}{{end}}'])) await docker(['network', 'disconnect', '-f', network, member]);
    await docker(['network', 'rm', network]);
  }
  if (containers.length || volumes.length) log(`Reste nach der Unterbrechung entfernt: ${containers.length} Container, ${volumes.length} Volumes`);
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

// Der Build-Dienst trägt die Limits des Docker-Daemons; mit dieser Kennung ist zu erkennen, ob er noch alte trägt.
const serviceKey = (repo) => `${limitsOf(repo).dockerCpus}/${limitRules.bytesOf(limitsOf(repo).dockerMemory)}`;

// Legt den Build-Dienst mit den geltenden Limits neu an, sobald im Pool nichts gebaut wird, und hängt ihn wieder in
// die Netze der stehenden Paare. Die Paare selbst bleiben, wie sie sind.
async function renewService(pool) {
  const settings = settingsOf(pool.repo);
  if (!settings?.cache || !pool.serviceBuilt || pool.serviceBuilt === serviceKey(pool.repo)) return;
  if (stopping || pool.removed || pool.hold || pool.renewingService || !pool.prepared || !linuxReady) return;
  if (pool.slots.some((slot) => slot.state === 'arbeitet' || slot.state === 'räumt auf')) return;
  pool.renewingService = true;
  try {
    log(`${pool.repo}: lege den Build-Dienst mit den neuen Limits an`);
    await prepareCaches(pool.repo);
    for (const [base, repo] of livePairs) if (repo === pool.repo) await docker(['network', 'connect', '--alias', 'buildkit', base, buildService(pool.repo)]);
  } finally { pool.renewingService = false; }
}

// Paket-Cache und Build-Dienst eines Repos bereitstellen.
async function prepareCaches(repo) {
  const settings = settingsOf(repo);
  await docker(['rm', '-f', buildService(repo)]);
  if (!settings?.cache) { await docker(['network', 'rm', buildNetwork(repo)]); return; }
  await docker(['volume', 'create', cacheVolume(repo)]);
  await docker(['run', '--rm', '-v', `${cacheVolume(repo)}:/c`, '--entrypoint', 'sh', 'docker:dind', '-c',
    'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
  await docker(['volume', 'create', buildVolume(repo)]);
  // Eigenes Netz je Repo: Im gemeinsamen Standard-Netz könnte ein Build den Dienst eines anderen Repos ansprechen.
  await docker(['network', 'create', buildNetwork(repo)]);
  const service = await docker(['run', '-d', '--name', buildService(repo), '--privileged', '--restart', 'no', '--network', buildNetwork(repo),
    '--cpus', String(limitsOf(repo).dockerCpus), '--memory', limitsOf(repo).dockerMemory,
    '-v', `${buildVolume(repo)}:/var/lib/buildkit`, 'moby/buildkit:latest', '--addr', 'tcp://0.0.0.0:1234']);
  if (service.code !== 0) log(`${repo}: Build-Dienst startet nicht – ${lastLine(service.stderr)}`);
  const pool = pools.get(repo);
  if (pool) pool.serviceBuilt = serviceKey(repo);
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
    await docker(['run', '-d', '--label', MARK, '--name', loader, '--privileged', '-v', `${seed}:/var/lib/docker`, 'docker:dind']);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      ready = (await docker(['exec', loader, 'docker', 'info', '--format', 'ok'], { timeout: 20 * SECOND })).code === 0;
      if (!ready) await sleep(1000);
    }
    // Ohne laufenden Lade-Daemon ließe sich nichts laden; das Gelernte bleibt, wie es ist.
    if (!ready) { await docker(['rm', '-f', loader]); throw new Error('Der Lade-Daemon wurde nicht bereit; die Vorlage bleibt unverändert.'); }
    const present = new Set();
    const retry = new Set();
    for (const image of wanted) {
      const pull = await docker(['exec', loader, 'docker', 'pull', '-q', image], { timeout: DOCKER_LONG });
      if (pull.code === 0) { present.add(image); continue; }
      log(`${repo}: ${image} kommt nicht in die Vorlage – ${lastLine(pull.stderr)}`);
      // Eine Störung (Netz, Anfragelimit) geht vorüber: Was schon in der Vorlage liegt, bleibt dort.
      if (!permanentPullError(pull.stderr)) { retry.add(image); continue; }
      // Was es bei der Registry nicht gibt, hat der Job selbst gebaut oder es ist nicht öffentlich: nicht wieder versuchen.
      (state.rejected[repo] ??= {})[image] = new Date().toISOString();
      delete state.learned[repo]?.[image];
    }
    const existing = await dockerList(['exec', loader, 'docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
    for (const image of existing) if (retry.has(image)) present.add(image);
    const obsolete = existing.filter((image) => !present.has(image) && IMAGE_NAME.test(image));
    if (obsolete.length) await docker(['exec', loader, 'docker', 'rmi', '-f', ...obsolete]);
    await docker(['exec', loader, 'docker', 'image', 'prune', '-f']);
    await docker(['stop', loader]);
    await docker(['rm', loader]);
    if (pool) pool.seeded = present;
    pruneOlder(state.rejected[repo], LEARNED_DAYS);
    pruneOlder(state.learned[repo], LEARNED_DAYS);
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
  livePairs.delete(base);
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
  const limits = limitsOf(pool.repo);
  const id = crypto.randomBytes(3).toString('hex');
  const base = `rc-${slug(pool.repo)}-${id}`;
  const label = ['--label', MARK];
  const pair = { id, base, copied: new Set(), extras: [], limits };
  livePairs.set(base, pool.repo);
  const giveUp = async (error) => { await removePair(pool.repo, base, null); if (error) throw error; return null; };

  // Docker hat nur einen begrenzten Vorrat an Netzen; ist er erschöpft, sagt es das hier.
  const network = await docker(['network', 'create', ...label, base]);
  if (network.code !== 0) return giveUp(new Error(`Netz lässt sich nicht anlegen: ${lastLine(network.stderr)}`));
  for (const volume of ['work', 'sock', 'docker']) await docker(['volume', 'create', ...label, `${base}-${volume}`]);

  // Kopie der Vorlage in den Speicher des Daemons – in einem eigenen Container, bevor der Daemon startet.
  await withSeed(pool.repo, false, async () => {
    pair.copied = new Set(pool.seeded);
    if (!pair.copied.size || cancelled()) return;
    await docker(['run', '--rm', ...label, '--name', `${base}-seed`, '-v', `${seedVolume(pool.repo)}:/seed:ro`, '-v', `${base}-docker:/var/lib/docker`,
      '--entrypoint', 'sh', 'docker:dind', '-c', 'cp -a /seed/. /var/lib/docker/'], { timeout: DOCKER_LONG });
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
    const entry = { cancel: false, ready: false, built: limitRules.key(limitsOf(pool.repo)) };
    const drop = () => { pool.reserve = pool.reserve.filter((other) => other !== entry); };
    entry.promise = provision(pool, () => entry.cancel || stopping)
      .then((pair) => { entry.ready = Boolean(pair); if (!pair) drop(); return pair; })
      .catch((error) => { log(`${pool.repo}: Vorbereitung eines Paars – ${error.message}`); drop(); return null; });
    pool.reserve.push(entry);
  }
}

// Die Reserve erneuern, soweit sie alte Limits trägt. Mehrere Aufrufe kurz nacheinander (vier Regler, vier Änderungen) laufen
// nacheinander: Erst wenn die alten Paare samt Netz entfernt sind, entstehen neue.
function renewReserve(pool) {
  pool.renewing = (pool.renewing ?? Promise.resolve())
    .then(async () => {
      // Nur was noch mit anderen Limits gebaut ist, geht; eine schon frische Reserve bleibt stehen.
      const current = limitRules.key(limitsOf(pool.repo));
      const old = pool.reserve.filter((entry) => entry.built !== current);
      pool.reserve = pool.reserve.filter((entry) => entry.built === current);
      for (const entry of old) entry.cancel = true;
      for (const entry of old) { const pair = await entry.promise; if (pair) await removePair(pool.repo, pair.base, null); }
    })
    .then(() => replenish(pool))
    .catch((error) => log(`${pool.repo}: ${error.message}`));
  return pool.renewing;
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
  Object.assign(slot, { state: 'startet', job: null, finished: false, error: null, aborted: false, building: true });
  let pair = null;
  try {
    const entry = pool.reserve.shift();
    replenish(pool);
    if (entry) pair = await entry.promise;
    if (!pair) pair = await provision(pool, () => slot.aborted);
  } finally { slot.building = false; }
  if (!pair) return;
  // Runner und Docker-Daemon eines Paars tragen dieselben Limits: die, mit denen es gebaut wurde.
  const limits = pair.limits;
  Object.assign(slot, { base: pair.base, name: `${HOST}-linux-${pair.id}`, copied: pair.copied, built: limitRules.key(limits) });
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
    timeout: 0, // läuft, solange der Job läuft
    env: { JITCONFIG: jit.encoded_jit_config },
    onLine: (line) => {
      const started = line.match(/Running job: (.+)$/);
      const finished = line.match(/Job (.+) completed with result: (\w+)/);
      if (/Listening for Jobs/.test(line) && slot.state === 'startet') slot.state = 'bereit';
      if (started && slot.state !== 'arbeitet') {
        Object.assign(slot, { state: 'arbeitet', job: started[1], jobStartedAt: new Date().toISOString(), meter: metrics.meter() });
        log(`${pool.repo}: Job „${started[1]}“ läuft auf ${slot.name}`);
        refreshRepo(pool.repo);
        setTimeout(() => refreshRepo(pool.repo), 4000);
      }
      if (finished && !slot.finished) {
        if (slot.meter) metrics.recordJob(pool.repo, { job: finished[1], result: finished[2], duration: Math.round((Date.now() - new Date(slot.jobStartedAt)) / 1000), ...slot.meter.finish() });
        slot.meter = null;
        refreshRepo(pool.repo);
        Object.assign(slot, { finished: true, lastResult: `${finished[1]}: ${finished[2]}`, jobs: slot.jobs + 1 });
        log(`${pool.repo}: Job „${finished[1]}“ – ${finished[2]}`);
      }
    },
  });
  if (slot.aborted) return;
  if (!slot.job) throw new Error(`Runner endete ohne Job (${lastLine(runner.stderr) || `Code ${runner.code}`})`);
  await learnImages(pool, slot);
}

// Freie Paare und Reserve, die noch mit anderen Limits gebaut sind als den jetzt geltenden.
function staleCount(pool) {
  const current = limitRules.key(limitsOf(pool.repo));
  return pool.slots.filter((slot) => slot.base && slot.built && slot.built !== current && slot.state !== 'arbeitet' && slot.state !== 'räumt auf').length +
    pool.reserve.filter((entry) => entry.built !== current).length;
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
  // Der Runner-Container kann gerade erst entstehen: so lange entfernen, bis der Platz sein Paar abgeräumt hat.
  // Hat der Runner inzwischen doch einen Job angenommen, läuft der zu Ende.
  const { base } = slot;
  for (let attempt = 0; attempt < 60 && base && slot.base === base && slot.state !== 'arbeitet'; attempt += 1) {
    await docker(['rm', '-f', `${base}-runner`]);
    if (slot.base === base) await sleep(1000);
  }
  // Der Abbruch gilt nicht mehr: Sonst würden die Abbilder dieses Jobs nicht gelernt.
  if (slot.state === 'arbeitet') slot.aborted = false;
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
  // Ein neuer Pool kann zugleich von `startPool` und von der Schleife in `linuxLoop` erreicht werden.
  if (pool.preparing) return;
  pool.preparing = true;
  pool.prepared = false;
  try {
    await prepareCaches(pool.repo);
    await refreshSeed(pool.repo);
  } catch (error) { log(`${pool.repo}: Vorbereitung – ${error.message}`); } finally { pool.prepared = true; pool.preparing = false; }
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

let statsFeed = false; // es läuft höchstens einer
function startStatsFeed() {
  if (statsFeed) return;
  statsFeed = true;
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
  }).then(() => { statsFeed = false; containerStats.clear(); otherStats.clear(); if (!stopping) setTimeout(startStatsFeed, 5000); });
}

// Docker kann später starten als dieses Programm, oder zwischendurch neu starten.
async function linuxLoop() {
  let misses = 0;
  while (!stopping) {
    if (!linuxReady) {
      try {
        await prepareLinux();
        for (const pool of pools.values()) pool.prepared = false;
        linuxReady = true;
        linuxError = null;
        misses = 0;
        startStatsFeed();
        for (const pool of pools.values()) await preparePool(pool);
      } catch (error) {
        if (linuxError !== error.message) log(error.message);
        linuxError = error.message;
      }
    } else if ((await docker(['info', '--format', 'ok'], { timeout: 20 * SECOND })).code !== 0) {
      // Eine einzelne ausbleibende Antwort (volle VM, kurzer Hänger) heißt nicht, dass Docker weg ist:
      // Erst nach mehreren in Folge warten die Plätze und alles wird neu vorbereitet.
      misses += 1;
      if (misses >= DOCKER_MISSES) {
        linuxReady = false;
        log('Docker antwortet nicht mehr – die Linux-Runner warten.');
      }
      await sleep(5000);
      continue;
    } else misses = 0;
    await sleep(linuxReady ? 30000 : 15000);
  }
}

// --- GitHub: Runner, laufende und wartende Jobs, letzte Läufe ---

const github = new Map(); // Repo -> { runners, jobs, runs, error }
const pipelines = createPipelines({ gh, dataDir: DATA_DIR });
const routing = createRouting({ gh }); // wohin die Jobs eines Repos gehen (Repo-Variable CI_RUNNER)

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
const githubBusy = new Set(); // Repos, deren Abfrage gerade läuft
const githubAgain = new Set(); // … und die danach noch einmal dran sind

// Ein Repo abfragen. Läuft schon eine Abfrage, folgt danach genau eine weitere.
async function refreshRepo(repo) {
  if (githubBusy.has(repo)) { githubAgain.add(repo); return; }
  githubBusy.add(repo);
  try {
    const runs = (await gh(['api', `repos/${repo}/actions/runs?per_page=20`])).workflow_runs;
    const jobs = (await pipelines.refresh(repo, runs)).flatMap((pipeline) => pipeline.jobs
      .filter((job) => job.status !== 'completed' && job.status !== 'pending')
      .map((job) => ({ workflow: pipeline.workflow, job: job.name, branch: pipeline.branch, status: job.status, runner: job.runner, startedAt: job.startedAt, url: job.url, estimate: job.estimate, step: job.step })));
    github.set(repo, {
      jobs, error: null,
      runs: runs.slice(0, 20).map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at ?? r.created_at, url: r.html_url, title: r.display_title })),
    });
  } catch (error) {
    github.set(repo, { ...(github.get(repo) ?? { jobs: [], runs: [] }), error: error.message });
  } finally {
    githubBusy.delete(repo);
    if (githubAgain.delete(repo) && !stopping) refreshRepo(repo);
  }
}

// Alle Repos der Reihe nach – der ruhige Takt.
async function refreshGitHub() {
  for (const pool of [...config.pools]) await refreshRepo(pool.repo);
}

// Wo gerade etwas läuft, öfter nachsehen: Dort ändert sich der Stand im Sekundentakt.
function refreshActive() {
  for (const settings of config.pools) {
    const working = pools.get(settings.repo)?.slots.some((slot) => slot.state === 'arbeitet');
    if (working || github.get(settings.repo)?.jobs.length) refreshRepo(settings.repo);
  }
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

const limitRange = () => limitRules.bounds({ dockerMemory, dockerCpus });
// Der Vorschlag für alle Projekte zusammen und ob er schon gilt (siehe `plan` in limits.js).
function limitPlan() {
  const found = limitRules.plan(config.pools.map((pool) => ({ repo: pool.repo, jobs: metrics.jobsView(pool.repo) })), limitRange());
  if (!found) return null;
  const projects = config.pools.map((pool) => ({ repo: pool.repo, own: pool.limits ? limitRules.view(limitsOf(pool.repo)) : null }));
  return { ...found, applied: limitRules.planApplied(found, limitRules.view(config.limits), projects) };
}

// Beim Speichern kann die Datei einen Augenblick fehlen; dann gilt der letzte bekannte Stand.
let uiSeenAt = 0;
function uiChangedAt() {
  try { uiSeenAt = fs.statSync(path.join(__dirname, 'ui.html')).mtimeMs; } catch { /* gleich wieder da */ }
  return uiSeenAt;
}

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
      limits: { own: Boolean(settings.limits), values: limitRules.view(limitsOf(settings.repo)), suggestion: limitRules.suggest(metrics.jobsView(settings.repo), limitRange()), fit: limitRules.rate(metrics.jobsView(settings.repo), limitRules.view(limitsOf(settings.repo)), limitRange()), stale: pool ? staleCount(pool) : 0 },
      routing: routing.of(settings.repo),
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
      limitsView: { values: limitRules.view(config.limits), bounds: limitRange(), plan: limitPlan(), needRuns: limitRules.SUGGEST_RUNS },
    },
    repos: [...repos.values()],
    log: recent.slice(-25),
    ui: uiChangedAt(), // die Seite lädt sich neu, wenn sich ihre Datei ändert
    ...hooks.status(),
  };
}

// --- Was die Oberfläche auslösen kann ---

const actions = {
  async 'pool/add'({ repo, parallel }) {
    if (!REPO_NAME.test(String(repo))) throw new Error('Das Repo wird als besitzer/name angegeben.');
    const info = await gh(['api', `repos/${repo}`]);
    if (!info.permissions?.admin) throw new Error('Für dieses Repo fehlen dir die Verwaltungsrechte; ohne sie lässt sich kein Runner anmelden.');
    // Erst hier prüfen, mit dem Namen, wie GitHub ihn schreibt, und ohne weiteres Warten bis zum Eintrag:
    // sonst entstünde bei anderer Schreibweise oder zwei Anfragen kurz nacheinander ein zweiter Pool.
    const taken = [...config.pools.map((pool) => pool.repo), ...pools.keys()];
    if (taken.some((other) => sameRepo(other, info.full_name))) throw new Error(pools.get(info.full_name)?.removed ? 'Dieser Pool wird gerade entfernt. Bitte warten, bis das abgeschlossen ist.' : 'Für dieses Repo gibt es schon einen Pool.');
    const clash = clashes(info.full_name, taken);
    if (clash) throw new Error(`Ein Pool für ${clash} belegt denselben Namen für Caches und Build-Dienst. Zwei Repos mit gleichem Namen lassen sich nicht zugleich bedienen.`);
    // Fremde Pull Requests eines öffentlichen Repos würden auf diesem Rechner Code ausführen (siehe Kopf dieser Datei).
    if (info.private === false) throw new Error('Das Repo ist öffentlich. Auf den eigenen Runnern darf nur Code laufen, dem du vertraust; Pools gibt es deshalb nur für private Repos.');
    config.pools.push({ repo: info.full_name, parallel: Math.min(4, Math.max(1, Number(parallel) || 1)), cache: true, paused: false, preload: [] });
    saveConfig();
    log(`${info.full_name}: Pool angelegt`);
    startPool(info.full_name);
    refreshGitHub();
    // Die Jobs des Repos auf die eigenen Runner leiten, wenn seine Workflows die Variable lesen.
    routing.check(info.full_name).then(async (found) => {
      if (found.uses === 'variable' && !found.here) { await routing.set(info.full_name, true); log(`${info.full_name}: ${VARIABLE} gesetzt – die Jobs laufen jetzt auf den eigenen Runnern`); }
      else if (found.uses === 'none') log(`${info.full_name}: Die Workflows lesen ${VARIABLE} nicht – die Jobs gehen weiter an GitHubs Runner`);
    }).catch((error) => log(`${info.full_name}: ${VARIABLE} – ${error.message}`));
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
      await docker(['network', 'rm', buildNetwork(repo)]);
      await docker(['volume', 'rm', '-f', cacheVolume(repo), seedVolume(repo), buildVolume(repo)]);
      // Ohne Pool würden die Jobs ewig auf einen Runner warten: zurück zu GitHubs Runnern.
      // Der Stand wird frisch gelesen – die Variable kann inzwischen von Hand gesetzt worden sein.
      try { if ((await routing.check(repo)).here) { await routing.set(repo, false); log(`${repo}: ${VARIABLE} entfernt – die Jobs gehen wieder an GitHubs Runner`); } } catch (error) { log(`${repo}: ${VARIABLE} – ${error.message}`); }
      routing.forget(repo);
      await removeRegistrations(repo);
      delete state.learned[repo];
      delete state.rejected[repo];
      saveState();
      metrics.forget(repo);
      github.delete(repo);
      log(`${repo}: Pool und seine Caches sind entfernt`);
    })().catch((error) => log(`${repo}: ${error.message}`))
      // Auch wenn ein Schritt scheitert, wird der Name wieder frei.
      .finally(() => { if (pools.get(repo) === pool) pools.delete(repo); });
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
  async 'pool/routing'({ repo, on }) {
    if (!settingsOf(repo)) throw new Error('Diesen Pool gibt es nicht.');
    await routing.set(repo, Boolean(on));
    log(`${repo}: ${VARIABLE} ${on ? 'gesetzt – die Jobs laufen auf den eigenen Runnern' : 'entfernt – die Jobs gehen an GitHubs Runner'}`);
  },
  // Speicher in GB, Kerne als Anzahl. Arbeitende und schon bereite Paare behalten ihre Limits bis zum nächsten Aufbau.
  // Mit `repo` gelten sie nur für dieses Projekt; `inherit` nimmt dessen eigene Werte wieder weg.
  async 'limits/set'({ repo, inherit, ...input }) {
    if (!linuxReady) throw new Error('Docker ist noch nicht bereit; die Grenzen der Docker-VM sind noch unbekannt.');
    const settings = repo ? settingsOf(repo) : null;
    if (repo && !settings) throw new Error('Diesen Pool gibt es nicht.');
    const text = (limits) => `Runner ${limits.runnerMemory} und ${limits.runnerCpus} Kerne, Docker ${limits.dockerMemory} und ${limits.dockerCpus} Kerne`;
    if (settings && inherit) { delete settings.limits; log(`${repo}: wieder die Limits für alle (${text(config.limits)})`); }
    else if (settings) { settings.limits = limitRules.normalize(input, limitsOf(repo), limitRange()); log(`${repo}: eigene Limits – ${text(settings.limits)}`); }
    else { config.limits = { ...config.limits, ...limitRules.normalize(input, config.limits, limitRange()) }; log(`Limits je Job: ${text(config.limits)}`); }
    saveConfig();
    // Vorbereitete Paare tragen noch die alten Limits: verwerfen, die Reserve füllt sich mit den neuen.
    for (const pool of pools.values()) renewReserve(pool);
  },
  // Übernimmt den Vorschlag aus den Messwerten als Ganzes: den Standard für alle und eigene Limits für die Ausreißer.
  // Gemessene Projekte, die nicht als Ausreißer gelten, verlieren dabei ihre eigenen Werte.
  async 'limits/plan'() {
    if (!linuxReady) throw new Error('Docker ist noch nicht bereit; die Grenzen der Docker-VM sind noch unbekannt.');
    const found = limitPlan();
    if (!found) throw new Error('Für einen Vorschlag fehlen noch Messwerte.');
    config.limits = { ...config.limits, ...limitRules.normalize(found.shared, config.limits, limitRange()) };
    for (const pool of config.pools) {
      if (!found.measured.includes(pool.repo)) continue; // zu wenige Läufe: Was der Nutzer eingestellt hat, bleibt
      if (found.own[pool.repo]) pool.limits = limitRules.normalize(found.own[pool.repo], limitsOf(pool.repo), limitRange()); else delete pool.limits;
    }
    saveConfig();
    const own = Object.keys(found.own);
    log(`Limits aus den Messwerten übernommen: Standard Runner ${config.limits.runnerMemory}, Docker ${config.limits.dockerMemory}${own.length ? `; eigene Limits für ${own.join(', ')}` : ''}`);
    for (const pool of pools.values()) renewReserve(pool);
  },
  // Baut die freien Paare neu auf, damit neue Limits sofort gelten. Arbeitende Paare laufen zu Ende.
  async 'pool/rebuild'({ repo }) {
    if (repo && !pools.get(repo)) throw new Error('Diesen Pool gibt es nicht.');
    for (const pool of repo ? [pools.get(repo)] : [...pools.values()]) {
      if (pool.removed || !staleCount(pool)) continue;
      log(`${pool.repo}: baue die freien Runner mit den neuen Limits auf`);
      const working = pool.slots.some((slot) => slot.state === 'arbeitet');
      // Läuft kein Job, entsteht auch der Build-Dienst neu; er trägt die Limits des Docker-Daemons.
      (working ? Promise.all([renewReserve(pool), ...pool.slots.map((slot) => abortIdle(slot))]) : withPoolAtRest(pool, () => prepareCaches(pool.repo)))
        .catch((error) => log(`${pool.repo}: ${error.message}`));
    }
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
  for (const settings of config.pools) { await docker(['rm', '-f', buildService(settings.repo)]); await docker(['network', 'rm', buildNetwork(settings.repo)]); }
  await removeLeftovers();
  log('Beendet.');
  hooks.onExit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);

const PAGE = (nonce) => fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8').replace('__TOKEN__', TOKEN).replace('__NONCE__', nonce);

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 10000) reject(new Error('zu groß')); });
    request.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein Objekt');
        resolve(data);
      } catch { reject(new Error('Der Aufruf ist kein gültiges JSON-Objekt.')); }
    });
  });
}

http.createServer(async (request, response) => {
  const json = (code, data) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
  // Nur der eigene Rechner unter seinem eigenen Namen: hält umgeleitete Namen fremder Seiten draußen.
  if (!access.hostAllowed(request.headers)) return json(403, { error: 'falscher Host' });
  if (request.method === 'GET' && request.url === '/api/ping') return json(200, { ok: true });
  const font = request.method === 'GET' && request.url.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
  if (font && fs.existsSync(path.join(__dirname, 'fonts', font[1]))) {
    response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' });
    return response.end(fs.readFileSync(path.join(__dirname, 'fonts', font[1])));
  }
  // Der Einstieg tauscht den Schlüssel gegen das Cookie; alles Weitere gibt es nur mit Cookie (siehe access.js).
  const entering = request.method === 'GET' ? access.entering(request.url) : null;
  if (entering) {
    response.writeHead(302, { location: '/', 'set-cookie': access.cookie, 'cache-control': 'no-store' });
    return response.end();
  }
  if (!access.allowed(request.headers)) return json(403, { error: 'Kein Zugriff. RunClub über das Symbol im Infobereich öffnen.' });
  if (request.method === 'GET' && request.url === '/') {
    const nonce = newNonce();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...pageHeaders(nonce) });
    return response.end(PAGE(nonce));
  }
  if (request.method === 'GET' && request.url === '/api/status') return json(200, status());
  if (request.method === 'GET' && request.url === '/api/metrics/day') return json(200, metrics.minutes());
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
}).listen(PORT, '127.0.0.1', () => {
  log(`Runner-Anzeige: http://localhost:${PORT}`);
  // Der Schlüssel steht nur in der Konsole und in einer Datei im Datenordner des Nutzers, nie im Protokoll,
  // das die Oberfläche zeigt.
  try { fs.writeFileSync(KEY_FILE, `${access.key}\n`); } catch { /* dann bleibt nur die Konsole */ }
  console.log(`Öffnen mit: ${access.entry}`);
});

refreshGitHub();
setInterval(refreshGitHub, GITHUB_INTERVAL_MS);
setInterval(refreshActive, GITHUB_ACTIVE_INTERVAL_MS);
setInterval(measure, MEASURE_INTERVAL_MS);
setInterval(() => {
  for (const pool of pools.values()) { replenish(pool); renewService(pool).catch((error) => log(`${pool.repo}: ${error.message}`)); }
}, MINUTE);
setInterval(() => { if (linuxReady) for (const pool of pools.values()) if (!pool.hold) measureSizes(pool); }, SIZES_INTERVAL_MS);

for (const settings of config.pools) { startPool(settings.repo); routing.check(settings.repo).catch(() => {}); }
linuxLoop();

module.exports = { PORT, DATA_DIR, ENTRY: access.entry, hooks, status, shutdown, log };
