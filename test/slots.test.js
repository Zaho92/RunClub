const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlots, noteWorkflows, pairNames, idleRegistrations, REFRESH_AGAIN, JOB_NAME_MAX, RESULT_MAX, RUNNER_MAX, RUNNER_LOG_MAX, ROUND_PAUSE, IDLE_PAUSE, BROKEN_PAUSE } = require('../src/slots');
const { READY_TRIES, DAEMON_POLL, SECURITY_FLAGS } = require('../src/dind');
const { SECOND, HOUR } = require('../src/units');

const PAUSE_STEPS = BROKEN_PAUSE / SECOND; // the pause after an error, in one-second steps
const { turn, until, rendered } = require('./support');
const { render } = require('../src/messages');
const { GitHubError } = require('../src/github');

const REPO = 'owner/App';
const BASE = 'rc-app-a1b2c3'; // `rc-<repo>-<id>`
const RUNNER = 'PC-linux-a1b2c3';
const MARK = 'runclub.runner=test';
const TOOLS = { image: 'sha256:runner', volume: 'rc-tools-runner' }; // what externals.js prepares
const LIMITS = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };

// A Docker call in short form: for `run` only the container's name, for the network without the random subnet.
function brief(args) {
  if (args[0] === 'run') return `run ${args[args.indexOf('--name') + 1]}`;
  if (args[0] === 'network' && args[1] === 'create') return `network create ${args.at(-1)}`;
  if (args[0] === 'exec') return `exec ${args[1]} ${args.includes('info') ? 'info' : args.slice(2).join(' ')}`;
  return args.join(' ');
}

// Docker, GitHub and the rest, simulated. `calls` holds the calls to Docker and GitHub in their
// order, `answer(name, args, options)` can give a Docker call a result (otherwise it succeeds).
// Time passes without waiting: `sleep` only yields once to everything else and notes the duration.
function world() {
  const w = {
    calls: [], details: [], logs: [], slept: [], timers: [], refreshed: [], recorded: [], forgotten: [], learned: [], replenished: [], released: [], discarded: 0, metered: 0,
    limits: LIMITS, newId: () => 'a1b2c3', stopping: false, ready: true, resting: false, settings: { repo: REPO, parallel: 1, cache: true, paused: false },
    answer: () => undefined, onSleep: () => {}, jit: { runner: { id: 77 }, encoded_jit_config: 'secret' },
  };
  const docker = async (args, options = {}) => {
    const name = brief(args);
    w.calls.push(name);
    w.details.push({ name, args, options });
    return { code: 0, stdout: '', stderr: '', ...(await w.answer(name, args, options)) };
  };
  const github = {
    send: async (method, url, body) => {
      w.calls.push(`send ${method} ${url}`);
      if (body) w.body = body;
      if (w.githubFails) throw w.githubFails;
      return url.endsWith('/generate-jitconfig') ? w.jit : null;
    },
  };
  w.slots = createSlots({
    docker, github,
    log: (...entry) => w.logs.push(rendered(entry)),
    sleep: async (ms) => { w.slept.push(ms); w.onSleep(ms); await turn(); },
    timer: (work, ms) => w.timers.push({ work, ms }),
    newId: () => w.newId(),
    host: 'PC', mark: MARK, dind: 'dind:test', externals: { prepare: async () => TOOLS, release: (volume) => w.released.push(volume) }, longTimeout: 1234,
    metrics: { meter: () => ({ finish: () => { w.metered += 1; return { peakMemory: 5 }; } }), recordJob: (repo, record) => w.recorded.push([repo, record]) },
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => w.limits,
    seedVolume: () => 'rc-seed-app', cacheVolume: () => 'rc-cache-app', buildSocket: () => 'rc-buildsock-app',
    stopping: () => w.stopping, dockerReady: () => w.ready, poolResting: () => w.resting,
    withSeed: (repo, exclusive, work) => { assert.equal(exclusive, false); return work(); },
    learnImages: async (pool, slot) => { w.learned.push(slot.job); w.onLearn?.(pool, slot); },
    replenish: (pool) => w.replenished.push(pool.repo),
    discardReserve: async () => { w.discarded += 1; },
    refreshRepo: (repo) => w.refreshed.push(repo),
    forgetStats: (name) => w.forgotten.push(name),
  });
  w.pool = { repo: REPO, slots: [], reserve: [], seeded: new Set(), removed: false };
  w.slot = { repo: REPO, state: 'starting', jobs: 0 }; // as `reconcile` in pools.js creates a slot
  w.pool.slots.push(w.slot);
  return w;
}

