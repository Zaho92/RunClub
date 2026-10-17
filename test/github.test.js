const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHub, GitHubError, unregisterRunner } = require('../src/github');

// The state as the interface gets it; unknown without a state.
const stateOf = (github) => github.quota()?.state ?? 'unknown';
const NOW = 1791900000000;
const RESET = NOW / 1000 + 600; // the window ends in ten minutes

// An answer as fetch returns it.
function reply(status, body = '', { etag, remaining = 4000, reset = RESET, headers = {} } = {}) {
  const all = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core', ...(etag ? { etag } : {}), ...headers };
  return { status, ok: status >= 200 && status < 300, headers: new Headers(all), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
const limit = (remaining, reset = RESET) => reply(200, { resources: { core: { limit: 5000, remaining, reset } } }, { remaining, reset });

// A fake fetch: answers the requests in order (a function gets the request) and remembers
// what was asked.
function fake(answers, { token = 'ghu_one_token', renew = async () => null, now = () => NOW } = {}) {
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

test('asks api.github.com with token, identification and a fixed version', async () => {
  const { calls, github } = fake([reply(200, { login: 'someone' })]);
  assert.deepEqual(await github.get('user'), { login: 'someone' });
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.authorization, 'Bearer ghu_one_token');
  assert.equal(calls[0].headers['user-agent'], 'RunClub/1.2.3');
  assert.equal(calls[0].headers['x-github-api-version'], '2022-11-28');
  assert.equal(calls[0].headers.accept, 'application/vnd.github+json');
});

test('a path must lie under api.github.com', async () => {
  const { calls, github } = fake([]);
  await assert.rejects(github.get('https://elsewhere.example/x'), TypeError);
  await assert.rejects(github.get('/user'), TypeError);
  await assert.rejects(github.get('//elsewhere.example/x'), TypeError);
  assert.equal(calls.length, 0);
});

test('without a sign-in no request goes out', async () => {
  const { calls, github } = fake([], { token: null });
  await assert.rejects(github.get('user'), /Sign in to GitHub first/);
  await assert.rejects(github.send('POST', 'repos/a/b/x'), /Sign in to GitHub first/);
  assert.equal(calls.length, 0);
});

test('the second query is conditional, and on 304 the remembered answer holds', async () => {
  const { calls, github } = fake([reply(200, { runs: [1] }, { etag: 'W/"one"' }), reply(304)]);
  assert.deepEqual(await github.get('repos/a/b/actions/runs'), { runs: [1] });
  assert.deepEqual(await github.get('repos/a/b/actions/runs'), { runs: [1] });
  assert.equal(calls[0].headers['if-none-match'], undefined);
  assert.equal(calls[1].headers['if-none-match'], 'W/"one"');
});

test('a remembered answer can\'t be changed by the caller', async () => {
  const { github } = fake([reply(200, { runs: [{ id: 1 }, { id: 2 }] }, { etag: 'W/"one"' }), reply(304)]);
  const first = await github.get('x');
  assert.throws(() => { 'use strict'; first.runs.reverse(); }, TypeError);
  assert.ok(Object.isFrozen(first.runs[0]));
  assert.deepEqual(await github.get('x'), { runs: [{ id: 1 }, { id: 2 }] });
});

test('a changed answer replaces the remembered one', async () => {
  const { calls, github } = fake([reply(200, { n: 1 }, { etag: 'W/"one"' }), reply(200, { n: 2 }, { etag: 'W/"two"' }), reply(304)]);
  await github.get('x');
  assert.deepEqual(await github.get('x'), { n: 2 });
  assert.deepEqual(await github.get('x'), { n: 2 });
  assert.equal(calls[2].headers['if-none-match'], 'W/"two"');
});

test('an error throws with the status and GitHub\'s message', async () => {
  const { github } = fake([reply(404, { message: 'Not Found' }), reply(500, '<html>broken</html>')]);
  const error = await github.get('repos/a/b/actions/variables/CI_RUNNER').catch((caught) => caught);
  assert.ok(error instanceof GitHubError);
  assert.equal(error.status, 404);
  assert.equal(error.message, 'Not Found (HTTP 404)');
  await assert.rejects(github.get('y'), { status: 500, message: 'HTTP 500' });
});

test('writing sends the body as JSON and returns the answer', async () => {
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

test('if GitHub rejects the token, it is renewed once and retried', async () => {
  const renewed = [];
  const { calls, github } = fake([reply(401, { message: 'Bad credentials' }), reply(200, { a: 1 })], { renew: async (old) => { renewed.push(old); return 'ghu_two_token'; } });
  assert.deepEqual(await github.get('x'), { a: 1 });
  assert.deepEqual(renewed, ['ghu_one_token']);
  assert.equal(calls[1].headers.authorization, 'Bearer ghu_two_token');
});

test('without a new token the error stays, and it doesn\'t retry endlessly', async () => {
  const { calls, github } = fake([reply(401, { message: 'Bad credentials' }), reply(401, { message: 'Bad credentials' })], { renew: async () => 'ghu_two_token' });
  await assert.rejects(github.get('x'), { status: 401 });
  assert.equal(calls.length, 2);
  const none = fake([reply(401, { message: 'Bad credentials' })]);
  await assert.rejects(none.github.send('POST', 'x'), { status: 401 });
  assert.equal(none.calls.length, 1);
});

test('if GitHub doesn\'t answer, that is a message, not a crash', async () => {
  const unreachable = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const timeout = Object.assign(new Error('too late'), { name: 'TimeoutError' });
  const { github } = fake([unreachable, timeout]);
  await assert.rejects(github.get('x'), (error) => error.msg.key === 'm_githubUnreachable' && error.msg.args[0] === 'ENOTFOUND');
  await assert.rejects(github.get('x'), (error) => error.msg.key === 'm_githubSilent');
});

test('the state of the limit comes from the headers', async () => {
  const { github } = fake([reply(200, {}, { remaining: 4368 })]);
  assert.equal(github.quota(), null);
  assert.equal(stateOf(github), 'unknown');
  await github.get('x');
  assert.deepEqual(github.quota(), { limit: 5000, remaining: 4368, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok', tightAt: 0.85 });
});

test('headers of another limit (such as search) don\'t count', async () => {
  const { github } = fake([reply(200, {}, { remaining: 3, headers: { 'x-ratelimit-resource': 'search' } })]);
  await github.get('x');
  assert.equal(github.quota(), null);
});

test('below 15 % it is tight, at the reserve it stops', async () => {
  const { github } = fake([reply(200, {}, { remaining: 749 }), reply(200, {}, { remaining: 101 }), reply(200, {}, { remaining: 100 })]);
  await github.get('x');
  assert.equal(stateOf(github), 'tight');
  await github.get('x');
  assert.equal(stateOf(github), 'tight');
  await github.get('x');
  assert.equal(stateOf(github), 'out');
});

test('rate_limit gives the state, even without other queries', async () => {
  const { calls, github } = fake([limit(40), new TypeError('fetch failed')]);
  await github.refreshQuota();
  assert.equal(calls[0].url, 'https://api.github.com/rate_limit');
  assert.equal(stateOf(github), 'out');
  await github.refreshQuota(); // fails: the last state stays
  assert.equal(github.quota().remaining, 40);
});

test('refreshQuota without a sign-in doesn\'t throw and doesn\'t ask', async () => {
  const { calls, github } = fake([], { token: null });
  assert.equal(await github.refreshQuota(), null);
  assert.equal(calls.length, 0);
});

test('refreshQuota reports only when the state flips', async () => {
  const { github } = fake([limit(4000), limit(3900), limit(500), limit(400), limit(4900)]);
  assert.deepEqual(await github.refreshQuota(), { limit: 5000, remaining: 4000, resetAt: new Date(RESET * 1000).toISOString(), state: 'ok', tightAt: 0.85, before: 'unknown', paused: false });
  assert.equal(await github.refreshQuota(), null);
  assert.partialDeepStrictEqual(await github.refreshQuota(), { state: 'tight', before: 'ok', remaining: 500 });
  assert.equal(await github.refreshQuota(), null);
  assert.partialDeepStrictEqual(await github.refreshQuota(), { state: 'ok', before: 'tight' });
});

test('after the end of the window the state is unknown until a new one arrives', async () => {
  let time = NOW;
  const { github } = fake([reply(200, {}, { remaining: 0 })], { now: () => time });
  await github.get('x');
  assert.equal(stateOf(github), 'out');
  time = RESET * 1000 + 1;
  assert.equal(stateOf(github), 'unknown');
  assert.equal(github.quota(), null);
  assert.equal(github.mayPoll('owner/repo'), true);
});

test('a nonsensical window end is no state', async () => {
  const { github } = fake([limit(0, 9e15)]);
  assert.equal(await github.refreshQuota(), null);
  assert.equal(github.quota(), null);
});

test('with a tight limit the same thing is polled at most once a minute', async () => {
  let time = NOW;
  const { github } = fake([limit(500)], { now: () => time });
  assert.equal(github.mayPoll('owner/repo'), true); // no state yet: as usual
  await github.refreshQuota();
  assert.equal(github.mayPoll('owner/repo'), true);
  assert.equal(github.mayPoll('owner/repo'), false);
  assert.equal(github.mayPoll('owner/other'), true);
  time += 60000;
  assert.equal(github.mayPoll('owner/repo'), true);
});

test('with a used-up limit there is no more reading, but writing still works', async () => {
  const { calls, github } = fake([limit(100), reply(201, { encoded_jit_config: 'x' })]);
  await github.refreshQuota();
  assert.equal(github.mayPoll('owner/repo'), false);
  await assert.rejects(github.get('repos/owner/repo'), /rate limit is used up/);
  assert.deepEqual(await github.send('POST', 'repos/owner/repo/actions/runners/generate-jitconfig', { name: 'n' }), { encoded_jit_config: 'x' });
  assert.equal(calls.length, 2); // rate_limit and the write; the read query didn't go out
});

test('if GitHub asks for a pause, nothing is read until then', async () => {
  let time = NOW;
  const { calls, github } = fake([reply(403, { message: 'You have exceeded a secondary rate limit' }, { headers: { 'retry-after': '90' } }), reply(200, { a: 1 })], { now: () => time });
  await assert.rejects(github.get('x'), /secondary rate limit/);
  assert.equal(stateOf(github), 'out');
  assert.equal(github.quota().resetAt, new Date(NOW + 90000).toISOString());
  assert.equal(github.mayPoll('owner/repo'), false);
  await assert.rejects(github.get('x'), /asks for a pause/);
  assert.equal(calls.length, 1);
  time += 90001;
  assert.equal(stateOf(github), 'ok');
  assert.deepEqual(await github.get('x'), { a: 1 });
});

test('a requested pause holds even beyond the end of the window', async () => {
  let time = NOW;
  const { github } = fake([reply(429, {}, { headers: { 'retry-after': '900' } })], { now: () => time });
  await assert.rejects(github.get('x'));
  time = RESET * 1000 + 1000; // the window has expired, the pause (15 min) not yet
  assert.equal(github.mayPoll('owner/repo'), false);
  await assert.rejects(github.get('x'), /asks for a pause/);
});

test('the interval with a tight limit can be chosen larger per thing', async () => {
  let time = NOW;
  const { github } = fake([limit(500)], { now: () => time });
  await github.refreshQuota();
  assert.equal(github.mayPoll('waiting runs', 300000), true);
  time += 100000;
  assert.equal(github.mayPoll('waiting runs', 300000), false);
  time += 200000;
  assert.equal(github.mayPoll('waiting runs', 300000), true);
});

test('a runner GitHub no longer knows counts as removed', async () => {
  const sent = [];
  const github = (status) => ({ send: async (method, path) => { sent.push(`${method} ${path}`); if (status) throw new GitHubError(status, 'x'); return null; } });
  await unregisterRunner(github(0), 'owner/App', 7);
  await unregisterRunner(github(404), 'owner/App', 8);
  await assert.rejects(unregisterRunner(github(403), 'owner/App', 9), { status: 403 });
  assert.deepEqual(sent, ['DELETE repos/owner/App/actions/runners/7', 'DELETE repos/owner/App/actions/runners/8', 'DELETE repos/owner/App/actions/runners/9']);
});
