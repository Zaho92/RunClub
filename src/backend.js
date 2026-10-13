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
const { run, lastLine } = require('./run');
const { SECOND, MINUTE, DAY, GB } = require('./units');
const { createAccess, pageHeaders, newNonce } = require('./access');
const { orphaned } = require('./pairs');
const { readJson, writeJson } = require('./store');
const { slug, sameRepo, clashes } = require('./images');
const limitRules = require('./limits');
const { createPipelines } = require('./pipeline');
const { createMetrics } = require('./metrics');
const { createVmMemory, COMMAND: VM_COMMAND } = require('./vmmemory');
const { createRouting, VARIABLE } = require('./routing');
const { createWaiting, candidates } = require('./waiting');
const { createJournal } = require('./journal');
const { createGitHub, STATE: QUOTA } = require('./github');
const { createSlots } = require('./slots');
const { createPools } = require('./pools');
const { createSeed } = require('./seed');
const { createCaches } = require('./caches');
const { createAuth, STATE: AUTH } = require('./auth');
const { createMinutes, SCOPE: MINUTES_SCOPE } = require('./minutes');

const PORT = Number(process.env.RUNCLUB_PORT) || 8770;
const DATA_DIR = process.env.RUNCLUB_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'runners.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'runclub.log');
const IMAGE = 'runclub-runner:latest';
// Was privilegiert läuft, ist per Digest festgenagelt: Ein bewegliches Etikett (`dind`, `latest`) kann von heute auf
// morgen etwas anderes sein. Anheben: das neue Abbild laden (`docker pull docker:dind`), prüfen, den Digest aus
// `docker image inspect --format '{{index .RepoDigests 0}}'` hier eintragen. Das Runner-Abbild selbst (linux/Dockerfile)
// folgt bewusst dem neuesten Stand: GitHub weist zu alte Runner ab.
const DIND = 'docker:29.9.0-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470';
const BUILDKIT = 'moby/buildkit@sha256:b059f8d7226d0b326bc871af489a5dddf65e36af4d20d14251b072974d9ee87c';
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
const SIZES_INTERVAL_MS = 5 * MINUTE;
const WAITING_INTERVAL_MS = 5 * MINUTE; // so oft wird nach wartenden Läufen ohne Pool gesucht
const MINUTES_INTERVAL_MS = 15 * MINUTE; // so oft wird das Minuten-Kontingent gelesen; die Zahl ändert sich langsam
const RERUN_SETTLE_MS = 3 * SECOND; // so lange braucht GitHub etwa, bis ein erneut gestarteter Lauf wieder als laufend erscheint
const IMAGE_INTERVAL_MS = DAY; // so oft wird das Runner-Abbild im laufenden Betrieb neu gebaut
const GH_TIMEOUT = MINUTE;
const DOCKER_TIMEOUT = 5 * MINUTE; // gewöhnliche Aufrufe; was länger dauern darf, nennt seine Grenze selbst
const DOCKER_LONG = 30 * MINUTE; // Abbilder bauen, laden, kopieren
const DOCKER_MISSES = 3; // so oft hintereinander muss Docker schweigen, bevor es als weg gilt
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Protokoll ---

const journal = createJournal({ file: LOG_FILE, echo: (line) => console.log(line) });
// `repo` nennt das Projekt, zu dem die Meldung gehört; `kind` und `about` (bei Jobs `{ job, runner }`) siehe journal.js.
const log = (text, repo, kind, about) => journal.add(text, { repo, kind, ...about });
// Kennung des Stands für die Oberfläche: Sie ändert sich mit jedem Eintrag und mit jedem Start, damit ein offenes
// Fenster nach einem Neustart nicht zufällig dieselbe Zahl sieht und das Nachladen auslässt.
const STARTED = Date.now();
const logStamp = () => `${STARTED}-${journal.count()}`;
// Für `.catch(…)`: schreibt den Fehler zum Projekt ins Protokoll, auf Wunsch mit dem, was gerade versucht wurde.
const logError = (repo, what) => (error) => log(what ? `${what} – ${error.message}` : error.message, repo, 'error');

// --- Einstellungen und Gelerntes ---

