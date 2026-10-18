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
//           `latest.yml`/`beta.yml` from electron-builder, which older releases carry, are not trusted.
// Sign-in   None: the releases of the public repo are read anonymously, so no token of the user leaves for them.
//
// No side effects on load; `createUpdater` does nothing until `check` or `setChannel` is called.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readJson, writeJson } = require('./store');
const { msg, render, Fault, reason, unreachableReason } = require('./messages');
const { compareVersions, parseVersion, isPrerelease, channelOf } = require('./versions');
const signature = require('./signature');
const { API, API_VERSION } = require('./github');

const FILE = 'update.json';
const CHANNELS = ['stable', 'beta'];
const PER_PAGE = 30; // this many releases are read; older ones aren't newer anyway
const REDIRECTS = 5;
const TRIES = 5; // this many of the newest releases are tried before the check gives up
const RENAME_TRIES = 5;
const SMALL = 64 * 1024; // manifest and signature are a few hundred bytes; more is not ours
const PHASE = { DEV: 'dev', IDLE: 'idle', CHECKING: 'checking', CURRENT: 'current', DOWNLOADING: 'downloading', READY: 'ready', ERROR: 'error' };

// An error the interface names in its own language (`code`); the message itself goes only to the log.
//   denied    GitHub doesn't hand out the releases (401/404)
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

// The releases that apply to the channel and are newer than the running version, newest first. Drafts never count,
// pre-releases only in the channel “beta” (which also sees the stable ones).
function candidates(releases, { channel, current }) {
  const found = [];
  for (const release of releases ?? []) {
    if (release.draft || (release.prerelease && channel !== 'beta')) continue;
    const version = String(release.tag_name ?? '').replace(/^v/, '');
    if (!parseVersion(version) || (isPrerelease(version) && channel !== 'beta')) continue;
    if (compareVersions(version, current) <= 0) continue;
    found.push({ version, release });
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

// The newest of them; otherwise null.
const pickRelease = (releases, options) => candidates(releases, options)[0] ?? null;

// The SHA-512 (Base64) and size of a file, read in pieces.
function digest(file) {
  const hash = crypto.createHash('sha512');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  let size = 0;
  try {
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, read)); size += read; }
  } finally { fs.closeSync(fd); }
  return { size, sha512: hash.digest('base64') };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