const isRunner = (name) => name === `run ${BASE}-runner`;
const PROVISION = [
  `network create ${BASE}`,
  `volume create --label ${MARK} ${BASE}-work`, `volume create --label ${MARK} ${BASE}-sock`, `volume create --label ${MARK} ${BASE}-docker`,
  `run ${BASE}-seed`, // set the volumes' permissions, copy the template
];
const REMOVE = [
  `rm -f -v ${BASE}-runner ${BASE}-dind ${BASE}-seed`,
  `volume rm -f ${BASE}-work ${BASE}-sock ${BASE}-docker`,
  `network rm ${BASE}`,
];
const ALIVE = (base) => `inspect --format {{.State.Running}} ${base}-runner`; // is the runner still running after the call ended?
const REGISTER = `send POST repos/${REPO}/actions/runners/generate-jitconfig`;
const UNREGISTER = `send DELETE repos/${REPO}/actions/runners/77`;

test('a job from start to end: build, registration, runner, teardown', async () => {
  const w = world();
  w.pool.seeded = new Set(['node:22']);
  const states = [];
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    states.push(w.slot.state);
    for (const line of ['√ Connected to GitHub', '2026-10-13 12:00:00Z: Listening for Jobs', '2026-10-13 12:00:05Z: Running job: Build', '2026-10-13 12:00:09Z: Job Build completed with result: Succeeded']) {
      onLine(line);
      states.push(w.slot.state);
    }
    assert.equal(w.slot.outcome?.result, 'Succeeded'); // it is only reported when the runner ends
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; }; // after this job the slot ends

  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.calls, [
    ...PROVISION,
    `run ${BASE}-dind`,
    `exec ${BASE}-dind info`,
    REGISTER,
    `run ${BASE}-runner`,
    ALIVE(BASE), // output is read until the runner really ends
    ...REMOVE, // without unregistering: the registration was for this one job
  ]);
  assert.deepEqual(states, ['starting', 'starting', 'ready', 'working', 'working']);
  assert.deepEqual(w.body, { name: RUNNER, runner_group_id: 1, labels: ['self-hosted', 'Linux', 'X64'], work_folder: '_work' });

  const call = (name) => w.details.find((detail) => detail.name === name);
  assert.deepEqual(call(`run ${BASE}-seed`).args, ['run', '--rm', '--label', MARK, '--name', `${BASE}-seed`, '-v', 'rc-seed-app:/seed:ro',
    '-v', `${BASE}-work:/w`, '-v', `${BASE}-sock:/s`, '-v', `${BASE}-docker:/d`, '--user', '0', '--entrypoint', 'sh', TOOLS.image, '-c', 'chown 1001:1001 /w /s /d && cp -a --preserve=xattr /seed/. /d/']);
  // GNU cp from the runner image, not busybox from the daemon image: it keeps the template's xattrs and hard links (#6).
  assert.deepEqual(call(`run ${BASE}-seed`).options, { timeout: 1234 });
  // The daemon runs without privileges (see dind.js).
  assert.deepEqual(call(`run ${BASE}-dind`).args, ['run', '-d', '--label', MARK, '--name', `${BASE}-dind`,
    '--device', '/dev/net/tun', ...SECURITY_FLAGS,
    '--network', BASE, '--cpus', '4', '--memory', '8g', '--pids-limit', '8192',
    '-v', `${BASE}-work:/home/runner/_work`, '-v', `${BASE}-sock:/sock`, '-v', `${BASE}-docker:/home/rootless/.local/share/docker`,
    '-v', 'rc-tools-runner:/home/runner/externals:ro', // the runner mounts it into job containers (see externals.js)
    'dind:test', 'dockerd', '--host=unix:///sock/docker.sock']);
  const runner = call(`run ${BASE}-runner`);
  assert.deepEqual(runner.args.slice(0, -1), ['run', '--rm', '-i', '--label', MARK, '--name', `${BASE}-runner`, '--network', `container:${BASE}-dind`,
    '--cpus', '6', '--memory', '4g', '--pids-limit', '8192',
    '--cap-drop', 'NET_RAW', '--cap-drop', 'MKNOD', '--cap-drop', 'SETFCAP',
    '--cap-drop', 'SETPCAP', '--cap-drop', 'SYS_CHROOT', '--cap-drop', 'NET_BIND_SERVICE', '--log-opt', `max-size=${RUNNER_LOG_MAX}`, '--log-opt', 'max-file=2',
    '-v', `${BASE}-work:/home/runner/_work`, '-v', `${BASE}-sock:/sock`,
    '-v', 'rc-cache-app:/opt/rc-cache', '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm',
    '-v', 'rc-buildsock-app:/run/rc-buildkit:ro', '--group-add', '1000', '-e', 'RC_BUILDER=rc',
    'sha256:runner', 'bash', '-c']); // the image whose tools the daemon carries
  // The registration reaches the runner through the environment, not through the command line.
  assert.match(runner.args.at(-1), /read -r ACTIONS_RUNNER_INPUT_JITCONFIG; export ACTIONS_RUNNER_INPUT_JITCONFIG; exec \.\/run\.sh$/);
  assert.match(runner.args.at(-1), /--driver remote --driver-opt default-load=true unix:\/\/\/run\/rc-buildkit\/buildkitd\.sock /);
  assert.equal(runner.options.timeout, RUNNER_MAX);
  assert.equal(runner.options.input, 'secret\n'); // the registration is neither in the command line nor in the container's settings
  assert.equal(runner.options.env, undefined);

  assert.deepEqual(w.logs, [
    [`Job “Build” is running on ${RUNNER}`, REPO, 'run'],
    ['Job “Build” – done', REPO, 'done'],
  ]);
  assert.equal(w.recorded.length, 1);
  const [repo, record] = w.recorded[0];
  assert.equal(repo, REPO);
  assert.equal(typeof record.duration, 'number');
  assert.deepEqual({ ...record, duration: 0 }, { job: 'Build', workflow: '', runner: RUNNER, result: 'Succeeded', duration: 0, peakMemory: 5 });
  assert.deepEqual(w.refreshed, [REPO, REPO]); // at the start and at the end …
  assert.deepEqual(w.timers.map((timer) => timer.ms), [REFRESH_AGAIN]); // … and once more shortly after the start
  w.timers[0].work();
  assert.deepEqual(w.refreshed, [REPO, REPO, REPO]);

  assert.deepEqual(w.learned, ['Build']);
  assert.deepEqual(w.replenished, [REPO]);
  assert.deepEqual(w.forgotten, [`${BASE}-runner`, `${BASE}-dind`]);
  assert.deepEqual(w.released, [TOOLS.volume]); // the daemon holds the tools volume now (see externals.js)
  assert.equal(w.slots.livePairs.size, 0);
  assert.deepEqual(w.slept, []);
  assert.deepEqual({ state: w.slot.state, base: w.slot.base, runnerId: w.slot.runnerId, jobs: w.slot.jobs, lastResult: w.slot.lastResult, meter: w.slot.meter, error: w.slot.error },
    { state: 'off', base: null, runnerId: null, jobs: 1, lastResult: { job: 'Build', result: 'Succeeded' }, meter: null, error: null });
  assert.deepEqual(w.pool.slots, []); // the ended slot leaves the pool
});