function loadJson(file) {
  const { data, broken } = readJson(file, {});
  if (broken) log(`${path.basename(file)} ließ sich nicht lesen und wird neu angelegt. Die alte Datei liegt unter ${broken}.`, null, 'error');
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

// Abfragen an GitHub gehen über github.js: bedingt, wo es geht, und mit dem Stand des Anfragelimits.
const githubApi = createGitHub({ run, timeout: GH_TIMEOUT });
const gh = githubApi.call;

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

// Das Runner-Abbild bauen. Scheitert das (kein Netz) und liegt ein früheres vor, arbeiten die Runner damit weiter;
// nur ganz ohne Abbild geht es nicht.
async function buildImage() {
  const build = await docker(['build', '--pull', '-q', '-t', IMAGE, path.join(__dirname, '..', 'linux')], { timeout: DOCKER_LONG });
  if (build.code === 0) return;
  const reason = lastLine(build.stderr);
  if ((await docker(['image', 'inspect', '--format', 'ok', IMAGE])).code !== 0) throw new Error(`Das Runner-Abbild ließ sich nicht bauen: ${reason}`);
  log(`Das Runner-Abbild ließ sich nicht neu bauen (${reason}); die Runner nutzen das vorhandene.`, null, 'error');
}

// Bei langer Laufzeit veraltet der Runner im Abbild, und GitHub weist zu alte Runner ab: täglich neu bauen. Neue
// Paare starten von selbst mit dem neuen Abbild; laufende Jobs berührt das nicht.
async function refreshImage() {
  if (stopping || !linuxReady) return;
  log('Baue das Runner-Abbild neu (tägliche Auffrischung) …');
  await buildImage();
}

async function prepareLinux() {
  const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeout: 20 * SECOND });
  if (info.code !== 0) throw new Error('Docker ist nicht erreichbar – läuft Docker Desktop?');
  dockerCpus = Number(info.stdout.trim().split(' ')[0]) || 1;
  dockerMemory = Number(info.stdout.trim().split(' ')[1]) || 0;
  log('Baue das Runner-Abbild (mit dem neuesten Runner von GitHub) …');
  await buildImage();
  await docker(['pull', '-q', DIND], { timeout: DOCKER_LONG });
  await docker(['pull', '-q', BUILDKIT], { timeout: DOCKER_LONG });
  // Reste gibt es nur vom vorigen Programmlauf. Meldet sich Docker später zurück, räumen die Plätze ihre Paare
  // selbst ab; alles Gekennzeichnete zu entfernen, träfe dann auch Paare, auf denen gerade ein Job läuft.
  if (!leftoversRemoved) { await removeLeftovers(); leftoversRemoved = true; } else await removeOrphans();
}

// Nach einer Unterbrechung von Docker: War Docker beim Abräumen eines Paars nicht erreichbar, sind dessen Container,
// Volumes und Netz liegen geblieben. Entfernt wird nur, was zu keinem stehenden Paar mehr gehört.
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
  } catch (error) { log(`Abmelden alter Runner – ${error.message}`, repo, 'error'); }
}

// Vorlage und Gelerntes liegen in seed.js: die Namen der Abbilder nach einem Job festhalten, die Vorlage auffrischen.
const { withSeed, refreshSeed, learnImages } = createSeed({
  docker, dockerList, log, sleep,
  mark: MARK, dind: DIND, longTimeout: DOCKER_LONG,
  settingsOf, seedVolume, poolOf: (repo) => pools.get(repo),
  state, saveState,
});

// Der Lebenslauf eines Platzes liegt in slots.js: ein Paar aufbauen, anmelden, einen Job bedienen, abräumen. Was davon
// hier gebraucht wird, behält seinen Namen. `metrics` entsteht weiter unten und wird deshalb erst beim Gebrauch gelesen;
// ebenso die Reserve aus pools.js, die gleich darunter entsteht und ihrerseits die Plätze braucht.
const { livePairs, provision, removePair, teardown, slotLoop, abortIdle } = createSlots({
  docker, gh, log, sleep,
  host: HOST, mark: MARK, image: IMAGE, dind: DIND, longTimeout: DOCKER_LONG,
  metrics: { meter: () => metrics.meter(), recordJob: (repo, record) => metrics.recordJob(repo, record) },
  settingsOf, limitsOf, seedVolume, cacheVolume, buildService,
  stopping: () => stopping, linuxReady: () => linuxReady, poolResting: (...args) => poolResting(...args),
  withSeed, learnImages, replenish: (...args) => replenish(...args), discardReserve: (...args) => discardReserve(...args), refreshRepo,
  forgetStats: (name) => containerStats.delete(name),
});

