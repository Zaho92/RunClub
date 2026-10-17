// Die Anmeldung bei GitHub über die GitHub-App „RunClub“ (Device Flow): RunClub holt einen Einmalcode, der Nutzer gibt
// ihn auf github.com ein und bestätigt, RunClub bekommt ein Token für sein Konto. Was RunClub damit darf, legen die
// Rechte der App fest und die Repos, auf denen sie installiert ist (siehe README).
//
// Stand     unknown (noch nicht gelesen) | out (nicht angemeldet, oder GitHub nimmt die Anmeldung nicht mehr an) |
//           in (angemeldet; dann mit Konto).
// Ablauf    starting (der Code ist noch nicht da) | waiting (wartet auf die Bestätigung, mit Code und Adresse) |
//           done | failed | cancelled. Höchstens einer zugleich. Ein beendeter Ablauf bleibt stehen, bis der nächste
//           beginnt. Ein gescheiterter nennt den Grund als Kennung (`why`), damit die Oberfläche ihn in ihrer Sprache
//           sagt: late (nicht rechtzeitig bestätigt) | denied (im Browser abgelehnt) | github (GitHub meldete einen
//           Fehler oder war nicht erreichbar; was es dazu sagte, steht wörtlich in `error`, sonst ist `error` null).
// Token     Gilt acht Stunden und wird 5 Minuten vor Ablauf erneuert, ebenso, wenn GitHub es ablehnt. Jeder
//           Erneuerungsschlüssel gilt nur einmal: Der neue wird erst gesichert, dann benutzt, und es erneuert nur
//           einer zugleich. Nimmt GitHub den Schlüssel nicht mehr an (widerrufen, ein halbes Jahr unbenutzt), ist der
//           Nutzer abgemeldet.
// Ablage    Verschlüsselt über `secrets` (main.js liefert Electrons safeStorage, unter Windows DPAPI) in `github.token`
//           im Datenordner. Ohne `secrets` (das Backend allein) nur im Speicher: Nach einem Neustart ist neu anzumelden.
// Abmelden  Vergisst das Token auf diesem Rechner. Bei GitHub widerrufen ließe es sich nur mit dem Geheimnis der App,
//           und das hat RunClub nicht; die Oberfläche nennt dafür die Seite bei GitHub (`revoke`).
// Protokoll Hinein kommt nur, dass an- oder abgemeldet wurde und als wer. Code und Token bleiben draußen.

const fs = require('node:fs');
const path = require('node:path');
const { SECOND, MINUTE } = require('./units');
const { API, apiHeaders } = require('./github');
const { msg, Fault, reason } = require('./messages');

// Die GitHub-App „RunClub“ (https://github.com/settings/apps/runclub-runners). Die Client-ID ist kein Geheimnis.
const CLIENT_ID = 'Iv23liMHlB06HEzY8bPM';
const APP_SLUG = 'runclub-runners';
// Wo die App für ein weiteres Konto oder eine Organisation installiert wird, und wo der Nutzer ihre Freigabe widerruft.
const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
const REVOKE_URL = 'https://github.com/settings/apps/authorizations';
// Wo der Einmalcode einzugeben ist. Die Adresse steht fest und wird nicht aus der Antwort gelesen: Die Oberfläche macht
// daraus einen Link.
const DEVICE_URL = 'https://github.com/login/device';
const CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const FILE = 'github.token';

