// Aktualisieren aus den GitHub-Releases des Repos: nachsehen, ob es eine neuere Version gibt, den Installer im
// Hintergrund laden und prüfen, dann „Update bereit“ melden. Eingespielt wird nur auf Klick (main.js): RunClub endet
// dabei wie beim Beenden und startet den Installer, der die App danach wieder öffnet.
//
// Kanal     „stable“ sieht nur stabile Versionen (Tag vX.Y.Z), „beta“ auch Vorabversionen (vX.Y.Z-beta.N). Der Kanal
//           steht in `update.json` im Datenordner; ohne Eintrag gilt der, zu dem die laufende Version gehört.
// Prüfen    Jeder Release trägt neben dem Installer die Datei, die electron-builder schreibt (`latest.yml`, bei Betas
//           `beta.yml`): Name des Installers und dessen SHA-512. Ein Installer, dessen Prüfsumme nicht stimmt, wird
//           verworfen.
// Anmeldung Solange das Repo privat ist, braucht schon das Lesen der Releases ein Token (das der Anmeldung in RunClub, siehe main.js).
//           Gibt es keins, wird ohne gefragt; ein öffentliches Repo braucht keins.
//
// Ohne Nebenwirkungen beim Laden; `createUpdater` tut erst etwas, wenn `check` oder `setChannel` gerufen wird.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./store');
const { msg, render, Fault, reason } = require('./messages');

const FILE = 'update.json';
const CHANNELS = ['stable', 'beta'];
const API = 'https://api.github.com';
const PER_PAGE = 30; // so viele Releases werden gelesen; ältere sind ohnehin nicht neuer
const REDIRECTS = 5;
const CHANNEL_FILE = /^(?:latest|beta|alpha)\.yml$/; // so benennt electron-builder die Datei für den Updater
const PHASE = { DEV: 'dev', IDLE: 'idle', CHECKING: 'checking', CURRENT: 'current', DOWNLOADING: 'downloading', READY: 'ready', ERROR: 'error' };

// Ein Fehler, den die Oberfläche in ihrer Sprache nennt (`code`); die Meldung selbst geht nur ins Protokoll.
//   private   GitHub gibt die Releases nicht heraus (401/404; das Repo ist privat und die Anmeldung fehlt)
//   network   GitHub ist nicht erreichbar
//   http      eine andere Antwort mit Fehler (`status`)
//   broken    der Installer ist beschädigt (Prüfsumme)
//   missing   zum Release fehlt der Installer oder seine Angabe
//   other     alles andere (Platte voll, Abbruch mitten im Laden); Einzelheiten im Protokoll
// `message` ist eine Meldung (siehe messages.js).
class UpdateError extends Error {
  constructor(code, message, status = null) { super(render(message)); this.msg = message; this.code = code; this.status = status; }
}

// Zerlegt „1.2.3-beta.4“ (auch mit „v“ davor); null, wenn es keine Version ist.
function parseVersion(text) {
  const match = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}