// Paket-Cache und Build-Dienst eines Repos liegen in caches.js: bereitstellen und mit neuen Limits neu anlegen.
const { prepareCaches, renewService } = createCaches({
  docker, log,
  dind: DIND, buildkit: BUILDKIT,
  settingsOf, limitsOf, poolOf: (repo) => pools.get(repo),
  cacheVolume, buildVolume, buildService, buildNetwork,
  livePairs, stopping: () => stopping, linuxReady: () => linuxReady,
});

// Die Reserve eines Pools und sein Anhalten liegen in pools.js: nachfüllen, erneuern, abbauen, die Zahl der Plätze
// angleichen, den Pool zur Ruhe bringen.
const { reserveSize, replenish, renewReserve, discardReserve, staleCount, poolResting, reconcile, quiesce, rebuildIdle, withPoolAtRest } = createPools({
  log, sleep,
  settingsOf, limitsOf, stopping: () => stopping, linuxReady: () => linuxReady,
  provision, removePair, slotLoop, abortIdle,
  prepareCaches,
});

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
  } catch (error) { log(`Vorbereitung – ${error.message}`, pool.repo, 'error'); } finally { pool.prepared = true; pool.preparing = false; }
  measureSizes(pool);
}

async function measureSizes(pool) {
  const existing = new Set(await dockerList(['volume', 'ls', '-q', '--filter', 'name=rc-']));
  const parts = [['packages', cacheVolume(pool.repo)], ['images', seedVolume(pool.repo)], ['build', buildVolume(pool.repo)]].filter(([, volume]) => existing.has(volume));
  const sizes = { packages: 0, images: 0, build: 0 };
  if (parts.length) {
    const mounts = parts.flatMap(([key, volume]) => ['-v', `${volume}:/m/${key}:ro`]);
    const result = await docker(['run', '--rm', ...mounts, '--entrypoint', 'sh', DIND, '-c', 'du -sm /m/* 2>/dev/null']);
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

const gbText = (bytes) => `${(bytes / GB).toFixed(1).replace('.', ',')} GB`; // für Meldungen

// Was die Docker-VM wirklich belegt, liest ein zweiter Dauerlauf in der VM selbst (siehe vmmemory.js); die Summe der
// Container lässt Kernel und Daemon aus. Das geht nur mit Docker Desktop unter WSL2. Gibt es die Distro nicht, endet
// der Aufruf ohne Messwert: Dann bleibt es still bei der Summe der Container, bis Docker neu vorbereitet wird.
// Neu gestartet wird nur von `linuxLoop`, wenn Docker gerade geantwortet hat: Der Aufruf würde eine angehaltene
// Distro sonst selbst hochfahren.
const vmProbe = createVmMemory({
  onChange: (tight, sample) => {
    if (tight) log(`Die Docker-VM hat nur noch ${gbText(sample.available)} von ${gbText(sample.total)} Arbeitsspeicher frei.`, null, 'error');
    else log(sample ? `Die Docker-VM hat wieder ${gbText(sample.available)} Arbeitsspeicher frei.` : 'Die Belegung der Docker-VM lässt sich nicht mehr messen; die Warnung entfällt.');
  },
});
// Der Messprozess wird stündlich beendet und neu gestartet: Bliebe er stumm hängen, käme sonst nie wieder ein Wert.
const VM_FEED_MAX = 60 * MINUTE;
const vmFree = () => { const sample = vmProbe.tight() ? vmProbe.current() : null; return sample ? { free: sample.available } : null; };
let vmFeed = false; // es läuft höchstens einer
let vmFeedMissing = false; // der letzte Versuch brachte keinen Messwert
function startVmFeed() {
  if (vmFeed || vmFeedMissing || stopping) return;
  vmFeed = true;
  let seen = false;
  run('wsl', ['-d', 'docker-desktop', 'sh', '-c', VM_COMMAND], { timeout: VM_FEED_MAX, onLine: (line) => { vmProbe.line(line); seen ||= Boolean(vmProbe.current()); } })
    .then(() => { vmFeed = false; vmFeedMissing = !seen; vmProbe.drop(); });
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
        vmFeedMissing = false;
        startVmFeed();
        for (const pool of pools.values()) await preparePool(pool);
      } catch (error) {
        if (linuxError !== error.message) log(error.message, null, 'error');
        linuxError = error.message;
      }
    } else if ((await docker(['info', '--format', 'ok'], { timeout: 20 * SECOND })).code !== 0) {
      // Eine einzelne ausbleibende Antwort (volle VM, kurzer Hänger) heißt nicht, dass Docker weg ist:
      // Erst nach mehreren in Folge warten die Plätze und alles wird neu vorbereitet.
      misses += 1;
      if (misses >= DOCKER_MISSES) {
        linuxReady = false;
        log('Docker antwortet nicht mehr – die Linux-Runner warten.', null, 'error');
      }
      await sleep(5000);
      continue;
    } else { misses = 0; startVmFeed(); }
    await sleep(linuxReady ? 30000 : 15000);
  }
}

