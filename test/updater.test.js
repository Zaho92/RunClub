const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUpdater, pickRelease, FILE } = require('../src/updater');
const { compareVersions, channelOf, releaseRepo } = require('../src/versions');
const { manifestBytes, sign, keyId, rawPublicKey } = require('../src/signature');
const { render } = require('../src/messages');

test('versions are compared as in semver', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.2.0-beta.1', '0.2.0') < 0);
  assert.ok(compareVersions('0.2.0-beta.10', '0.2.0-beta.9') > 0);
  assert.ok(compareVersions('0.2.0-beta.1', '0.1.0') > 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('broken', '0.0.1') < 0);
  assert.ok(compareVersions('1.0.0-beta.01.9', '1.0.0-beta.1.1') > 0); // equal numbers go on to the next part
});

test('without an entry the channel follows the running version', () => {
  assert.equal(channelOf('0.1.0'), 'stable');
  assert.equal(channelOf('0.2.0-beta.3'), 'beta');
});

test('stable sees no pre-releases, beta also the stable ones, drafts never count', () => {
  const releases = [
    { tag_name: 'v0.3.0-beta.1', prerelease: true },
    { tag_name: 'v0.2.0', prerelease: false },
    { tag_name: 'v0.4.0', prerelease: false, draft: true },
    { tag_name: 'v0.1.0', prerelease: false },
  ];
  assert.equal(pickRelease(releases, { channel: 'stable', current: '0.1.0' }).version, '0.2.0');
  assert.equal(pickRelease(releases, { channel: 'beta', current: '0.1.0' }).version, '0.3.0-beta.1');
  assert.equal(pickRelease(releases, { channel: 'stable', current: '0.2.0' }), null);
  // A stable version after the beta also applies in channel beta.
  assert.equal(pickRelease([...releases, { tag_name: 'v0.3.0', prerelease: false }], { channel: 'beta', current: '0.3.0-beta.1' }).version, '0.3.0');
});

// The maintainer's key pair in the tests; the updater trusts its public key.
const signer = crypto.generateKeyPairSync('ed25519');
const signerRaw = rawPublicKey(signer.publicKey);
const KEYS = { [keyId(signerRaw)]: signerRaw.toString('base64') };

// GitHub to touch: releases under /releases, each file behind a redirect to another host.
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
      return name in w.files ? new Response(w.files[name]) : new Response('missing', { status: 404 });
    }
    return new Response('?', { status: 404 });
  };
  w.updater = createUpdater({ repo: 'owner/RunClub', current, packaged, dataDir: dir, keys: KEYS, fetch: w.fetch });
  return w;
}

// A release with installer, latest.yml (older releases carry it; it is ignored), signed manifest and
// signature. `manifest` overrides fields of the manifest, `key` signs with another key, `without` leaves out files,
// `content` replaces the installer after signing.
function release(w, version, { prerelease = false, manifest = {}, key = signer.privateKey, without = [], content } = {}) {
  const exe = `RunClub-Setup-${version}.exe`;
  const signed = `Installer ${version}`;
  const yml = prerelease ? 'beta.yml' : 'latest.yml';
  const bytes = manifestBytes({
    repo: 'owner/RunClub', version, file: exe, size: Buffer.byteLength(signed),
    sha512: crypto.createHash('sha512').update(signed).digest('base64'), commit: 'c'.repeat(40), signedAt: '2026-10-18T12:00:00.000Z', ...manifest,
  });
  const files = {
    [exe]: content ?? signed,
    [yml]: `version: ${version}\npath: ${exe}\nsha512: x\n`,
    'runclub-update.json': bytes,
    'runclub-update.json.sig': sign(bytes, key),
    [`${exe}.blockmap`]: 'map',
  };
  const assetUrl = (name) => `https://api.github.com/repos/owner/RunClub/releases/assets/${version}/${name}`;
  const assets = [];
  for (const [name, data] of Object.entries(files)) {
    if (without.includes(name)) continue;
    w.files[`${version}/${name}`] = data;
    assets.push({ name, url: assetUrl(name) });
  }
  w.releases.push({ tag_name: `v${version}`, prerelease, draft: false, assets });
}

