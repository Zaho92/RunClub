const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHub, GitHubError, unregisterRunner } = require('../src/github');

// Der Zustand, wie die Oberfläche ihn bekommt; ohne Stand unbekannt.
const stateOf = (github) => github.quota()?.state ?? 'unknown';
const NOW = 1791900000000;
const RESET = NOW / 1000 + 600; // das Fenster endet in zehn Minuten

// Eine Antwort, wie fetch sie liefert.
function reply(status, body = '', { etag, remaining = 4000, reset = RESET, headers = {} } = {}) {
  const all = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core', ...(etag ? { etag } : {}), ...headers };
  return { status, ok: status >= 200 && status < 300, headers: new Headers(all), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
const limit = (remaining, reset = RESET) => reply(200, { resources: { core: { limit: 5000, remaining, reset } } }, { remaining, reset });

// Ein nachgestelltes fetch: beantwortet die Anfragen der Reihe nach (eine Funktion bekommt die Anfrage) und merkt
// sich, was gefragt wurde.
function fake(answers, { token = 'ghu_eins_token', renew = async () => null, now = () => NOW } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, options) : next;
  };
  const github = createGitHub({ token: async () => (typeof token === 'function' ? token() : token), renew, fetch, now, version: '1.2.3' });
  return { calls, github };
}

test('fragt mit Token, Kennung und fester Version bei api.github.com', async () => {
  const { calls, github } = fake([reply(200, { login: 'wer' })]);
  assert.deepEqual(await github.get('user'), { login: 'wer' });
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.authorization, 'Bearer ghu_eins_token');
  assert.equal(calls[0].headers['user-agent'], 'RunClub/1.2.3');
  assert.equal(calls[0].headers['x-github-api-version'], '2022-11-28');
  assert.equal(calls[0].headers.accept, 'application/vnd.github+json');
});

test('ein Pfad muss unter api.github.com liegen', async () => {
  const { calls, github } = fake([]);
  await assert.rejects(github.get('https://anderswo.example/x'), TypeError);
  await assert.rejects(github.get('/user'), TypeError);
  await assert.rejects(github.get('//anderswo.example/x'), TypeError);
  assert.equal(calls.length, 0);
});

test('ohne Anmeldung geht keine Anfrage hinaus', async () => {
  const { calls, github } = fake([], { token: null });
  await assert.rejects(github.get('user'), /Erst bei GitHub anmelden/);
  await assert.rejects(github.send('POST', 'repos/a/b/x'), /Erst bei GitHub anmelden/);
  assert.equal(calls.length, 0);
});

test('die zweite Abfrage ist bedingt, und bei 304 gilt die gemerkte Antwort', async () => {
  const { calls, github } = fake([reply(200, { runs: [1] }, { etag: 'W/"eins"' }), reply(304)]);
  assert.deepEqual(await github.get('repos/a/b/actions/runs'), { runs: [1] });
  assert.deepEqual(await github.get('repos/a/b/actions/runs'), { runs: [1] });
  assert.equal(calls[0].headers['if-none-match'], undefined);
  assert.equal(calls[1].headers['if-none-match'], 'W/"eins"');
});

test('eine gemerkte Antwort lässt sich vom Aufrufer nicht verändern', async () => {
  const { github } = fake([reply(200, { runs: [{ id: 1 }, { id: 2 }] }, { etag: 'W/"eins"' }), reply(304)]);
  const first = await github.get('x');
  assert.throws(() => { 'use strict'; first.runs.reverse(); }, TypeError);
  assert.ok(Object.isFrozen(first.runs[0]));
  assert.deepEqual(await github.get('x'), { runs: [{ id: 1 }, { id: 2 }] });
});

test('eine geänderte Antwort ersetzt die gemerkte', async () => {
  const { calls, github } = fake([reply(200, { n: 1 }, { etag: 'W/"eins"' }), reply(200, { n: 2 }, { etag: 'W/"zwei"' }), reply(304)]);
  await github.get('x');
  assert.deepEqual(await github.get('x'), { n: 2 });
  assert.deepEqual(await github.get('x'), { n: 2 });
  assert.equal(calls[2].headers['if-none-match'], 'W/"zwei"');
});

