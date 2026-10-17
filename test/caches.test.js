const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaches } = require('../src/caches');
const { SECURITY_FLAGS } = require('../src/dind');
const { MINUTE } = require('../src/units');
const { createEngine } = require('../src/engine');
const { rendered } = require('./support');

const REPO = 'owner/App';
const OLD = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };
const NEW = { ...OLD, dockerMemory: '6g' };
const KEY_OLD = `4/${8 * 1073741824}`;
const KEY_NEW = `4/${6 * 1073741824}`;

// A Docker call in short form: for `run` only the container name; the tools for the volumes have none and are named
// after what they prepare. For the network without the random subnet, for `inspect` without the format.
function brief(args) {
  if (args[0] === 'run') return args.includes('--name') ? `run ${args[args.indexOf('--name') + 1]}` : args.at(-1).includes('/c/nuget') ? 'run cache' : args.at(-1).includes('du -sm') ? 'run du' : 'run volumes';
  if (args[0] === 'network' && args[1] === 'create') return `network create ${args.at(-1)}`;
  if (args[0] === 'inspect') return `inspect ${args.includes('{{.State.Running}}') ? 'running ' : ''}${args.at(-1)}`;
  return args.join(' ');
}

// Docker and the rest faked. `calls` holds the calls to Docker in their order,
// `answer(name, args)` can give a call a result (otherwise it succeeds).
function world() {
  const w = {
    calls: [], details: [], logs: [], stopping: false, ready: true, limits: OLD, answer: () => undefined,
    settings: { repo: REPO, parallel: 2, cache: true, paused: false },
    pool: { repo: REPO, slots: [], reserve: [], hold: false, prepared: true, removed: false }, // like `startPool`, already prepared
  };
  // Docker through engine.js, as in operation; only `run` is faked.
  const run = async (command, args) => {
    const name = brief(args);
    w.calls.push(name);
    w.details.push({ name, args });
    // A build service that has just started is running unless the test says otherwise.
    return { code: 0, stdout: name.startsWith('inspect running') ? 'true' : '', stderr: '', ...(await w.answer(name, args)) };
  };
  const { docker, dockerList } = createEngine({ run, timeout: 99 });
  w.caches = createCaches({
    docker, dockerList, sleep: async () => {},
    log: (...entry) => w.logs.push(rendered(entry)),
    dind: 'dind:test', buildkit: 'buildkit:test', serviceMark: 'runclub.service=test',
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => w.limits,
    poolOf: (repo) => (repo === REPO ? w.pool : undefined),
    cacheVolume: () => 'rc-cache-app', seedVolume: () => 'rc-seed-app', buildVolume: () => 'rc-build-app', buildSocket: () => 'rc-buildsock-app',
    buildService: () => 'rc-buildkit-app', buildNetwork: () => 'rc-buildnet-app',
    stopping: () => w.stopping, dockerReady: () => w.ready,
  });
  return w;
}

const READY = ['volume create rc-cache-app', 'run cache', 'volume create rc-build-app', 'volume create rc-buildsock-app', 'network create rc-buildnet-app', 'inspect rc-buildkit-app'];
const SERVICE = ['rm -f rc-buildkit-app', 'run volumes', 'run rc-buildkit-app', 'inspect running rc-buildkit-app'];
const PREPARE = [...READY, ...SERVICE];
// This is how `docker inspect` reports a running build service with these limits.
const running = (key) => (name) => (name === 'inspect rc-buildkit-app' ? { stdout: `true ${key}\n` } : undefined);

test('preparing creates the package cache, network and unprivileged build service with the limits of the Docker daemon', async () => {
  const w = world();
  const before = Date.now();
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, PREPARE);
  const args = (name) => w.details.find((call) => call.name === name).args;
  assert.deepEqual(args('run cache'),
    ['run', '--rm', '-v', 'rc-cache-app:/c', '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c', 'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
  assert.deepEqual(args('network create rc-buildnet-app').slice(-3), ['--label', 'runclub.service=test', 'rc-buildnet-app']);
  // Build layers of the earlier privileged service belong to root: they are cleared, then both volumes belong to the service.
  assert.deepEqual(args('run volumes'), ['run', '--rm', '-v', 'rc-build-app:/b', '-v', 'rc-buildsock-app:/s', '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c',
    '[ "$(stat -c %u /b)" = 1000 ] || find /b -mindepth 1 -delete; chown 1000:1000 /b /s']);
  assert.deepEqual(args('run rc-buildkit-app', 'inspect running rc-buildkit-app'),
    ['run', '-d', '--name', 'rc-buildkit-app', '--label', 'runclub.service=test', '--label', `runclub.limits=${KEY_OLD}`,
      '--restart', 'no', '--network', 'rc-buildnet-app', '--cpus', '4', '--memory', '8g', '--pids-limit', '8192',
      ...SECURITY_FLAGS,
      '-v', 'rc-build-app:/home/user/.local/share/buildkit', '-v', 'rc-buildsock-app:/run/rc-buildkit',
      'buildkit:test', '--addr', 'unix:///run/rc-buildkit/buildkitd.sock']); // with a sandbox for the build steps
  assert.equal(args('run rc-buildkit-app', 'inspect running rc-buildkit-app').includes('--privileged'), false);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.equal(w.pool.serviceFailed, false);
  assert.equal(w.pool.serviceFailures, 0);
  assert.ok(w.pool.serviceRetryAt >= before + MINUTE);
  assert.deepEqual(w.logs, []);
});

test('a build service already running with the current limits stays: a running build would break off otherwise', async () => {
  const w = world();
  w.answer = running(KEY_OLD);
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, READY);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);

  // With other limits or stopped it is created anew.
  for (const answer of [running(KEY_NEW), (name) => (name === 'inspect rc-buildkit-app' ? { stdout: `false ${KEY_OLD}\n` } : undefined)]) {
    const other = world();
    other.answer = answer;
    await other.caches.prepareCaches(REPO);
    assert.deepEqual(other.calls, PREPARE);
  }
});

