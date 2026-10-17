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
const grant = (n, extra) => ({ access_token: `ghu_token_nummer_${n}`, expires_in: 28800, refresh_token: `ghr_schluessel_${n}`, refresh_token_expires_in: 15897600, token_type: 'bearer', ...extra });
// Verschlüsseln nachgestellt: umgedreht und mit Kennung davor, damit der Klartext nicht in der Datei steht.
const secrets = { encrypt: (buffer) => Buffer.concat([Buffer.from('X:'), Buffer.from(buffer).reverse()]), decrypt: (buffer) => { assert.equal(buffer.subarray(0, 2).toString(), 'X:'); return Buffer.from(buffer.subarray(2)).reverse(); } };

// GitHub nachgestellt. `world.device` beantwortet die Bitte um einen Code, `world.tokens` der Reihe nach die Abfragen
// nach dem Token (auch das Erneuern), `world.user` die Frage nach dem Konto. Warten (`wait`) geht erst weiter, wenn der
// Test `step()` ruft, oder wenn abgebrochen wird.
function fake({ stored, file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-auth-')), 'github.token'), withSecrets = true } = {}) {
  const world = { now: NOW, device: json(200, { device_code: 'geraet', user_code: CODE, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }), tokens: [], user: () => json(200, { login: 'Zaho92' }), accounts: 0 };
  const calls = [];
  const logs = [];
  const waits = [];
  const fetch = async (url, options = {}) => {
    const form = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : null;
    calls.push({ url, form, authorization: options.headers?.authorization });
    if (url === 'https://github.com/login/device/code') return typeof world.device === 'function' ? world.device() : world.device;
    if (url === 'https://github.com/login/oauth/access_token') {
      const next = world.tokens.shift();
      if (!next) throw new Error('keine Antwort vorbereitet');
      return typeof next === 'function' ? next(form) : next;
    }
    if (url === 'https://api.github.com/user') return world.user(options.headers.authorization);
    throw new Error(`unerwartet: ${url}`);
  };
  const wait = (ms, signal) => new Promise((resolve) => { waits.push({ ms, resolve }); signal?.addEventListener('abort', resolve, { once: true }); });
  if (stored) fs.writeFileSync(file, secrets.encrypt(Buffer.from(JSON.stringify(stored))));
  const make = () => createAuth({ file, secrets: withSecrets ? secrets : null, fetch, wait, now: () => world.now, log: (text) => logs.push(render(text)), onAccount: () => { world.accounts += 1; } });
  const auth = make();
  // Das nächste Warten beenden und laufen lassen, was dann läuft.
  const step = async () => { await until(() => waits.length); waits.shift().resolve(); await settle(); };
  const posts = (url) => calls.filter((call) => call.url === url);
  return { auth, world, calls, logs, waits, step, file, make, posts };
}
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const saved = (file) => JSON.parse(secrets.decrypt(fs.readFileSync(file)).toString('utf8'));
const STORED = { token: 'ghu_gesichert_eins', expiresAt: NOW + 8 * HOUR, refresh: 'ghr_gesichert_eins', refreshExpiresAt: NOW + 4000 * HOUR, login: 'Zaho92' };

test('ohne gesichertes Token ist niemand angemeldet; die Links stehen im Stand', () => {
  const { auth } = fake();
  assert.deepEqual(auth.view(), { state: 'out', login: null, flow: null, install: INSTALL_URL, revoke: REVOKE_URL });
  assert.equal(auth.signedIn(), null);
  assert.match(INSTALL_URL, /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/);
  assert.ok(REVOKE_URL.startsWith('https://github.com/'));
});

test('Anmelden: Code zeigen, fragen bis bestätigt, dann angemeldet und gesichert', async () => {
  const env = fake();
  const { auth, world, logs, step, file } = env;
  const shown = await auth.login();
  assert.deepEqual(shown.flow, { state: 'waiting', code: CODE, url: 'https://github.com/login/device', why: null, error: null });
  assert.deepEqual(env.posts('https://github.com/login/device/code')[0].form, { client_id: CLIENT_ID });
  world.tokens.push(json(200, { error: 'authorization_pending' }), json(200, { error: 'slow_down', interval: 10 }), json(200, grant(1)));
  await step();
  await step();
  assert.equal(env.waits[0].ms, 10000); // GitHub bat um langsameres Fragen
  await step();
  assert.deepEqual(env.posts(TOKEN_URL)[0].form, { client_id: CLIENT_ID, device_code: 'geraet', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  assert.equal(auth.view().state, 'in');
  assert.equal(auth.view().login, 'Zaho92');
  assert.equal(auth.view().flow.state, 'done');
  assert.equal(auth.view().flow.code, null);
  assert.equal(world.accounts, 1);
  assert.equal(await auth.token(), 'ghu_token_nummer_1');
  assert.deepEqual(logs, ['Bei GitHub angemeldet als Zaho92.']);
  // Gesichert, aber nicht im Klartext.
  assert.equal(fs.readFileSync(file).includes('ghu_token_nummer_1'), false);
  assert.partialDeepStrictEqual(saved(file), { token: 'ghu_token_nummer_1', refresh: 'ghr_schluessel_1', login: 'Zaho92', expiresAt: NOW + 8 * HOUR });
});

test('ohne slow_down-Angabe wird fünf Sekunden länger gewartet', async () => {
  const { auth, world, waits, step } = fake();
  await auth.login();
  assert.equal(waits[0].ms, 5000);
  world.tokens.push(json(200, { error: 'slow_down' }));
  await step();
  assert.equal(waits[0].ms, 10000);
  await auth.cancel();
});

test('abgelehnt, verfallen oder ein Fehler von GitHub: gescheitert mit Grund', async () => {
  for (const [answer, why, error] of [[{ error: 'access_denied' }, 'denied', null], [{ error: 'expired_token' }, 'late', null], [{ error: 'unsupported_grant_type', error_description: 'Kaputt.' }, 'github', 'Kaputt.']]) {
    const { auth, world, step } = fake();
    await auth.login();
    world.tokens.push(json(200, answer));
    await step();
    assert.deepEqual(auth.view().flow, { state: 'failed', code: null, url: null, why, error });
    assert.equal(auth.view().state, 'out');
  }
});

test('nach Ablauf der Zeit des Codes ist es zu spät, ohne weitere Frage', async () => {
  const { auth, world, step, posts } = fake();
  await auth.login();
  world.now += 901000;
  await step();
  assert.equal(auth.view().flow.why, 'late');
  assert.equal(posts(TOKEN_URL).length, 0);
});

test('ist GitHub kurz nicht erreichbar, wird weiter gefragt', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  world.tokens.push(() => { throw new TypeError('fetch failed'); }, json(200, grant(1)));
  await step();
  assert.equal(auth.view().flow.state, 'waiting');
  await step();
  assert.equal(auth.view().state, 'in');
});

test('scheitert schon die Bitte um einen Code, antwortet login mit dem Grund', async () => {
  const disabled = fake();
  disabled.world.device = json(400, { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App' });
  assert.deepEqual((await disabled.auth.login()).flow, { state: 'failed', code: null, url: null, why: 'github', error: 'Device Flow must be explicitly enabled for this App' });
  const strange = fake();
  strange.world.device = json(200, { device_code: 'x', user_code: '<b>nein</b>', interval: 5 });
  assert.equal((await strange.auth.login()).flow.why, 'github');
  const offline = fake();
  offline.world.device = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.deepEqual((await offline.auth.login()).flow, { state: 'failed', code: null, url: null, why: 'github', error: 'ENOTFOUND' });
});

test('Abbrechen beendet das Fragen; ein neuer Ablauf ist danach möglich', async () => {
  const { auth, posts } = fake();
  await auth.login();
  await assert.rejects(auth.login(), /läuft schon eine Anmeldung/);
  await auth.cancel();
  assert.equal(auth.view().flow.state, 'cancelled');
  assert.equal(auth.view().flow.code, null);
  await settle();
  assert.equal(posts(TOKEN_URL).length, 0);
  assert.equal((await auth.login()).flow.state, 'waiting');
  await auth.cancel();
});

test('nach close beginnt kein Ablauf mehr, ein laufender endet', async () => {
  const { auth } = fake();
  await auth.login();
  await auth.close();
  assert.equal(auth.view().flow.state, 'cancelled');
  await assert.rejects(auth.login(), /beendet/);
});

test('ein gesichertes Token gilt nach dem Start; poll prüft es einmal bei GitHub', async () => {
  const { auth, calls } = fake({ stored: STORED });
  assert.equal(auth.view().state, 'in');
  assert.equal(auth.signedIn(), 'Zaho92');
  await auth.poll();
  await auth.poll();
  assert.deepEqual(calls.map((call) => call.url), ['https://api.github.com/user']);
  assert.equal(calls[0].authorization, 'Bearer ghu_gesichert_eins');
});

test('ein unlesbares gesichertes Token zählt nicht', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-auth-')), 'github.token');
  fs.writeFileSync(file, 'kein Geheimnis');
  assert.equal(fake({ file }).auth.view().state, 'out');
});

test('ohne Verschlüsselung bleibt das Token nur im Speicher', async () => {
  const { auth, world, step, file } = fake({ withSecrets: false });
  await auth.login();
  world.tokens.push(json(200, grant(1)));
  await step();
  assert.equal(auth.view().state, 'in');
  assert.equal(fs.existsSync(file), false);
});

test('kurz vor Ablauf wird erneuert, einmal für alle, und der neue Schlüssel ist vorher gesichert', async () => {
  const env = fake({ stored: STORED });
  const { auth, world, file } = env;
  world.now = STORED.expiresAt - 4 * 60000; // weniger als fünf Minuten übrig
  let savedFirst = null;
  world.tokens.push((form) => { assert.deepEqual(form, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'ghr_gesichert_eins' }); return json(200, grant(2)); });
  const origin = fs.renameSync;
  fs.renameSync = (from, to) => { origin(from, to); if (to === file) savedFirst ??= saved(file).refresh; };
  try {
    assert.deepEqual(await Promise.all([auth.token(), auth.token()]), ['ghu_token_nummer_2', 'ghu_token_nummer_2']);
  } finally { fs.renameSync = origin; }
  assert.equal(env.posts(TOKEN_URL).length, 1);
  assert.equal(savedFirst, 'ghr_schluessel_2');
  assert.equal(saved(file).token, 'ghu_token_nummer_2');
});

test('lehnt GitHub ein Token ab, wird erneuert; ein schon erneuertes wird nicht noch einmal erneuert', async () => {
  const env = fake({ stored: STORED });
  env.world.tokens.push(json(200, grant(2)));
  assert.equal(await env.auth.renew('ghu_gesichert_eins'), 'ghu_token_nummer_2');
  assert.equal(await env.auth.renew('ghu_gesichert_eins'), 'ghu_token_nummer_2');
  assert.equal(env.posts(TOKEN_URL).length, 1);
});

test('nimmt GitHub den Schlüssel nicht mehr an, ist der Nutzer abgemeldet', async () => {
  const { auth, world, logs, file } = fake({ stored: STORED });
  world.tokens.push(json(200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }));
  assert.equal(await auth.renew('ghu_gesichert_eins'), null);
  assert.equal(auth.view().state, 'out');
  assert.equal(await auth.token(), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(logs, ['GitHub nimmt die Anmeldung von Zaho92 nicht mehr an; bitte neu anmelden.']);
});

test('ist GitHub beim Erneuern nicht erreichbar, bleibt die Anmeldung', async () => {
  const { auth, world } = fake({ stored: STORED });
  world.tokens.push(() => { throw new TypeError('fetch failed'); });
  assert.equal(await auth.renew('ghu_gesichert_eins'), null);
  assert.equal(auth.view().state, 'in');
  assert.equal(await auth.token(), 'ghu_gesichert_eins');
});

test('beim Prüfen nach dem Start wird ein abgelehntes Token erneuert', async () => {
  const { auth, world, calls } = fake({ stored: STORED });
  world.user = (authorization) => (authorization === 'Bearer ghu_gesichert_eins' ? json(401, { message: 'Bad credentials' }) : json(200, { login: 'Zaho92' }));
  world.tokens.push(json(200, grant(2)));
  await auth.poll();
  assert.equal(auth.view().state, 'in');
  assert.equal(await auth.token(), 'ghu_token_nummer_2');
  assert.equal(calls.filter((call) => call.url.endsWith('/user')).length, 2);
});

test('Abmelden vergisst das Token auf diesem Rechner, ohne GitHub zu fragen', async () => {
  const { auth, calls, logs, file } = fake({ stored: STORED });
  await auth.logout();
  assert.equal(auth.view().state, 'out');
  assert.equal(await auth.token(), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, ['Bei GitHub abgemeldet (Zaho92).']);
  await assert.rejects(auth.logout(), /nicht bei GitHub angemeldet/);
});

test('wer angemeldet ist, meldet sich nicht noch einmal an; während des Anmeldens wird nicht abgemeldet', async () => {
  const signedIn = fake({ stored: STORED });
  await assert.rejects(signedIn.auth.login(), /schon als Zaho92 angemeldet/);
  const running = fake();
  await running.auth.login();
  await assert.rejects(running.auth.logout(), /laufende Anmeldung/);
  await running.auth.cancel();
});

test('Code und Token stehen nie im Protokoll', async () => {
  const { auth, world, logs, step } = fake();
  await auth.login();
  world.tokens.push(json(200, grant(1)));
  await step();
  await auth.logout();
  assert.equal(logs.some((line) => line.includes(CODE) || line.includes('ghu_') || line.includes('ghr_')), false);
});

test('lehnt GitHub ein Token ab und ist der Schlüssel abgelaufen, ist der Nutzer abgemeldet', async () => {
  const { auth, calls } = fake({ stored: { ...STORED, refreshExpiresAt: NOW - 1 } });
  assert.equal(await auth.renew('ghu_gesichert_eins'), null);
  assert.equal(auth.view().state, 'out');
  assert.deepEqual(calls, []);
});

test('ließ sich ein neuer Stand nicht an seinen Platz bringen, gilt er beim nächsten Start', async () => {
  const env = fake({ stored: STORED });
  const draft = `${env.file}.neu`;
  env.world.tokens.push(json(200, grant(2)));
  const origin = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('belegt'), { code: 'EBUSY' }); };
  try { assert.equal(await env.auth.renew('ghu_gesichert_eins'), 'ghu_token_nummer_2'); } finally { fs.renameSync = origin; }
  assert.ok(fs.existsSync(draft));
  fs.utimesSync(draft, new Date(), new Date(Date.now() + 1000));
  assert.match(env.logs[0], /ließ sich nicht sichern/);
  assert.equal(await env.make().token(), 'ghu_token_nummer_2');
});

