// RunClub: Verwaltung der eigenen GitHub-Actions-Runner auf diesem Rechner.
// Läuft im Hauptprozess der App (main.js, über `start`) oder allein:  node src/backend.js  ->  http://127.0.0.1:8770
//
// Linux-Runner: je Repo ein Pool in `runners.json`. Für jeden Job entsteht ein frisches Paar aus
// Runner-Container und eigenem Docker-Daemon; nach dem Job wird es samt Volumes entfernt. Der Docker-Socket
// des Rechners und Windows-Ordner werden nie hineingereicht, die Anmeldung bei GitHub gilt für einen Job.
//
// Kein Container läuft mit `--privileged`: Der Docker-Daemon eines Jobs und der Build-Dienst laufen als gewöhnliche
// Benutzer in eigenen Namensräumen (siehe dind.js und caches.js). Wer aus einem Job-Container ausbricht, landet im
// Daemon-Container seines Paars, nicht in der Docker-VM. Anders der Runner-Container selbst: Dort haben die Schritte
// des Jobs per `sudo` root, mit Dockers üblichen Capabilities bis auf einige, die kein Job braucht (siehe slots.js);
// wer aus ihm ausbricht, ist root in der Docker-VM. Eine Grenze gegen jeden Angriff ist das alles nicht (ein Fehler im
// Kernel reicht weiter): Auf diesen Runnern soll nur Code laufen, dem der Nutzer vertraut – Pools für öffentliche Repos
// werden nicht angelegt, und wird ein Repo mit Pool öffentlich, pausiert sein Pool.
//
// Was zwischen den Jobs eines Repos bleibt (alles abschaltbar und in der Oberfläche zu leeren):
//   Pakete      Volume, im Runner als NuGet- und npm-Ordner gesetzt. Jobs schreiben hinein.
//   Build-Layer ein Build-Dienst je Repo, ohne Rechte und nur über einen Socket erreichbar (siehe caches.js);
//               einfaches `docker build` nutzt ihn (linux/docker-shim.sh). Jobs schreiben hinein. Wer mit eigenem
//               Builder baut (Veröffentlichen), nutzt ihn nicht.
//   Abbilder    Vorlage für den Docker-Daemon. Dieses Programm merkt sich nach jedem Job nur die Namen der
//               geladenen Abbilder und holt sie selbst von der Registry – kein Job schreibt hinein.
//
// Endet dieses Programm, enden auch die Runner, die es gestartet hat.
//
// Diese Datei verdrahtet nur: Sie legt die Module an (in der Reihenfolge, in der sie einander brauchen), startet die
// Takte und den lokalen Dienst und beendet alles wieder (Ablauf von Start und Ende in lifecycle.js). Was die Module
// tun, steht in ihnen.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./run');
const { SECOND, MINUTE, DAY } = require('./units');
const { createAccess } = require('./access');
const { createJournal, errorLog } = require('./journal');
const { msg } = require('./messages');
const { createSettings } = require('./settings');
const { createNames, pinnedImages, DEFAULT_PORT, IMAGE } = require('./names');
const { DAEMON_IMAGE } = require('./dind');
const { createGitHub } = require('./github');
const { engineFrom, createEngine } = require('./engine');
const { createMetrics } = require('./metrics');
const { createPipelines } = require('./pipeline');
const { createRouting } = require('./routing');
const { createWaiting } = require('./waiting');
const { createUsage } = require('./usage');
const { createRemote, WAITING_INTERVAL } = require('./remote');
const { createRunners } = require('./runners');
const { createDockerWatch } = require('./dockerwatch');
const { createAccount } = require('./account');
const { createStatus } = require('./status');
const { createActions } = require('./actions');
const { createServer, mergeActions } = require('./server');
const { createHousekeeping } = require('./housekeeping');
const { createLifecycle } = require('./lifecycle');
const { createShutdown } = require('./shutdown');

const GH_TIMEOUT = MINUTE;
const DOCKER_TIMEOUT = 5 * MINUTE; // gewöhnliche Aufrufe; was länger dauern darf, nennt seine Grenze selbst
const DOCKER_LONG = 30 * MINUTE; // Abbilder bauen, laden, kopieren
const SHUTDOWN_WAIT = 30 * SECOND; // so lange wartet das Beenden auf Paare, die gerade entstehen
// Die Takte. Wo gerade ein Job auf den eigenen Runnern läuft, wird öfter bei GitHub nachgesehen.
const EVERY = {
  github: 20 * SECOND, githubActive: 8 * SECOND, account: MINUTE, quota: MINUTE, waiting: WAITING_INTERVAL,
  image: DAY, measure: 2 * SECOND, reserve: MINUTE, sizes: 5 * MINUTE,
  housekeeping: 10 * MINUTE, // Sichtbarkeit der Repos prüfen, verwaiste Runner abmelden
};