const STATE = { UNKNOWN: 'unknown', OUT: 'out', IN: 'in' };
const FLOW = { STARTING: 'starting', WAITING: 'waiting', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' };
const WHY = { LATE: 'late', DENIED: 'denied', GITHUB: 'github' };
const FLOW_TIMEOUT = 15 * MINUTE; // so lange gilt der Einmalcode bei GitHub; nennt GitHub weniger, gilt das
const EARLY = 5 * MINUTE; // so lange vor Ablauf wird das Token erneuert
const SLOW_DOWN = 5 * SECOND; // so viel länger wird gewartet, wenn GitHub um langsameres Fragen bittet
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/; // so sieht ein Konto bei GitHub aus
const SECRET = /^[\w.-]{10,512}$/; // ein Token oder Schlüssel, wie GitHub sie ausgibt; nichts für eine Kopfzeile Gefährliches
// So lehnt GitHub einen Erneuerungsschlüssel ab, der nicht mehr gilt. Einen schon benutzten beantwortet es (echt
// erprobt am 18.10.2026) mit `incorrect_client_credentials`, nicht mit dem dokumentierten `bad_refresh_token`.
const REJECTED = ['bad_refresh_token', 'incorrect_client_credentials'];
const USER_TRIES = 3; // so oft wird nach der Bestätigung das Konto erfragt, bevor der Ablauf scheitert
const RENAME_TRIES = 5; // Windows hält eine eben geschriebene Datei manchmal kurz fest (Virenscanner, Index)

// Wartet `ms`, oder bis `signal` abbricht.
function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// Was ein Fehler beim Fragen sagt, als Text von außen.
const said = (error) => String(error?.cause?.code ?? error?.message ?? error ?? '').slice(0, 300) || null;

//   file, secrets           wo das Token liegt und wie es ver- und entschlüsselt wird ({ encrypt(buffer), decrypt(buffer) });
//                           ohne beides nur im Speicher
//   log(text)               schreibt ins Protokoll
//   onAccount()             ein anderes Token gilt (nach einem gelungenen Anmelden): Anfragelimit und Repos neu lesen
//   fetch, now, wait        wie die von Node und `pause`; in Tests steuerbar
function createAuth({ clientId = CLIENT_ID, file = null, secrets = null, fetch = globalThis.fetch, log = () => {}, onAccount = () => {}, now = Date.now, timeout = MINUTE, flowTimeout = FLOW_TIMEOUT, wait = pause, version = '0' }) {
  let held = null; // { token, expiresAt, refresh, refreshExpiresAt, login } oder null
  let current = { state: STATE.UNKNOWN, login: null }; // bis die Ablage gelesen ist
  let checked = false; // das gesicherte Token wurde bei GitHub geprüft
  let checking = null; // die laufende Prüfung
  let renewing = null; // das laufende Erneuern; es läuft höchstens eines
  let flow = null; // der laufende oder der zuletzt beendete Ablauf
  let closed = false; // die App endet: Es beginnt nichts mehr

  const accountChanged = () => { try { onAccount(); } catch { /* der Stand gilt trotzdem */ } };
  const running = () => flow?.state === FLOW.STARTING || flow?.state === FLOW.WAITING;

  // --- Ablage ---

  // Prüft, was aus der Datei oder von GitHub kommt; null, wenn es keine brauchbare Anmeldung ist.
  function valid(entry) {
    if (!entry || typeof entry !== 'object' || !SECRET.test(String(entry.token))) return null;
    const time = (value) => (Number.isFinite(value) && value > 0 ? value : null);
    return {
      token: entry.token, expiresAt: time(entry.expiresAt), refresh: SECRET.test(String(entry.refresh)) ? entry.refresh : null,
      refreshExpiresAt: time(entry.refreshExpiresAt), login: LOGIN.test(String(entry.login)) ? entry.login : null,
    };
  }

  const draft = () => `${file}.neu`;
  function read(name) {
    try { return { entry: valid(JSON.parse(secrets.decrypt(fs.readFileSync(name)).toString('utf8'))), at: fs.statSync(name).mtimeMs }; } catch { return null; }
  }
  // Ließ sich ein neuer Stand nicht an seinen Platz bringen, liegt er noch daneben (siehe `keep`); dann gilt der neuere.
  function load() {
    if (!file || !secrets) return null;
    const found = [read(file), read(draft())].filter((item) => item?.entry).sort((a, b) => b.at - a.at);
    return found[0]?.entry ?? null;
  }

  function settle(name) {
    for (let tries = 1; ; tries += 1) {
      try { fs.renameSync(name, file); return; } catch (error) { if (tries >= RENAME_TRIES) throw error; }
    }
  }

  // Erst sichern, dann gilt es: Ein neuer Erneuerungsschlüssel darf nicht verloren gehen, nachdem der alte verbraucht ist.
  function keep(entry) {
    if (file && secrets) {
      try {
        if (entry) {
          fs.writeFileSync(draft(), secrets.encrypt(Buffer.from(JSON.stringify(entry), 'utf8')));
          settle(draft());
        } else {
          // Jede für sich: Bliebe eine liegen, wäre der Nutzer nach dem nächsten Start wieder angemeldet.
          for (const name of [draft(), file]) {
            try { fs.rmSync(name, { force: true }); } catch (error) { log(msg('m_tokenNotRemoved', path.basename(name), reason(error))); }
          }
        }
      } catch (error) {
        // Der neue Stand liegt dann wenigstens daneben und gilt beim nächsten Start (siehe `load`).
        log(msg('m_tokenNotSaved', reason(error)));
      }
    }
    held = entry;
    current = entry ? { state: STATE.IN, login: entry.login } : { state: STATE.OUT, login: null };
  }

  // GitHub nimmt die Anmeldung nicht mehr an.
  function lost() {
    const login = held?.login;
    keep(null);
    checked = false;
    if (login) log(msg('m_signInLost', login));
  }

  // --- Anfragen an GitHub ---

  // Ein Formular an github.com/login/…; GitHub antwortet mit JSON, auch bei Fehlern (`error`).
  async function post(url, form, signal) {
    const limit = AbortSignal.timeout(timeout);
    const response = await fetch(url, {
      method: 'POST', body: new URLSearchParams(form),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': `RunClub/${version}` },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    let answer = null;
    try { answer = JSON.parse(await response.text()); } catch { /* unten */ }
    if (!answer || typeof answer !== 'object') throw new Error(`HTTP ${response.status}`);
    return answer;
  }

  // Das Konto zum Token. Wirft mit `status`, wenn GitHub ablehnt.
  async function userOf(token, signal) {
    const limit = AbortSignal.timeout(timeout);
    const response = await fetch(`${API}/user`, { headers: apiHeaders(token, version), signal: signal ? AbortSignal.any([signal, limit]) : limit });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const login = String((await response.json())?.login ?? '');
    if (!LOGIN.test(login)) throw new Fault('m_githubNoAccount');
    return login;
  }

  // Aus der Antwort mit dem Token die Anmeldung; null, wenn keine darin steht.
  function granted(answer, login) {
    const at = (seconds) => (Number(seconds) > 0 ? now() + Number(seconds) * SECOND : null);
    return valid({ token: answer?.access_token, expiresAt: at(answer?.expires_in), refresh: answer?.refresh_token, refreshExpiresAt: at(answer?.refresh_token_expires_in), login });
  }

  // --- Token ---

  async function renewNow() {
    const before = held;
    if (!before?.refresh || (before.refreshExpiresAt && now() >= before.refreshExpiresAt)) {
      // Ohne gültigen Schlüssel lässt sich nichts erneuern; ein abgelaufenes Token ist dann verloren.
      if (before && before.expiresAt && now() >= before.expiresAt) lost();
      return held?.token ?? null;
    }
    let answer;
    try { answer = await post(TOKEN_URL, { client_id: clientId, grant_type: 'refresh_token', refresh_token: before.refresh }); } catch { return null; }
    if (held !== before) return held?.token ?? null; // inzwischen ab- oder neu angemeldet
    if (REJECTED.includes(answer.error)) { lost(); return null; }
    const next = granted(answer, before.login);
    if (!next) return null;
    keep(next);
    return next.token;
  }

  // Erneuern; es läuft höchstens eines, ein zweiter Aufruf bekommt dasselbe Ergebnis.
  function renewOnce() {
    renewing ??= renewNow().finally(() => { renewing = null; });
    return renewing;
  }

  // Das Token für eine Anfrage, oder null ohne Anmeldung. Kurz vor Ablauf wird es erst erneuert.
  async function token() {
    if (!held) return null;
    if (held.expiresAt && now() >= held.expiresAt - EARLY) await renewOnce();
    return held?.token ?? null;
  }

  // GitHub hat `rejected` abgelehnt. Gilt schon ein anderes, ist es das; sonst wird erneuert. Ohne Schlüssel zum
  // Erneuern ist die Anmeldung verloren.
  async function renew(rejected) {
    if (!held) return null;
    if (held.token !== rejected) return held.token;
    if (!held.refresh || (held.refreshExpiresAt && now() >= held.refreshExpiresAt)) { lost(); return null; }
    return renewOnce();
  }

  // Das gesicherte Token einmal bei GitHub prüfen und dabei das Konto lesen. Ist GitHub nicht erreichbar, bleibt der
  // Stand und es wird beim nächsten Mal wieder versucht.
  async function check() {
    try {
      let secret = await token();
      if (!secret) return;
      let login;
      try { login = await userOf(secret); } catch (error) {
        if (error.status !== 401) throw error;
        secret = await renew(secret);
        if (!secret) return;
        login = await userOf(secret);
      }
      if (held?.token === secret) {
        if (held.login !== login) keep({ ...held, login });
        checked = true;
      }
    } catch { /* nicht erreichbar: später noch einmal */ }
  }

  // Für den Takt im Betrieb: den Stand nach dem Start einmal bei GitHub bestätigen.
  function poll() {
    if (held && !checked) checking ??= check().finally(() => { checking = null; });
    return (checking ?? Promise.resolve()).then(view);
  }

  // --- Anmelden ---

  function end(mine, state, why = null, error = null) {
    Object.assign(mine, { state, why, error, code: null, url: null });
    if (state === FLOW.FAILED && why !== WHY.DENIED) log(msg('m_loginFailed', why === WHY.LATE ? msg('m_loginLate') : error ?? msg('m_noReason')));
  }

  // Fragt, bis der Nutzer im Browser bestätigt hat, abgelehnt hat oder der Code verfallen ist.
  async function confirm(mine, device) {
    let interval = Math.max(Number(device.interval) || 5, 1) * SECOND;
    const deadline = now() + Math.min((Number(device.expires_in) || Infinity) * SECOND, flowTimeout);
    for (;;) {
      await wait(interval, mine.controller.signal);
      if (mine.state !== FLOW.WAITING) return;
      if (now() >= deadline) { end(mine, FLOW.FAILED, WHY.LATE); return; }
      let answer;
      try { answer = await post(TOKEN_URL, { client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT }, mine.controller.signal); } catch { continue; } // kurz nicht erreichbar: weiter fragen
      if (mine.state !== FLOW.WAITING) return;
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') { interval = Number(answer.interval) > 0 ? Number(answer.interval) * SECOND : interval + SLOW_DOWN; continue; }
      if (answer.error === 'expired_token') { end(mine, FLOW.FAILED, WHY.LATE); return; }
      if (answer.error === 'access_denied') { end(mine, FLOW.FAILED, WHY.DENIED); return; }
      if (answer.error) { end(mine, FLOW.FAILED, WHY.GITHUB, String(answer.error_description ?? answer.error).slice(0, 300)); return; }
      // Bestätigt: Ab jetzt gibt es nichts mehr abzubrechen (siehe `cancel`).
      mine.settled = true;
      const entry = granted(answer, null);
      if (!entry) { end(mine, FLOW.FAILED, WHY.GITHUB); return; }
      // Das Token ist erteilt; ein kurzer Aussetzer beim Erfragen des Kontos soll es nicht verwerfen.
      let login;
      for (let tries = 1; !login; tries += 1) {
        try { login = await userOf(entry.token, mine.controller.signal); } catch (error) {
          if (tries >= USER_TRIES || error.status === 401 || mine.controller.signal.aborted) { end(mine, FLOW.FAILED, WHY.GITHUB, error.msg ? null : said(error)); return; }
          await wait(interval, mine.controller.signal);
        }
      }
      keep({ ...entry, login });
      checked = true;
      end(mine, FLOW.DONE);
      log(msg('m_loggedIn', login));
      accountChanged();
      return;
    }
  }

  async function begin(mine, show) {
    let device;
    try { device = await post(CODE_URL, { client_id: clientId }, mine.controller.signal); } catch (error) {
      if (mine.state === FLOW.STARTING) end(mine, FLOW.FAILED, WHY.GITHUB, said(error));
      return;
    }
    if (mine.state !== FLOW.STARTING) return;
    if (device.error || !USER_CODE.test(String(device.user_code)) || !device.device_code) {
      end(mine, FLOW.FAILED, WHY.GITHUB, device.error ? String(device.error_description ?? device.error).slice(0, 300) : null);
      return;
    }
    Object.assign(mine, { state: FLOW.WAITING, code: device.user_code, url: DEVICE_URL });
    show();
    await confirm(mine, device);
  }

  // Antwortet, sobald der Code da ist oder der Ablauf endete.
  async function login() {
    if (closed) throw new Fault('m_closing');
    if (running()) throw new Fault('m_loginRunning');
    if (current.state === STATE.IN) throw new Fault('m_alreadyIn', current.login);
    const mine = { state: FLOW.STARTING, code: null, url: null, why: null, error: null, controller: new AbortController(), ended: null, settled: false };
    flow = mine;
    let show;
    const shown = new Promise((resolve) => { show = resolve; });
    mine.ended = begin(mine, show).catch((error) => { if (running()) end(mine, FLOW.FAILED, WHY.GITHUB, said(error)); }).finally(show);
    await shown;
    return view();
  }

  // Bricht den laufenden Ablauf ab. Hat der Nutzer schon bestätigt, gilt das: Dann wird nur noch zu Ende angemeldet.
  async function cancel() {
    if (!running()) return;
    const mine = flow;
    if (!mine.settled) {
      end(mine, FLOW.CANCELLED);
      mine.controller.abort();
    }
    await mine.ended;
  }

  // Vergisst das Token auf diesem Rechner (siehe oben).
  async function logout() {
    if (closed) throw new Fault('m_closing');
    if (running()) throw new Fault('m_finishLogin');
    if (current.state !== STATE.IN) throw new Fault('m_notIn');
    const login = current.login;
    keep(null);
    checked = false;
    flow = null;
    log(msg('m_loggedOut', login ?? '?'));
  }

  // Die App endet: einen wartenden Ablauf beenden und keinen neuen mehr beginnen.
  // Auch ein schon bestätigter Ablauf endet: Das Programm soll nicht auf das Erfragen des Kontos warten.
  function close() {
    closed = true;
    if (flow?.settled && running()) flow.controller.abort();
    return cancel();
  }

  // Das angemeldete Konto, oder null.
  const signedIn = () => (current.state === STATE.IN ? current.login : null);

  function view() {
    return {
      state: current.state, login: current.login,
      flow: flow ? { state: flow.state, code: flow.code, url: flow.url, why: flow.why, error: flow.error } : null,
      install: INSTALL_URL, revoke: REVOKE_URL,
    };
  }

  held = load();
  current = held ? { state: STATE.IN, login: held.login } : { state: STATE.OUT, login: null };

  return { view, signedIn, poll, token, renew, login, cancel, logout, close };
}

module.exports = { createAuth, STATE, FLOW, WHY, CLIENT_ID, APP_SLUG, INSTALL_URL, REVOKE_URL, FILE };
