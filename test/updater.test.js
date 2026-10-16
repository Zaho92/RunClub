const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdater, compareVersions, parseUpdateInfo, pickRelease, channelOf, FILE } = require('../src/updater');
const { render } = require('../src/messages');

test('Versionen werden wie bei Semver verglichen', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.2.0-beta.1', '0.2.0') < 0);
  assert.ok(compareVersions('0.2.0-beta.10', '0.2.0-beta.9') > 0);
  assert.ok(compareVersions('0.2.0-beta.1', '0.1.0') > 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('kaputt', '0.0.1') < 0);
});

test('der Kanal folgt ohne Eintrag der laufenden Version', () => {
  assert.equal(channelOf('0.1.0'), 'stable');
  assert.equal(channelOf('0.2.0-beta.3'), 'beta');
});

test('latest.yml liefert Version, Installer und Prüfsumme', () => {
  const text = "version: 0.2.0-beta.1\nfiles:\n  - url: RunClub-Setup-0.2.0-beta.1.exe\n    sha512: abc\n    size: 12\npath: RunClub-Setup-0.2.0-beta.1.exe\nsha512: 'xyz=='\nreleaseDate: '2026-10-16T10:00:00.000Z'\n";
  assert.deepEqual(parseUpdateInfo(text), { version: '0.2.0-beta.1', path: 'RunClub-Setup-0.2.0-beta.1.exe', sha512: 'xyz==' });
  assert.equal(parseUpdateInfo('version: 1.0.0\n'), null);
});

test('stabil sieht keine Vorabversionen, Beta auch die stabilen, Entwürfe zählen nie', () => {
  const releases = [
    { tag_name: 'v0.3.0-beta.1', prerelease: true },
    { tag_name: 'v0.2.0', prerelease: false },
    { tag_name: 'v0.4.0', prerelease: false, draft: true },
    { tag_name: 'v0.1.0', prerelease: false },
  ];
  assert.equal(pickRelease(releases, { channel: 'stable', current: '0.1.0' }).version, '0.2.0');
  assert.equal(pickRelease(releases, { channel: 'beta', current: '0.1.0' }).version, '0.3.0-beta.1');
  assert.equal(pickRelease(releases, { channel: 'stable', current: '0.2.0' }), null);
  // Eine stabile Version nach der Beta gilt auch im Kanal Beta.
  assert.equal(pickRelease([...releases, { tag_name: 'v0.3.0', prerelease: false }], { channel: 'beta', current: '0.3.0-beta.1' }).version, '0.3.0');
});

// GitHub zum Anfassen: Releases unter /releases, jede Datei hinter einer Weiterleitung auf einen anderen Rechner.
function world(t, { current = '0.1.0', packaged = true, releases = [], files = {}, saved } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-updater-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (saved) fs.writeFileSync(path.join(dir, FILE), JSON.stringify(saved));
  const w = { dir, releases, files, calls: [] };
  w.fetch = async (url, { headers }) => {
    w.calls.push({ url, authorization: headers.authorization ?? null });
    const { pathname, host } = new URL(url);
    if (pathname.endsWith('/releases')) return Response.json(w.releases);
    const asset = pathname.match(/\/assets\/(.+)$/);
    if (asset) return new Response(null, { status: 302, headers: { location: `https://objects.example/${asset[1]}` } });
    if (host === 'objects.example') {
      const name = pathname.slice(1);
      return name in w.files ? new Response(w.files[name]) : new Response('fehlt', { status: 404 });
    }
    return new Response('?', { status: 404 });
  };
  w.updater = createUpdater({ repo: 'wer/RunClub', current, packaged, dataDir: dir, token: async () => 'geheim', fetch: w.fetch });
  return w;
}

// Ein Release mit Installer und latest.yml; `sha512` überschreibt die Prüfsumme.
function release(w, version, { prerelease = false, sha512 } = {}) {
  const exe = `RunClub-Setup-${version}.exe`;
  const content = `Installer ${version}`;
  const sum = sha512 ?? crypto.createHash('sha512').update(content).digest('base64');
  const yml = prerelease ? 'beta.yml' : 'latest.yml';
  w.files[exe] = content;
  w.files[`${version}-${yml}`] = `version: ${version}\npath: ${exe}\nsha512: ${sum}\n`;
  const assetUrl = (name) => `https://api.github.com/repos/wer/RunClub/releases/assets/${name}`;
  w.releases.push({
    tag_name: `v${version}`, prerelease, draft: false,
    assets: [{ name: exe, url: assetUrl(exe) }, { name: yml, url: assetUrl(`${version}-${yml}`) }, { name: `${exe}.blockmap`, url: assetUrl('x') }],
  });
}

