const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccess, pageHeaders, newNonce } = require('../src/access');

const access = createAccess({ port: 8770, key: 'geheim' });

test('nur der eigene Rechner unter seinem eigenen Namen', () => {
  assert.equal(access.hostAllowed({ host: 'localhost:8770' }), true);
  assert.equal(access.hostAllowed({ host: '127.0.0.1:8770' }), true);
  assert.equal(access.hostAllowed({ host: 'host.docker.internal:8770' }), false);
  assert.equal(access.hostAllowed({ host: 'evil.example:8770' }), false);
  assert.equal(access.hostAllowed({}), false);
});

test('ohne das Cookie mit dem Schlüssel gibt es keinen Zugriff', () => {
  assert.equal(access.allowed({}), false);
  assert.equal(access.allowed({ cookie: 'rc=falsch' }), false);
  assert.equal(access.allowed({ cookie: 'rc=' }), false);
  assert.equal(access.allowed({ cookie: 'anderes=geheim' }), false);
  assert.equal(access.allowed({ cookie: 'rc=geheim' }), true);
  assert.equal(access.allowed({ cookie: 'a=1; rc=geheim; b=2' }), true);
});

test('die Einstiegsadresse tauscht den Schlüssel gegen das Cookie', () => {
  assert.equal(access.entry, 'http://127.0.0.1:8770/?key=geheim');
  assert.equal(access.entering('/?key=geheim'), true);
  assert.equal(access.entering('/?key=falsch'), false);
  assert.equal(access.entering('/?key='), false);
  assert.equal(access.entering('/'), null);
  assert.equal(access.entering('/api/status?key=geheim'), null);
  assert.match(access.cookie, /^rc=geheim; HttpOnly; SameSite=Strict/);
});

test('jeder Programmlauf hat seinen eigenen Schlüssel', () => {
  const first = createAccess({ port: 1 });
  const second = createAccess({ port: 1 });
  assert.equal(first.key.length, 48);
  assert.notEqual(first.key, second.key);
});

test('die Seite lässt sich nicht einbetten und lädt nichts von außen', () => {
  const headers = pageHeaders('abc123');
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(headers['content-security-policy'], /default-src 'self'/);
  assert.equal(headers['x-frame-options'], 'DENY');
});

test('Skripte laufen nur mit der Kennung der einen Antwort', () => {
  const policy = pageHeaders('abc123')['content-security-policy'];
  assert.match(policy, /script-src 'self' 'nonce-abc123';/);
  assert.doesNotMatch(policy.match(/script-src[^;]*/)[0], /unsafe-inline/);
  assert.notEqual(newNonce(), newNonce());
});
