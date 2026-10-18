const test = require('node:test');
const assert = require('node:assert/strict');
const { createDockerWatch, MISSES, READY_PAUSE, WAIT_PAUSE, MISS_PAUSE } = require('../src/dockerwatch');
const { PROBE_TIMEOUT } = require('../src/dind');
const { createEngine } = require('../src/engine');
const { GitHubError } = require('../src/github');
const { rendered } = require('./support');

const MARK = 'runclub.runner=test';
const SERVICE_MARK = 'runclub.service=test';
const IMAGE = 'runner:test';

// A Docker call in short form.
const brief = (args) => args.join(' ');

// Docker, GitHub and the rest faked. `calls` holds the calls to Docker and GitHub in their
// order; `answer(name)` can give a Docker call a result (otherwise it succeeds without output).
// `sleep` remembers the duration and calls `onSleep`, with which a test steers or ends the loop.
// Our own images: the runner's and the Docker daemon's, built on the pinned image.
const BUILDS = [
  { image: IMAGE, dir: 'C:/rc/linux', what: 'm_imageRunner' },
  { image: 'dind:test', dir: 'C:/rc/linux/dind', args: ['--build-arg', 'BASE=docker:pin'], what: 'm_imageDaemon' },
];
const BUILT = ['build --pull -q -t runner:test C:/rc/linux', 'build --pull -q --build-arg BASE=docker:pin -t dind:test C:/rc/linux/dind'];

function world() {
  const w = {
    calls: [], logs: [], slept: [], prepared: [], ready: 0, alive: 0, stopping: false, answer: () => undefined, onSleep: () => {},
    runners: { runners: [] }, githubFails: null, livePairs: new Map(), repos: ['owner/App'], pools: [{ repo: 'owner/App', prepared: true }],
  };
  // Docker via engine.js, as in operation; only `run` is faked.
  const run = async (command, args, options = {}) => {
    w.calls.push(brief(args));
    return { code: 0, stdout: '', stderr: '', ...(await w.answer(brief(args), options)) };
  };
  const { docker, dockerList, unreachable } = createEngine({ run, timeout: 99 });
  w.watch = createDockerWatch({
    docker, dockerList,
    github: {
      get: async (url) => { w.calls.push(`get ${url}`); if (w.githubFails) throw w.githubFails; return w.runners; },
      send: async (method, url) => { w.calls.push(`send ${method} ${url}`); if (w.githubFails) throw w.githubFails; return null; },
    },
    log: (...entry) => w.logs.push(rendered(entry)),
    sleep: async (ms) => { w.slept.push(ms); await w.onSleep(ms); },
    host: 'PC', mark: MARK, serviceMark: SERVICE_MARK, builds: BUILDS, requiredImages: ['buildkit:test'], longTimeout: 1234,
    unreachable, exposure: async () => w.exposure ?? null,
    livePairs: w.livePairs, repos: () => w.repos, pools: () => w.pools,
    preparePool: async (pool) => { w.prepared.push(pool.repo); assert.equal(pool.prepared, false); },
    stopping: () => w.stopping,
    onReady: () => { w.ready += 1; }, onAlive: () => { w.alive += 1; },
  });
  return w;
}

// Runs the loop until `rounds` pauses have passed; `each(round)` runs before each pause.
async function loopFor(w, rounds, each = () => {}) {
  let round = 0;
  w.onSleep = () => { each(round); round += 1; if (round >= rounds) w.stopping = true; };
  await w.watch.watch();
}

const PREPARE = [
  'info --format {{.NCPU}} {{.MemTotal}}', ...BUILT, 'pull -q buildkit:test',
];
const LEFTOVERS = [
  `ps -aq --filter label=${MARK}`, `ps -aq --filter label=${SERVICE_MARK}`, `volume ls -q --filter label=${MARK}`,
  `network ls -q --filter label=${MARK}`, `network ls -q --filter label=${SERVICE_MARK}`, 'get repos/owner/App/actions/runners?per_page=100',
];
const ORPHANS = [`ps -a --filter label=${MARK} --format {{.Names}}`, `volume ls -q --filter label=${MARK}`, `network ls --filter label=${MARK} --format {{.Name}}`];