// --- GitHub: Runner, laufende und wartende Jobs, letzte Läufe ---

const github = new Map(); // Repo -> { runners, jobs, runs, error }
const pipelines = createPipelines({ gh, dataDir: DATA_DIR });
const routing = createRouting({ gh }); // wohin die Jobs eines Repos gehen (Repo-Variable CI_RUNNER)
const waiting = createWaiting({ gh }); // Repos ohne Pool, in denen Jobs auf einen eigenen Runner warten oder Läufe am Kontingent von GitHub scheitern

// --- Messung: Rechner, Docker-VM und der Verbrauch je Job ---

const metrics = createMetrics({ dataDir: DATA_DIR });
// CPU in Kernen. `vmMemory` und `otherMemory` sind die Summen der eigenen und der fremden Container; `vmUsed` ist die
// Belegung der Docker-VM im Ganzen: gemessen in der VM, solange der Messwert frisch ist, sonst die beiden Summen.
const usage = { hostCpu: 0, vmCpu: 0, vmMemory: 0, vmUsed: 0, otherCpu: 0, otherMemory: 0 };
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
  usage.vmUsed = vmProbe.current()?.used ?? usage.vmMemory + usage.otherMemory;

  for (const pool of pools.values()) {
    for (const slot of pool.slots) if (slot.meter && slot.base) slot.meter.add(containerStats.get(`${slot.base}-runner`), containerStats.get(`${slot.base}-dind`));
  }
  measureRound += 1;
  if (measureRound % SAMPLE_EVERY === 0) {
    metrics.sample({ hostCpu: usage.hostCpu, hostMemory: os.totalmem() - os.freemem(), vmCpu: usage.vmCpu + usage.otherCpu, vmMemory: usage.vmUsed });
  }
}
const githubBusy = new Set(); // Repos, deren Abfrage gerade läuft
const githubAgain = new Set(); // … und die danach noch einmal dran sind

// Ein Repo abfragen. Läuft schon eine Abfrage, folgt danach genau eine weitere.
async function refreshRepo(repo) {
  if (githubBusy.has(repo)) { githubAgain.add(repo); return; }
  if (!githubApi.mayPoll(repo)) return; // das Anfragelimit ist knapp oder aufgebraucht (siehe github.js)
  githubBusy.add(repo);
  try {
    const runs = (await gh(['api', `repos/${repo}/actions/runs?per_page=20`])).workflow_runs;
    const jobs = (await pipelines.refresh(repo, runs)).flatMap((pipeline) => pipeline.jobs
      .filter((job) => job.status !== 'completed' && job.status !== 'pending')
      .map((job) => ({ workflow: pipeline.workflow, job: job.name, branch: pipeline.branch, status: job.status, runner: job.runner, own: job.own, startedAt: job.startedAt, url: job.url, estimate: job.estimate, step: job.step })));
    github.set(repo, {
      jobs, error: null,
      runs: runs.slice(0, 20).map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at ?? r.created_at, url: r.html_url, title: r.display_title })),
    });
    // Der Platz merkt sich den Workflow seines Jobs: Am Ende nennt der Runner nur den Jobnamen (siehe metrics.js).
    for (const slot of pools.get(repo)?.slots ?? []) if (slot.state === 'arbeitet') slot.workflow = jobs.find((job) => job.runner === slot.name)?.workflow || slot.workflow;
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

// Wo gerade etwas auf den eigenen Runnern läuft oder darauf wartet, öfter nachsehen: Dort ändert sich der Stand im
// Sekundentakt. Jobs auf GitHubs Runnern genügt der ruhige Takt.
function refreshActive() {
  for (const settings of config.pools) {
    const working = pools.get(settings.repo)?.slots.some((slot) => slot.state === 'arbeitet');
    if (working || github.get(settings.repo)?.jobs.some((job) => job.own)) refreshRepo(settings.repo);
  }
}

