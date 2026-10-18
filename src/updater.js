// Updating from the repo's GitHub releases: look whether there is a newer version, download and verify the installer
// in the background, then report “Update to … is ready”. It is installed only on click (main.js): RunClub ends
// as on quitting and starts the installer, which opens the app again afterwards.
//
// Channel   “stable” sees only stable versions (tag vX.Y.Z), “beta” also pre-releases (vX.Y.Z-beta.N). The channel
//           is stored in `update.json` in the data folder; without an entry, the one the running version belongs to applies.
// Verify    Next to the installer, every release carries a manifest signed by the maintainer (see signature.js):
//           version, channel, the installer's name, size and SHA-512. In this order: without manifest and signature
//           nothing is downloaded; the signature must hold for one of the app's keys before the manifest is read;
//           the manifest must name this repo and the release's version, which must be newer than the running one;
//           the download stops beyond the signed size; an installer whose checksum doesn't match is discarded.
//           `latest.yml`/`beta.yml` from electron-builder stay in the release for versions up to 0.1.0-beta.5, but
//           this updater doesn't trust them.
// Sign-in   As long as the repo is private, even reading the releases needs a token (the RunClub sign-in's, see main.js).
//           Without one it requests anonymously; a public repo needs none.
//
// No side effects on load; `createUpdater` does nothing until `check` or `setChannel` is called.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./store');
const { msg, render, Fault, reason } = require('./messages');
const { compareVersions, parseVersion, isPrerelease, channelOf } = require('./versions');
const signature = require('./signature');

const FILE = 'update.json';
const CHANNELS = ['stable', 'beta'];
const API = 'https://api.github.com';
const PER_PAGE = 30; // this many releases are read; older ones aren't newer anyway
const REDIRECTS = 5;
const SMALL = 64 * 1024; // manifest and signature are a few hundred bytes; more is not ours
const PHASE = { DEV: 'dev', IDLE: 'idle', CHECKING: 'checking', CURRENT: 'current', DOWNLOADING: 'downloading', READY: 'ready', ERROR: 'error' };

// An error the interface names in its own language (`code`); the message itself goes only to the log.
//   private   GitHub doesn't hand out the releases (401/404; the repo is private and the sign-in is missing)
//   network   GitHub is unreachable
//   http      another answer with an error (`status`)
//   unsigned  manifest or signature is missing, the signature doesn't hold or the manifest doesn't fit the release
//   broken    the installer is damaged (size or checksum)
//   missing   the release lacks the installer the manifest names
//   other     everything else (disk full, aborted mid-download); details in the log
// `message` is a message (see messages.js).
class UpdateError extends Error {
  constructor(code, message, status = null) { super(render(message)); this.msg = message; this.code = code; this.status = status; }
}

// The newest release that applies to the channel and is newer than the running version; otherwise null. Drafts never
// count, pre-releases only in the channel “beta” (which also sees the stable ones).
function pickRelease(releases, { channel, current }) {
  let best = null;
  for (const release of releases ?? []) {
    if (release.draft || (release.prerelease && channel !== 'beta')) continue;
    const version = String(release.tag_name ?? '').replace(/^v/, '');
    if (!parseVersion(version) || (isPrerelease(version) && channel !== 'beta')) continue;
    if (compareVersions(version, current) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, release };
  }
  return best;
}