test('before the first answer Docker is not ready, with a limit of one core and no memory', () => {
  const w = world();
  assert.deepEqual([w.watch.ready(), w.watch.error(), w.watch.cpus(), w.watch.memory()], [false, null, 1, 0]);
});

test('when Docker answers, it is prepared: read limits, build image, pull images, clear leftovers of the previous run, prepare pools', async () => {
  const w = world();
  w.answer = (name, options) => {
    if (name.startsWith('info --format {{.NCPU}}')) { assert.equal(options.timeout, PROBE_TIMEOUT); return { stdout: '12 16000000000\n' }; }
    if (name.startsWith('build') || name.startsWith('pull')) assert.equal(options.timeout, 1234);
    return undefined;
  };
  await loopFor(w, 1);
  assert.deepEqual(w.calls, [...PREPARE, ...LEFTOVERS]);
  assert.deepEqual([w.watch.ready(), w.watch.error(), w.watch.cpus(), w.watch.memory()], [true, null, 12, 16000000000]);
  assert.deepEqual([w.ready, w.prepared], [1, ['owner/App']]);
  assert.deepEqual(w.slept, [READY_PAUSE]);
  assert.deepEqual(w.logs, [['Building the runner image (with GitHub’s latest runner) and the Docker daemon image …']]);
});

test('if Docker doesn\'t answer, the reason is logged once, and it keeps trying at intervals', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('info') ? { code: 1, stderr: 'error during connect' } : undefined);
  await loopFor(w, 3);
  assert.deepEqual(w.logs, [['Docker is not reachable – is Docker Desktop running?', null, 'error']]);
  assert.deepEqual(w.watch.error(), { key: 'm_dockerUnreachableDesktop', args: [] }); // the interface translates
  assert.deepEqual(w.slept, [WAIT_PAUSE, WAIT_PAUSE, WAIT_PAUSE]);
  assert.deepEqual([w.watch.ready(), w.ready, w.prepared], [false, 0, []]);
});

test('only after several missing answers in a row does Docker count as gone; then it is prepared again without clearing labelled pairs', async () => {
  const w = world();
  let down = 0; // this many of the next checks get no answer
  w.answer = (name) => {
    if (name !== 'info --format ok') return undefined;
    if (down > 0) { down -= 1; return { code: 1 }; }
    return undefined;
  };
  await loopFor(w, 1);
  assert.equal(w.watch.ready(), true);

  // One answer is missing, then Docker is back: nothing happens except a short pause.
  down = 1;
  w.stopping = false;
  await loopFor(w, 2);
  assert.deepEqual(w.slept.slice(-2), [MISS_PAUSE, READY_PAUSE]);
  assert.deepEqual([w.watch.ready(), w.logs.length, w.alive], [true, 1, 1]);

  // If MISSES answers in a row are missing, the slots wait, and Docker is prepared again.
  down = MISSES;
  w.stopping = false;
  w.calls.length = 0;
  w.pools[0].prepared = true;
  let readyDuring = [];
  await loopFor(w, MISSES + 1, () => readyDuring.push(w.watch.ready()));
  assert.deepEqual(readyDuring, [true, true, false, true]);
  assert.deepEqual(w.logs.at(-1), ['Building the runner image (with GitHub’s latest runner) and the Docker daemon image …']);
  assert.ok(w.logs.some((entry) => entry[0] === 'Docker no longer responds – the Linux runners are waiting.'));
  // This time only what belongs to no standing pair, and no removal at GitHub.
  assert.deepEqual(w.calls.slice(-(PREPARE.length + ORPHANS.length)), [...PREPARE, ...ORPHANS]);
  assert.equal(w.calls.some((name) => name.startsWith('get ') || name.startsWith('send ')), false);
  assert.deepEqual([w.ready, w.prepared], [2, ['owner/App', 'owner/App']]);
});