test('downloads the newer version, verifies it and reports it ready', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  await w.updater.check();
  const view = w.updater.view();
  assert.equal(view.phase, 'ready');
  assert.equal(view.ready, '0.2.0');
  const installer = w.updater.installer();
  assert.equal(fs.readFileSync(installer.file, 'utf8'), 'Installer 0.2.0');
  assert.deepEqual(installer.args, ['--updated', '/S', '--force-run']);
  // Anonymous: no token of the user leaves for the releases.
  assert.ok(w.calls.every((call) => call.authorization === null));
});

test('an installer with a wrong checksum is discarded', async (t) => {
  const w = world(t);
  release(w, '0.2.0', { content: 'Installer 0.2.X' });
  await w.updater.check();
  const view = w.updater.view();
  assert.equal(view.phase, 'error');
  assert.deepEqual(view.error, { code: 'broken', status: null });
  assert.equal(w.updater.installer(), null);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), []);
});

test('without a newer version the app is current', async (t) => {
  const w = world(t, { current: '0.2.0' });
  release(w, '0.2.0');
  release(w, '0.3.0-beta.1', { prerelease: true });
  await w.updater.check();
  assert.equal(w.updater.view().phase, 'current');
  assert.equal(w.updater.view().channel, 'stable');
});

test('in channel beta the pre-release comes; back to stable it lapses', async (t) => {
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

test('a newer version replaces the update already downloaded', async (t) => {
  const w = world(t, { current: '0.2.0-beta.1' });
  release(w, '0.2.0-beta.2', { prerelease: true });
  await w.updater.check();
  assert.equal(w.updater.view().ready, '0.2.0-beta.2');
  release(w, '0.2.0-beta.3', { prerelease: true });
  await w.updater.check();
  assert.equal(w.updater.view().ready, '0.2.0-beta.3');
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), ['RunClub-Setup-0.2.0-beta.3.exe']);
});

test('outside the installed app it doesn\'t look', async (t) => {
  const w = world(t, { packaged: false });
  release(w, '0.2.0');
  await w.updater.check();
  assert.equal(w.updater.view().phase, 'dev');
  assert.equal(w.calls.length, 0);
});

