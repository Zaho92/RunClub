// RunClub: manages self-hosted GitHub Actions runners on this machine.
// Runs in the app's main process (main.js, via `start`) or alone:  node src/backend.js  ->  http://127.0.0.1:8770
//
// Linux runners: one pool per repo in `runners.json`. For every job a fresh pair of runner container and
// its own Docker daemon is created; after the job it is removed along with its volumes. The machine's Docker socket
// and Windows folders are never passed in; the GitHub registration holds for one job.
//
// No container runs with `--privileged`: a job's Docker daemon and the build service run as ordinary
// users in their own namespaces (see dind.js and caches.js). Whoever breaks out of a job container lands in the
// daemon container of its pair, not in the Docker VM. The runner container itself is different: there the job's steps
// have root via `sudo`, with Docker's usual capabilities except a few no job needs (see slots.js);
// whoever breaks out of it is root in the Docker VM. None of this is a boundary against every attack (a kernel bug
// goes further): only code the user trusts should run on these runners – pools for public repos
// are not created, and if a repo with a pool turns public, its pool pauses.
//
// What stays between the jobs of a repo (all of it can be switched off and cleared in the interface):
//   Packages    volume, set in the runner as NuGet and npm folder. Jobs write to it.
//   Build layers one build service per repo, without privileges and reachable only via a socket (see caches.js);
//               plain `docker build` uses it (linux/docker-shim.sh). Jobs write to it. Whoever builds with their own
//               builder (publishing) doesn't use it.
//   Images      template for the Docker daemon. After each job this program remembers only the names of the
//               loaded images and pulls them itself from the registry – no job writes to it.
//
// When this program ends, the runners it started end too.
//
// This file only wires things up: it creates the modules (in the order in which they need each other), starts the
// timers and the local service and shuts everything down again (start and end in lifecycle.js). What the modules
// do is written in them.

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
const { createAuth, FILE: TOKEN_FILE } = require('./auth');
const { engineFrom, createEngine } = require('./engine');
const { createMetrics } = require('./metrics');
const { createPipelines } = require('./pipeline');
const { createRouting } = require('./routing');
const { createWaiting } = require('./waiting');
const { createUsage } = require('./usage');
const { createRemote, WAITING_INTERVAL } = require('./remote');
const { createRunners } = require('./runners');
const { createDockerWatch } = require('./dockerwatch');
const { createSetup } = require('./setup');
const { createAccount } = require('./account');
const { createStatus } = require('./status');
const { createActions } = require('./actions');
const { createServer, mergeActions } = require('./server');
const { createHousekeeping } = require('./housekeeping');
const { createLifecycle } = require('./lifecycle');
const { createShutdown } = require('./shutdown');

const GITHUB_TIMEOUT = MINUTE;
const DOCKER_TIMEOUT = 5 * MINUTE; // ordinary calls; whatever may take longer names its own limit
const DOCKER_LONG = 30 * MINUTE; // building, pulling, copying images
const SHUTDOWN_WAIT = 30 * SECOND; // shutdown waits this long for pairs being created
// The timers. Where a job is running on our own runners, GitHub is checked more often.
const EVERY = {
  github: 20 * SECOND, githubActive: 8 * SECOND, account: MINUTE, quota: MINUTE, waiting: WAITING_INTERVAL,
  image: DAY, measure: 2 * SECOND, reserve: MINUTE, sizes: 5 * MINUTE,
  housekeeping: 10 * MINUTE, // check the repos' visibility, remove orphaned runners
  setup: 15 * SECOND, // while Docker doesn't answer: what the machine lacks
};

