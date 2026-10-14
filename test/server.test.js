const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer, BODY_MAX } = require('../src/server');
const { createAccess } = require('../src/access');

const TOKEN = 'token-der-seite';

// Ein Dienst auf einem freien Port, mit Seite und einer Schrift in einem eigenen Ordner. `called` hält die Aufrufe.
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-server-'));
  fs.writeFileSync(path.join(dir, 'ui.html'), '<script nonce="__NONCE__">const TOKEN = \'__TOKEN__\';</script>');
  fs.mkdirSync(path.join(dir, 'fonts'));
  fs.writeFileSync(path.join(dir, 'fonts', 'mona.woff2'), 'schrift');
  const s = { called: [] };
  const server = createServer({
    // Der Zugang hängt am Port, den es erst nach `listen` gibt: bis dahin nur ein Verweis darauf.
    access: new Proxy({}, { get: (_, key) => s.access[key] }),
    token: TOKEN, uiFile: path.join(dir, 'ui.html'), fontsDir: path.join(dir, 'fonts'),
    routes: { status: () => ({ ok: 'status' }), dayMinutes: () => [1], log: () => ({ stamp: 's', entries: [] }), logFile: () => 'ganze Datei', repos: async () => { if (s.reposFail) throw new Error(s.reposFail); return ['wer/App']; } },
    actions: () => ({ 'pool/set': async (body) => { s.called.push(body); if (body.fail) throw new Error('geht nicht'); } }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  s.port = server.address().port;
  s.access = createAccess({ port: s.port, key: 'schluessel' });
  t.after(() => server.close());
  s.request = (method, url, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: s.port, method, path: url, headers: { host: `127.0.0.1:${s.port}`, ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ code: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(body);
  });
  s.cookie = { cookie: 'rc=schluessel' };
  return s;
}

test('ohne Schlüssel gibt es nur den Ping und die Schriften; ein fremder Host bekommt nichts', async (t) => {
  const s = await serve(t);
  assert.equal((await s.request('GET', '/api/ping')).code, 200);
  const font = await s.request('GET', '/fonts/mona.woff2');
  assert.deepEqual([font.code, font.text, font.headers['content-type']], [200, 'schrift', 'font/woff2']);
  assert.equal((await s.request('GET', '/fonts/..%2Fui.html')).code, 403);
  assert.equal((await s.request('GET', '/fonts/fehlt.woff2')).code, 403);
  for (const url of ['/', '/api/status', '/api/log/file', '/api/repos']) assert.equal((await s.request('GET', url)).code, 403, url);
  assert.equal((await s.request('GET', '/api/ping', { headers: { host: 'boese.example:80' } })).code, 403);
  assert.equal((await s.request('GET', '/api/status', { headers: { ...s.cookie, host: 'boese.example' } })).code, 403);
});

test('der Einstieg tauscht den Schlüssel gegen ein Cookie; ein falscher Schlüssel bekommt keines', async (t) => {
  const s = await serve(t);
  const entry = await s.request('GET', '/?key=schluessel');
  assert.equal(entry.code, 302);
  assert.equal(entry.headers.location, '/');
  assert.match(entry.headers['set-cookie'][0], /^rc=schluessel; HttpOnly; SameSite=Strict/);
  const wrong = await s.request('GET', '/?key=falsch');
  assert.deepEqual([wrong.code, wrong.headers['set-cookie']], [403, undefined]);
});

test('mit Cookie: die Seite mit Token und frischer Nonce, dazu die Daten', async (t) => {
  const s = await serve(t);
  const page = await s.request('GET', '/', { headers: s.cookie });
  const nonce = page.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  assert.equal(page.text, `<script nonce="${nonce}">const TOKEN = '${TOKEN}';</script>`);
  assert.notEqual((await s.request('GET', '/', { headers: s.cookie })).headers['content-security-policy'], page.headers['content-security-policy']);
  assert.deepEqual((await s.request('GET', '/api/status', { headers: s.cookie })).json(), { ok: 'status' });
  assert.deepEqual((await s.request('GET', '/api/log', { headers: s.cookie })).json(), { stamp: 's', entries: [] });
  const file = await s.request('GET', '/api/log/file', { headers: s.cookie });
  assert.deepEqual([file.text, file.headers['content-disposition']], ['ganze Datei', 'attachment; filename="runclub.log"']);
  assert.deepEqual((await s.request('GET', '/api/repos', { headers: s.cookie })).json(), ['wer/App']);
  s.reposFail = 'HTTP 502';
  const failed = await s.request('GET', '/api/repos', { headers: s.cookie });
  assert.deepEqual([failed.code, failed.json()], [502, { error: 'HTTP 502' }]);
  assert.equal((await s.request('GET', '/gibt-es-nicht', { headers: s.cookie })).code, 404);
});

test('Aufrufe brauchen Cookie und Token; unbekannte und geerbte Namen gibt es nicht', async (t) => {
  const s = await serve(t);
  const post = (name, headers, body = '{}') => s.request('POST', `/api/${name}`, { headers, body });
  assert.equal((await post('pool/set', { 'x-rc-token': TOKEN })).code, 403); // ohne Cookie
  const stale = await post('pool/set', s.cookie);
  assert.deepEqual([stale.code, stale.json()], [403, { error: 'Die Seite ist veraltet – bitte neu laden.' }]);
  for (const name of ['nichts', 'constructor', '__proto__', 'hasOwnProperty']) assert.equal((await post(name, { ...s.cookie, 'x-rc-token': TOKEN })).code, 404, name);
  const done = await post('pool/set', { ...s.cookie, 'x-rc-token': TOKEN }, '{"repo":"wer/App"}');
  assert.deepEqual([done.code, done.json()], [200, { ok: true }]);
  const failed = await post('pool/set', { ...s.cookie, 'x-rc-token': TOKEN }, '{"fail":true}');
  assert.deepEqual([failed.code, failed.json()], [400, { error: 'geht nicht' }]);
  assert.deepEqual(s.called, [{ repo: 'wer/App' }, { fail: true }]);
});

test('ein Aufruf muss ein JSON-Objekt sein und darf nicht zu groß sein', async (t) => {
  const s = await serve(t);
  const post = (body) => s.request('POST', '/api/pool/set', { headers: { ...s.cookie, 'x-rc-token': TOKEN }, body });
  for (const body of ['[1]', 'null', '"text"', '{kaputt']) assert.deepEqual((await post(body)).json(), { error: 'Der Aufruf ist kein gültiges JSON-Objekt.' }, body);
  assert.deepEqual((await post('')).json(), { ok: true }); // ohne Inhalt: ein leeres Objekt
  const big = await post(JSON.stringify({ text: 'x'.repeat(BODY_MAX) })).catch((error) => ({ error }));
  assert.ok(big.error || big.code === 400); // abgewiesen; die Verbindung darf dabei abbrechen
  assert.deepEqual(s.called, [{}]);
});