test('lädt die neuere Version, prüft sie und meldet sie bereit', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  await w.updater.check();
  const view = w.updater.view();
  assert.equal(view.phase, 'ready');
  assert.equal(view.ready, '0.2.0');
  const installer = w.updater.installer();
  assert.equal(fs.readFileSync(installer.file, 'utf8'), 'Installer 0.2.0');
  assert.deepEqual(installer.args, ['--updated', '/S', '--force-run']);
  // Das Token geht nur an GitHub, nicht an den Rechner hinter der Weiterleitung.
  assert.ok(w.calls.filter((call) => call.url.startsWith('https://api.github.com/')).every((call) => call.authorization === 'Bearer geheim'));
  assert.ok(w.calls.filter((call) => call.url.startsWith('https://objects.example/')).every((call) => call.authorization === null));
});

test('ein Installer mit falscher Prüfsumme wird verworfen', async (t) => {
  const w = world(t);
  release(w, '0.2.0', { sha512: 'falsch' });
  await w.updater.check();
  const view = w.updater.view();
  assert.equal(view.phase, 'error');
  assert.deepEqual(view.error, { code: 'broken', status: null });
  assert.equal(w.updater.installer(), null);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), []);
});

test('ohne neuere Version ist die App aktuell', async (t) => {
  const w = world(t, { current: '0.2.0' });
  release(w, '0.2.0');
  release(w, '0.3.0-beta.1', { prerelease: true });
  await w.updater.check();
  assert.equal(w.updater.view().phase, 'current');
  assert.equal(w.updater.view().channel, 'stable');
});

test('im Kanal Beta kommt die Vorabversion; zurück auf Stabil verfällt sie', async (t) => {
  const w = world(t, { current: '0.2.0' });
  release(w, '0.2.0');
  release(w, '0.3.0-beta.1', { prerelease: true });
  await w.updater.setChannel('beta');
  assert.equal(w.updater.view().ready, '0.3.0-beta.1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.dir, FILE), 'utf8')), { channel: 'beta' });
  await w.updater.setChannel('stable');
  assert.equal(w.updater.view().ready, null);
  assert.equal(w.updater.view().phase, 'current');
  assert.equal(w.updater.installer(), null);
});

test('eine neuere Version ersetzt das schon geladene Update', async (t) => {
  const w = world(t, { current: '0.2.0-beta.1' });
  release(w, '0.2.0-beta.2', { prerelease: true });
  await w.updater.check();
  assert.equal(w.updater.view().ready, '0.2.0-beta.2');
  release(w, '0.2.0-beta.3', { prerelease: true });
  await w.updater.check();
  assert.equal(w.updater.view().ready, '0.2.0-beta.3');
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), ['RunClub-Setup-0.2.0-beta.3.exe']);
});

test('außerhalb der installierten App wird nicht nachgesehen', async (t) => {
  const w = world(t, { packaged: false });
  release(w, '0.2.0');
  await w.updater.check();
  assert.equal(w.updater.view().phase, 'dev');
  assert.equal(w.calls.length, 0);
});

test('ohne Netz nennt die Anzeige den Grund als Code', async (t) => {
  const w = world(t);
  const updater = createUpdater({ repo: 'wer/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, fetch: async () => { throw new TypeError('fetch failed'); } });
  await updater.check();
  assert.deepEqual(updater.view().error, { code: 'network', status: null });
});

test('eine Antwort mit Fehler steht in der Anzeige', async (t) => {
  const w = world(t);
  w.fetch = async () => new Response('nein', { status: 404 });
  const logged = [];
  const updater = createUpdater({ repo: 'wer/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, fetch: w.fetch, log: (text) => logged.push(render(text)) });
  await updater.check();
  await updater.check();
  assert.equal(updater.view().phase, 'error');
  assert.deepEqual(updater.view().error, { code: 'private', status: 404 });
  assert.equal(logged.length, 1); // derselbe Fehler nur einmal im Protokoll
  assert.match(logged[0], /404/);
});
