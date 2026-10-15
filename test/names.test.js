const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createNames, pinnedImages, DEFAULT_PORT } = require('../src/names');

test('Daemon und Build-Dienst sind per Version und Digest festgenagelt (linux/pins.Dockerfile)', () => {
  const { dind, buildkit } = pinnedImages();
  for (const image of [dind, buildkit]) assert.match(image, /^[a-z/]+:v?\d+\.\d+\.\d+[^@]*@sha256:[0-9a-f]{64}$/);
  assert.match(buildkit, /-rootless@/); // der Build-Dienst läuft ohne Rechte (siehe caches.js)
  assert.deepEqual(pinnedImages('FROM a:1@sha256:x AS dind\nfrom b:2 as buildkit\n'), { dind: 'a:1@sha256:x', buildkit: 'b:2' });
  assert.throws(() => pinnedImages('FROM a:1 AS dind\n'), { message: 'In linux/pins.Dockerfile fehlt das Abbild buildkit.' });
});

test('Node und .NET-SDK im Runner-Abbild sind per Digest festgenagelt; nur der Runner folgt dem neuesten Stand', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'linux', 'Dockerfile'), 'utf8');
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  assert.equal(froms.length, 3);
  for (const image of froms.filter((from) => !from.startsWith('ghcr.io/actions/actions-runner:'))) assert.match(image, /@sha256:[0-9a-f]{64}$/, image);
});

test('das Kennzeichen hängt am Datenordner, ohne Rücksicht auf Groß- und Kleinschreibung', () => {
  const a = createNames({ dataDir: 'C:/Daten/RunClub', port: DEFAULT_PORT });
  const b = createNames({ dataDir: 'c:/daten/runclub', port: DEFAULT_PORT });
  const other = createNames({ dataDir: 'C:/Anders', port: DEFAULT_PORT });
  assert.match(a.mark, /^runclub\.runner=[0-9a-f]{10}$/);
  assert.equal(a.mark, b.mark);
  assert.notEqual(a.mark, other.mark);
  assert.equal(a.serviceMark, a.mark.replace('runner', 'service'));
});

test('Caches, Vorlage und Build-Dienst heißen nach dem Repo; eine zweite Instanz hängt ihre Kennung an', () => {
  const first = createNames({ dataDir: 'C:/Daten', port: DEFAULT_PORT });
  assert.deepEqual(['cacheVolume', 'seedVolume', 'buildVolume', 'buildSocket', 'buildService', 'buildNetwork'].map((name) => first[name]('Wer/Mein.App')),
    ['rc-cache-mein-app', 'rc-seed-mein-app', 'rc-build-mein-app', 'rc-buildsock-mein-app', 'rc-buildkit-mein-app', 'rc-buildnet-mein-app']);
  const second = createNames({ dataDir: 'C:/Probe', port: 8799 });
  assert.equal(second.cacheVolume('wer/app'), `rc-cache-app-${second.mark.split('=')[1]}`);
});
