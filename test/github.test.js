const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHub, parseResponse } = require('../src/github');

const NOW = 1791900000000;
const RESET = NOW / 1000 + 600; // das Fenster endet in zehn Minuten

const answer = (status, body, { etag, remaining = 4000 } = {}) => [
  `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Not Modified'}`, ...(etag ? [`Etag: ${etag}`] : []),
  'X-Ratelimit-Limit: 5000', `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Reset: ${RESET}`, 'X-Ratelimit-Resource: core', '', body,
].join('\r\n');

// Ein nachgestelltes `gh`: beantwortet die Aufrufe der Reihe nach und merkt sich, was gefragt wurde.
function fake(answers) {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ args, input: options.input }); return { code: 0, stdout: '', stderr: '', ...answers.shift() }; };
  return { calls, github: createGitHub({ run, now: () => NOW }) };
}

test('zerlegt Status, Kopfzeilen und Inhalt', () => {
  const parsed = parseResponse(answer(200, '{"a":1}', { etag: 'W/"x"' }));
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers.etag, 'W/"x"');
  assert.equal(parsed.headers['x-ratelimit-remaining'], '4000');
  assert.equal(parsed.body, '{"a":1}');
  assert.deepEqual(parseResponse('{"a":1}'), { status: 0, headers: {}, body: '{"a":1}' });
});

test('die zweite Abfrage ist bedingt, und bei 304 gilt die gemerkte Antwort', async () => {
  const { calls, github } = fake([
    { stdout: answer(200, '{"runs":[1]}', { etag: 'W/"eins"' }) },
    { code: 1, stdout: answer(304, ''), stderr: 'gh: HTTP 304' },
  ]);
  assert.deepEqual(await github.call(['api', 'repos/a/b/actions/runs']), { runs: [1] });
  assert.deepEqual(await github.call(['api', 'repos/a/b/actions/runs']), { runs: [1] });
  assert.deepEqual(calls[0].args, ['api', '-i', 'repos/a/b/actions/runs']);
  assert.deepEqual(calls[1].args, ['api', '-i', 'repos/a/b/actions/runs', '-H', 'If-None-Match: W/"eins"']);
});

test('eine geänderte Antwort ersetzt die gemerkte', async () => {
  const { calls, github } = fake([
    { stdout: answer(200, '{"n":1}', { etag: 'W/"eins"' }) },
    { stdout: answer(200, '{"n":2}', { etag: 'W/"zwei"' }) },
    { code: 1, stdout: answer(304, ''), stderr: 'gh: HTTP 304' },
  ]);
  await github.call(['api', 'x']);
  assert.deepEqual(await github.call(['api', 'x']), { n: 2 });
  assert.deepEqual(await github.call(['api', 'x']), { n: 2 });
  assert.equal(calls[2].args.at(-1), 'If-None-Match: W/"zwei"');
});

test('ein Fehler wirft mit der Meldung von gh', async () => {
  const { github } = fake([{ code: 1, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' }]);
  await assert.rejects(github.call(['api', 'repos/a/b/actions/variables/CI_RUNNER']), /404/);
});

test('Schreiben und Aufrufe mit Eingabe gehen unverändert an gh', async () => {
  const { calls, github } = fake([{ stdout: '{"ok":true}' }, { stdout: '' }]);
  assert.deepEqual(await github.call(['api', '-X', 'POST', 'repos/a/b/x'], { name: 'n' }), { ok: true });
  assert.equal(await github.call(['api', '-X', 'DELETE', 'repos/a/b/x']), null);
  assert.deepEqual(calls[0].args, ['api', '-X', 'POST', 'repos/a/b/x', '--input', '-']);
  assert.deepEqual(calls[0].input, { name: 'n' });
  assert.deepEqual(calls[1].args, ['api', '-X', 'DELETE', 'repos/a/b/x']);
});

test('der Stand des Limits kommt aus den Kopfzeilen', async () => {
  const { github } = fake([{ stdout: answer(200, '{}', { remaining: 4368 }) }]);
  assert.equal(github.quota(), null);
  assert.equal(github.state(), 'unknown');
  await github.call(['api', 'x']);
  assert.deepEqual(github.quota(), { limit: 5000, remaining: 4368, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok' });
});

test('unter 15 % ist es knapp, bei der Reserve ist Schluss', async () => {
  const { github } = fake([{ stdout: answer(200, '{}', { remaining: 749 }) }, { stdout: answer(200, '{}', { remaining: 101 }) }, { stdout: answer(200, '{}', { remaining: 100 }) }]);
  await github.call(['api', 'x']);
  assert.equal(github.state(), 'tight');
  await github.call(['api', 'x']);
  assert.equal(github.state(), 'tight');
  await github.call(['api', 'x']);
  assert.equal(github.state(), 'out');
});

test('rate_limit liefert den Stand, auch ohne andere Abfragen', async () => {
  const { calls, github } = fake([{ stdout: JSON.stringify({ resources: { core: { limit: 5000, remaining: 40, reset: RESET, used: 4960 } } }) }, { code: 1, stderr: 'kein Netz' }]);
  await github.refreshQuota();
  assert.deepEqual(calls[0].args, ['api', 'rate_limit']);
  assert.equal(github.state(), 'out');
  await github.refreshQuota(); // scheitert: der letzte Stand bleibt
  assert.equal(github.quota().remaining, 40);
});

test('nach dem Ende des Fensters gilt das Limit wieder als frei', async () => {
  let time = NOW;
  const run = async () => ({ code: 0, stderr: '', stdout: answer(200, '{}', { remaining: 0 }) });
  const github = createGitHub({ run, now: () => time });
  await github.call(['api', 'x']);
  assert.equal(github.state(), 'out');
  time = RESET * 1000 + 1;
  assert.equal(github.state(), 'ok');
  assert.equal(github.quota().remaining, 5000);
});