test('without network the view names the reason as a code', async (t) => {
  const w = world(t);
  const updater = createUpdater({ repo: 'owner/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, fetch: async () => { throw new TypeError('fetch failed'); } });
  await updater.check();
  assert.deepEqual(updater.view().error, { code: 'network', status: null });
});

test('an answer with an error shows in the view', async (t) => {
  const w = world(t);
  w.fetch = async () => new Response('no', { status: 404 });
  const logged = [];
  const updater = createUpdater({ repo: 'owner/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, fetch: w.fetch, log: (text) => logged.push(render(text)) });
  await updater.check();
  await updater.check();
  assert.equal(updater.view().phase, 'error');
  assert.deepEqual(updater.view().error, { code: 'denied', status: 404 });
  assert.equal(logged.length, 1); // the same error only once in the log
  assert.match(logged[0], /404/);
});

// Whether the installer itself was requested.
const installerLoaded = (w) => w.calls.some((call) => /\.exe$/.test(call.url));

test('a release without manifest or signature is refused and nothing is downloaded', async (t) => {
  for (const missing of ['runclub-update.json', 'runclub-update.json.sig']) {
    const w = world(t);
    release(w, '0.2.0', { without: [missing] });
    await w.updater.check();
    assert.deepEqual(w.updater.view().error, { code: 'unsigned', status: null }, missing);
    assert.equal(installerLoaded(w), false, missing);
  }
});

test('a release signed with a key the app doesn\'t carry is refused', async (t) => {
  const w = world(t);
  release(w, '0.2.0', { key: crypto.generateKeyPairSync('ed25519').privateKey });
  await w.updater.check();
  assert.deepEqual(w.updater.view().error, { code: 'unsigned', status: null });
  assert.equal(installerLoaded(w), false);
});

test('an old signed manifest under a new tag is refused', async (t) => {
  const w = world(t, { current: '0.2.0' });
  release(w, '0.3.0', { manifest: { version: '0.1.0' } });
  await w.updater.check();
  assert.deepEqual(w.updater.view().error, { code: 'unsigned', status: null });
  assert.equal(installerLoaded(w), false);
});

test('the download stops beyond the signed size', async (t) => {
  const w = world(t);
  release(w, '0.2.0', { content: 'Installer 0.2.0 with a lot more in it' });
  await w.updater.check();
  assert.deepEqual(w.updater.view().error, { code: 'broken', status: null });
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), []);
});

test('an oversized manifest is not read to the end', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  w.files['0.2.0/runclub-update.json'] = 'x'.repeat(70 * 1024);
  await w.updater.check();
  assert.deepEqual(w.updater.view().error, { code: 'unsigned', status: null });
});

test('without keys in the app no update is accepted', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  const updater = createUpdater({ repo: 'owner/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, keys: {}, fetch: w.fetch });
  await updater.check();
  assert.deepEqual(updater.view().error, { code: 'unsigned', status: null });
});

test('a newer release without signature doesn\'t block an older signed one', async (t) => {
  const logged = [];
  const w = world(t);
  release(w, '0.2.0');
  release(w, '9.0.0', { without: ['runclub-update.json'] });
  const updater = createUpdater({ repo: 'owner/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, keys: KEYS, fetch: w.fetch, log: (text) => logged.push(render(text)) });
  await updater.check();
  assert.equal(updater.view().ready, '0.2.0');
  assert.equal(updater.view().error, null);
  await updater.check();
  assert.equal(logged.filter((line) => /9\.0\.0/.test(line)).length, 1); // the refused release appears once
});

test('a download that stalls is given up', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  const inner = w.fetch;
  // The installer's body never delivers anything; only the abort ends it.
  const fetch = async (url, options) => (/\.exe$/.test(url) && url.startsWith('https://objects.example/')
    ? new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.error(new Error('aborted'))); } }))
    : inner(url, options));
  const updater = createUpdater({ repo: 'owner/RunClub', current: '0.1.0', packaged: true, dataDir: w.dir, keys: KEYS, fetch, timeouts: { idle: 50 } });
  await updater.check();
  assert.deepEqual(updater.view().error, { code: 'network', status: null });
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'update')), []);
});

test('an installer changed after the download is not started', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  await w.updater.check();
  const { file } = w.updater.installer();
  fs.writeFileSync(file, 'Installer 0.2.X');
  assert.equal(w.updater.installer(), null);
  assert.equal(w.updater.view().ready, null);
  assert.equal(fs.existsSync(file), false);
});

test('while an update is being installed, no check runs', async (t) => {
  const w = world(t);
  release(w, '0.2.0');
  await w.updater.check();
  w.updater.hold();
  const calls = w.calls.length;
  release(w, '0.3.0');
  await w.updater.check();
  assert.equal(w.calls.length, calls);
  assert.equal(w.updater.installer().version, '0.2.0');
});

test('a beta in a release not marked as pre-release doesn\'t reach channel stable', async (t) => {
  const w = world(t);
  release(w, '0.2.0', { manifest: { version: '0.2.0-beta.1' } });
  await w.updater.check();
  assert.deepEqual(w.updater.view().error, { code: 'unsigned', status: null });
});

test('the releases live in the repo named in package.json', () => {
  assert.equal(releaseRepo({ repository: { url: 'git+https://github.com/Zaho92/RunClub.git' } }), 'Zaho92/RunClub');
  assert.equal(releaseRepo(require('../package.json')), 'Zaho92/RunClub');
});