test('an answer in between resets the count of missing ones', async () => {
  const w = world();
  await loopFor(w, 1);
  // Twice no answer, once one, twice none again: never MISSES in a row.
  const pattern = [false, false, true, false, false, true];
  assert.ok(MISSES > 2);
  w.answer = (name) => (name === 'info --format ok' && pattern.shift() === false ? { code: 1 } : undefined);
  w.stopping = false;
  await loopFor(w, 6);
  assert.equal(w.watch.ready(), true);
  assert.equal(w.logs.some((entry) => entry[0].startsWith('Docker no longer responds')), false);
});

test('if the image can\'t be built, work goes on with the existing one; without one it doesn\'t', async () => {
  const w = world();
  let present = true;
  w.answer = (name) => {
    if (name.startsWith('build')) return { code: 1, stderr: 'ERROR: failed to solve: no network\n' };
    if (name.startsWith('image inspect')) return present ? undefined : { code: 1 };
    return undefined;
  };
  await w.watch.prepareDocker();
  assert.deepEqual(w.logs.filter(([, , kind]) => kind === 'error'), [
    ['The runner image could not be rebuilt (ERROR: failed to solve: no network); the runners use the existing one.', null, 'error'],
    ['The Docker daemon image could not be rebuilt (ERROR: failed to solve: no network); the runners use the existing one.', null, 'error'],
  ]);
  present = false;
  await assert.rejects(w.watch.prepareDocker(), /The runner image could not be built: ERROR: failed to solve: no network/);
});

test('the daily rebuild happens only when Docker is ready and RunClub isn\'t ending', async () => {
  const w = world();
  await w.watch.refreshImage();
  assert.deepEqual(w.calls, []);
  await loopFor(w, 1);
  w.calls.length = 0;
  w.stopping = false;
  await w.watch.refreshImage();
  assert.deepEqual(w.calls, BUILT);
  assert.deepEqual(w.logs.at(-1), ['Rebuilding the runner and Docker daemon images (daily refresh) …']);
  w.stopping = true;
  w.calls.length = 0;
  await w.watch.refreshImage();
  assert.deepEqual(w.calls, []);
});

test('leftovers of an earlier run: everything labelled including build services, networks with their members, free runners of this machine at GitHub', async () => {
  const w = world();
  w.repos = ['owner/App', 'owner/Two'];
  w.answer = (name) => ({
    [`ps -aq --filter label=${MARK}`]: { stdout: 'c1\nc2\n' },
    [`ps -aq --filter label=${SERVICE_MARK}`]: { stdout: 'b1\n' },
    [`volume ls -q --filter label=${MARK}`]: { stdout: 'v1\n' },
    [`network ls -q --filter label=${MARK}`]: { stdout: 'n1\n' },
    [`network ls -q --filter label=${SERVICE_MARK}`]: { stdout: 'n2\n' },
    'network inspect n1 --format {{range .Containers}}{{println .Name}}{{end}}': { stdout: 'rc-other\n' },
  })[name];
  w.runners = { runners: [
    { id: 1, name: 'PC-linux-a1', busy: false }, { id: 2, name: 'PC-linux-b2', busy: true }, { id: 3, name: 'OTHER-linux-c3', busy: false },
  ] };
  // On shutdown it reports how far it got (see shutdown.js).
  await w.watch.removeLeftovers((name, count) => w.calls.push(`step ${name}${count === undefined ? '' : ` ${count}`}`));
  assert.deepEqual(w.calls, [
    'step cleanup',
    `ps -aq --filter label=${MARK}`, `ps -aq --filter label=${SERVICE_MARK}`, 'rm -f -v c1 c2 b1', `volume ls -q --filter label=${MARK}`, 'volume rm -f v1',
    `network ls -q --filter label=${MARK}`, 'network inspect n1 --format {{range .Containers}}{{println .Name}}{{end}}', 'network disconnect -f n1 rc-other', 'network rm n1',
    `network ls -q --filter label=${SERVICE_MARK}`, 'network inspect n2 --format {{range .Containers}}{{println .Name}}{{end}}', 'network rm n2',
    'step signoff 2',
    'get repos/owner/App/actions/runners?per_page=100', 'send DELETE repos/owner/App/actions/runners/1', 'step signedOff',
    'get repos/owner/Two/actions/runners?per_page=100', 'send DELETE repos/owner/Two/actions/runners/1', 'step signedOff',
  ]);
});