test('during the job the slot has its pair, name and registration; teardown happens in the state “cleaning up”', async () => {
  const w = world();
  let during = null;
  let removing = null;
  w.answer = (name, args, { onLine }) => {
    if (name === REMOVE[0]) removing = w.slot.state;
    if (!isRunner(name)) return undefined;
    onLine('Running job: Tests');
    during = { ...w.slot, live: [...w.slots.livePairs] };
    onLine('Job Tests completed with result: Failed');
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual({ state: during.state, base: during.base, name: during.name, runnerId: during.runnerId, job: during.job, built: during.built, building: during.building },
    { state: 'working', base: BASE, name: RUNNER, runnerId: 77, job: 'Tests', built: `6/${4 * 1024 ** 3}/4/${8 * 1024 ** 3}`, building: false });
  assert.deepEqual(during.live, [[BASE, REPO]]);
  assert.equal(removing, 'cleaning');
  assert.deepEqual(w.logs.at(-1), ['Job “Tests” – failed', REPO, 'fail']);
  const prepare = w.details.find((detail) => detail.name === `run ${BASE}-seed`).args;
  assert.equal(prepare.at(-1), 'chown 1001:1001 /w /s /d'); // without a template nothing is copied, only the permissions are set
  assert.equal(prepare.includes('rc-seed-app:/seed:ro'), false);
});

test('a pair from the reserve is taken over, with the limits it was built with', async () => {
  const w = world();
  const pair = { id: 'ffffff', base: 'rc-app-ffffff', image: 'sha256:older', copied: new Set(['node:22']), extras: ['-e', 'X=1'], limits: { ...LIMITS, runnerCpus: 2, runnerMemory: '2g' } };
  w.pool.reserve.push({ promise: Promise.resolve(pair) });
  w.answer = (name, args, { onLine }) => { if (name === 'run rc-app-ffffff-runner') onLine('Running job: Build'); };
  await w.slots.serveOneJob(w.pool, w.slot);

  assert.deepEqual(w.calls, [REGISTER, 'run rc-app-ffffff-runner', ALIVE('rc-app-ffffff')]);
  const { args } = w.details[0];
  assert.deepEqual(args.slice(args.indexOf('--cpus'), args.indexOf('--cpus') + 4), ['--cpus', '2', '--memory', '2g']);
  assert.ok(args.join(' ').includes('-e X=1 sha256:older')); // the image it was built for, even if the name meanwhile carries a newer one
  assert.deepEqual(w.pool.reserve, []);
  assert.deepEqual(w.replenished, [REPO]);
  assert.equal(w.slot.name, 'PC-linux-ffffff');
  assert.equal(w.slot.copied, pair.copied);
});

test('with cache the pair gets the build service socket read-only, without cache none of it', async () => {
  const off = world();
  off.settings.cache = false;
  assert.deepEqual((await off.slots.provision(off.pool, () => false)).extras, []);
  assert.deepEqual(off.calls, [...PROVISION, `run ${BASE}-dind`, `exec ${BASE}-dind info`]);

  const on = world();
  const pair = await on.slots.provision(on.pool, () => false);
  assert.deepEqual(pair.extras, ['-v', 'rc-cache-app:/opt/rc-cache', '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm',
    '-v', 'rc-buildsock-app:/run/rc-buildkit:ro', '--group-add', '1000', '-e', 'RC_BUILDER=rc']);
  assert.deepEqual(on.calls, [...PROVISION, `run ${BASE}-dind`, `exec ${BASE}-dind info`]); // no network is shared
  assert.deepEqual({ id: pair.id, base: pair.base, limits: pair.limits }, { id: 'a1b2c3', base: BASE, limits: LIMITS });
  assert.deepEqual([...on.slots.livePairs], [[BASE, REPO]]);
});

test('if the runner ends without a job, the slot is broken: error to the log, teardown with unregistering, then a pause', async () => {
  const w = world();
  w.answer = (name) => (isRunner(name) ? { code: 1, stderr: 'docker: Error response from daemon: Conflict.\nRun \'docker run --help\' for more information\n' } : undefined);
  let paused = null;
  w.onSleep = () => { paused = { state: w.slot.state, error: w.slot.error, base: w.slot.base }; w.stopping = true; };

  await w.slots.slotLoop(w.pool, w.slot);

  const message = 'Runner ended without a job (docker: Error response from daemon: Conflict.)';
  assert.deepEqual(w.logs, [[message, REPO, 'error']]);
  assert.deepEqual({ ...paused, error: render(paused.error) }, { state: 'broken', error: message, base: null }); // the error stays a message
  assert.deepEqual(w.calls.slice(-6), [`run ${BASE}-runner`, ALIVE(BASE), ...REMOVE, UNREGISTER]); // no job: the registration is withdrawn
  assert.deepEqual(w.slept, [IDLE_PAUSE]);
  assert.deepEqual(w.learned, []);
  assert.deepEqual(w.recorded, []);
  assert.equal(w.slot.state, 'off');
  assert.equal(w.slot.jobs, 0);
});

test('without error output the message names the code; after the pause the slot tries again', async () => {
  const w = world();
  let runs = 0;
  w.answer = (name) => { if (!isRunner(name)) return undefined; runs += 1; return { code: 137 }; };
  w.onSleep = () => { if (runs === 2) w.stopping = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.logs.map(([text]) => text), ['Runner ended without a job (code 137)', 'Runner ended without a job (code 137)']);
  assert.equal(w.slept.length, PAUSE_STEPS + 1); // a minute's pause in one-second steps, then the second attempt
  assert.equal(w.calls.filter((name) => name === UNREGISTER).length, 2);
});

const BUILD = [...PROVISION, `run ${BASE}-dind`, `exec ${BASE}-dind info`];

test('if GitHub reports that the runner already exists, the pair is not kept: the same name would not help', async () => {
  // Recognised by the status (409, 422).
  for (const error of [new GitHubError(409, 'Already exists - A runner with the name already exists.'), new GitHubError(422, 'Validation Failed')]) {
    const w = world();
    w.githubFails = error;
    w.onSleep = () => { if (w.slept.length === 1) w.slot.retired = true; };
    await w.slots.slotLoop(w.pool, w.slot);

    assert.equal(w.slot.kept ?? null, null);
    assert.deepEqual(w.calls, [...BUILD, REGISTER, ...REMOVE]); // torn down right after the error, not only after the pause
    assert.equal(w.slept.length, 1);
    assert.equal(w.slots.livePairs.size, 0);
  }
});

test('if registration at GitHub fails, the pair stays; after the pause the same pair is registered again', async () => {
  const w = world();
  w.githubFails = new GitHubError(403, 'Forbidden');
  let paused = null;
  w.onSleep = () => {
    if (w.slept.length === 1) paused = { state: w.slot.state, error: w.slot.error, base: w.slot.base, live: [...w.slots.livePairs] };
    if (w.slept.length === PAUSE_STEPS) w.githubFails = null;
  };
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    onLine('Running job: Build');
    onLine('Job Build completed with result: Succeeded');
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.calls, [...BUILD, REGISTER, REGISTER, `run ${BASE}-runner`, ALIVE(BASE), ...REMOVE]); // one build, two registrations
  assert.deepEqual(paused, { state: 'broken', error: 'Forbidden (HTTP 403)', base: BASE, live: [[BASE, REPO]] });
  assert.deepEqual(w.logs[0], ['Forbidden (HTTP 403)', REPO, 'error']);
  assert.equal(w.slept.length, PAUSE_STEPS);
  assert.deepEqual(w.replenished, [REPO]); // the reserve does not give a second pair
  assert.equal(w.slot.jobs, 1);
  assert.equal(w.slots.livePairs.size, 0);
});