//   repo                    “owner/name” of the repo with the releases
//   current                 the running version
//   packaged                only an installed app updates itself; otherwise it just shows the version
//   dataDir                 holds `update.json` and the downloaded installer (folder `update`)
//   token()                 returns the token for GitHub or null
//   keys                    the public keys a manifest must be signed with (see signature.js); controllable in tests
//   fetch                   like Node's; controllable in tests
//   log(text), now()
function createUpdater({ repo, current, packaged, dataDir, token = async () => null, keys = signature.KEYS, fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
  const file = path.join(dataDir, FILE);
  const folder = path.join(dataDir, 'update');
  const saved = readJson(file, {}).data ?? {};
  let channel = CHANNELS.includes(saved.channel) ? saved.channel : channelOf(current);
  let phase = packaged ? PHASE.IDLE : PHASE.DEV;
  let available = null; // the newer version, once known
  let ready = null; // { version, file } after a verified download
  let error = null;
  let checkedAt = null;
  let lastLogged = null;
  let running = null; // the running check; a second one waits for it

  // A request to GitHub. Redirects (downloads live elsewhere) are followed without the token: it is only for GitHub.
  async function request(url, { accept, auth }) {
    let target = url;
    let secret = auth ? await token().catch(() => null) : null;
    for (let hop = 0; hop <= REDIRECTS; hop += 1) {
      const headers = { accept, 'user-agent': 'RunClub', 'x-github-api-version': '2022-11-28' };
      if (secret) headers.authorization = `Bearer ${secret}`;
      const response = await fetch(target, { headers, redirect: 'manual' }).catch((failure) => { throw new UpdateError('network', msg('m_updateUnreachable', String(failure?.cause?.code ?? failure?.message ?? failure))); });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const next = new URL(response.headers.get('location'), target);
        if (next.origin !== new URL(target).origin) secret = null;
        target = next.href;
        continue;
      }
      const where = new URL(url).pathname;
      if (response.status === 401 || response.status === 404) throw new UpdateError('private', msg('m_updatePrivate', where, String(response.status)), response.status);
      if (!response.ok) throw new UpdateError('http', msg('m_updateHttp', String(response.status), where), response.status);
      return response;
    }
    throw new UpdateError('http', msg('m_updateRedirects'));
  }

  const asset = (release, name) => (release.assets ?? []).find((item) => item.name === name);
  // The token goes only to GitHub's API, even if the answer names another address.
  const loadAsset = (item) => request(item.url, { accept: 'application/octet-stream', auth: new URL(item.url).origin === API });

  // A small file of the release (manifest, signature) as bytes; beyond `SMALL` it is not read further.
  async function loadSmall(item, version) {
    const response = await loadAsset(item);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > SMALL) throw new UpdateError('unsigned', msg('m_updateTooLarge', version, item.name));
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // The verified manifest of the release; throws `unsigned` if it is missing or doesn't hold.
  async function manifestOf(found) {
    const manifest = asset(found.release, signature.MANIFEST);
    const sig = asset(found.release, signature.SIGNATURE);
    if (!manifest || !sig) throw new UpdateError('unsigned', msg('m_updateUnsigned', found.version));
    const bytes = await loadSmall(manifest, found.version);
    const sigText = (await loadSmall(sig, found.version)).toString('utf8');
    try {
      return signature.checkManifest(signature.verify(bytes, sigText, keys), { repo, version: found.version, current, channel });
    } catch (failure) {
      if (failure instanceof Fault) throw new UpdateError('unsigned', msg('m_updateNotTrusted', found.version, failure.msg));
      throw failure;
    }
  }

  // Downloads the installer next to the target file, verifies size and checksum from the manifest and only then
  // renames it. Beyond the signed size the download stops.
  async function download(item, info, target) {
    const response = await loadAsset(item);
    const draft = `${target}.part`;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(draft);
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > info.size) throw new UpdateError('broken', msg('m_updateTooLarge', info.version, info.file));
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
      await new Promise((resolve, reject) => out.end((failure) => (failure ? reject(failure) : resolve())));
    } catch (failure) {
      // The file opens in the background; only once it is closed can it be removed for good.
      if (!out.closed) await new Promise((resolve) => { out.once('close', resolve); out.destroy(); });
      fs.rmSync(draft, { force: true });
      throw failure;
    }
    if (size !== info.size || hash.digest('base64') !== info.sha512) {
      fs.rmSync(draft, { force: true });
      throw new UpdateError('broken', msg('m_updateBroken', info.version));
    }
    fs.renameSync(draft, target);
  }

  // Removes downloaded installers except `keep`.
  function prune(keep) {
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder)) if (path.join(folder, name) !== keep) fs.rmSync(path.join(folder, name), { force: true });
  }

  async function checkNow() {
    phase = ready ? PHASE.READY : PHASE.CHECKING;
    error = null;
    try {
      const response = await request(`${API}/repos/${repo}/releases?per_page=${PER_PAGE}`, { accept: 'application/vnd.github+json', auth: true });
      const found = pickRelease(await response.json(), { channel, current });
      checkedAt = now();
      lastLogged = null;
      if (!found) { available = null; ready = null; prune(null); phase = PHASE.CURRENT; return; }
      available = found.version;
      if (ready?.version === found.version && fs.existsSync(ready.file)) { phase = PHASE.READY; return; }
      const info = await manifestOf(found);
      const installer = asset(found.release, info.file);
      if (!installer) throw new UpdateError('missing', msg('m_updateNoInstaller', found.version, info.file));
      phase = PHASE.DOWNLOADING;
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, path.basename(info.file));
      ready = null; // an older downloaded update gives way to the newer one
      prune(null);
      await download(installer, info, target);
      ready = { version: found.version, file: target };
      phase = PHASE.READY;
      log(msg('m_updateReady', found.version));
    } catch (failure) {
      checkedAt = now();
      const message = msg('m_withReason', 'Update', reason(failure));
      // The same error on every check appears in the log only once.
      if (render(message) !== lastLogged) log(message);
      lastLogged = render(message);
      error = failure instanceof UpdateError ? { code: failure.code, status: failure.status } : { code: 'other', status: null };
      phase = ready ? PHASE.READY : PHASE.ERROR;
    }
  }

  // Looks and downloads what is newer; outside the installed app nothing.
  function check() {
    if (!packaged) return Promise.resolve();
    running ??= checkNow().finally(() => { running = null; });
    return running;
  }

  // Switches the channel. A downloaded update that doesn't apply in the new channel (a beta in channel “stable”) lapses.
  function setChannel(next) {
    if (!CHANNELS.includes(next)) throw new Fault('m_unknownChannel', String(next));
    channel = next;
    writeJson(file, { channel });
    if (channel === 'stable' && ready && isPrerelease(ready.version)) { ready = null; available = null; prune(null); phase = packaged ? PHASE.IDLE : PHASE.DEV; }
    return check();
  }

  // What the installer needs to install: install silently, then start the app (`--force-run`).
  const installer = () => (ready && fs.existsSync(ready.file) ? { file: ready.file, args: ['--updated', '/S', '--force-run'], version: ready.version } : null);

  //   phase    dev | idle | checking | current | downloading | ready | error
  //   error    null or `{ code, status }` (see UpdateError)
  //   available  the newer version or null; `ready` is it once it is downloaded and verified
  const view = () => ({
    version: current, channel, phase, available, ready: ready?.version ?? null, error,
    checkedAt: checkedAt == null ? null : new Date(checkedAt).toISOString(),
  });

  return { check, setChannel, installer, view };
}

module.exports = { createUpdater, pickRelease, FILE, PHASE, CHANNELS };
