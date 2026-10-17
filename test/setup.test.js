const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSetup, appCandidates, MISSING, ENGINE_GRACE } = require('../src/setup');
const { render } = require('../src/messages');

const ENV = { ProgramFiles: 'C:\\Program Files' };
const APP = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const TASK = '"Docker Desktop.exe","23396","Console","1","13,836 K"\r\n';
const NO_TASK = 'INFO: No tasks are running which match the specified criteria.\r\n';

// A machine to set up: what `wsl --status`, `tasklist` and `docker info` answer, which files exist.
function machine({ wsl = 0, tasks = NO_TASK, daemon = 1, files = [APP], ready = false, env = ENV } = {}) {
  const state = { wsl, tasks, daemon, files, ready, now: 0, calls: [], spawned: [], logged: [] };
  const run = async (command, args) => {
    state.calls.push([command, ...args].join(' '));
    if (command === 'wsl') return state.wsl === 'late' ? { code: -1, stdout: '', stderr: '', timedOut: true } : { code: state.wsl, stdout: '', stderr: '', timedOut: false };
    if (command === 'tasklist') return { code: 0, stdout: state.tasks, stderr: '', timedOut: false };
    return { code: -1, stdout: '', stderr: '', timedOut: false };
  };
  const docker = async (args) => { state.calls.push(['docker', ...args].join(' ')); return { code: state.daemon, stdout: '', stderr: '', timedOut: false }; };
  const spawn = (file, args, options) => { const child = new EventEmitter(); child.unref = () => { child.unrefed = true; }; state.spawned.push({ file, args, options, child }); return child; };
  const setup = createSetup({
    run, docker, ready: () => state.ready, desktop: true, log: (message) => state.logged.push(render(message)),
    env, exists: (file) => state.files.includes(file), findDocker: () => null, spawn, now: () => state.now,
  });
  return { state, setup };
}

test('if nothing is missing because Docker answers, nothing else is checked', async () => {
  const { state, setup } = machine({ ready: true });
  await setup.check();
  assert.equal(setup.view(), null);
  assert.deepEqual(state.calls, []);
  // If the daemon answers but is still being prepared (building images), nothing is missing either.
  const building = machine({ daemon: 0 });
  await building.setup.check();
  assert.equal(building.setup.view(), null);
  assert.deepEqual(building.state.calls, ['docker info --format ok']);
});

test('a fresh machine: WSL and Docker Desktop are missing', async () => {
  const { setup } = machine({ wsl: 1, files: [] });
  await setup.check();
  assert.deepEqual(setup.view(), { missing: [MISSING.WSL, MISSING.INSTALL], app: false });
});

test('installed but not started: starting is offered, and afterwards it is no longer missing', async () => {
  const { state, setup } = machine();
  await setup.check();
  assert.deepEqual(setup.view(), { missing: [MISSING.START], app: true });
  setup.launch();
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].file, APP);
  assert.deepEqual(state.spawned[0].options, { detached: true, stdio: 'ignore' });
  assert.ok(state.spawned[0].child.unrefed);
  assert.deepEqual(state.logged, ['Starting Docker Desktop …']);
  assert.equal(setup.view(), null);
  // If the start fails, it is logged.
  state.spawned[0].child.emit('error', new Error('Access denied'));
  assert.equal(state.logged[1], 'Docker Desktop could not be started: Access denied');
});

test('if Docker Desktop is running but its daemon still does not answer after the grace period, that is a case of its own', async () => {
  const { state, setup } = machine({ tasks: TASK });
  await setup.check();
  assert.equal(setup.view(), null); // it is still starting
  state.now = ENGINE_GRACE - 1;
  await setup.check();
  assert.equal(setup.view(), null);
  state.now = ENGINE_GRACE;
  await setup.check();
  assert.deepEqual(setup.view(), { missing: [MISSING.ENGINE], app: true });
  // Ended and started again: the grace period starts over.
  state.tasks = NO_TASK;
  await setup.check();
  assert.deepEqual(setup.view().missing, [MISSING.START]);
  state.tasks = TASK;
  await setup.check();
  assert.equal(setup.view(), null);
});

test('WSL: once found, it is not asked again; without an answer it does not count as missing', async () => {
  const { state, setup } = machine();
  await setup.check();
  await setup.check();
  assert.equal(state.calls.filter((call) => call.startsWith('wsl')).length, 1);
  const late = machine({ wsl: 'late' });
  await late.setup.check();
  assert.deepEqual(late.setup.view().missing, [MISSING.START]);
});

test('a daemon other than Docker Desktop: nothing to check', async () => {
  for (const env of [{ ...ENV, DOCKER_HOST: 'tcp://server:2376' }, { ...ENV, DOCKER_CONTEXT: 'remote' }]) {
    const { state, setup } = machine({ files: [], env });
    await setup.check();
    assert.equal(setup.view(), null);
    assert.deepEqual(state.calls, []);
  }
  const own = createSetup({ run: async () => ({ code: 1 }), docker: async () => ({ code: 1 }), ready: () => false, desktop: false });
  await own.check();
  assert.equal(own.view(), null);
});

test('not installed: starting fails with a message', () => {
  const { setup } = machine({ files: [] });
  assert.throws(() => setup.launch(), (error) => error.msg?.key === 'm_desktopNotFound');
});

test('Docker Desktop is in the usual place or two levels above the CLI', () => {
  assert.deepEqual(appCandidates(ENV, () => null), [APP]);
  assert.deepEqual(appCandidates({ ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files' }, () => 'D:\\Apps\\Docker\\resources\\bin\\docker.exe'),
    [APP, 'D:\\Apps\\Docker\\Docker Desktop.exe']);
  // A CLI somewhere else (from a package manager, say) says nothing about Docker Desktop.
  assert.deepEqual(appCandidates({}, () => 'C:\\tools\\docker.exe'), []);
});