test('a pair without registration is torn down when the slot ends, and nothing is unregistered', async () => {
  const w = world();
  w.githubFails = new GitHubError(403, 'Forbidden');
  w.onSleep = () => { w.stopping = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.logs, [['Forbidden (HTTP 403)', REPO, 'error']]);
  assert.deepEqual(w.calls, [...BUILD, REGISTER, ...REMOVE]);
  assert.equal(w.slot.error, 'Forbidden (HTTP 403)');
  assert.deepEqual(w.slept, [IDLE_PAUSE]);
  assert.equal(w.slot.state, 'off');
  assert.equal(w.slots.livePairs.size, 0);
});

test('a pair without registration is torn down when the pool rests or the limits have changed', async () => {
  const rest = world();
  rest.githubFails = new GitHubError(403, 'Forbidden');
  let resting = null;
  rest.onSleep = () => {
    if (rest.slept.length === 1) { rest.resting = true; rest.settings.paused = true; }
    if (rest.slept.length === 2) { resting = { state: rest.slot.state, base: rest.slot.base }; rest.stopping = true; }
  };
  await rest.slots.slotLoop(rest.pool, rest.slot);
  assert.deepEqual(rest.calls, [...BUILD, REGISTER, ...REMOVE]);
  assert.deepEqual(resting, { state: 'paused', base: null });

  const changed = world();
  changed.githubFails = new GitHubError(403, 'Forbidden');
  changed.onSleep = () => {
    if (changed.slept.length === 1) changed.limits = { ...LIMITS, dockerMemory: '6g' };
    if (changed.slept.length === PAUSE_STEPS + 1) changed.stopping = true;
  };
  await changed.slots.slotLoop(changed.pool, changed.slot);
  // After the pause a new pair with the current limits is built instead of registering the old one again.
  assert.deepEqual(changed.calls, [...BUILD, REGISTER, ...REMOVE, ...BUILD, REGISTER, ...REMOVE]);
  assert.deepEqual(changed.details.filter((detail) => detail.name === `run ${BASE}-dind`).map((detail) => detail.args[detail.args.indexOf('--memory') + 1]), ['8g', '6g']);
});

