const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSetup, appCandidates, MISSING, ENGINE_GRACE } = require('../src/setup');
const { render } = require('../src/messages');

const ENV = { ProgramFiles: 'C:\\Program Files' };
const APP = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const TASK = '"Docker Desktop.exe","23396","Console","1","13.836 K"\r\n';
const NO_TASK = 'INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.\r\n';

// Ein Rechner zum Einstellen: was `wsl --status`, `tasklist` und `docker info` antworten, welche Dateien es gibt.
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

test('fehlt nichts, weil Docker antwortet, wird nichts weiter geprüft', async () => {
  const { state, setup } = machine({ ready: true });
  await setup.check();
  assert.equal(setup.view(), null);
  assert.deepEqual(state.calls, []);
  // Antwortet der Daemon, wird aber noch vorbereitet (Abbilder bauen), fehlt auch nichts.
  const building = machine({ daemon: 0 });
  await building.setup.check();
  assert.equal(building.setup.view(), null);
  assert.deepEqual(building.state.calls, ['docker info --format ok']);
});

test('ein frischer Rechner: WSL und Docker Desktop fehlen', async () => {
  const { setup } = machine({ wsl: 1, files: [] });
  await setup.check();
  assert.deepEqual(setup.view(), { missing: [MISSING.WSL, MISSING.INSTALL], app: false });
});

test('installiert, aber nicht gestartet: Starten bietet sich an, und danach fehlt es nicht mehr', async () => {
  const { state, setup } = machine();
  await setup.check();
  assert.deepEqual(setup.view(), { missing: [MISSING.START], app: true });
  setup.launch();
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].file, APP);
  assert.deepEqual(state.spawned[0].options, { detached: true, stdio: 'ignore' });
  assert.ok(state.spawned[0].child.unrefed);
  assert.deepEqual(state.logged, ['Starte Docker Desktop …']);
  assert.equal(setup.view(), null);
  // Scheitert der Start, steht es im Protokoll.
  state.spawned[0].child.emit('error', new Error('Zugriff verweigert'));
  assert.equal(state.logged[1], 'Docker Desktop ließ sich nicht starten: Zugriff verweigert');
});

test('läuft Docker Desktop, antwortet sein Daemon aber auch nach der Frist nicht, ist das ein eigener Fall', async () => {
  const { state, setup } = machine({ tasks: TASK });
  await setup.check();
  assert.equal(setup.view(), null); // es startet noch
  state.now = ENGINE_GRACE - 1;
  await setup.check();
  assert.equal(setup.view(), null);
  state.now = ENGINE_GRACE;
  await setup.check();
  assert.deepEqual(setup.view(), { missing: [MISSING.ENGINE], app: true });
  // Beendet und neu gestartet: Die Frist beginnt von vorn.
  state.tasks = NO_TASK;
  await setup.check();
  assert.deepEqual(setup.view().missing, [MISSING.START]);
  state.tasks = TASK;
  await setup.check();
  assert.equal(setup.view(), null);
});

test('WSL: einmal gefunden, wird es nicht mehr gefragt; ohne Antwort gilt es nicht als fehlend', async () => {
  const { state, setup } = machine();
  await setup.check();
  await setup.check();
  assert.equal(state.calls.filter((call) => call.startsWith('wsl')).length, 1);
  const late = machine({ wsl: 'late' });
  await late.setup.check();
  assert.deepEqual(late.setup.view().missing, [MISSING.START]);
});

test('ein anderer Daemon als Docker Desktop: nichts zu prüfen', async () => {
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

test('nicht installiert: Starten scheitert mit einer Meldung', () => {
  const { setup } = machine({ files: [] });
  assert.throws(() => setup.launch(), (error) => error.msg?.key === 'm_desktopNotFound');
});

test('Docker Desktop liegt am üblichen Ort oder zwei Ebenen über der CLI', () => {
  assert.deepEqual(appCandidates(ENV, () => null), [APP]);
  assert.deepEqual(appCandidates({ ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files' }, () => 'D:\\Apps\\Docker\\resources\\bin\\docker.exe'),
    [APP, 'D:\\Apps\\Docker\\Docker Desktop.exe']);
  // Eine CLI an anderer Stelle (etwa aus einem Paketmanager) sagt nichts über Docker Desktop.
  assert.deepEqual(appCandidates({}, () => 'C:\\tools\\docker.exe'), []);
});