// Den Stand des Anfragelimits holen und ins Protokoll schreiben, wenn er kippt.
async function checkQuota() {
  const changed = await githubApi.refreshQuota();
  if (!changed) return;
  if (changed.paused) log(`GitHub bittet um eine Pause (zu viele Anfragen in kurzer Zeit). Bis ${changed.until} wird nicht mehr abgefragt.`);
  else if (changed.state === QUOTA.OUT) log(`GitHub-Anfragen sind aufgebraucht (${changed.remaining} von ${changed.limit} frei). Bis ${changed.until} wird nicht mehr abgefragt; der Rest bleibt für das Anmelden neuer Runner.`);
  else if (changed.state === QUOTA.TIGHT) log(`GitHub-Anfragen werden knapp (${changed.remaining} von ${changed.limit} frei). Bis ${changed.until} wird seltener abgefragt.`);
  else if (changed.before !== QUOTA.UNKNOWN) log('GitHub-Anfragen sind wieder frei; es wird wieder im gewohnten Takt abgefragt.');
  // Solange nichts gelesen werden durfte, blieb auch der Stand von CI_RUNNER unbekannt: jetzt nachholen.
  if (changed.before === QUOTA.OUT) for (const settings of config.pools) routing.check(settings.repo).catch(() => {});
}
const watchQuota = () => checkQuota().catch(logError(null, 'Anfragelimit'));

// Die Anmeldung bei GitHub ist die von `gh` (siehe auth.js). Nach einem gelungenen Anmelden oder Ergänzen gilt ein
// anderes Token: das Anfragelimit neu holen und die Repos gleich abfragen.
const auth = createAuth({ run, timeout: GH_TIMEOUT, log: (text) => log(text), onSuccess: () => { watchQuota(); refreshGitHub(); watchMinutes(); } });
const watchAuth = () => auth.poll().catch(logError(null, 'Anmeldung bei GitHub'));

// Das Minuten-Kontingent von GitHub Actions (siehe minutes.js): nur mit Anmeldung und dem freiwilligen Recht dafür.
// Ein Fehler bleibt beim letzten Stand und steht einmal im Protokoll.
const minutes = createMinutes({ gh, log: (text) => log(text, null, 'error') });
const minutesLogin = () => { const signedIn = auth.view(); return signedIn.state === AUTH.IN && signedIn.scopes?.includes(MINUTES_SCOPE) ? signedIn.login : null; };
function watchMinutes() {
  const login = minutesLogin();
  return login && !stopping && githubApi.mayPoll('Minuten-Kontingent') ? minutes.refresh(login) : Promise.resolve();
}

// Repos, für die sich Runner anmelden lassen (Verwaltungsrecht), die zuletzt bewegten zuerst.
let repoList = { at: 0, repos: [] };
async function listRepos() {
  if (Date.now() - repoList.at > 5 * MINUTE) {
    const repos = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await gh(['api', `user/repos?per_page=100&page=${page}&sort=pushed`]);
      repos.push(...batch.filter((r) => r.permissions?.admin && !r.archived).map((r) => ({ repo: r.full_name, private: r.private, pushedAt: r.pushed_at })));
      if (batch.length < 100) break;
    }
    repoList = { at: Date.now(), repos };
  }
  // `free`: Für das Repo ist ein Pool möglich (es hat keinen, und öffentliche bekommen keinen; siehe `pool/add`).
  return repoList.repos.map((r) => { const pool = Boolean(settingsOf(r.repo)); return { ...r, pool, free: !pool && r.private !== false }; });
}