test('if the runner ends mid-job without a result, that goes in the log and the measurement is discarded', async () => {
  const w = world();
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    onLine('Running job: Build');
    return { code: 137 }; // without "completed with result"
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.logs, [
    [`Job “Build” is running on ${RUNNER}`, REPO, 'run'],
    ['Job “Build” ended without a result (code 137)', REPO, 'error'],
  ]);
  assert.deepEqual(w.recorded, []); // duration and result are wrong: no usage
  assert.equal(w.slot.meter, null);
  assert.deepEqual(w.slot.lastResult, { job: 'Build', result: null });
  assert.equal(w.slot.jobs, 1);
  assert.deepEqual(w.learned, ['Build']);
  assert.deepEqual(w.calls.slice(-5), [`run ${BASE}-runner`, ALIVE(BASE), ...REMOVE]); // the registration is used up
  assert.deepEqual(w.slept, []);
});

test('an abort during the pause after an error ends it at once, and the slot starts over', async () => {
  const w = world();
  let runs = 0;
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    runs += 1;
    if (runs === 1) return { code: 137 };
    onLine('Running job: Build');
    onLine('Job Build completed with result: Succeeded');
    return { code: 0 };
  };
  w.onSleep = () => { if (w.slept.length === 3) w.slots.abortIdle(w.slot); };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.equal(w.slept.length, 3); // not the whole minute
  assert.equal(runs, 2);
  assert.deepEqual(w.logs.map(([text]) => text), ['Runner ended without a job (code 137)', `Job “Build” is running on ${RUNNER}`, 'Job “Build” – done']);
});

test('an abort during the pause after a failed registration tears down the kept pair', async () => {
  const w = world();
  w.githubFails = new GitHubError(403, 'Forbidden');
  let abort = null;
  w.onSleep = () => {
    if (w.slept.length !== 3) return;
    w.slot.retired = true; // like `reconcile` when a slot goes away
    abort = w.slots.abortIdle(w.slot);
  };
  await w.slots.slotLoop(w.pool, w.slot);
  await abort;

  assert.deepEqual(w.calls, [...BUILD, REGISTER, `rm -f ${BASE}-runner`, ...REMOVE]);
  assert.ok(w.slept.length <= 4); // three seconds of pause, at most one of the abort
  assert.equal(w.slot.aborted, true);
  assert.equal(w.slot.state, 'off');
  assert.equal(w.slots.livePairs.size, 0);
});

test('an abort while idle removes the runner and unregisters it at GitHub', async () => {
  const w = world();
  let end = null;
  w.answer = (name, args, { onLine }) => {
    if (name === `rm -f ${BASE}-runner`) end({ code: 137 });
    if (!isRunner(name)) return undefined;
    onLine('Listening for Jobs');
    return new Promise((resolve) => { end = resolve; }); // the runner is waiting for a job
  };
  const loop = w.slots.slotLoop(w.pool, w.slot);
  await until(() => w.slot.state === 'ready');
  assert.equal(w.slot.runnerId, 77);

  w.slot.retired = true; // like `reconcile` when a slot goes away
  await w.slots.abortIdle(w.slot);
  await loop;

  assert.deepEqual(w.calls.slice(-5), [`rm -f ${BASE}-runner`, ...REMOVE, UNREGISTER]); // after an abort output is no longer followed
  assert.deepEqual(w.slept, [IDLE_PAUSE]);
  assert.deepEqual(w.logs, []); // an abort is not an error
  assert.deepEqual(w.learned, []);
  assert.equal(w.slot.aborted, true);
  assert.equal(w.slot.state, 'off');
  assert.equal(w.slots.livePairs.size, 0);
});