//   port, dataDir           Port des lokalen Dienstes und Datenordner (sonst RUNCLUB_PORT und RUNCLUB_DATA)
//   hooks                   was die App beisteuert: `actions` (weitere Aufrufe), `status()` (weitere Angaben für die
//                           Oberfläche), `onExit()` (nach dem Beenden; ohne Angabe endet der Prozess)
function start({
  port = Number(process.env.RUNCLUB_PORT) || DEFAULT_PORT,
  // Allein gestartet liegen die Daten im Profil des Nutzers, getrennt von denen der App: Im Ordner des Repos könnten
  // andere Benutzer des Rechners den Schlüssel lesen (access.key).
  dataDir = process.env.RUNCLUB_DATA || path.join(process.env.APPDATA || os.homedir(), 'RunClub', 'backend'),
  hooks = {},
} = {}) {
  const { actions: appActions = {}, status: appStatus = () => ({}), onExit = () => process.exit(0) } = hooks;
  fs.mkdirSync(dataDir, { recursive: true });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- Protokoll ---
  const journal = createJournal({ file: path.join(dataDir, 'runclub.log'), echo: (line) => console.log(line) });
  // `message`: eine Meldung (siehe messages.js) oder ein Text von außen. `repo` nennt das Projekt, zu dem sie gehört;
  // `kind` siehe journal.js.
  const log = (message, repo, kind) => journal.add(message, { repo, kind });
  const logError = errorLog(log);
  // Start und Ende; was das Beenden braucht, entsteht erst weiter unten.
  const progress = createShutdown({
    dataDir, wait: SHUTDOWN_WAIT, repos: () => [...runners.pools.keys()], remaining: (repo) => (runners.pools.has(repo) ? runners.remaining(runners.pools.get(repo)) : null),
  });
  const lifecycle = createLifecycle({
    log,
    // Die Messung sichern, ein `gh`, das noch auf die Bestätigung im Browser wartet, nicht zurücklassen.
    beforeStop: () => { metrics.save(); account.close(); },
    dismantle: () => runners.dismantle(SHUTDOWN_WAIT),
    removeLeftovers: (step) => dockerWatch.removeLeftovers(step),
    releaseIdle: () => runners.releaseIdle(),
    progress,
    onExit,
  });
  const isStopping = lifecycle.stopping;
  const { shutdown, release, every, everyAfter } = lifecycle;
  // Kennung des Stands für die Oberfläche: Sie ändert sich mit jedem Eintrag und mit jedem Start, damit ein offenes
  // Fenster nach einem Neustart nicht zufällig dieselbe Zahl sieht und das Nachladen auslässt.
  const started = Date.now();
  const logStamp = () => `${started}-${journal.count()}`;

  // --- Einstellungen, Namen, Zugang zu GitHub und Docker ---
  const settings = createSettings({ dataDir, log });
  const names = createNames({ dataDir, port });
  const { dind: DIND, buildkit: BUILDKIT } = pinnedImages();
  const githubApi = createGitHub({ run, timeout: GH_TIMEOUT }); // bedingt, wo es geht, und mit dem Stand des Anfragelimits
  const gh = githubApi.call;
  const engine = createEngine({ run, timeout: DOCKER_TIMEOUT, ...engineFrom() }); // wo Docker läuft
  const { docker, dockerList } = engine;

  // --- Was gemessen, gelernt und bei GitHub gelesen wird ---
  const metrics = createMetrics({ dataDir });
  const pipelines = createPipelines({ gh, dataDir });
  const routing = createRouting({ gh }); // wohin die Jobs eines Repos gehen (Repo-Variable CI_RUNNER)
  const waiting = createWaiting({ gh }); // Repos ohne Pool, in denen nichts vorankommt
  let runners = null; // die Pools; sie brauchen die Abfragen bei GitHub, die Abfragen ihre Pools
  let actionsApi = null; // die Aufrufe; sie brauchen fast alles, und ein öffentlich gewordenes Repo (oder eins mit Fork-PRs) braucht sie
  const remote = createRemote({
    gh, githubApi, pipelines, routing, waiting, log, logError,
    repos: settings.repos, settingsOf: settings.settingsOf, poolOf: (repo) => runners.pools.get(repo), stopping: isStopping,
    guard: {
      block: (repo, kind, reason) => actionsApi.guard.block(repo, kind, reason), unblock: (repo, kind) => actionsApi.guard.unblock(repo, kind),
      restUnchecked: (repo) => actionsApi.guard.restUnchecked(repo),
    },
    confirmResults: metrics.confirmResults,
  });
  let dockerWatch = null; // die Docker-Überwachung; sie bereitet die Pools vor, die Pools fragen sie, ob Docker bereit ist
  const usage = createUsage({ docker, inVm: engine.inVm, metrics, pools: () => runners.pools.values(), log, stopping: isStopping });

  // --- Die Runner und die Docker-Überwachung ---
  runners = createRunners({
    docker, dockerList, gh, log, sleep,
    host: os.hostname(), names, image: IMAGE, dind: DAEMON_IMAGE, buildkit: BUILDKIT, longTimeout: DOCKER_LONG,
    settings, metrics, stopping: isStopping, dockerReady: () => dockerWatch.ready(), vetted: remote.vetted,
    refreshRepo: remote.refreshRepo, forgetStats: usage.forget,
  });
  dockerWatch = createDockerWatch({
    docker, dockerList, gh, log, sleep,
    host: os.hostname(), mark: names.mark, serviceMark: names.serviceMark,
    builds: [
      { image: IMAGE, dir: path.join(__dirname, '..', 'linux'), what: 'm_imageRunner' },
      { image: DAEMON_IMAGE, dir: path.join(__dirname, '..', 'linux', 'dind'), args: ['--build-arg', `BASE=${DIND}`], what: 'm_imageDaemon' },
    ],
    requiredImages: [BUILDKIT], longTimeout: DOCKER_LONG,
    unreachable: engine.unreachable, exposure: engine.exposure, buildService: names.buildService, buildNetwork: names.buildNetwork,
    livePairs: runners.slots.livePairs, repos: settings.repos, pools: () => runners.pools.values(), preparePool: runners.preparePool,
    stopping: isStopping, onReady: usage.onDockerReady, onAlive: usage.onDockerAlive,
  });

  // --- Konto, Oberfläche, Aufrufe ---
  const account = createAccount({
    run, timeout: GH_TIMEOUT, gh, githubApi, log, logError, stopping: isStopping,
    onAccount: () => { remote.watchQuota(); remote.refreshAll(); },
  });
  const uiFile = path.join(__dirname, 'ui.html');
  const { status, limitRange, limitPlan } = createStatus({
    settings, runners, remote, pipelines, metrics, usage, routing, waiting, account, githubApi, dockerWatch,
    buildService: names.buildService, logStamp, uiFile, shutdown: progress.view, extra: appStatus,
  });

  actionsApi = createActions({
    gh, settings, runners, remote, routing, waiting, metrics, account, dockerWatch, limitRange, limitPlan, log, logError, shutdown,
  });

  // --- Lokaler Dienst ---
  const actions = mergeActions(actionsApi.actions, appActions); // ein Name, den es schon gibt, ist ein Fehler
  const token = crypto.randomBytes(24).toString('hex'); // schützt die ändernden Aufrufe vor fremden Webseiten
  const access = createAccess({ port }); // schützt Seite und Daten vor allem, was nicht das eigene Fenster ist
  const server = createServer({
    access, token, uiFile, fontsDir: path.join(__dirname, 'fonts'),
    routes: { status, dayMinutes: metrics.dayMinutes, log: () => ({ stamp: logStamp(), entries: journal.recent() }), logFile: journal.read, repos: remote.listRepos },
    actions: () => actions,
  });
  server.listen(port, '127.0.0.1', () => {
    log(msg('m_listening', `http://127.0.0.1:${port}`));
    lifecycle.saveKey(path.join(dataDir, 'access.key'), access.key);
    console.log(`Öffnen mit: ${access.entry}`);
  });

  // --- Takte ---
  every(EVERY.account, account.watch);
  every(EVERY.quota, remote.watchQuota);
  every(EVERY.waiting, remote.scanWaiting);
  everyAfter(EVERY.image, () => dockerWatch.refreshImage().catch(logError(null, msg('m_whatImages'))));
  every(EVERY.github, remote.refreshAll);
  everyAfter(EVERY.githubActive, remote.refreshActive);
  everyAfter(EVERY.measure, usage.measure);
  everyAfter(EVERY.reserve, runners.tick);
  everyAfter(EVERY.sizes, runners.measureAll);
  everyAfter(EVERY.housekeeping, createHousekeeping({
    pools: () => runners.pools.values(), mayPoll: githubApi.mayPoll, gap: EVERY.housekeeping,
    watchVisibility: remote.watchVisibility, removeRegistrations: dockerWatch.removeRegistrations,
  }));

  lifecycle.startPools(settings.repos(), { startPool: runners.startPool, checkRouting: routing.check, watchVisibility: remote.watchVisibility });
  dockerWatch.watch();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);

  return { port, entry: access.entry, status, shutdown, release, log };
}

if (require.main === module) start();

module.exports = { start };
