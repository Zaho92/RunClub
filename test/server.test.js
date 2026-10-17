const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createServer, mergeActions, readBody, BODY_MAX } = require('../src/server');
const { createAccess } = require('../src/access');

const TOKEN = 'token-of-the-page';

// A service on a free port, with page and a font in a folder of its own. `called` holds the calls.
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-server-'));
  fs.writeFileSync(path.join(dir, 'ui.html'), '<script nonce="__NONCE__">const TOKEN = \'__TOKEN__\';</script>');
  fs.mkdirSync(path.join(dir, 'fonts'));
  fs.writeFileSync(path.join(dir, 'fonts', 'mona.woff2'), 'font');
  const s = { called: [] };
  const server = createServer({
    // Access depends on the port, which exists only after `listen`: until then just a reference to it.
    access: new Proxy({}, { get: (_, key) => s.access[key] }),
    token: TOKEN, uiFile: path.join(dir, 'ui.html'), fontsDir: path.join(dir, 'fonts'),
    routes: { status: () => ({ ok: 'status' }), dayMinutes: () => [1], log: () => ({ stamp: 's', entries: [] }), logFile: () => 'whole file', repos: async () => { if (s.reposFail) throw new Error(s.reposFail); return ['owner/App']; } },
    actions: () => ({ 'pool/set': async (body) => { s.called.push(body); if (body.fail) throw new Error('does not work'); } }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  s.port = server.address().port;
  s.access = createAccess({ port: s.port, key: 'secretkey' });
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
  s.cookie = { cookie: 'rc=secretkey' };
  return s;
}

test('without the key there is only the ping and the fonts; a foreign host gets nothing', async (t) => {
  const s = await serve(t);
  assert.equal((await s.request('GET', '/api/ping')).code, 200);
  const font = await s.request('GET', '/fonts/mona.woff2');
  assert.deepEqual([font.code, font.text, font.headers['content-type']], [200, 'font', 'font/woff2']);
  // Only fonts from their folder, even with the key: no way leads out.
  for (const url of ['/fonts/..%2Fui.html', '/fonts/../ui.html', '/fonts/missing.woff2', '/fonts/MONA.woff2']) assert.equal((await s.request('GET', url, { headers: s.cookie })).code, 404, url);
  for (const url of ['/', '/api/status', '/api/log/file', '/api/repos']) assert.equal((await s.request('GET', url)).code, 403, url);
  assert.equal((await s.request('GET', '/api/ping', { headers: { host: 'evil.example:80' } })).code, 403);
  assert.equal((await s.request('GET', '/api/status', { headers: { ...s.cookie, host: 'evil.example' } })).code, 403);
});

test('the entry swaps the key for a cookie; a wrong key gets none', async (t) => {
  const s = await serve(t);
  const entry = await s.request('GET', '/?key=secretkey');
  assert.equal(entry.code, 302);
  assert.equal(entry.headers.location, '/');
  assert.match(entry.headers['set-cookie'][0], /^rc=secretkey; HttpOnly; SameSite=Strict/);
  const wrong = await s.request('GET', '/?key=wrong');
  assert.deepEqual([wrong.code, wrong.headers['set-cookie']], [403, undefined]);
});

test('with the cookie: the page with token and a fresh nonce, plus the data', async (t) => {
  const s = await serve(t);
  const page = await s.request('GET', '/', { headers: s.cookie });
  const nonce = page.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  assert.equal(page.text, `<script nonce="${nonce}">const TOKEN = '${TOKEN}';</script>`);
  assert.notEqual((await s.request('GET', '/', { headers: s.cookie })).headers['content-security-policy'], page.headers['content-security-policy']);
  assert.deepEqual((await s.request('GET', '/api/status', { headers: s.cookie })).json(), { ok: 'status' });
  assert.deepEqual((await s.request('GET', '/api/log', { headers: s.cookie })).json(), { stamp: 's', entries: [] });
  const file = await s.request('GET', '/api/log/file', { headers: s.cookie });
  assert.deepEqual([file.text, file.headers['content-disposition']], ['whole file', 'attachment; filename="runclub.log"']);
  assert.deepEqual((await s.request('GET', '/api/repos', { headers: s.cookie })).json(), ['owner/App']);
  s.reposFail = 'HTTP 502';
  const failed = await s.request('GET', '/api/repos', { headers: s.cookie });
  assert.deepEqual([failed.code, failed.json()], [502, { error: 'HTTP 502' }]);
  assert.equal((await s.request('GET', '/does-not-exist', { headers: s.cookie })).code, 404);
});

test('calls need cookie and token; unknown and inherited names don\'t exist', async (t) => {
  const s = await serve(t);
  const post = (name, headers, body = '{}') => s.request('POST', `/api/${name}`, { headers, body });
  assert.equal((await post('pool/set', { 'x-rc-token': TOKEN })).code, 403); // without cookie
  const stale = await post('pool/set', s.cookie);
  assert.deepEqual([stale.code, stale.json()], [403, { error: 'The page is out of date – please reload.', msg: { key: 'm_pageStale', args: [] } }]);
  for (const name of ['nothing', 'constructor', '__proto__', 'hasOwnProperty']) assert.equal((await post(name, { ...s.cookie, 'x-rc-token': TOKEN })).code, 404, name);
  const done = await post('pool/set', { ...s.cookie, 'x-rc-token': TOKEN }, '{"repo":"owner/App"}');
  assert.deepEqual([done.code, done.json()], [200, { ok: true }]);
  const failed = await post('pool/set', { ...s.cookie, 'x-rc-token': TOKEN }, '{"fail":true}');
  assert.deepEqual([failed.code, failed.json()], [400, { error: 'does not work' }]);
  assert.deepEqual(s.called, [{ repo: 'owner/App' }, { fail: true }]);
});

test('a call must be a JSON object and must not be too large', async (t) => {
  const s = await serve(t);
  const post = (body) => s.request('POST', '/api/pool/set', { headers: { ...s.cookie, 'x-rc-token': TOKEN }, body });
  for (const body of ['[1]', 'null', '"text"', '{broken']) assert.deepEqual((await post(body)).json(), { error: 'The request is not a valid JSON object.', msg: { key: 'm_bodyNotJson', args: [] } }, body);
  assert.deepEqual((await post('')).json(), { ok: true }); // without a body: an empty object
  const big = await post(JSON.stringify({ text: 'x'.repeat(BODY_MAX) })).catch((error) => ({ error }));
  assert.ok(big.error || big.code === 400); // refused; the connection may break off doing so
  assert.deepEqual(s.called, [{}]);
});

test('calls of the app and from actions.js are merged; a name can\'t exist twice', () => {
  const own = async () => {};
  const app = async () => {};
  assert.deepEqual(Object.keys(mergeActions({ 'pool/set': own }, { 'app/autostart': app })), ['pool/set', 'app/autostart']);
  assert.throws(() => mergeActions({ shutdown: own }, { shutdown: app }), { message: 'The call shutdown exists twice.' });
});

test('if the connection breaks off mid-call, the waiting ends with an error', async () => {
  // A fake request: data arrives, then it closes without being complete.
  const closed = Object.assign(new EventEmitter(), { complete: false, destroy() {} });
  const reading = readBody(closed);
  closed.emit('data', '{"repo":');
  closed.emit('close');
  await assert.rejects(reading, { message: 'The request did not arrive completely.' });

  const failed = Object.assign(new EventEmitter(), { complete: false, destroy() {} });
  const broken = readBody(failed);
  failed.emit('error', new Error('read ECONNRESET'));
  await assert.rejects(broken, { message: 'read ECONNRESET' });

  // A complete request closes too; that doesn't change its result.
  const whole = Object.assign(new EventEmitter(), { complete: true, destroy() {} });
  const read = readBody(whole);
  whole.emit('data', '{"repo":"owner/App"}');
  whole.emit('end');
  whole.emit('close');
  assert.deepEqual(await read, { repo: 'owner/App' });
});
