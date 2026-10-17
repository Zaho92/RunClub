const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuth, CLIENT_ID, INSTALL_URL, REVOKE_URL } = require('../src/auth');
const { render } = require('../src/messages');
const { settle, until } = require('./support');

const CODE = 'AB12-CD34';
const NOW = 1791900000000;
const HOUR = 3600000;
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), json: async () => body });
const grant = (n, extra) => ({ access_token: `ghu_token_number_${n}`, expires_in: 28800, refresh_token: `ghr_key_number_${n}`, refresh_token_expires_in: 15897600, token_type: 'bearer', ...extra });
// Encryption faked: reversed and with a marker in front, so the plain text is not in the file.
const secrets = { encrypt: (buffer) => Buffer.concat([Buffer.from('X:'), Buffer.from(buffer).reverse()]), decrypt: (buffer) => { assert.equal(buffer.subarray(0, 2).toString(), 'X:'); return Buffer.from(buffer.subarray(2)).reverse(); } };

// GitHub faked. `world.device` answers the request for a code, `world.tokens` in turn the requests
// for the token (renewing too), `world.user` the question for the account. Waiting (`wait`) only goes on when the
// test calls `step()`, or when aborted.
function fake({ stored, file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-auth-')), 'github.token'), withSecrets = true } = {}) {
  const world = { now: NOW, device: json(200, { device_code: 'device', user_code: CODE, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }), tokens: [], user: () => json(200, { login: 'Zaho92' }), accounts: 0 };
  const calls = [];
  const logs = [];
  const waits = [];
  const fetch = async (url, options = {}) => {
    const form = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : null;
    calls.push({ url, form, authorization: options.headers?.authorization });
    if (url === 'https://github.com/login/device/code') return typeof world.device === 'function' ? world.device() : world.device;
    if (url === 'https://github.com/login/oauth/access_token') {
      const next = world.tokens.shift();
      if (!next) throw new Error('no answer prepared');
      return typeof next === 'function' ? next(form) : next;
    }
    if (url === 'https://api.github.com/user') return world.user(options.headers.authorization);
    throw new Error(`unexpected: ${url}`);
  };
  const wait = (ms, signal) => new Promise((resolve) => { waits.push({ ms, resolve }); signal?.addEventListener('abort', resolve, { once: true }); });
  if (stored) fs.writeFileSync(file, secrets.encrypt(Buffer.from(JSON.stringify(stored))));
  const make = () => createAuth({ file, secrets: withSecrets ? secrets : null, fetch, wait, now: () => world.now, log: (text) => logs.push(render(text)), onAccount: () => { world.accounts += 1; } });
  const auth = make();
  // End the next wait and let run whatever runs then.
  const step = async () => { await until(() => waits.length); waits.shift().resolve(); await settle(); };
  const posts = (url) => calls.filter((call) => call.url === url);
  return { auth, world, calls, logs, waits, step, file, make, posts };
}
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const saved = (file) => JSON.parse(secrets.decrypt(fs.readFileSync(file)).toString('utf8'));
const STORED = { token: 'ghu_saved_one', expiresAt: NOW + 8 * HOUR, refresh: 'ghr_saved_one', refreshExpiresAt: NOW + 4000 * HOUR, login: 'Zaho92' };

test('without a saved token nobody is signed in; the links are in the state', () => {
  const { auth } = fake();
  assert.deepEqual(auth.view(), { state: 'out', login: null, flow: null, install: INSTALL_URL, revoke: REVOKE_URL });
  assert.equal(auth.signedIn(), null);
  assert.match(INSTALL_URL, /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/);
  assert.ok(REVOKE_URL.startsWith('https://github.com/'));
});

test('sign-in: show the code, ask until confirmed, then signed in and saved', async () => {
  const env = fake();
  const { auth, world, logs, step, file } = env;
  const shown = await auth.login();
  assert.deepEqual(shown.flow, { state: 'waiting', code: CODE, url: 'https://github.com/login/device', why: null, error: null });
  assert.deepEqual(env.posts('https://github.com/login/device/code')[0].form, { client_id: CLIENT_ID });
  world.tokens.push(json(200, { error: 'authorization_pending' }), json(200, { error: 'slow_down', interval: 10 }), json(200, grant(1)));
  await step();
  await step();
  assert.equal(env.waits[0].ms, 10000); // GitHub asked for slower polling
  await step();
  assert.deepEqual(env.posts(TOKEN_URL)[0].form, { client_id: CLIENT_ID, device_code: 'device', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  assert.equal(auth.view().state, 'in');
  assert.equal(auth.view().login, 'Zaho92');
  assert.equal(auth.view().flow.state, 'done');
  assert.equal(auth.view().flow.code, null);
  assert.equal(world.accounts, 1);
  assert.equal(await auth.token(), 'ghu_token_number_1');
  assert.deepEqual(logs, ['Signed in to GitHub as Zaho92.']);
  // Saved, but not in plain text.
  assert.equal(fs.readFileSync(file).includes('ghu_token_number_1'), false);
  assert.partialDeepStrictEqual(saved(file), { token: 'ghu_token_number_1', refresh: 'ghr_key_number_1', login: 'Zaho92', expiresAt: NOW + 8 * HOUR });
});

test('without a slow_down interval it waits five seconds longer', async () => {
  const { auth, world, waits, step } = fake();
  await auth.login();
  assert.equal(waits[0].ms, 5000);
  world.tokens.push(json(200, { error: 'slow_down' }));
  await step();
  assert.equal(waits[0].ms, 10000);
  await auth.cancel();
});

test('declined, expired or an error from GitHub: failed with reason', async () => {
  for (const [answer, why, error] of [[{ error: 'access_denied' }, 'denied', null], [{ error: 'expired_token' }, 'late', null], [{ error: 'unsupported_grant_type', error_description: 'Broken.' }, 'github', 'Broken.']]) {
    const { auth, world, step } = fake();
    await auth.login();
    world.tokens.push(json(200, answer));
    await step();
    assert.deepEqual(auth.view().flow, { state: 'failed', code: null, url: null, why, error });
    assert.equal(auth.view().state, 'out');
  }
});

test('once the code time has run out it is too late, without another request', async () => {
  const { auth, world, step, posts } = fake();
  await auth.login();
  world.now += 901000;
  await step();
  assert.equal(auth.view().flow.why, 'late');
  assert.equal(posts(TOKEN_URL).length, 0);
});

test('if GitHub is briefly unreachable, it keeps asking', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  world.tokens.push(() => { throw new TypeError('fetch failed'); }, json(200, grant(1)));
  await step();
  assert.equal(auth.view().flow.state, 'waiting');
  await step();
  assert.equal(auth.view().state, 'in');
});

test('if the request for a code already fails, login answers with the reason', async () => {
  const disabled = fake();
  disabled.world.device = json(400, { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App' });
  assert.deepEqual((await disabled.auth.login()).flow, { state: 'failed', code: null, url: null, why: 'github', error: 'Device Flow must be explicitly enabled for this App' });
  const strange = fake();
  strange.world.device = json(200, { device_code: 'x', user_code: '<b>no</b>', interval: 5 });
  assert.equal((await strange.auth.login()).flow.why, 'github');
  const offline = fake();
  offline.world.device = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.deepEqual((await offline.auth.login()).flow, { state: 'failed', code: null, url: null, why: 'github', error: 'ENOTFOUND' });
});

test('cancelling ends the asking; a new flow is possible afterwards', async () => {
  const { auth, posts } = fake();
  await auth.login();
  await assert.rejects(auth.login(), /sign-in is already running/);
  await auth.cancel();
  assert.equal(auth.view().flow.state, 'cancelled');
  assert.equal(auth.view().flow.code, null);
  await settle();
  assert.equal(posts(TOKEN_URL).length, 0);
  assert.equal((await auth.login()).flow.state, 'waiting');
  await auth.cancel();
});

test('after close no flow begins any more, a running one ends', async () => {
  const { auth } = fake();
  await auth.login();
  await auth.close();
  assert.equal(auth.view().flow.state, 'cancelled');
  await assert.rejects(auth.login(), /shutting down/);
});

test('a saved token applies after the start; poll checks it once at GitHub', async () => {
  const { auth, calls } = fake({ stored: STORED });
  assert.equal(auth.view().state, 'in');
  assert.equal(auth.signedIn(), 'Zaho92');
  await auth.poll();
  await auth.poll();
  assert.deepEqual(calls.map((call) => call.url), ['https://api.github.com/user']);
  assert.equal(calls[0].authorization, 'Bearer ghu_saved_one');
});

test('an unreadable saved token does not count', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-auth-')), 'github.token');
  fs.writeFileSync(file, 'no secret');
  assert.equal(fake({ file }).auth.view().state, 'out');
});

test('without encryption the token stays in memory only', async () => {
  const { auth, world, step, file } = fake({ withSecrets: false });
  await auth.login();
  world.tokens.push(json(200, grant(1)));
  await step();
  assert.equal(auth.view().state, 'in');
  assert.equal(fs.existsSync(file), false);
});

test('shortly before expiry it renews, once for all, and the new key is saved beforehand', async () => {
  const env = fake({ stored: STORED });
  const { auth, world, file } = env;
  world.now = STORED.expiresAt - 4 * 60000; // less than five minutes left
  let savedFirst = null;
  world.tokens.push((form) => { assert.deepEqual(form, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'ghr_saved_one' }); return json(200, grant(2)); });
  const origin = fs.renameSync;
  fs.renameSync = (from, to) => { origin(from, to); if (to === file) savedFirst ??= saved(file).refresh; };
  try {
    assert.deepEqual(await Promise.all([auth.token(), auth.token()]), ['ghu_token_number_2', 'ghu_token_number_2']);
  } finally { fs.renameSync = origin; }
  assert.equal(env.posts(TOKEN_URL).length, 1);
  assert.equal(savedFirst, 'ghr_key_number_2');
  assert.equal(saved(file).token, 'ghu_token_number_2');
});

test('if GitHub rejects a token, it renews; an already renewed one is not renewed again', async () => {
  const env = fake({ stored: STORED });
  env.world.tokens.push(json(200, grant(2)));
  assert.equal(await env.auth.renew('ghu_saved_one'), 'ghu_token_number_2');
  assert.equal(await env.auth.renew('ghu_saved_one'), 'ghu_token_number_2');
  assert.equal(env.posts(TOKEN_URL).length, 1);
});

test('incorrect_client_credentials too (how GitHub answers an already used key) signs out', async () => {
  const { auth, world } = fake({ stored: STORED });
  world.tokens.push(json(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' }));
  assert.equal(await auth.renew('ghu_saved_one'), null);
  assert.equal(auth.view().state, 'out');
});

test('if GitHub no longer accepts the key, the user is signed out', async () => {
  const { auth, world, logs, file } = fake({ stored: STORED });
  world.tokens.push(json(200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }));
  assert.equal(await auth.renew('ghu_saved_one'), null);
  assert.equal(auth.view().state, 'out');
  assert.equal(await auth.token(), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(logs, ['GitHub no longer accepts the sign-in of Zaho92; please sign in again.']);
});

test('if GitHub is unreachable while renewing, the sign-in stays', async () => {
  const { auth, world } = fake({ stored: STORED });
  world.tokens.push(() => { throw new TypeError('fetch failed'); });
  assert.equal(await auth.renew('ghu_saved_one'), null);
  assert.equal(auth.view().state, 'in');
  assert.equal(await auth.token(), 'ghu_saved_one');
});

test('when checking after the start, a rejected token is renewed', async () => {
  const { auth, world, calls } = fake({ stored: STORED });
  world.user = (authorization) => (authorization === 'Bearer ghu_saved_one' ? json(401, { message: 'Bad credentials' }) : json(200, { login: 'Zaho92' }));
  world.tokens.push(json(200, grant(2)));
  await auth.poll();
  assert.equal(auth.view().state, 'in');
  assert.equal(await auth.token(), 'ghu_token_number_2');
  assert.equal(calls.filter((call) => call.url.endsWith('/user')).length, 2);
});

test('signing out forgets the token on this machine without asking GitHub', async () => {
  const { auth, calls, logs, file } = fake({ stored: STORED });
  await auth.logout();
  assert.equal(auth.view().state, 'out');
  assert.equal(await auth.token(), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, ['Signed out of GitHub (Zaho92).']);
  await assert.rejects(auth.logout(), /not signed in to GitHub/);
});

test('whoever is signed in does not sign in again; during sign-in there is no signing out', async () => {
  const signedIn = fake({ stored: STORED });
  await assert.rejects(signedIn.auth.login(), /already signed in as Zaho92/);
  const running = fake();
  await running.auth.login();
  await assert.rejects(running.auth.logout(), /running sign-in/);
  await running.auth.cancel();
});

test('code and token never appear in the log', async () => {
  const { auth, world, logs, step } = fake();
  await auth.login();
  world.tokens.push(json(200, grant(1)));
  await step();
  await auth.logout();
  assert.equal(logs.some((line) => line.includes(CODE) || line.includes('ghu_') || line.includes('ghr_')), false);
});

test('if GitHub rejects a token and the key has expired, the user is signed out', async () => {
  const { auth, calls } = fake({ stored: { ...STORED, refreshExpiresAt: NOW - 1 } });
  assert.equal(await auth.renew('ghu_saved_one'), null);
  assert.equal(auth.view().state, 'out');
  assert.deepEqual(calls, []);
});

test('if a new state could not be moved into place, it applies at the next start', async () => {
  const env = fake({ stored: STORED });
  const draft = `${env.file}.new`;
  env.world.tokens.push(json(200, grant(2)));
  const origin = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  try { assert.equal(await env.auth.renew('ghu_saved_one'), 'ghu_token_number_2'); } finally { fs.renameSync = origin; }
  assert.ok(fs.existsSync(draft));
  fs.utimesSync(draft, new Date(), new Date(Date.now() + 1000));
  assert.match(env.logs[0], /could not be saved/);
  assert.equal(await env.make().token(), 'ghu_token_number_2');
});

test('a newer draft left behind under the legacy name `.neu` still applies at the start', async () => {
  const { file, make } = fake({ stored: STORED });
  fs.writeFileSync(`${file}.neu`, secrets.encrypt(Buffer.from(JSON.stringify({ ...STORED, token: 'ghu_legacy_draft' }))));
  fs.utimesSync(`${file}.neu`, new Date(), new Date(Date.now() + 1000));
  assert.equal(await make().token(), 'ghu_legacy_draft');
});

test('an older draft left behind under the legacy name `.neu` does not displace the saved state', async () => {
  const { file, make } = fake({ stored: STORED });
  fs.writeFileSync(`${file}.neu`, secrets.encrypt(Buffer.from(JSON.stringify({ ...STORED, token: 'ghu_legacy_draft' }))));
  fs.utimesSync(`${file}.neu`, new Date(0), new Date(0));
  assert.equal(await make().token(), 'ghu_saved_one');
});

test('signing out also deletes a leftover draft, under the new and the legacy name', async () => {
  const { auth, file } = fake({ stored: STORED });
  for (const name of [`${file}.new`, `${file}.neu`]) fs.writeFileSync(name, secrets.encrypt(Buffer.from(JSON.stringify(STORED))));
  await auth.logout();
  assert.equal(fs.existsSync(`${file}.new`), false);
  assert.equal(fs.existsSync(`${file}.neu`), false);
  assert.equal(fs.existsSync(file), false);
});

test('after confirmation the account is asked for again after a hiccup', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  let asked = 0;
  world.user = () => { asked += 1; return asked === 1 ? json(502, {}) : json(200, { login: 'Zaho92' }); };
  world.tokens.push(json(200, grant(1)));
  await step();
  await step();
  assert.equal(asked, 2);
  assert.equal(auth.view().state, 'in');
});

test('if GitHub names no account, the flow fails without its own sentence as text from GitHub', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  world.user = () => json(200, { login: '' });
  world.tokens.push(json(200, grant(1)));
  await step();
  await step();
  await step();
  assert.deepEqual(auth.view().flow, { state: 'failed', code: null, url: null, why: 'github', error: null });
});

test('a failed flow is in the log, a refusal is not', async () => {
  for (const [answer, expected] of [[{ error: 'expired_token' }, ['Signing in to GitHub failed: the code was not confirmed in time']], [{ error: 'access_denied' }, []], [{ error: 'x', error_description: 'Broken.' }, ['Signing in to GitHub failed: Broken.']]]) {
    const { auth, world, logs, step } = fake();
    await auth.login();
    world.tokens.push(json(200, answer));
    await step();
    assert.deepEqual(logs, expected);
  }
});

test('if GitHub rejects the new token while asking for the account, it does not retry', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  let asked = 0;
  world.user = () => { asked += 1; return json(401, { message: 'Bad credentials' }); };
  world.tokens.push(json(200, grant(1)));
  await step();
  assert.equal(asked, 1);
  assert.equal(auth.view().flow.state, 'failed');
});

test('on shutdown a flow that is still asking for the account after confirmation ends too', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  world.user = () => json(502, {});
  world.tokens.push(json(200, grant(1)));
  await step();
  await auth.close();
  assert.equal(auth.view().flow.state, 'failed');
  assert.equal(auth.view().state, 'out');
});

test('if a file cannot be deleted on sign-out, the log says which, and the others go anyway', async () => {
  const { auth, file, logs } = fake({ stored: STORED });
  fs.writeFileSync(`${file}.new`, 'x');
  const origin = fs.rmSync;
  fs.rmSync = (name, options) => { if (name.endsWith('.new')) throw new Error('busy'); return origin(name, options); };
  try { await auth.logout(); } finally { fs.rmSync = origin; }
  assert.equal(fs.existsSync(file), false);
  assert.match(logs[0], /^github\.token\.new could not be deleted \(busy\)/);
});
