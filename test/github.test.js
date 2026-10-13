const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHub, parseResponse } = require('../src/github');

// Der Zustand, wie die Oberfläche ihn bekommt; ohne Stand unbekannt.
const stateOf = (github) => github.quota()?.state ?? 'unknown';
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

test('eine gemerkte Antwort lässt sich vom Aufrufer nicht verändern', async () => {
  const { github } = fake([{ stdout: answer(200, '{"runs":[{"id":1},{"id":2}]}', { etag: 'W/"eins"' }) }, { code: 1, stdout: answer(304, ''), stderr: 'gh: HTTP 304' }]);
  const first = await github.call(['api', 'x']);
  assert.throws(() => { 'use strict'; first.runs.reverse(); }, TypeError);
  assert.ok(Object.isFrozen(first.runs[0]));
  assert.deepEqual(await github.call(['api', 'x']), { runs: [{ id: 1 }, { id: 2 }] });
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
  assert.equal(stateOf(github), 'unknown');
  await github.call(['api', 'x']);
  assert.deepEqual(github.quota(), { limit: 5000, remaining: 4368, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok', tightAt: 0.85 });
});

test('unter 15 % ist es knapp, bei der Reserve ist Schluss', async () => {
  const { github } = fake([{ stdout: answer(200, '{}', { remaining: 749 }) }, { stdout: answer(200, '{}', { remaining: 101 }) }, { stdout: answer(200, '{}', { remaining: 100 }) }]);
  await github.call(['api', 'x']);
  assert.equal(stateOf(github), 'tight');
  await github.call(['api', 'x']);
  assert.equal(stateOf(github), 'tight');
  await github.call(['api', 'x']);
  assert.equal(stateOf(github), 'out');
});

const limit = (remaining, reset = RESET) => ({ stdout: JSON.stringify({ resources: { core: { limit: 5000, remaining, reset } } }) });

test('rate_limit liefert den Stand, auch ohne andere Abfragen', async () => {
  const { calls, github } = fake([limit(40), { code: 1, stderr: 'kein Netz' }]);
  await github.refreshQuota();
  assert.deepEqual(calls[0].args, ['api', 'rate_limit']);
  assert.equal(stateOf(github), 'out');
  await github.refreshQuota(); // scheitert: der letzte Stand bleibt
  assert.equal(github.quota().remaining, 40);
});

test('refreshQuota meldet nur, wenn der Zustand kippt', async () => {
  const { github } = fake([limit(4000), limit(3900), limit(500), limit(400), limit(4900)]);
  assert.deepEqual(await github.refreshQuota(), { limit: 5000, remaining: 4000, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok', tightAt: 0.85, before: 'unknown', until: new Date(RESET * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), paused: false });
  assert.equal(await github.refreshQuota(), null);
  assert.partialDeepStrictEqual(await github.refreshQuota(), { state: 'tight', before: 'ok', remaining: 500 });
  assert.equal(await github.refreshQuota(), null);
  assert.partialDeepStrictEqual(await github.refreshQuota(), { state: 'ok', before: 'tight' });
});

test('nach dem Ende des Fensters ist der Stand unbekannt, bis ein neuer da ist', async () => {
  let time = NOW;
  const run = async () => ({ code: 0, stderr: '', stdout: answer(200, '{}', { remaining: 0 }) });
  const github = createGitHub({ run, now: () => time });
  await github.call(['api', 'x']);
  assert.equal(stateOf(github), 'out');
  time = RESET * 1000 + 1;
  assert.equal(stateOf(github), 'unknown');
  assert.equal(github.quota(), null);
  assert.equal(github.mayPoll('wer/was'), true);
});

test('ein unsinniges Fensterende ist kein Stand', async () => {
  const { github } = fake([limit(0, 9e15)]);
  assert.equal(await github.refreshQuota(), null);
  assert.equal(github.quota(), null);
});

test('bei knappem Limit wird dieselbe Sache höchstens einmal je Minute abgefragt', async () => {
  let time = NOW;
  const run = async () => ({ code: 0, stderr: '', ...limit(500) });
  const github = createGitHub({ run, now: () => time });
  assert.equal(github.mayPoll('wer/was'), true); // noch kein Stand: wie gewohnt
  await github.refreshQuota();
  assert.equal(github.mayPoll('wer/was'), true);
  assert.equal(github.mayPoll('wer/was'), false);
  assert.equal(github.mayPoll('wer/anders'), true);
  time += 60000;
  assert.equal(github.mayPoll('wer/was'), true);
});

test('bei aufgebrauchtem Limit wird nicht mehr gelesen, geschrieben schon', async () => {
  const { calls, github } = fake([limit(100), { stdout: '{"encoded_jit_config":"x"}' }]);
  await github.refreshQuota();
  assert.equal(github.mayPoll('wer/was'), false);
  await assert.rejects(github.call(['api', 'repos/wer/was']), /Anfragelimit/);
  assert.deepEqual(await github.call(['api', '-X', 'POST', 'repos/wer/was/actions/runners/generate-jitconfig'], { name: 'n' }), { encoded_jit_config: 'x' });
  assert.equal(calls.length, 2); // rate_limit und das Schreiben; die Leseabfrage ging nicht hinaus
});

test('nach einer Weiterleitung gilt der letzte Block', () => {
  const parsed = parseResponse(`HTTP/2.0 301 Moved Permanently\r\nLocation: /neu\r\n\r\n${answer(200, '{"a":1}', { etag: 'W/"x"' })}`);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body, '{"a":1}');
});

test('ein Inhalt, der wie eine Statuszeile beginnt, bleibt Inhalt', () => {
  const body = 'HTTP/1.1 200 OK\r\nEtag: W/"falsch"\r\n\r\n{"b":2}';
  const parsed = parseResponse(answer(200, body, { etag: 'W/"echt"' }));
  assert.equal(parsed.headers.etag, 'W/"echt"');
  assert.equal(parsed.body, body);
});

test('bittet GitHub um eine Pause, wird bis dahin nicht mehr gelesen', async () => {
  let time = NOW;
  const answers = [
    { code: 1, stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)', stdout: ['HTTP/2.0 403 Forbidden', 'Retry-After: 90', 'X-Ratelimit-Limit: 5000', 'X-Ratelimit-Remaining: 4000', `X-Ratelimit-Reset: ${RESET}`, '', '{}'].join('\r\n') },
    { code: 0, stderr: '', stdout: answer(200, '{"a":1}') },
  ];
  const calls = [];
  const github = createGitHub({ run: async (command, args) => { calls.push(args); return answers.shift(); }, now: () => time });
  await assert.rejects(github.call(['api', 'x']), /secondary rate limit/);
  assert.equal(stateOf(github), 'out');
  assert.equal(github.quota().resetAt, new Date(NOW + 90000).toISOString());
  assert.equal(github.mayPoll('wer/was'), false);
  await assert.rejects(github.call(['api', 'x']), /Pause/);
  assert.equal(calls.length, 1);
  time += 90001;
  assert.equal(stateOf(github), 'ok');
  assert.deepEqual(await github.call(['api', 'x']), { a: 1 });
});

test('eine erbetene Pause gilt auch über das Ende des Fensters hinaus', async () => {
  let time = NOW;
  const pause = { code: 1, stderr: 'gh: HTTP 429', stdout: ['HTTP/2.0 429 Too Many Requests', 'Retry-After: 900', 'X-Ratelimit-Limit: 5000', 'X-Ratelimit-Remaining: 4000', `X-Ratelimit-Reset: ${RESET}`, '', '{}'].join('\r\n') };
  const github = createGitHub({ run: async () => pause, now: () => time });
  await assert.rejects(github.call(['api', 'x']));
  time = RESET * 1000 + 1000; // das Fenster ist abgelaufen, die Pause (15 min) noch nicht
  assert.equal(github.mayPoll('wer/was'), false);
  await assert.rejects(github.call(['api', 'x']), /Pause/);
});

test('der Abstand bei knappem Limit lässt sich je Sache größer wählen', async () => {
  let time = NOW;
  const github = createGitHub({ run: async () => ({ code: 0, stderr: '', ...limit(500) }), now: () => time });
  await github.refreshQuota();
  assert.equal(github.mayPoll('wartende Läufe', 300000), true);
  time += 100000;
  assert.equal(github.mayPoll('wartende Läufe', 300000), false);
  time += 200000;
  assert.equal(github.mayPoll('wartende Läufe', 300000), true);
});
