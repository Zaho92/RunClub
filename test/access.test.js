const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccess, pageHeaders, newNonce } = require('../src/access');

const access = createAccess({ port: 8770, key: 'secret' });

test('only this machine under its own name', () => {
  assert.equal(access.hostAllowed({ host: 'localhost:8770' }), true);
  assert.equal(access.hostAllowed({ host: '127.0.0.1:8770' }), true);
  assert.equal(access.hostAllowed({ host: 'host.docker.internal:8770' }), false);
  assert.equal(access.hostAllowed({ host: 'evil.example:8770' }), false);
  assert.equal(access.hostAllowed({}), false);
});

test('without the cookie with the key there is no access', () => {
  assert.equal(access.allowed({}), false);
  assert.equal(access.allowed({ cookie: 'rc=wrong' }), false);
  assert.equal(access.allowed({ cookie: 'rc=' }), false);
  assert.equal(access.allowed({ cookie: 'other=secret' }), false);
  assert.equal(access.allowed({ cookie: 'rc=secret' }), true);
  assert.equal(access.allowed({ cookie: 'a=1; rc=secret; b=2' }), true);
});

test('the entry address trades the key for the cookie', () => {
  assert.equal(access.entry, 'http://127.0.0.1:8770/?key=secret');
  assert.equal(access.entering('/?key=secret'), true);
  assert.equal(access.entering('/?key=wrong'), false);
  assert.equal(access.entering('/?key='), false);
  assert.equal(access.entering('/'), null);
  assert.equal(access.entering('/api/status?key=secret'), null);
  assert.match(access.cookie, /^rc=secret; HttpOnly; SameSite=Strict/);
});

test('every program run has its own key', () => {
  const first = createAccess({ port: 1 });
  const second = createAccess({ port: 1 });
  assert.equal(first.key.length, 48);
  assert.notEqual(first.key, second.key);
});

test('the page cannot be embedded and loads nothing from outside', () => {
  const headers = pageHeaders('abc123');
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(headers['content-security-policy'], /default-src 'self'/);
  assert.equal(headers['x-frame-options'], 'DENY');
});

test('scripts only run with the id of the one response', () => {
  const policy = pageHeaders('abc123')['content-security-policy'];
  assert.match(policy, /script-src 'self' 'nonce-abc123';/);
  assert.doesNotMatch(policy.match(/script-src[^;]*/)[0], /unsafe-inline/);
  assert.notEqual(newNonce(), newNonce());
});
