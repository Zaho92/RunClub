const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { engineFrom, createEngine, DESKTOP_DISTRO, EXPOSED_PING } = require('../src/engine');

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
  // Zertifikate ohne eigenen Endpunkt gelten nicht: Docker Desktop spräche sonst TLS mit einer Named Pipe.
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_CERTS: 'C:\\certs' }), { host: null, certs: null, distro: DESKTOP_DISTRO });
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
  // Ohne eigene Zertifikate gehen TLS-Einstellungen des Benutzers nicht an den eigenen Endpunkt.
  const plain = fakeRun();
  await createEngine({ run: plain.run, timeout: 1, host: 'npipe:////./pipe/runclub' }).docker(['ps']);
  assert.deepEqual(plain.calls[0].options.env, { DOCKER_HOST: 'npipe:////./pipe/runclub', DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '' });
  assert.deepEqual(fake.calls.map((call) => call.options.env), [own, { JITCONFIG: 'geheim', ...own }, own]);
  assert.equal(engine.unreachableText, 'Docker ist nicht erreichbar – läuft der Daemon unter tcp://127.0.0.1:2376 in der WSL-Distro runclub?');
});

test('auch ohne engineFrom: ein eigener Endpunkt ist nicht Docker Desktop und wird nicht in docker-desktop gemessen', async () => {
  const fake = fakeRun();
  const engine = createEngine({ run: fake.run, timeout: 1, host: 'npipe:////./pipe/runclub' });
  assert.equal(engine.unreachableText, 'Docker ist nicht erreichbar – läuft der Daemon unter npipe:////./pipe/runclub?');
  assert.equal((await engine.inVm('echo hallo', {})).code, -1);
  assert.equal(fake.calls.length, 0);
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

// Ein nachgestelltes `http.get`: `answer` ist der Text, den der Port liefert, oder ein Fehler.
function fakeGet(answer, calls = []) {
  return (url, options, onResponse) => {
    calls.push([url, options.timeout]);
    const request = new EventEmitter();
    request.destroy = () => request.emit('error', new Error('abgebrochen'));
    setImmediate(() => {
      if (answer instanceof Error) { request.emit('error', answer); return; }
      const response = new EventEmitter();
      onResponse(response);
      response.emit('data', answer);
      response.emit('end');
    });
    return request;
  };
}

test('ein ungeschützter Daemon: bei Docker Desktop über Port 2375, bei eigenem Endpunkt über tcp:// ohne TLS', async () => {
  const calls = [];
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  assert.match(await createEngine({ run, timeout: 1, get: fakeGet('OK', calls) }).exposure(), /tcp:\/\/localhost:2375/);
  assert.deepEqual(calls, [[EXPOSED_PING, 2000]]);
  assert.equal(await createEngine({ run, timeout: 1, get: fakeGet(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) }).exposure(), null);
  assert.equal(await createEngine({ run, timeout: 1, get: fakeGet('etwas anderes') }).exposure(), null);
  const other = [];
  assert.equal(await createEngine({ run, timeout: 1, host: 'npipe:////./pipe/runclub', get: fakeGet('OK', other) }).exposure(), null);
  assert.deepEqual(other, []); // ohne Docker Desktop kein Blick auf Port 2375
  assert.match(await createEngine({ run, timeout: 1, host: 'tcp://127.0.0.1:2375', get: fakeGet('OK') }).exposure(), /^RUNCLUB_DOCKER_HOST zeigt auf tcp:\/\/127\.0\.0\.1:2375 ohne TLS/);
  assert.equal(await createEngine({ run, timeout: 1, host: 'tcp://127.0.0.1:2376', certs: 'C:\\certs', get: fakeGet('OK') }).exposure(), null);
});