//   port, dataDir           port of the local service and data folder (otherwise RUNCLUB_PORT and RUNCLUB_DATA)
//   hooks                   what the app contributes: `actions` (more calls), `status()` (more details for the
//                           interface), `onExit()` (after shutdown; if missing, the process ends), `secrets`
//                           ({ encrypt(buffer), decrypt(buffer) }: this way the sign-in token lies encrypted in the
//                           data folder; without them only in memory, see auth.js), `version` (for the identification at GitHub)
function start({
  port = Number(process.env.RUNCLUB_PORT) || DEFAULT_PORT,
  // Started alone, the data lives in the user's profile, apart from the app's: in the repo's folder
  // other users of the machine could read the key (access.key).
  dataDir = process.env.RUNCLUB_DATA || path.join(process.env.APPDATA || os.homedir(), 'RunClub', 'backend'),
  hooks = {},
} = {}) {
  const { actions: appActions = {}, status: appStatus = () => ({}), onExit = () => process.exit(0), secrets = null, version = '0' } = hooks;
  fs.mkdirSync(dataDir, { recursive: true });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- Log ---
  const journal = createJournal({ file: path.join(dataDir, 'runclub.log'), echo: (line) => console.log(line) });
  // `message`: a message (see messages.js) or a text from outside. `repo` names the project it belongs to;
  // `kind` see journal.js.
  const log = (message, repo, kind) => journal.add(message, { repo, kind });
  const logError = errorLog(log);
  // Start and end; what shutdown needs is only created further below.
  const progress = createShutdown({
    dataDir, wait: SHUTDOWN_WAIT, repos: () => [...runners.pools.keys()], remaining: (repo) => (runners.pools.has(repo) ? runners.remaining(runners.pools.get(repo)) : null),
  });
  const lifecycle = createLifecycle({
    log,
    // Save the metrics, don't leave behind a sign-in still waiting for confirmation in the browser.
    beforeStop: () => { metrics.save(); account.close(); },
    dismantle: () => runners.dismantle(SHUTDOWN_WAIT),
    removeLeftovers: (step) => dockerWatch.removeLeftovers(step),
    releaseIdle: () => runners.releaseIdle(),
    progress,
    onExit,
  });
  const isStopping = lifecycle.stopping;
  const { shutdown, release, every, everyAfter } = lifecycle;
  // Stamp of the state for the interface: it changes with every entry and every start, so that an open
  // window doesn't happen to see the same number after a restart and skip reloading.
  const started = Date.now();
  const logStamp = () => `${started}-${journal.count()}`;

  // --- Settings, names, access to GitHub and Docker ---
  const settings = createSettings({ dataDir, log });
  const names = createNames({ dataDir, port });
  const { dind: DIND, buildkit: BUILDKIT } = pinnedImages();
  // The GitHub sign-in; its token holds for all requests. After a successful sign-in, read the new account's request
  // limit, repos and minutes.
  const auth = createAuth({
    file: path.join(dataDir, TOKEN_FILE), secrets, version, log: (text) => log(text),
    onAccount: () => { remote.watchQuota(); remote.refreshAll(); account.changed(); },
  });
  const github = createGitHub({ token: auth.token, renew: auth.renew, timeout: GITHUB_TIMEOUT, version }); // conditional where possible, and with the state of the rate limit
  const engine = createEngine({ run, timeout: DOCKER_TIMEOUT, ...engineFrom() }); // where Docker runs
  const { docker, dockerList } = engine;

  // --- What is measured, learned and read at GitHub ---
  const metrics = createMetrics({ dataDir });
  const pipelines = createPipelines({ github, dataDir });
  const routing = createRouting({ github }); // where a repo's jobs go (repo variable CI_RUNNER)
  const waiting = createWaiting({ github }); // repos without a pool where nothing moves on
  let runners = null; // the pools; they need the GitHub queries, the queries need their pools
  let actionsApi = null; // the calls; they need almost everything, and a repo turned public (or one with fork PRs) needs them
  const remote = createRemote({
    github, pipelines, routing, waiting, log, logError,
    repos: settings.repos, settingsOf: settings.settingsOf, poolOf: (repo) => runners.pools.get(repo), stopping: isStopping,
    guard: {
      block: (repo, kind, reason) => actionsApi.guard.block(repo, kind, reason), unblock: (repo, kind) => actionsApi.guard.unblock(repo, kind),
      restUnchecked: (repo) => actionsApi.guard.restUnchecked(repo),
    },
    confirmResults: metrics.confirmResults,
  });
  let dockerWatch = null; // the Docker watch; it prepares the pools, the pools ask it whether Docker is ready
  const usage = createUsage({ docker, inVm: engine.inVm, metrics, pools: () => runners.pools.values(), log, stopping: isStopping });

  // --- The runners and the Docker watch ---
  runners = createRunners({
    docker, dockerList, github, log, sleep,
    host: os.hostname(), names, image: IMAGE, dind: DAEMON_IMAGE, buildkit: BUILDKIT, longTimeout: DOCKER_LONG,
    settings, metrics, stopping: isStopping, dockerReady: () => dockerWatch.ready(), vetted: remote.vetted,
    refreshRepo: remote.refreshRepo, forgetStats: usage.forget,
  });
  dockerWatch = createDockerWatch({
    docker, dockerList, github, log, sleep,
    host: os.hostname(), mark: names.mark, serviceMark: names.serviceMark,
    builds: [
      { image: IMAGE, dir: path.join(__dirname, '..', 'linux'), what: 'm_imageRunner' },
      { image: DAEMON_IMAGE, dir: path.join(__dirname, '..', 'linux', 'dind'), args: ['--build-arg', `BASE=${DIND}`], what: 'm_imageDaemon' },
    ],
    requiredImages: [BUILDKIT], longTimeout: DOCKER_LONG,
    unreachable: engine.unreachable, exposure: engine.exposure,
    livePairs: runners.slots.livePairs, repos: settings.repos, pools: () => runners.pools.values(), preparePool: runners.preparePool,
    stopping: isStopping, onReady: usage.onDockerReady, onAlive: usage.onDockerAlive,
  });
  const setup = createSetup({ run, docker, ready: dockerWatch.ready, desktop: engine.desktop, log }); // what the machine lacks for Docker

  // --- Account, interface, calls ---
  const account = createAccount({ auth, github, log, logError, stopping: isStopping });
  const uiFile = path.join(__dirname, 'ui.html');
  const { status, limitRange, limitPlan } = createStatus({
    settings, runners, remote, pipelines, metrics, usage, routing, waiting, account, github, dockerWatch, setup,
    buildService: names.buildService, logStamp, uiFile, shutdown: progress.view, extra: appStatus,
  });

  actionsApi = createActions({
    github, settings, runners, remote, routing, waiting, metrics, account, dockerWatch, setup, limitRange, limitPlan, log, logError, shutdown,
  });

  // --- Local service ---
  const actions = mergeActions(actionsApi.actions, appActions); // a name that already exists is an error
  const token = crypto.randomBytes(24).toString('hex'); // protects the changing calls from foreign web pages
  const access = createAccess({ port }); // protects page and data from everything that isn't our own window
  const server = createServer({
    access, token, uiFile, fontsDir: path.join(__dirname, 'fonts'),
    routes: { status, dayMinutes: metrics.dayMinutes, log: () => ({ stamp: logStamp(), entries: journal.recent() }), logFile: journal.read, repos: remote.listRepos },
    actions: () => actions,
  });
  server.listen(port, '127.0.0.1', () => {
    log(msg('m_listening', `http://127.0.0.1:${port}`));
    lifecycle.saveKey(path.join(dataDir, 'access.key'), access.key);
    console.log(`Open with: ${access.entry}`);
  });

  // --- Timers ---
  every(EVERY.account, account.watch);
  every(EVERY.setup, setup.check);
  every(EVERY.quota, remote.watchQuota);
  every(EVERY.waiting, remote.scanWaiting);
  everyAfter(EVERY.image, () => dockerWatch.refreshImage().catch(logError(null, msg('m_whatImages'))));
  every(EVERY.github, remote.refreshAll);
  everyAfter(EVERY.githubActive, remote.refreshActive);
  everyAfter(EVERY.measure, usage.measure);
  everyAfter(EVERY.reserve, runners.tick);
  everyAfter(EVERY.sizes, runners.measureAll);
  everyAfter(EVERY.housekeeping, createHousekeeping({
    pools: () => runners.pools.values(), mayPoll: github.mayPoll, gap: EVERY.housekeeping,
    watchVisibility: remote.watchVisibility, removeRegistrations: dockerWatch.removeRegistrations,
  }));

  lifecycle.startPools(settings.repos(), { startPool: runners.startPool, checkRouting: routing.check, watchVisibility: remote.watchVisibility });
  dockerWatch.watch();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);

  // `githubToken()`: the sign-in token, e.g. for the updater (main.js); null without a sign-in.
  return { port, entry: access.entry, status, shutdown, release, log, githubToken: auth.token };
}

if (require.main === module) start();

module.exports = { start };
