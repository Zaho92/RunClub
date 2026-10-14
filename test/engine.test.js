const test = require('node:test');
const assert = require('node:assert/strict');
const { engineFrom, createEngine, DESKTOP_DISTRO } = require('../src/engine');

// `run` nachgestellt: merkt sich jeden Aufruf und antwortet mit `answer`.
function fakeRun(answer = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { timedOut: false, ...answer }; };
  return { calls, run };
}

test('ohne Angaben ist es Docker Desktop', () => {
  assert.deepEqual(engineFrom({}), { host: null, distro: DESKTOP_DISTRO, desktop: true });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: '  ' }), { host: null, distro: DESKTOP_DISTRO, desktop: true });
});

test('eine andere Engine: eigener Endpunkt, eigene Distro oder keine Messung', () => {
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: 'tcp://127.0.0.1:2376', RUNCLUB_DOCKER_DISTRO: 'runclub' }), { host: 'tcp://127.0.0.1:2376', distro: 'runclub', desktop: false });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_DISTRO: '' }), { host: null, distro: null, desktop: false });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: 'npipe:////./pipe/runclub' }), { host: 'npipe:////./pipe/runclub', distro: DESKTOP_DISTRO, desktop: false });
});

test('Docker Desktop: die CLI wie bisher, mit der gewöhnlichen Zeitgrenze, die ein Aufruf selbst überschreiben kann', async () => {
  const fake = fakeRun({ code: 0, stdout: 'a\n b \n\n', stderr: '' });
  const engine = createEngine({ run: fake.run, timeout: 1234, ...engineFrom({}) });
  await engine.docker(['ps']);
  await engine.docker(['build', '.'], { timeout: 99 });
  assert.deepEqual(await engine.dockerList(['ps', '-q']), ['a', 'b']);
  assert.deepEqual(fake.calls.map((call) => [call.command, call.args, call.options]), [
    ['docker', ['ps'], { timeout: 1234 }],
    ['docker', ['build', '.'], { timeout: 99 }],
    ['docker', ['ps', '-q'], { timeout: 1234 }],
  ]);
  assert.match(engine.unreachable, /läuft Docker Desktop\?/);
});

test('ein eigener Endpunkt geht der CLI als DOCKER_HOST mit, bei jedem Aufruf', async () => {
  const fake = fakeRun();
  const engine = createEngine({ run: fake.run, timeout: 1234, ...engineFrom({ RUNCLUB_DOCKER_HOST: 'tcp://127.0.0.1:2376', RUNCLUB_DOCKER_DISTRO: 'runclub' }) });
  await engine.docker(['info'], { onLine: () => {} });
  await engine.dockerList(['ps']);
  for (const call of fake.calls) assert.deepEqual(call.options.env, { DOCKER_HOST: 'tcp://127.0.0.1:2376' });
  assert.equal(engine.unreachable, 'Docker ist nicht erreichbar – läuft der Daemon unter tcp://127.0.0.1:2376 in der WSL-Distro runclub?');
});

test('gemessen wird in der Distro der Engine; ohne Distro gibt es nichts zu messen', async () => {
  const fake = fakeRun({ code: 0, stdout: '', stderr: '' });
  const onLine = () => {};
  await createEngine({ run: fake.run, timeout: 1, ...engineFrom({ RUNCLUB_DOCKER_DISTRO: 'runclub' }) }).inVm('echo hallo', { timeout: 5, onLine });
  assert.deepEqual(fake.calls.map((call) => [call.command, call.args, call.options]), [['wsl', ['-d', 'runclub', 'sh', '-c', 'echo hallo'], { timeout: 5, onLine }]]);

  const none = fakeRun();
  const result = await createEngine({ run: none.run, timeout: 1, ...engineFrom({ RUNCLUB_DOCKER_DISTRO: '' }) }).inVm('echo hallo', {});
  assert.deepEqual(none.calls, []);
  assert.equal(result.code, -1);
  assert.equal(result.stdout, '');
});