test('ein Fehler wirft mit dem Status und der Meldung von GitHub', async () => {
  const { github } = fake([reply(404, { message: 'Not Found' }), reply(500, '<html>kaputt</html>')]);
  const error = await github.get('repos/a/b/actions/variables/CI_RUNNER').catch((caught) => caught);
  assert.ok(error instanceof GitHubError);
  assert.equal(error.status, 404);
  assert.equal(error.message, 'Not Found (HTTP 404)');
  await assert.rejects(github.get('y'), { status: 500, message: 'HTTP 500' });
});

test('Schreiben schickt den Inhalt als JSON und liefert die Antwort', async () => {
  const { calls, github } = fake([reply(201, { ok: true }), reply(204)]);
  assert.deepEqual(await github.send('POST', 'repos/a/b/x', { name: 'n' }), { ok: true });
  assert.equal(await github.send('DELETE', 'repos/a/b/x'), null);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"name":"n"}');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers['content-type'], undefined);
});

test('lehnt GitHub das Token ab, wird einmal erneuert und wiederholt', async () => {
  const renewed = [];
  const { calls, github } = fake([reply(401, { message: 'Bad credentials' }), reply(200, { a: 1 })], { renew: async (old) => { renewed.push(old); return 'ghu_zwei_token'; } });
  assert.deepEqual(await github.get('x'), { a: 1 });
  assert.deepEqual(renewed, ['ghu_eins_token']);
  assert.equal(calls[1].headers.authorization, 'Bearer ghu_zwei_token');
});

test('ohne neues Token bleibt es beim Fehler, und es wird nicht endlos wiederholt', async () => {
  const { calls, github } = fake([reply(401, { message: 'Bad credentials' }), reply(401, { message: 'Bad credentials' })], { renew: async () => 'ghu_zwei_token' });
  await assert.rejects(github.get('x'), { status: 401 });
  assert.equal(calls.length, 2);
  const none = fake([reply(401, { message: 'Bad credentials' })]);
  await assert.rejects(none.github.send('POST', 'x'), { status: 401 });
  assert.equal(none.calls.length, 1);
});

test('antwortet GitHub nicht, ist das eine Meldung, kein Absturz', async () => {
  const unreachable = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const timeout = Object.assign(new Error('zu spät'), { name: 'TimeoutError' });
  const { github } = fake([unreachable, timeout]);
  await assert.rejects(github.get('x'), (error) => error.msg.key === 'm_githubUnreachable' && error.msg.args[0] === 'ENOTFOUND');
  await assert.rejects(github.get('x'), (error) => error.msg.key === 'm_githubSilent');
});