//   repo                    “owner/name” of the repo with the releases
//   current                 the running version
//   packaged                only an installed app updates itself; otherwise it just shows the version
//   dataDir                 holds `update.json` and the downloaded installer (folder `update`)
//   keys                    the public keys a manifest must be signed with (see signature.js); controllable in tests
//   timeouts                `request`: longest wait for an answer and a small file; `idle`: longest pause in the
//                           installer's download (ms)
//   fetch                   like Node's; controllable in tests
//   log(message), now()     a message (see messages.js) to the log; the clock
function createUpdater({ repo, current, packaged, dataDir, keys = signature.KEYS, timeouts = {}, fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
  const file = path.join(dataDir, FILE);
  const folder = path.join(dataDir, 'update');
  const saved = readJson(file, {}).data ?? {};
  const wait = { request: 60 * 1000, idle: 60 * 1000, ...timeouts };
  let channel = CHANNELS.includes(saved.channel) ? saved.channel : channelOf(current);
  let phase = packaged ? PHASE.IDLE : PHASE.DEV;
  let available = null; // the newer version, once known
  let ready = null; // { version, file, size, sha512 } after a verified download
  let error = null;
  let checkedAt = null;
  let lastLogged = null;
  let running = null; // the running check; a second one waits for it
  let held = false; // the update is being installed: no more checks that could remove it
  const skipped = new Set(); // releases already logged as refused, so each appears only once

  // A request to GitHub, anonymous. Redirects (downloads live elsewhere) are followed.
  // `signal` ends it (and reading its body) from outside.
  async function request(url, { accept, signal }) {
    let target = url;
    for (let hop = 0; hop <= REDIRECTS; hop += 1) {
      const headers = { accept, 'user-agent': `RunClub/${current}`, 'x-github-api-version': API_VERSION };
      const response = await fetch(target, { headers, redirect: 'manual', signal }).catch((failure) => { throw new UpdateError('network', msg('m_updateUnreachable', unreachableReason(failure))); });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        target = new URL(response.headers.get('location'), target).href;
        continue;
      }
      const where = new URL(url).pathname;
      if (response.status === 401 || response.status === 404) throw new UpdateError('denied', msg('m_updateDenied', where, String(response.status)), response.status);
      if (!response.ok) throw new UpdateError('http', msg('m_updateHttp', String(response.status), where), response.status);
      return response;
    }
    throw new UpdateError('http', msg('m_updateRedirects'));
  }

  const asset = (release, name) => (release.assets ?? []).find((item) => item.name === name);
  const loadAsset = (item, signal) => request(item.url, { accept: 'application/octet-stream', signal });

  // A small file of the release (manifest, signature) as bytes; beyond `SMALL` it is not read further.
  async function loadSmall(item, version) {
    const signal = AbortSignal.timeout(wait.request);
    const response = await loadAsset(item, signal);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > SMALL) throw new UpdateError('unsigned', msg('m_updateTooLarge', version, item.name));
        chunks.push(chunk);
      }
    } catch (failure) {
      if (failure instanceof UpdateError) throw failure;
      throw new UpdateError('network', msg('m_updateStalled', version));
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
  // renames it. Beyond the signed size the download stops, likewise after a pause longer than `wait.idle`.
  async function download(item, info, target) {
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(), wait.idle);
    const draft = `${target}.part`;
    const hash = crypto.createHash('sha512');
    let size = 0;
    const meter = new Transform({
      transform(chunk, encoding, done) {
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(), wait.idle);
        size += chunk.length;
        if (size > info.size) return done(new UpdateError('broken', msg('m_updateTooLarge', info.version, info.file)));
        hash.update(chunk);
        return done(null, chunk);
      },
    });
    try {
      const response = await loadAsset(item, stall.signal);
      const body = typeof response.body?.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
      await pipeline(body, meter, fs.createWriteStream(draft));
    } catch (failure) {
      fs.rmSync(draft, { force: true });
      if (stall.signal.aborted) throw new UpdateError('network', msg('m_updateStalled', info.version));
      throw failure;
    } finally { clearTimeout(timer); }
    if (size !== info.size || hash.digest('base64') !== info.sha512) {
      fs.rmSync(draft, { force: true });
      throw new UpdateError('broken', msg('m_updateBroken', info.version));
    }
    // A virus scanner often holds a freshly written .exe for a moment.
    for (let attempt = 1; ; attempt += 1) {
      try { fs.renameSync(draft, target); return; } catch (failure) {
        if (attempt >= RENAME_TRIES) { fs.rmSync(draft, { force: true }); throw failure; }
        await sleep(attempt * 500);
      }
    }
  }

  // Removes downloaded installers except `keep`.
  function prune(keep) {
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder)) if (path.join(folder, name) !== keep) fs.rmSync(path.join(folder, name), { force: true });
  }

  // Logs a refused release once, then goes on with the next older one.
  function skip(failure) {
    const message = msg('m_withReason', 'Update', reason(failure));
    if (!skipped.has(render(message))) log(message);
    skipped.add(render(message));
  }

  async function checkNow() {
    phase = ready ? PHASE.READY : PHASE.CHECKING;
    error = null;
    try {
      const response = await request(`${API}/repos/${repo}/releases?per_page=${PER_PAGE}`, { accept: 'application/vnd.github+json', signal: AbortSignal.timeout(wait.request) });
      const found = candidates(await response.json(), { channel, current });
      checkedAt = now();
      lastLogged = null;
      if (!found.length) { available = null; ready = null; prune(null); phase = PHASE.CURRENT; return; }
      // A newer release that isn't signed (or lacks its installer) doesn't block an older one that is: whoever can
      // create releases could otherwise stop all updates, including the one that replaces a stolen key.
      let refused = null;
      for (const candidate of found.slice(0, TRIES)) {
        if (held) return; // the update being installed stays as it is
        if (ready?.version === candidate.version && fs.existsSync(ready.file)) { available = candidate.version; phase = PHASE.READY; return; }
        let info;
        let installer;
        try {
          info = await manifestOf(candidate);
          installer = asset(candidate.release, info.file);
          if (!installer) throw new UpdateError('missing', msg('m_updateNoInstaller', candidate.version, info.file));
        } catch (failure) {
          if (!(failure instanceof UpdateError) || !['unsigned', 'missing'].includes(failure.code)) throw failure;
          refused ??= failure;
          skip(failure);
          continue;
        }
        if (held) return;
        available = candidate.version;
        phase = PHASE.DOWNLOADING;
        fs.mkdirSync(folder, { recursive: true });
        const target = path.join(folder, path.basename(info.file));
        ready = null; // an older downloaded update gives way to the newer one
        prune(null);
        await download(installer, info, target);
        ready = { version: candidate.version, file: target, size: info.size, sha512: info.sha512 };
        phase = PHASE.READY;
        log(msg('m_updateReady', candidate.version));
        return;
      }
      available = null;
      lastLogged = render(msg('m_withReason', 'Update', reason(refused))); // already in the log through skip()
      throw refused;
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

  // Looks and downloads what is newer; outside the installed app nothing, nor while an update is being installed.
  function check() {
    if (!packaged || held) return Promise.resolve();
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

  // What the installer needs to install: install silently, then start the app (`--force-run`). The file is verified
  // once more against the manifest right before; one that changed since the download is discarded.
  function installer() {
    if (!ready || !fs.existsSync(ready.file)) return null;
    let onDisk;
    try { onDisk = digest(ready.file); } catch (failure) { log(msg('m_withReason', 'Update', reason(failure))); return null; }
    if (onDisk.size !== ready.size || onDisk.sha512 !== ready.sha512) {
      log(msg('m_withReason', 'Update', msg('m_updateBroken', ready.version)));
      ready = null;
      prune(null);
      phase = packaged ? PHASE.IDLE : PHASE.DEV;
      return null;
    }
    return { file: ready.file, args: ['--updated', '/S', '--force-run'], version: ready.version };
  }

  // From here on the update is being installed: no check may replace or remove the downloaded file.
  const hold = () => { held = true; };

  //   phase    dev | idle | checking | current | downloading | ready | error
  //   error    null or `{ code, status }` (see UpdateError)
  //   available  the newer version or null; `ready` is it once it is downloaded and verified
  const view = () => ({
    version: current, channel, phase, available, ready: ready?.version ?? null, error,
    checkedAt: checkedAt == null ? null : new Date(checkedAt).toISOString(),
  });

  return { check, setChannel, installer, hold, view };
}

module.exports = { createUpdater, candidates, pickRelease, FILE };