test('a working or cleaning slot is not aborted', async () => {
  const w = world();
  let end = null;
  let emit = null;
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    emit = onLine;
    onLine('Running job: Build');
    return new Promise((resolve) => { end = resolve; });
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  const loop = w.slots.slotLoop(w.pool, w.slot);
  await until(() => w.slot.state === 'working');
  const before = w.calls.length;

  await w.slots.abortIdle(w.slot);
  assert.equal(w.calls.length, before);
  assert.equal(w.slot.aborted, false);

  emit('Job Build completed with result: Canceled');
  end({ code: 0 });
  await loop;
  assert.deepEqual(w.calls.slice(before), [ALIVE(BASE), ...REMOVE]); // after a job nothing is unregistered any more
  assert.deepEqual(w.logs.at(-1), ['Job “Build” – cancelled', REPO, 'cancel']);
  assert.deepEqual(w.learned, ['Build']);

  const cleaning = { repo: REPO, state: 'cleaning', base: BASE, aborted: false };
  await w.slots.abortIdle(cleaning);
  assert.equal(cleaning.aborted, false);
  assert.equal(w.calls.length, before + 1 + REMOVE.length);
});

test('if the runner accepts a job during the abort after all, it runs to the end and is learned', async () => {
  const w = world();
  let end = null;
  let emit = null;
  w.answer = (name, args, { onLine }) => {
    if (name === `rm -f ${BASE}-runner`) emit('Running job: Build'); // too late: the job is already running
    if (!isRunner(name)) return undefined;
    emit = onLine;
    onLine('Listening for Jobs');
    return new Promise((resolve) => { end = resolve; });
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  const loop = w.slots.slotLoop(w.pool, w.slot);
  await until(() => w.slot.state === 'ready');

  await w.slots.abortIdle(w.slot);
  assert.equal(w.slot.state, 'working');
  assert.equal(w.slot.aborted, false);

  emit('Job Build completed with result: Succeeded');
  end({ code: 0 });
  await loop;
  assert.deepEqual(w.learned, ['Build']);
  assert.ok(!w.calls.includes(UNREGISTER));
});

test('abort during the build: the half pair is removed, nothing is registered', async () => {
  const w = world();
  w.answer = (name) => (name === `exec ${BASE}-dind info` ? { code: 1 } : undefined); // the daemon is not ready yet
  let building = null;
  w.onSleep = () => { building = w.slot.building; w.slot.aborted = true; };
  await w.slots.serveOneJob(w.pool, w.slot);

  assert.deepEqual(w.calls, [...PROVISION, `run ${BASE}-dind`, `exec ${BASE}-dind info`, ...REMOVE]);
  assert.equal(building, true);
  assert.equal(w.slot.building, false);
  assert.equal(w.slot.base, undefined);
  assert.equal(w.slots.livePairs.size, 0);
});

test('if the pair cannot be built, nothing of it remains', async () => {
  const net = world();
  net.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: permission denied\n' } : undefined);
  await assert.rejects(net.slots.provision(net.pool, () => false), { message: 'Could not create the network: Error response from daemon: permission denied' });
  assert.deepEqual(net.calls, [`network create ${BASE}`, ...REMOVE]);
  assert.equal(net.slots.livePairs.size, 0);

  const start = world();
  start.answer = (name) => (name === `run ${BASE}-dind` ? { code: 125, stderr: 'no space left on device' } : undefined);
  await assert.rejects(start.slots.provision(start.pool, () => false), { message: 'Docker daemon does not start: no space left on device' });
  assert.deepEqual(start.calls.slice(-REMOVE.length), REMOVE);

  const prepare = world();
  prepare.pool.seeded = new Set(['node:22']);
  prepare.answer = (name) => (name === `run ${BASE}-seed` ? { code: 1, stderr: 'cp: write error: No space left on device\n' } : undefined);
  await assert.rejects(prepare.slots.provision(prepare.pool, () => false), { message: 'Could not prepare the volumes: cp: write error: No space left on device' });
  assert.equal(prepare.calls.includes(`run ${BASE}-dind`), false);
  assert.deepEqual(prepare.calls.slice(-REMOVE.length), REMOVE);
  assert.equal(prepare.slots.livePairs.size, 0);

  const slow = world();
  slow.answer = (name) => (name === `exec ${BASE}-dind info` ? { code: 1 } : undefined);
  await assert.rejects(slow.slots.provision(slow.pool, () => false), { message: 'Docker daemon did not become ready' });
  assert.equal(slow.slept.length, READY_TRIES);
  assert.ok(slow.slept.every((ms) => ms === DAEMON_POLL));
  assert.deepEqual(slow.calls.slice(-REMOVE.length), REMOVE);
});

test('if the pool rests or Docker is missing, the slot waits and the reserve is torn down', async () => {
  const w = world();
  w.ready = false;
  const states = [];
  w.onSleep = () => {
    states.push(w.slot.state);
    if (states.length === 1) { w.ready = true; w.resting = true; w.settings.paused = true; }
    if (states.length === 2) w.settings.paused = false;
    if (states.length === 3) w.pool.removed = true;
  };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(states, ['noDocker', 'paused', 'waiting']);
  assert.equal(w.discarded, 3);
  assert.deepEqual(w.slept, [IDLE_PAUSE, IDLE_PAUSE, IDLE_PAUSE]);
  assert.deepEqual(w.calls, []);
  assert.equal(w.slot.state, 'off');
});

test('teardown: without a pair nothing happens; without a job it unregisters, after a job not', async () => {
  const w = world();
  await w.slots.teardown({ repo: REPO, base: null, runnerId: 5 });
  assert.deepEqual(w.calls, []);

  const idle = { repo: REPO, base: BASE, runnerId: 77, job: null };
  await w.slots.teardown(idle);
  assert.deepEqual(w.calls, [...REMOVE, UNREGISTER]);
  assert.deepEqual(idle, { repo: REPO, base: null, runnerId: null, job: null, kept: null }); // a kept pair is gone with it too

  w.calls.length = 0;
  await w.slots.teardown({ repo: REPO, base: BASE, runnerId: 77, job: 'Build' });
  assert.deepEqual(w.calls, REMOVE);

  w.calls.length = 0;
  w.githubFails = new GitHubError(404, 'Not Found'); // already gone: no error
  await w.slots.teardown({ repo: REPO, base: BASE, runnerId: 77, job: null });
  assert.deepEqual(w.calls, [...REMOVE, UNREGISTER]);
  assert.deepEqual(w.logs, []);

  // Everything else stays at GitHub and belongs in the log.
  w.githubFails = new Error('The GitHub rate limit is used up; continuing at 17:05.');
  await w.slots.teardown({ repo: REPO, base: BASE, runnerId: 77, job: null });
  assert.deepEqual(w.logs, [['Could not remove the runner from GitHub – The GitHub rate limit is used up; continuing at 17:05.', REPO, 'error']]);
});

test('if the connection to `docker run` breaks while the runner keeps running, output is followed instead of tearing down', async () => {
  const w = world();
  let alive = true;
  w.answer = (name, args, { onLine }) => {
    if (isRunner(name)) { onLine('Listening for Jobs'); onLine('Running job: Build'); return { code: -1, stderr: 'error during connect' }; }
    if (name === ALIVE(BASE)) return { stdout: alive ? 'true\n' : 'false\n' };
    if (name === `logs -f ${BASE}-runner`) {
      // The logs start from the beginning: what was already read has no effect a second time.
      for (const line of ['Listening for Jobs', 'Running job: Build', 'Job Build completed with result: Succeeded']) onLine(line);
      alive = false;
      return { code: 0 };
    }
    return undefined;
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.calls.slice(-7), [`run ${BASE}-runner`, ALIVE(BASE), `logs -f ${BASE}-runner`, ALIVE(BASE), ...REMOVE]);
  const reattach = w.details.find((call) => call.name === `logs -f ${BASE}-runner`).options.timeout;
  assert.ok(reattach > 0 && reattach <= RUNNER_MAX); // the same deadline as for the runner, not a new one
  assert.deepEqual(w.logs.map(([text]) => text), [
    `Job “Build” is running on ${RUNNER}`,
    `Lost the connection to ${RUNNER}; still following its output`,
    'Job “Build” – done',
  ]);
  assert.equal(w.recorded.length, 1);
  assert.equal(w.slot.jobs, 1);
  assert.deepEqual(w.learned, ['Build']);
});

test('if something throws during teardown, it goes in the log and the slot carries on', async () => {
  const w = world();
  let rounds = 0;
  // A slot whose reserve throws on the first discard.
  const discard = async () => { rounds += 1; if (rounds === 1) throw new Error('Docker does not respond'); w.stopping = true; };
  const { createSlots } = require('../src/slots');
  const slots = createSlots({
    docker: async () => ({ code: 0, stdout: '', stderr: '' }), github: { send: async () => null },
    log: (...entry) => w.logs.push(rendered(entry)), sleep: async (ms) => { w.slept.push(ms); await turn(); },
    host: 'PC', mark: MARK, dind: 'dind:test', externals: { prepare: async () => TOOLS, release: () => {} }, longTimeout: 1234, metrics: {},
    settingsOf: () => w.settings, limitsOf: () => LIMITS, seedVolume: () => 'rc-seed-app', cacheVolume: () => 'rc-cache-app', buildSocket: () => 'rc-buildsock-app',
    stopping: () => w.stopping, dockerReady: () => true, poolResting: () => true,
    withSeed: (repo, exclusive, work) => work(), learnImages: async () => {}, replenish: () => {}, discardReserve: discard,
    refreshRepo: () => {}, forgetStats: () => {},
  });
  await slots.slotLoop(w.pool, w.slot);
  assert.deepEqual(w.logs, [['Slot – Docker does not respond', REPO, 'error']]);
  assert.deepEqual(w.slept, [ROUND_PAUSE, IDLE_PAUSE]); // first the pause after the error, then the usual round
  assert.equal(w.slot.state, 'off');
  assert.deepEqual(w.pool.slots, []);
});

test('a slot is only wanted while the program runs, the pool exists and the slot is not retiring', () => {
  const w = world();
  assert.equal(w.slots.slotWanted(w.pool, w.slot), true);
  assert.equal(w.slots.slotWanted(w.pool, { retired: true }), false);
  assert.equal(w.slots.slotWanted({ removed: true }, w.slot), false);
  w.stopping = true;
  assert.equal(w.slots.slotWanted(w.pool, w.slot), false);
});

test('noteWorkflows: a working slot remembers its job\'s workflow; without one the old one stays', () => {
  const pool = { slots: [{ name: 'PC-linux-1', state: 'working', workflow: '' }, { name: 'PC-linux-2', state: 'working', workflow: 'CI' }, { name: 'PC-linux-3', state: 'ready' }] };
  noteWorkflows(pool, [{ runner: 'PC-linux-1', workflow: 'Release' }, { runner: 'PC-linux-3', workflow: 'CI' }, { runner: 'PC-linux-2', workflow: '' }]);
  assert.deepEqual(pool.slots.map((slot) => slot.workflow), ['Release', 'CI', undefined]);
  noteWorkflows(undefined, []); // a repo without a pool
});

test('idleRegistrations: only slots with a registration and without a job', () => {
  const pools = [
    { slots: [{ repo: 'owner/a', runnerId: 1, job: null }, { repo: 'owner/a', runnerId: 2, job: 'Build' }, { repo: 'owner/a', runnerId: null }] },
    { slots: [{ repo: 'owner/b', runnerId: 3 }] },
  ];
  assert.deepEqual(idleRegistrations(pools), [{ repo: 'owner/a', runnerId: 1 }, { repo: 'owner/b', runnerId: 3 }]);
});

test('pairNames: the runners of the slots whose pair is standing', () => {
  assert.deepEqual([...pairNames({ slots: [{ name: 'PC-linux-1', base: 'rc-app-1' }, { name: 'PC-linux-2', base: null }, { name: 'PC-linux-3', base: 'rc-app-3' }] })], ['PC-linux-1', 'PC-linux-3']);
});

test('a faked end does not count: the last result before the runner ends applies, under the name from the start', async () => {
  const w = world();
  let during = null;
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    onLine('Running job: Build');
    onLine('Job Other completed with result: Succeeded'); // written from a step of the job
    during = { logs: w.logs.length, recorded: w.recorded.length, state: w.slot.state };
    onLine('Job Build completed with result: Failed'); // the real end
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(during, { logs: 1, recorded: 0, state: 'working' }); // nothing reported, the slot keeps working
  assert.deepEqual(w.recorded.map(([repo, record]) => [repo, record.job, record.result]), [[REPO, 'Build', 'Failed']]);
  assert.equal(w.metered, 1);
  assert.deepEqual(w.logs.at(-1), ['Job “Build” – failed', REPO, 'fail']);
  assert.deepEqual(w.slot.lastResult, { job: 'Build', result: 'Failed' });
  assert.equal(w.slot.jobs, 1);
});

test('job name and result from the runner\'s output are truncated; an end before the start does not count', async () => {
  const w = world();
  const long = 'x'.repeat(JOB_NAME_MAX * 5);
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    onLine('Job Build completed with result: Succeeded'); // before a job starts: not credible
    assert.equal(w.slot.outcome, null);
    onLine(`Running job: ${long}`);
    onLine(`Job ${long} completed with result: ${'S'.repeat(RESULT_MAX * 5)}`);
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.equal(w.recorded[0][1].job.length, JOB_NAME_MAX);
  assert.equal(w.recorded[0][1].result.length, RESULT_MAX);
  assert.deepEqual([w.slot.lastResult.job.length, w.slot.lastResult.result.length], [JOB_NAME_MAX, RESULT_MAX]);
  assert.equal(w.logs[0][0], `Job “${'x'.repeat(JOB_NAME_MAX)}” is running on ${w.slot.name}`);
});

test('if a runner runs past the deadline, it is removed and the job counts without a result', async () => {
  const w = world();
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    onLine('Running job: Build');
    onLine('Job Build completed with result: Succeeded'); // after that a step keeps the runner alive
    return { code: -1, stderr: 'no response', timedOut: true };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.calls.slice(-4), [`rm -f ${BASE}-runner`, ...REMOVE]); // without following the output again
  assert.deepEqual(w.recorded, []);
  assert.deepEqual(w.logs.at(-1), [`Job “Build” ended without a result (stopped after ${RUNNER_MAX / HOUR} h)`, REPO, 'error']);
});