test('in operation: only free runners without a connection that belong to no standing pair', async () => {
  const w = world();
  const RUNNERS = [
    { id: 1, name: 'PC-linux-a1', busy: false, status: 'offline' }, // pair ended mid-job: goes
    { id: 2, name: 'PC-linux-b2', busy: true, status: 'offline' }, // GitHub still lists it as busy
    { id: 3, name: 'PC-linux-c3', busy: false, status: 'online' }, // e.g. a second instance for trying things out
    { id: 4, name: 'PC-linux-d4', busy: false, status: 'offline' }, // just registered, the runner is still starting
    { id: 5, name: 'OTHER-linux-e5', busy: false, status: 'offline' },
  ];
  // Who stays is asked only after GitHub's answer: a slot may just have registered.
  let asked = false;
  w.runners = { ...w.runners, get runners() { assert.equal(asked, false); return RUNNERS; } };
  await w.watch.removeRegistrations('owner/App', { keep: () => { asked = true; return new Set(['PC-linux-d4']); }, offline: true });
  assert.equal(asked, true);
  assert.deepEqual(w.calls, ['get repos/owner/App/actions/runners?per_page=100', 'send DELETE repos/owner/App/actions/runners/1']);
  assert.deepEqual(w.logs, [['Orphaned runners removed from GitHub: 1', 'owner/App']]);
});

test('if removal at GitHub fails, it is logged with the project, and it carries on', async () => {
  const w = world();
  w.githubFails = new GitHubError(403, 'Must have admin rights');
  await w.watch.removeRegistrations('owner/App');
  assert.deepEqual(w.logs, [['Removing old runners – Must have admin rights (HTTP 403)', 'owner/App', 'error']]);
});

test('after an interruption only what belongs to no standing pair goes', async () => {
  const w = world();
  w.livePairs.set('rc-app-1', 'owner/App');
  w.answer = (name) => ({
    [`ps -a --filter label=${MARK} --format {{.Names}}`]: { stdout: 'rc-app-1-runner\nrc-app-1-dind\nrc-app-2-runner\n' },
    [`volume ls -q --filter label=${MARK}`]: { stdout: 'rc-app-1-work\nrc-app-2-work\nrc-app-2-docker\n' },
    [`network ls --filter label=${MARK} --format {{.Name}}`]: { stdout: 'rc-app-1\nrc-app-2\n' },
  })[name];
  await w.watch.removeOrphans();
  assert.deepEqual(w.calls, [
    `ps -a --filter label=${MARK} --format {{.Names}}`, 'rm -f -v rc-app-2-runner',
    `volume ls -q --filter label=${MARK}`, 'volume rm -f rc-app-2-work rc-app-2-docker',
    `network ls --filter label=${MARK} --format {{.Name}}`, 'network inspect rc-app-2 --format {{range .Containers}}{{println .Name}}{{end}}', 'network rm rc-app-2',
  ]);
  assert.deepEqual(w.logs, [['Removed leftovers after the interruption: containers: 1, volumes: 2']]);

  // If nothing is lying around, nothing is logged either.
  const quiet = world();
  await quiet.watch.removeOrphans();
  assert.deepEqual(quiet.logs, []);
});

test('if Docker exposes its daemon without protection, that is logged after preparation', async () => {
  const w = world();
  w.exposure = 'Daemon without protection';
  await loopFor(w, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(w.logs.filter(([text]) => text === 'Daemon without protection'), [['Daemon without protection', null, 'error']]);

  const safe = world();
  await loopFor(safe, 1);
  assert.equal(safe.logs.some(([, , kind]) => kind === 'error'), false);
});
