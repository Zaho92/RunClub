const test = require('node:test');
const assert = require('node:assert/strict');
const { createNames, DEFAULT_PORT, DIND, BUILDKIT } = require('../src/names');

test('die Abbilder mit Rechten sind per Digest festgenagelt und nennen ihre Version', () => {
  for (const image of [DIND, BUILDKIT]) assert.match(image, /^[a-z/]+:v?\d+\.\d+\.\d+[^@]*@sha256:[0-9a-f]{64}$/);
  assert.match(BUILDKIT, /-rootless@/); // der Build-Dienst läuft ohne Rechte (siehe caches.js)
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
