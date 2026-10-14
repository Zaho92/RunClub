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
  assert.deepEqual(engineFrom({}), { host: null, certs: null, distro: DESKTOP_DISTRO });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: '  ' }), { host: null, certs: null, distro: DESKTOP_DISTRO });
});

test('eine andere Engine: eigener Endpunkt ohne Messung, außer eine Distro ist genannt', () => {
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: 'npipe:////./pipe/runclub' }), { host: 'npipe:////./pipe/runclub', certs: null, distro: null });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: 'tcp://127.0.0.1:2376', RUNCLUB_DOCKER_CERTS: 'C:\\certs', RUNCLUB_DOCKER_DISTRO: 'runclub' }), { host: 'tcp://127.0.0.1:2376', certs: 'C:\\certs', distro: 'runclub' });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_DISTRO: '' }), { host: null, certs: null, distro: null });
});

test('Docker Desktop: die CLI wie bisher, mit der gewöhnlichen Zeitgrenze, die ein Aufruf selbst überschreiben kann', async () => {
  const fake = fakeRun({ code: 0, stdout: 'a\n b \r\n\n', stderr: '' });
  const engine = createEngine({ run: fake.run, timeout: 1234, ...engineFrom({}) });
  await engine.docker(['ps']);
  await engine.docker(['stats'], { timeout: 0 });
  await engine.docker(['run'], { env: { JITCONFIG: 'geheim' } });
  assert.deepEqual(await engine.dockerList(['ps', '-q']), ['a', 'b']);
  assert.deepEqual(fake.calls.map((call) => [call.command, call.args, call.options]), [
    ['docker', ['ps'], { timeout: 1234 }],
    ['docker', ['stats'], { timeout: 0 }],
    ['docker', ['run'], { timeout: 1234, env: { JITCONFIG: 'geheim' } }],
    ['docker', ['ps', '-q'], { timeout: 1234 }],
  ]);
  assert.match(engine.unreachableText, /läuft Docker Desktop\?/);
});

test('ein eigener Endpunkt geht der CLI bei jedem Aufruf mit, neben der Umgebung des Aufrufers und vor ihr', async () => {
  const fake = fakeRun();
  const engine = createEngine({ run: fake.run, timeout: 1234, ...engineFrom({ RUNCLUB_DOCKER_HOST: 'tcp://127.0.0.1:2376', RUNCLUB_DOCKER_CERTS: 'C:\\certs', RUNCLUB_DOCKER_DISTRO: 'runclub' }) });
  await engine.docker(['info'], { onLine: () => {} });
  await engine.docker(['run'], { env: { JITCONFIG: 'geheim', DOCKER_HOST: 'tcp://fremd:2375' } });
  await engine.dockerList(['ps']);
  const own = { DOCKER_HOST: 'tcp://127.0.0.1:2376', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: 'C:\\certs' };
  assert.deepEqual(fake.calls.map((call) => call.options.env), [own, { JITCONFIG: 'geheim', ...own }, own]);
  assert.equal(engine.unreachableText, 'Docker ist nicht erreichbar – läuft der Daemon unter tcp://127.0.0.1:2376 in der WSL-Distro runclub?');
});

test('auch ohne engineFrom: ein eigener Endpunkt ist nicht Docker Desktop', () => {
  const engine = createEngine({ run: fakeRun().run, timeout: 1, host: 'npipe:////./pipe/runclub', distro: null });
  assert.equal(engine.unreachableText, 'Docker ist nicht erreichbar – läuft der Daemon unter npipe:////./pipe/runclub?');
});

test('gemessen wird in der Distro der Engine, ohne deren Shell dazwischen; ohne Distro gibt es nichts zu messen', async () => {
  const fake = fakeRun({ code: 0, stdout: '', stderr: '' });
  const onLine = () => {};
  await createEngine({ run: fake.run, timeout: 1, ...engineFrom({ RUNCLUB_DOCKER_DISTRO: 'runclub' }) }).inVm('echo hallo', { timeout: 5, onLine });
  assert.deepEqual(fake.calls.map((call) => [call.command, call.args, call.options]), [['wsl', ['-d', 'runclub', '--exec', 'sh', '-c', 'echo hallo'], { timeout: 5, onLine }]]);

  const none = fakeRun();
  const result = await createEngine({ run: none.run, timeout: 1, ...engineFrom({ RUNCLUB_DOCKER_HOST: 'npipe:////./pipe/runclub' }) }).inVm('echo hallo', {});
  assert.deepEqual(none.calls, []);
  assert.equal(result.code, -1);
  assert.equal(result.stdout, '');
});