test('without a cache the build service and network go away, and nothing is created', async () => {
  const w = world();
  w.settings.cache = false;
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, ['rm -f rc-buildkit-app', 'network rm rc-buildnet-app']);
  assert.equal(w.pool.serviceBuilt, undefined);
});

test('a network that already exists is no error', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: network with name rc-buildnet-app already exists' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.ok(w.calls.includes('run rc-buildkit-app', 'inspect running rc-buildkit-app'));
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.deepEqual(w.logs, []);
});

test('if the network cannot be created, the build service does not start, and it is in the log', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: broken' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.calls.includes('run rc-buildkit-app', 'inspect running rc-buildkit-app'), false);
  assert.equal(w.pool.serviceFailed, true);
  assert.equal(w.pool.serviceBuilt, null);
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0][0], /^Could not create the network for the build service – /);
  assert.deepEqual(w.logs[0].slice(1), [REPO, 'error']);
});

test('if the build service ends right after the start, the reason from its log is in the message', async () => {
  const w = world();
  w.answer = (name) => (name === 'inspect running rc-buildkit-app' ? { stdout: 'false' }
    : name.startsWith('logs') ? { stderr: 'level=info msg="start"\nerror: unshare: operation not permitted' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.pool.serviceFailed, true);
  assert.match(w.logs[0][0], /^Build service stops right after starting – error: unshare: operation not permitted \(the seccomp profile linux\/seccomp.json may block/);
});

test('if the state of the build service cannot be read after the start, the message says so, not “stops right after”', async () => {
  const w = world();
  w.answer = (name) => (name === 'inspect running rc-buildkit-app' ? { code: 1, stderr: 'Error: context deadline exceeded' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.logs[0][0], 'Build service: state after start not readable – Error: context deadline exceeded');
});

test('if the build service does not start, the gap until the next attempt grows', async () => {
  const w = world();
  w.answer = (name) => (name === 'run rc-buildkit-app' ? { code: 125, stderr: 'docker: Error response from daemon: no space.\nRun \'docker run --help\' for more information' } : undefined);
  const waits = [];
  for (let round = 0; round < 6; round += 1) {
    const before = Date.now();
    await w.caches.prepareCaches(REPO);
    waits.push(Math.round((w.pool.serviceRetryAt - before) / MINUTE));
  }
  assert.deepEqual(waits, [2, 4, 8, 16, 30, 30]);
  assert.equal(w.pool.serviceFailed, true);
  assert.deepEqual(w.logs[0], ['Build service does not start – docker: Error response from daemon: no space.', REPO, 'error']);

  // Once it works again, the count starts over.
  w.answer = () => undefined;
  await w.caches.prepareCaches(REPO);
  assert.equal(w.pool.serviceFailures, 0);
  assert.equal(w.pool.serviceFailed, false);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
});

test('preparing for a repo whose pool is already gone does not fail', async () => {
  const w = world();
  w.pool = undefined;
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, PREPARE);
});

test('the build service with the current limits stays', async () => {
  const w = world();
  await w.caches.renewService(w.pool); // never built yet: the preparation of the pool takes care of that
  w.pool.serviceBuilt = KEY_OLD;
  await w.caches.renewService(w.pool);
  w.settings.cache = false;
  w.limits = NEW;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, []);
});

test('with new limits the build service is created anew; the pairs reach it through the same socket', async () => {
  const w = world();
  w.pool.serviceBuilt = KEY_OLD;
  w.pool.slots = [{ state: 'ready' }, { state: 'starting' }];
  w.answer = running(KEY_OLD);
  w.limits = NEW;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, PREPARE);
  assert.equal(w.pool.serviceBuilt, KEY_NEW);
  assert.equal(w.pool.renewingService, false);
  assert.deepEqual(w.logs, [['Creating the build service with the new limits', REPO]]);
});