test('Abmelden löscht auch einen liegengebliebenen neuen Stand', async () => {
  const { auth, file } = fake({ stored: STORED });
  fs.writeFileSync(`${file}.neu`, secrets.encrypt(Buffer.from(JSON.stringify(STORED))));
  await auth.logout();
  assert.equal(fs.existsSync(`${file}.neu`), false);
  assert.equal(fs.existsSync(file), false);
});

test('nach der Bestätigung wird das Konto bei einem Aussetzer noch einmal erfragt', async () => {
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

test('nennt GitHub kein Konto, scheitert der Ablauf ohne eigenen Satz als Text von GitHub', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  world.user = () => json(200, { login: '' });
  world.tokens.push(json(200, grant(1)));
  await step();
  await step();
  await step();
  assert.deepEqual(auth.view().flow, { state: 'failed', code: null, url: null, why: 'github', error: null });
});

test('ein gescheiterter Ablauf steht im Protokoll, eine Ablehnung nicht', async () => {
  for (const [answer, expected] of [[{ error: 'expired_token' }, ['Anmeldung bei GitHub gescheitert: der Code wurde nicht rechtzeitig bestätigt']], [{ error: 'access_denied' }, []], [{ error: 'x', error_description: 'Kaputt.' }, ['Anmeldung bei GitHub gescheitert: Kaputt.']]]) {
    const { auth, world, logs, step } = fake();
    await auth.login();
    world.tokens.push(json(200, answer));
    await step();
    assert.deepEqual(logs, expected);
  }
});

test('lehnt GitHub das neue Token beim Erfragen des Kontos ab, wird nicht wiederholt', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  let asked = 0;
  world.user = () => { asked += 1; return json(401, { message: 'Bad credentials' }); };
  world.tokens.push(json(200, grant(1)));
  await step();
  assert.equal(asked, 1);
  assert.equal(auth.view().flow.state, 'failed');
});

test('beim Beenden endet auch ein Ablauf, der nach der Bestätigung noch das Konto erfragt', async () => {
  const { auth, world, step } = fake();
  await auth.login();
  world.user = () => json(502, {});
  world.tokens.push(json(200, grant(1)));
  await step();
  await auth.close();
  assert.equal(auth.view().flow.state, 'failed');
  assert.equal(auth.view().state, 'out');
});

test('lässt sich beim Abmelden eine Datei nicht löschen, sagt das Protokoll welche, und die andere geht trotzdem', async () => {
  const { auth, file, logs } = fake({ stored: STORED });
  fs.writeFileSync(`${file}.neu`, 'x');
  const origin = fs.rmSync;
  fs.rmSync = (name, options) => { if (name.endsWith('.neu')) throw new Error('belegt'); return origin(name, options); };
  try { await auth.logout(); } finally { fs.rmSync = origin; }
  assert.equal(fs.existsSync(file), false);
  assert.match(logs[0], /^github\.token\.neu ließ sich nicht löschen \(belegt\)/);
});
