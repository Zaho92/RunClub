const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createNames, pinnedImages, DEFAULT_PORT } = require('../src/names');

test('daemon and build service are pinned by version and digest (linux/pins.Dockerfile)', () => {
  const { dind, buildkit } = pinnedImages();
  for (const image of [dind, buildkit]) assert.match(image, /^[a-z/]+:v?\d+\.\d+\.\d+[^@]*@sha256:[0-9a-f]{64}$/);
  assert.match(buildkit, /-rootless@/); // the build service runs without privileges (see caches.js)
  assert.deepEqual(pinnedImages('FROM a:1@sha256:x AS dind\nfrom b:2 as buildkit\n'), { dind: 'a:1@sha256:x', buildkit: 'b:2' });
  assert.throws(() => pinnedImages('FROM a:1 AS dind\n'), { message: 'The image buildkit is missing from linux/pins.Dockerfile.' });
});

test('Node and .NET SDK in the runner image are pinned by digest; only the runner follows the latest release', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'linux', 'Dockerfile'), 'utf8');
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  assert.equal(froms.length, 3);
  for (const image of froms.filter((from) => !from.startsWith('ghcr.io/actions/actions-runner:'))) assert.match(image, /@sha256:[0-9a-f]{64}$/, image);
});

test('the mark depends on the data folder, regardless of upper and lower case', () => {
  const a = createNames({ dataDir: 'C:/Data/RunClub', port: DEFAULT_PORT });
  const b = createNames({ dataDir: 'c:/data/runclub', port: DEFAULT_PORT });
  const other = createNames({ dataDir: 'C:/Other', port: DEFAULT_PORT });
  assert.match(a.mark, /^runclub\.runner=[0-9a-f]{10}$/);
  assert.equal(a.mark, b.mark);
  assert.notEqual(a.mark, other.mark);
  assert.equal(a.serviceMark, a.mark.replace('runner', 'service'));
});

test('caches, template and build service are named after the repo; a second instance appends its id', () => {
  const first = createNames({ dataDir: 'C:/Data', port: DEFAULT_PORT });
  assert.deepEqual(['cacheVolume', 'seedVolume', 'buildVolume', 'buildSocket', 'buildService', 'buildNetwork'].map((name) => first[name]('Who/My.App')),
    ['rc-cache-my-app', 'rc-seed-my-app', 'rc-build-my-app', 'rc-buildsock-my-app', 'rc-buildkit-my-app', 'rc-buildnet-my-app']);
  const second = createNames({ dataDir: 'C:/Trial', port: 8799 });
  assert.equal(second.cacheVolume('who/app'), `rc-cache-app-${second.mark.split('=')[1]}`);
});