test('while the pool is building or otherwise busy, renewing waits', async () => {
  const blocked = [
    (w) => { w.pool.slots = [{ state: 'working' }]; },
    (w) => { w.pool.slots = [{ state: 'cleaning' }]; },
    (w) => { w.pool.hold = true; },
    (w) => { w.pool.removed = true; },
    (w) => { w.pool.prepared = false; },
    (w) => { w.pool.renewingService = true; },
    (w) => { w.pool.preparing = true; },
    (w) => { w.stopping = true; },
    (w) => { w.ready = false; },
  ];
  for (const block of blocked) {
    const w = world();
    w.pool.serviceBuilt = KEY_OLD;
    w.limits = NEW;
    block(w);
    await w.caches.renewService(w.pool);
    assert.deepEqual(w.calls, []);
    assert.equal(w.pool.serviceBuilt, KEY_OLD);
  }
});

test('a failed build service is only tried again after the delay', async () => {
  const w = world();
  w.pool.serviceFailed = true;
  w.pool.serviceBuilt = null;
  w.pool.serviceRetryAt = Date.now() + MINUTE;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, []);

  w.pool.serviceRetryAt = Date.now() - 1;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, PREPARE);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.equal(w.pool.serviceFailed, false);
  assert.deepEqual(w.logs, [['Trying again to create the build service', REPO]]);
});

test('two calls in quick succession renew only once', async () => {
  const w = world();
  w.pool.serviceBuilt = KEY_OLD;
  w.limits = NEW;
  await Promise.all([w.caches.renewService(w.pool), w.caches.renewService(w.pool)]);
  assert.deepEqual(w.calls, PREPARE);
});

test('clearing: package cache, build layers with service and socket, as asked; what cannot be deleted throws', async () => {
  const w = world();
  await w.caches.removeCaches(REPO, { packages: true });
  assert.deepEqual(w.calls, ['volume rm -f rc-cache-app']);

  w.calls.length = 0;
  await w.caches.removeCaches(REPO, { build: true });
  assert.deepEqual(w.calls, ['rm -f rc-buildkit-app', 'network rm rc-buildnet-app', 'volume rm -f rc-build-app rc-buildsock-app']);

  w.calls.length = 0;
  await w.caches.removeCaches(REPO, {});
  assert.deepEqual(w.calls, []);

  w.answer = (name) => (name.startsWith('volume rm') ? { code: 1, stderr: 'Error response from daemon: remove rc-cache-app: volume is in use\n' } : undefined);
  await assert.rejects(w.caches.removeCaches(REPO, { packages: true, build: true }), { message: 'Could not delete the caches – Error response from daemon: remove rc-cache-app: volume is in use' });
});

test('a pool that is being removed or already being measured is not measured', async () => {
  for (const pool of [{ repo: REPO, removed: true, sizes: null }, { repo: REPO, measuring: true, sizes: null }]) {
    const w = world();
    await w.caches.measureSizes(pool);
    assert.deepEqual(w.calls, []);
    assert.equal(pool.sizes, null);
  }
});

test('only the volumes that exist are measured, in bytes; what is missing counts 0', async () => {
  const w = world();
  const pool = { repo: REPO, sizes: null };
  const lists = { 'volume ls -q --filter name=rc-': 'rc-cache-app\nrc-build-app\nrc-cache-other\n' };
  w.answer = (name, args) => {
    if (name === 'volume ls -q --filter name=rc-') return { stdout: lists[name] };
    if (args[0] === 'run' && args.includes('du -sm /m/* 2>/dev/null')) return { stdout: '12\t/m/packages\n3\t/m/build\nnonsense\n' };
    return undefined;
  };
  await w.caches.measureSizes(pool);
  assert.deepEqual(pool.sizes, { packages: 12 * 1048576, images: 0, build: 3 * 1048576 });
  assert.equal(pool.measuring, false);
  const du = w.details.find((call) => call.args.includes('du -sm /m/* 2>/dev/null')).args;
  assert.deepEqual(du, ['run', '--rm', '-v', 'rc-cache-app:/m/packages:ro', '-v', 'rc-build-app:/m/build:ro', '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c', 'du -sm /m/* 2>/dev/null']);

  // Without a single volume nothing is started.
  const empty = world();
  const bare = { repo: REPO, sizes: null };
  await empty.caches.measureSizes(bare);
  assert.deepEqual(bare.sizes, { packages: 0, images: 0, build: 0 });
  assert.equal(empty.calls.some((name) => name.startsWith('run')), false);
});
