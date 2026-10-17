const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { engineFrom, createEngine, DESKTOP_DISTRO, EXPOSED_PING } = require('../src/engine');
const { render } = require('../src/messages');

// `run` simulated: remembers every call and answers with `answer`.
function fakeRun(answer = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { timedOut: false, ...answer }; };
  return { calls, run };
}

test('without settings it is Docker Desktop', () => {
  assert.deepEqual(engineFrom({}), { host: null, certs: null, distro: DESKTOP_DISTRO });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: '  ' }), { host: null, certs: null, distro: DESKTOP_DISTRO });
});

test('another engine: own endpoint without measuring, unless a distro is named', () => {
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: 'npipe:////./pipe/runclub' }), { host: 'npipe:////./pipe/runclub', certs: null, distro: null });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_HOST: 'tcp://127.0.0.1:2376', RUNCLUB_DOCKER_CERTS: 'C:\\certs', RUNCLUB_DOCKER_DISTRO: 'runclub' }), { host: 'tcp://127.0.0.1:2376', certs: 'C:\\certs', distro: 'runclub' });
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_DISTRO: '' }), { host: null, certs: null, distro: null });
  // Certificates without your own endpoint do not apply: Docker Desktop would otherwise talk TLS to a named pipe.
  assert.deepEqual(engineFrom({ RUNCLUB_DOCKER_CERTS: 'C:\\certs' }), { host: null, certs: null, distro: DESKTOP_DISTRO });
});

test('Docker Desktop: the CLI as before, with the usual time limit, which a call can override itself', async () => {
  const fake = fakeRun({ code: 0, stdout: 'a\n b \r\n\n', stderr: '' });
  const engine = createEngine({ run: fake.run, timeout: 1234, ...engineFrom({}) });
  await engine.docker(['ps']);
  await engine.docker(['stats'], { timeout: 0 });
  await engine.docker(['run'], { env: { JITCONFIG: 'secret' } });
  assert.deepEqual(await engine.dockerList(['ps', '-q']), ['a', 'b']);
  assert.deepEqual(fake.calls.map((call) => [call.command, call.args, call.options]), [
    ['docker', ['ps'], { timeout: 1234 }],
    ['docker', ['stats'], { timeout: 0 }],
    ['docker', ['run'], { timeout: 1234, env: { JITCONFIG: 'secret' } }],
    ['docker', ['ps', '-q'], { timeout: 1234 }],
  ]);
  assert.match(render(engine.unreachable), /is Docker Desktop running\?/);
});

test('your own endpoint goes along with the CLI on every call, next to the caller\'s environment and ahead of it', async () => {
  const fake = fakeRun();
  const engine = createEngine({ run: fake.run, timeout: 1234, ...engineFrom({ RUNCLUB_DOCKER_HOST: 'tcp://127.0.0.1:2376', RUNCLUB_DOCKER_CERTS: 'C:\\certs', RUNCLUB_DOCKER_DISTRO: 'runclub' }) });
  await engine.docker(['info'], { onLine: () => {} });
  await engine.docker(['run'], { env: { JITCONFIG: 'secret', DOCKER_HOST: 'tcp://other:2375' } });
  await engine.dockerList(['ps']);
  const own = { DOCKER_HOST: 'tcp://127.0.0.1:2376', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: 'C:\\certs' };
  // Without your own certificates the user's TLS settings do not go to your own endpoint.
  const plain = fakeRun();
  await createEngine({ run: plain.run, timeout: 1, host: 'npipe:////./pipe/runclub' }).docker(['ps']);
  assert.deepEqual(plain.calls[0].options.env, { DOCKER_HOST: 'npipe:////./pipe/runclub', DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '' });
  assert.deepEqual(fake.calls.map((call) => call.options.env), [own, { JITCONFIG: 'secret', ...own }, own]);
  assert.equal(render(engine.unreachable), 'Docker is not reachable – is the daemon running at tcp://127.0.0.1:2376 in the WSL distro runclub?');
});

test('without engineFrom too: your own endpoint is not Docker Desktop and is not measured in docker-desktop', async () => {
  const fake = fakeRun();
  const engine = createEngine({ run: fake.run, timeout: 1, host: 'npipe:////./pipe/runclub' });
  assert.equal(render(engine.unreachable), 'Docker is not reachable – is the daemon running at npipe:////./pipe/runclub?');
  assert.equal((await engine.inVm('echo hello', {})).code, -1);
  assert.equal(fake.calls.length, 0);
});

test('measuring happens in the engine\'s distro, without its shell in between; without a distro there is nothing to measure', async () => {
  const fake = fakeRun({ code: 0, stdout: '', stderr: '' });
  const onLine = () => {};
  await createEngine({ run: fake.run, timeout: 1, ...engineFrom({ RUNCLUB_DOCKER_DISTRO: 'runclub' }) }).inVm('echo hello', { timeout: 5, onLine });
  assert.deepEqual(fake.calls.map((call) => [call.command, call.args, call.options]), [['wsl', ['-d', 'runclub', '--exec', 'sh', '-c', 'echo hello'], { timeout: 5, onLine }]]);

  const none = fakeRun();
  const result = await createEngine({ run: none.run, timeout: 1, ...engineFrom({ RUNCLUB_DOCKER_HOST: 'npipe:////./pipe/runclub' }) }).inVm('echo hello', {});
  assert.deepEqual(none.calls, []);
  assert.equal(result.code, -1);
  assert.equal(result.stdout, '');
});

// A simulated `http.get`: `answer` is the text the port returns, or an error.
function fakeGet(answer, calls = []) {
  return (url, options, onResponse) => {
    calls.push([url, options.timeout]);
    const request = new EventEmitter();
    request.destroy = () => request.emit('error', new Error('cancelled'));
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

test('an unprotected daemon: with Docker Desktop through port 2375, with your own endpoint through tcp:// without TLS', async () => {
  const calls = [];
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  assert.match(render(await createEngine({ run, timeout: 1, get: fakeGet('OK', calls) }).exposure()), /tcp:\/\/localhost:2375/);
  assert.deepEqual(calls, [[EXPOSED_PING, 2000]]);
  assert.equal(await createEngine({ run, timeout: 1, get: fakeGet(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) }).exposure(), null);
  assert.equal(await createEngine({ run, timeout: 1, get: fakeGet('something else') }).exposure(), null);
  const other = [];
  assert.equal(await createEngine({ run, timeout: 1, host: 'npipe:////./pipe/runclub', get: fakeGet('OK', other) }).exposure(), null);
  assert.deepEqual(other, []); // without Docker Desktop no look at port 2375
  assert.match(render(await createEngine({ run, timeout: 1, host: 'tcp://127.0.0.1:2375', get: fakeGet('OK') }).exposure()), /^RUNCLUB_DOCKER_HOST points to tcp:\/\/127\.0\.0\.1:2375 without TLS/);
  assert.equal(await createEngine({ run, timeout: 1, host: 'tcp://127.0.0.1:2376', certs: 'C:\\certs', get: fakeGet('OK') }).exposure(), null);
});