// Wie Semver: Eine Vorabversion liegt vor der Version ohne Zusatz, Zahlen werden als Zahlen verglichen.
// Liefert < 0, 0 oder > 0; eine Angabe, die keine Version ist, liegt vor jeder anderen.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/;
    if (numeric.test(p) && numeric.test(q)) return Number(p) - Number(q);
    if (numeric.test(p) !== numeric.test(q)) return numeric.test(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isPrerelease = (version) => Boolean(parseVersion(version)?.pre.length);
const channelOf = (version) => (isPrerelease(version) ? 'beta' : 'stable');

// Die Angaben aus `latest.yml`: Version, Name des Installers und seine Prüfsumme (SHA-512, Base64). Nur die Felder der
// obersten Ebene; die Liste `files` darunter wiederholt sie.
function parseUpdateInfo(text) {
  const field = (name) => String(text ?? '').match(new RegExp(`^${name}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm'))?.[1] ?? null;
  const info = { version: field('version'), path: field('path'), sha512: field('sha512') };
  return info.version && info.path && info.sha512 ? info : null;
}

// Der neueste Release, der für den Kanal gilt und neuer ist als die laufende Version; sonst null. Entwürfe zählen nie,
// Vorabversionen nur im Kanal „beta“ (der auch die stabilen sieht).
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

//   repo                    „besitzer/name“ des Repos mit den Releases
//   current                 die laufende Version
//   packaged                nur eine installierte App aktualisiert sich; sonst bleibt es bei der Anzeige der Version
//   dataDir                 hier liegen `update.json` und der geladene Installer (Ordner `update`)
//   token()                 liefert das Token für GitHub oder null
//   fetch                   wie das von Node; in Tests steuerbar
//   log(text), now()
function createUpdater({ repo, current, packaged, dataDir, token = async () => null, fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
  const file = path.join(dataDir, FILE);
  const folder = path.join(dataDir, 'update');
  const saved = readJson(file, {}).data ?? {};
  let channel = CHANNELS.includes(saved.channel) ? saved.channel : channelOf(current);
  let phase = packaged ? PHASE.IDLE : PHASE.DEV;
  let available = null; // die neuere Version, sobald bekannt
  let ready = null; // { version, file } nach geprüftem Download
  let error = null;
  let checkedAt = null;
  let lastLogged = null;
  let running = null; // die laufende Prüfung; eine zweite wartet auf sie

  // Eine Anfrage an GitHub. Weiterleitungen (Downloads liegen anderswo) folgen ohne Token: Das gilt nur für GitHub.
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
  const loadAsset = (item) => request(item.url, { accept: 'application/octet-stream', auth: true });

  // Lädt den Installer neben die Zieldatei, prüft ihn und benennt ihn erst dann um.
  async function download(item, info, target) {
    const response = await loadAsset(item);
    const draft = `${target}.teil`;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(draft);
    try {
      for await (const chunk of response.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve)); }
      await new Promise((resolve, reject) => out.end((failure) => (failure ? reject(failure) : resolve())));
    } catch (failure) { out.destroy(); fs.rmSync(draft, { force: true }); throw failure; }
    if (hash.digest('base64') !== info.sha512) {
      fs.rmSync(draft, { force: true });
      throw new UpdateError('broken', msg('m_updateBroken', info.version));
    }
    fs.renameSync(draft, target);
  }

  // Entfernt geladene Installer bis auf `keep`.
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
      const yml = (found.release.assets ?? []).find((item) => CHANNEL_FILE.test(item.name));
      if (!yml) throw new UpdateError('missing', msg('m_updateNoYml', found.version));
      const info = parseUpdateInfo(await (await loadAsset(yml)).text());
      if (!info) throw new UpdateError('missing', msg('m_updateYmlIncomplete', found.version));
      const installer = asset(found.release, info.path);
      if (!installer || !/\.exe$/i.test(info.path)) throw new UpdateError('missing', msg('m_updateNoInstaller', found.version, info.path));
      phase = PHASE.DOWNLOADING;
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, path.basename(info.path));
      ready = null; // ein älteres geladenes Update weicht dem neueren
      prune(null);
      await download(installer, info, target);
      ready = { version: found.version, file: target };
      phase = PHASE.READY;
      log(msg('m_updateReady', found.version));
    } catch (failure) {
      checkedAt = now();
      const message = msg('m_withReason', 'Update', reason(failure));
      // Derselbe Fehler bei jeder Prüfung steht nur einmal im Protokoll.
      if (render(message) !== lastLogged) log(message);
      lastLogged = render(message);
      error = failure instanceof UpdateError ? { code: failure.code, status: failure.status } : { code: 'other', status: null };
      phase = ready ? PHASE.READY : PHASE.ERROR;
    }
  }

  // Sieht nach und lädt, was neuer ist; außerhalb der installierten App nichts.
  function check() {
    if (!packaged) return Promise.resolve();
    running ??= checkNow().finally(() => { running = null; });
    return running;
  }

  // Wechselt den Kanal. Ein geladenes Update, das im neuen Kanal nicht gilt (eine Beta im Kanal „stable“), verfällt.
  function setChannel(next) {
    if (!CHANNELS.includes(next)) throw new Fault('m_unknownChannel', String(next));
    channel = next;
    writeJson(file, { channel });
    if (channel === 'stable' && ready && isPrerelease(ready.version)) { ready = null; available = null; prune(null); phase = packaged ? PHASE.IDLE : PHASE.DEV; }
    return check();
  }

  // Was der Installer zum Einspielen braucht: still installieren, danach die App starten (`--force-run`).
  const installer = () => (ready && fs.existsSync(ready.file) ? { file: ready.file, args: ['--updated', '/S', '--force-run'], version: ready.version } : null);

  //   phase    dev | idle | checking | current | downloading | ready | error
  //   error    null oder `{ code, status }` (siehe UpdateError)
  //   available  die neuere Version oder null; `ready` ist sie, sobald sie geladen und geprüft ist
  const view = () => ({
    version: current, channel, phase, available, ready: ready?.version ?? null, error,
    checkedAt: checkedAt == null ? null : new Date(checkedAt).toISOString(),
  });

  return { check, setChannel, installer, view };
}

module.exports = { createUpdater, compareVersions, parseVersion, parseUpdateInfo, pickRelease, channelOf, FILE, PHASE, CHANNELS };