// Nach Läufen suchen, für die es keinen Pool gibt und die deshalb auf einen eigenen Runner warten oder am
// aufgebrauchten Kontingent von GitHub gescheitert sind (siehe waiting.js).
// Lässt sich die Liste der Repos nicht lesen, bleibt der letzte Stand.
function scanWaiting() {
  // Bei knappem Limit nur jede dritte Runde.
  if (stopping || !githubApi.mayPoll('wartende Läufe', 3 * WAITING_INTERVAL_MS)) return Promise.resolve();
  return listRepos().then((repos) => waiting.scan(candidates(repos))).catch(() => {});
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
      usage, vmTight: vmFree(), // { free }, wenn die Docker-VM kaum noch Arbeitsspeicher frei hat, sonst null
      limits: config.limits, series: metrics.series(),
      limitsView: { values: limitRules.view(config.limits), bounds: limitRange(), plan: limitPlan(), needRuns: limitRules.SUGGEST_RUNS, tightAt: limitRules.TIGHT },
    },
    repos: [...repos.values()],
    quota: githubApi.quota(), // Anfragelimit des GitHub-Kontos: { limit, remaining, resetAt, state, tightAt } oder null
    minutes: minutes.view(minutesLogin()), // Minuten-Kontingent von GitHub Actions in diesem Monat: { plan, used, included | null, paid, cost, systems: { linux, windows, macos, other }, resetAt, state, tightAt } oder null (ohne das Recht `user`, oder noch nicht gelesen)
    unserved: waiting.list().filter((entry) => !settingsOf(entry.repo)), // Repos ohne Pool, in denen nichts vorankommt: [{ repo, reason: 'runner', jobs, since, url } | { repo, reason: 'minutes', runs, since, url }]
    auth: auth.view(), // Anmeldung bei GitHub: { state, login, scopes, missing, optional: [{ scope, purpose }], flow: { kind, state, code, url, error } | null }
    logStamp: logStamp(), // das Protokoll selbst holt die Oberfläche, wenn sich die Kennung ändert
    ui: uiChangedAt(), // die Seite lädt sich neu, wenn sich ihre Datei ändert
    ...hooks.status(),
  };
}

// --- Was die Oberfläche auslösen kann ---

