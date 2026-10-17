const test = require('node:test');
const assert = require('node:assert/strict');
const { permanentPullError, daysSince, pruneOlder, slug, sameRepo, clashes } = require('../src/images');

test('only an image the registry does not have is refused', () => {
  assert.equal(permanentPullError('Error response from daemon: pull access denied for app, repository does not exist or may require \'docker login\': denied: requested access to the resource is denied'), true);
  assert.equal(permanentPullError('Error response from daemon: manifest for postgres:99 not found: manifest unknown: manifest unknown'), true);
  assert.equal(permanentPullError('Error response from daemon: Head "https://registry-1.docker.io/v2/library/postgres/manifests/17": unauthorized: incorrect username or password'), true);
});

test('a disruption changes nothing about what was learned', () => {
  assert.equal(permanentPullError('toomanyrequests: You have reached your unauthenticated pull rate limit.'), false);
  assert.equal(permanentPullError('Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host'), false);
  assert.equal(permanentPullError('Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled (Client.Timeout exceeded while awaiting headers)'), false);
  assert.equal(permanentPullError('no answer after 1800 s'), false);
  assert.equal(permanentPullError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), false);
  assert.equal(permanentPullError(''), false);
});

test('old entries drop out', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const entries = { fresh: '2026-10-12T12:00:00Z', old: '2026-09-01T12:00:00Z', broken: 'not a date' };
  assert.equal(pruneOlder(entries, 14, now), true);
  assert.deepEqual(Object.keys(entries), ['fresh']);
  assert.equal(pruneOlder(entries, 14, now), false);
  assert.equal(pruneOlder(undefined, 14, now), false);
});

test('two repos with the same name share no cache', () => {
  assert.equal(slug('Zaho92/What.To_Wear'), 'what-to-wear');
  assert.equal(sameRepo('zaho92/runclub', 'Zaho92/RunClub'), true);
  assert.equal(clashes('company/api', ['alice/api', 'alice/web']), 'alice/api');
  assert.equal(clashes('alice/my.repo', ['alice/my-repo']), 'alice/my-repo');
  assert.equal(clashes('alice/api', ['Alice/API']), null);
  assert.equal(clashes('alice/api', ['alice/web']), null);
});

test('daysSince counts days with fraction', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(daysSince('2026-10-13T00:00:00Z', now), 1.5);
  assert.equal(daysSince('2026-10-14T12:00:00Z', now), 0);
});