test('der Stand des Limits kommt aus den Kopfzeilen', async () => {
  const { github } = fake([reply(200, {}, { remaining: 4368 })]);
  assert.equal(github.quota(), null);
  assert.equal(stateOf(github), 'unknown');
  await github.get('x');
  assert.deepEqual(github.quota(), { limit: 5000, remaining: 4368, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok', tightAt: 0.85 });
});

test('Kopfzeilen eines anderen Limits (etwa der Suche) zählen nicht', async () => {
  const { github } = fake([reply(200, {}, { remaining: 3, headers: { 'x-ratelimit-resource': 'search' } })]);
  await github.get('x');
  assert.equal(github.quota(), null);
});

test('unter 15 % ist es knapp, bei der Reserve ist Schluss', async () => {
  const { github } = fake([reply(200, {}, { remaining: 749 }), reply(200, {}, { remaining: 101 }), reply(200, {}, { remaining: 100 })]);
  await github.get('x');
  assert.equal(stateOf(github), 'tight');
  await github.get('x');
  assert.equal(stateOf(github), 'tight');
  await github.get('x');
  assert.equal(stateOf(github), 'out');
});

test('rate_limit liefert den Stand, auch ohne andere Abfragen', async () => {
  const { calls, github } = fake([limit(40), new TypeError('fetch failed')]);
  await github.refreshQuota();
  assert.equal(calls[0].url, 'https://api.github.com/rate_limit');
  assert.equal(stateOf(github), 'out');
  await github.refreshQuota(); // scheitert: der letzte Stand bleibt
  assert.equal(github.quota().remaining, 40);
});

test('refreshQuota ohne Anmeldung wirft nicht und fragt nicht', async () => {
  const { calls, github } = fake([], { token: null });
  assert.equal(await github.refreshQuota(), null);
  assert.equal(calls.length, 0);
});

test('refreshQuota meldet nur, wenn der Zustand kippt', async () => {
  const { github } = fake([limit(4000), limit(3900), limit(500), limit(400), limit(4900)]);
  assert.deepEqual(await github.refreshQuota(), { limit: 5000, remaining: 4000, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok', tightAt: 0.85, before: 'unknown', paused: false });
  assert.equal(await github.refreshQuota(), null);
  assert.partialDeepStrictEqual(await github.refreshQuota(), { state: 'tight', before: 'ok', remaining: 500 });
  assert.equal(await github.refreshQuota(), null);
  assert.partialDeepStrictEqual(await github.refreshQuota(), { state: 'ok', before: 'tight' });
});

test('nach dem Ende des Fensters ist der Stand unbekannt, bis ein neuer da ist', async () => {
  let time = NOW;
  const { github } = fake([reply(200, {}, { remaining: 0 })], { now: () => time });
  await github.get('x');
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
  const { github } = fake([limit(500)], { now: () => time });
  assert.equal(github.mayPoll('wer/was'), true); // noch kein Stand: wie gewohnt
  await github.refreshQuota();
  assert.equal(github.mayPoll('wer/was'), true);
  assert.equal(github.mayPoll('wer/was'), false);
  assert.equal(github.mayPoll('wer/anders'), true);
  time += 60000;
  assert.equal(github.mayPoll('wer/was'), true);
});

test('bei aufgebrauchtem Limit wird nicht mehr gelesen, geschrieben schon', async () => {
  const { calls, github } = fake([limit(100), reply(201, { encoded_jit_config: 'x' })]);
  await github.refreshQuota();
  assert.equal(github.mayPoll('wer/was'), false);
  await assert.rejects(github.get('repos/wer/was'), /Anfragelimit/);
  assert.deepEqual(await github.send('POST', 'repos/wer/was/actions/runners/generate-jitconfig', { name: 'n' }), { encoded_jit_config: 'x' });
  assert.equal(calls.length, 2); // rate_limit und das Schreiben; die Leseabfrage ging nicht hinaus
});

test('bittet GitHub um eine Pause, wird bis dahin nicht mehr gelesen', async () => {
  let time = NOW;
  const { calls, github } = fake([reply(403, { message: 'You have exceeded a secondary rate limit' }, { headers: { 'retry-after': '90' } }), reply(200, { a: 1 })], { now: () => time });
  await assert.rejects(github.get('x'), /secondary rate limit/);
  assert.equal(stateOf(github), 'out');
  assert.equal(github.quota().resetAt, new Date(NOW + 90000).toISOString());
  assert.equal(github.mayPoll('wer/was'), false);
  await assert.rejects(github.get('x'), /Pause/);
  assert.equal(calls.length, 1);
  time += 90001;
  assert.equal(stateOf(github), 'ok');
  assert.deepEqual(await github.get('x'), { a: 1 });
});

test('eine erbetene Pause gilt auch über das Ende des Fensters hinaus', async () => {
  let time = NOW;
  const { github } = fake([reply(429, {}, { headers: { 'retry-after': '900' } })], { now: () => time });
  await assert.rejects(github.get('x'));
  time = RESET * 1000 + 1000; // das Fenster ist abgelaufen, die Pause (15 min) noch nicht
  assert.equal(github.mayPoll('wer/was'), false);
  await assert.rejects(github.get('x'), /Pause/);
});

test('der Abstand bei knappem Limit lässt sich je Sache größer wählen', async () => {
  let time = NOW;
  const { github } = fake([limit(500)], { now: () => time });
  await github.refreshQuota();
  assert.equal(github.mayPoll('wartende Läufe', 300000), true);
  time += 100000;
  assert.equal(github.mayPoll('wartende Läufe', 300000), false);
  time += 200000;
  assert.equal(github.mayPoll('wartende Läufe', 300000), true);
});

test('ein Runner, den GitHub nicht mehr kennt, gilt als abgemeldet', async () => {
  const sent = [];
  const github = (status) => ({ send: async (method, path) => { sent.push(`${method} ${path}`); if (status) throw new GitHubError(status, 'x'); return null; } });
  await unregisterRunner(github(0), 'wer/App', 7);
  await unregisterRunner(github(404), 'wer/App', 8);
  await assert.rejects(unregisterRunner(github(403), 'wer/App', 9), { status: 403 });
  assert.deepEqual(sent, ['DELETE repos/wer/App/actions/runners/7', 'DELETE repos/wer/App/actions/runners/8', 'DELETE repos/wer/App/actions/runners/9']);
});