// Einen Lauf oder Job eines Repos mit Pool bei GitHub erneut starten (`path` unter `actions/`) und danach, wenn GitHub
// den neuen Versuch angelegt hat, die Läufe des Repos neu abfragen.
async function rerun(repo, id, path, unknown) {
  if (!settingsOf(repo) || !/^\d+$/.test(String(id))) throw new Error(unknown);
  await gh(['api', '-X', 'POST', `repos/${repo}/actions/${path}`]);
  setTimeout(() => { if (!stopping) refreshRepo(repo); }, RERUN_SETTLE_MS);
}

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
    waiting.forget(info.full_name);
    log('Pool angelegt', info.full_name);
    startPool(info.full_name);
    refreshGitHub();
    // Die Jobs des Repos auf die eigenen Runner leiten, wenn seine Workflows die Variable lesen.
    routing.check(info.full_name).then(async (found) => {
      if (found.uses === 'variable' && !found.here) { await routing.set(info.full_name, true); log(`${VARIABLE} gesetzt – die Jobs laufen jetzt auf den eigenen Runnern`, info.full_name); }
      else if (found.uses === 'none') log(`Die Workflows lesen ${VARIABLE} nicht – die Jobs gehen weiter an GitHubs Runner`, info.full_name);
    }).catch(logError(info.full_name, VARIABLE));
  },
  async 'pool/set'({ repo, parallel, paused, cache }) {
    const settings = settingsOf(repo);
    const pool = pools.get(repo);
    if (!settings || !pool) throw new Error('Diesen Pool gibt es nicht.');
    if (parallel !== undefined) settings.parallel = Math.min(4, Math.max(1, Number(parallel) || 1));
    if (paused !== undefined) settings.paused = Boolean(paused);
    saveConfig();
    if (settings.paused) { pool.slots.forEach((slot) => abortIdle(slot)); discardReserve(pool).catch(logError(repo)); }
    reconcile(pool);
    if (cache !== undefined && Boolean(cache) !== settings.cache) {
      settings.cache = Boolean(cache);
      saveConfig();
      withPoolAtRest(pool, () => prepareCaches(repo)).catch(logError(repo));
    }
    log(`${settings.parallel} ${settings.parallel === 1 ? 'Platz' : 'Plätze'}, ${settings.paused ? 'pausiert' : 'aktiv'}, Cache ${settings.cache ? 'an' : 'aus'}`, repo);
  },
  async 'pool/remove'({ repo }) {
    const pool = pools.get(repo);
    if (!settingsOf(repo) || !pool) throw new Error('Diesen Pool gibt es nicht.');
    config.pools = config.pools.filter((settings) => settings.repo !== repo);
    saveConfig();
    pool.removed = true;
    log('Pool wird entfernt', repo);
    (async () => {
      await quiesce(pool);
      await docker(['rm', '-f', buildService(repo)]);
      await docker(['network', 'rm', buildNetwork(repo)]);
      await docker(['volume', 'rm', '-f', cacheVolume(repo), seedVolume(repo), buildVolume(repo)]);
      // Ohne Pool würden die Jobs ewig auf einen Runner warten: zurück zu GitHubs Runnern.
      // Der Stand wird frisch gelesen – die Variable kann inzwischen von Hand gesetzt worden sein.
      // Lässt er sich nicht lesen, bleibt die Variable, wie sie ist, und das steht im Protokoll.
      await (async () => {
        const found = await routing.check(repo);
        if (found.error) throw new Error(found.error);
        if (found.here) { await routing.set(repo, false); log(`${VARIABLE} entfernt – die Jobs gehen wieder an GitHubs Runner`, repo); }
      })().catch(logError(repo, `${VARIABLE} bleibt, wie es ist`));
      routing.forget(repo);
      await removeRegistrations(repo);
      delete state.learned[repo];
      delete state.rejected[repo];
      saveState();
      metrics.forget(repo);
      github.delete(repo);
      log('Pool und seine Caches sind entfernt', repo);
    })().catch(logError(repo))
      // Auch wenn ein Schritt scheitert, wird der Name wieder frei.
      .finally(() => { if (pools.get(repo) === pool) pools.delete(repo); });
  },
  // Leert, was zwischen den Jobs bleibt. Freie Paare werden dafür beendet, arbeitende laufen erst zu Ende.
  async 'pool/clear'({ repo, what }) {
    const pool = pools.get(repo);
    if (!settingsOf(repo) || !pool) throw new Error('Diesen Pool gibt es nicht.');
    if (!['packages', 'build', 'images', 'all'].includes(what)) throw new Error('Unbekannter Cache.');
    const all = what === 'all';
    log(`Leere ${{ packages: 'den Paket-Cache', build: 'die Build-Layer', images: 'die gelernten Abbilder', all: 'alle Caches' }[what]} …`, repo);
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
      log('Geleert; der nächste Lauf füllt wieder auf', repo);
    }).catch(logError(repo));
  },
  async 'pool/routing'({ repo, on }) {
    if (!settingsOf(repo)) throw new Error('Diesen Pool gibt es nicht.');
    await routing.set(repo, Boolean(on));
    log(`${VARIABLE} ${on ? 'gesetzt – die Jobs laufen auf den eigenen Runnern' : 'entfernt – die Jobs gehen an GitHubs Runner'}`, repo);
  },
  // Einen abgeschlossenen Lauf oder Job von Hand erneut starten; das löscht nichts. Bei GitHub erscheint er erst nach
  // einem Augenblick wieder als laufend, deshalb wird das Repo kurz danach neu abgefragt.
  async 'run/rerun'({ repo, id, failedOnly }) {
    await rerun(repo, id, `runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, 'Diesen Lauf gibt es nicht.');
    log(`Lauf ${id} erneut gestartet${failedOnly ? ' (nur die gescheiterten Jobs)' : ''}`, repo);
  },
  async 'job/rerun'({ repo, id }) {
    await rerun(repo, id, `jobs/${id}/rerun`, 'Diesen Job gibt es nicht.');
    log(`Job ${id} erneut gestartet`, repo);
  },
  // Speicher in GB, Kerne als Anzahl. Arbeitende und schon bereite Paare behalten ihre Limits bis zum nächsten Aufbau.
  // Mit `repo` gelten sie nur für dieses Projekt; `inherit` nimmt dessen eigene Werte wieder weg.
  async 'limits/set'({ repo, inherit, ...input }) {
    if (!linuxReady) throw new Error('Docker ist noch nicht bereit; die Grenzen der Docker-VM sind noch unbekannt.');
    const settings = repo ? settingsOf(repo) : null;
    if (repo && !settings) throw new Error('Diesen Pool gibt es nicht.');
    const text = (limits) => `Runner ${limits.runnerMemory} und ${limits.runnerCpus} Kerne, Docker ${limits.dockerMemory} und ${limits.dockerCpus} Kerne`;
    if (settings && inherit) { delete settings.limits; log(`Wieder die Limits für alle (${text(config.limits)})`, repo); }
    else if (settings) { settings.limits = limitRules.normalize(input, limitsOf(repo), limitRange()); log(`Eigene Limits – ${text(settings.limits)}`, repo); }
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
      log('Baue die freien Runner mit den neuen Limits auf', pool.repo);
      rebuildIdle(pool).catch(logError(pool.repo));
    }
  },
  // Anmelden und Ergänzen antworten, sobald der Einmalcode im Stand steht; bestätigt wird im Browser (siehe auth.js).
  // `scope` nennt ein freiwilliges Recht; ohne Angabe werden die fehlenden Pflichtrechte ergänzt.
  async 'auth/login'() { await auth.login(); },
  async 'auth/scope'({ scope }) { await auth.grant(scope === undefined ? undefined : String(scope)); },
  async 'auth/cancel'() { await auth.cancel(); },
  async 'auth/logout'() { await auth.logout(); },
  async shutdown() { setTimeout(shutdown, 100); },
};

// --- Start und Ende ---

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  log('Beende die Runner …');
  metrics.save();
  auth.cancel().catch(() => {}); // ein `gh`, das noch auf die Bestätigung im Browser wartet, endet mit
  await Promise.all([...pools.values()].flatMap((pool) => pool.slots.map((slot) => { slot.aborted = true; return teardown(slot); })));
  for (const settings of config.pools) { await docker(['rm', '-f', buildService(settings.repo)]); await docker(['network', 'rm', buildNetwork(settings.repo)]); }
  await removeLeftovers();
  log('Beendet.');
  hooks.onExit();
}
// Beim Abmelden von Windows bleibt für den Abbau keine Zeit (siehe main.js). Dann nur die freien Runner bei GitHub
// abmelden, alle zugleich, damit dort keine toten Einträge stehen bleiben; Container und Volumes räumt der nächste
// Start ab.
async function release() {
  if (stopping) return;
  stopping = true; // Beenden bleibt danach möglich: `shutdown` achtet nur auf sich selbst
  metrics.save();
  auth.cancel().catch(() => {}); // ein `gh`, das noch auf die Bestätigung im Browser wartet, bliebe sonst zurück
  const idle = [...pools.values()].flatMap((pool) => pool.slots.filter((slot) => slot.runnerId && !slot.job));
  await Promise.all(idle.map((slot) => gh(['api', '-X', 'DELETE', `repos/${slot.repo}/actions/runners/${slot.runnerId}`]).catch(() => {})));
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
  if (request.method === 'GET' && request.url === '/api/log') return json(200, { stamp: logStamp(), entries: journal.recent() });
  // Die ganze Datei zum Speichern oder Kopieren.
  if (request.method === 'GET' && request.url === '/api/log/file') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="runclub.log"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return response.end(journal.read());
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
}).listen(PORT, '127.0.0.1', () => {
  log(`Runner-Anzeige: http://localhost:${PORT}`);
  // Der Schlüssel steht nur in der Konsole und in einer Datei im Datenordner des Nutzers, nie im Protokoll,
  // das die Oberfläche zeigt.
  try { fs.writeFileSync(KEY_FILE, `${access.key}\n`); } catch { /* dann bleibt nur die Konsole */ }
  console.log(`Öffnen mit: ${access.entry}`);
});

watchAuth().then(watchMinutes); // das Kontingent braucht den Stand der Anmeldung
setInterval(watchAuth, MINUTE);
setInterval(watchMinutes, MINUTES_INTERVAL_MS);
watchQuota();
setInterval(watchQuota, MINUTE);
scanWaiting();
setInterval(scanWaiting, WAITING_INTERVAL_MS);
setInterval(() => refreshImage().catch(logError(null, 'Runner-Abbild')), IMAGE_INTERVAL_MS);
refreshGitHub();
setInterval(refreshGitHub, GITHUB_INTERVAL_MS);
setInterval(refreshActive, GITHUB_ACTIVE_INTERVAL_MS);
setInterval(measure, MEASURE_INTERVAL_MS);
setInterval(() => {
  for (const pool of pools.values()) { replenish(pool); renewService(pool).catch(logError(pool.repo)); }
}, MINUTE);
setInterval(() => { if (linuxReady) for (const pool of pools.values()) if (!pool.hold) measureSizes(pool); }, SIZES_INTERVAL_MS);

for (const settings of config.pools) { startPool(settings.repo); routing.check(settings.repo).catch(() => {}); }
linuxLoop();

module.exports = { PORT, DATA_DIR, ENTRY: access.entry, hooks, status, shutdown, release, log };
