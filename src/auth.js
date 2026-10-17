// Signing in to GitHub through the GitHub App “RunClub” (device flow): RunClub fetches a one-time code, the user enters
// it on github.com and confirms, RunClub gets a token for their account. What RunClub may do with it is set by the
// app's permissions and the repos it is installed on (see README).
//
// State     unknown (not read yet) | out (not signed in, or GitHub no longer accepts the sign-in) |
//           in (signed in; then with account).
// Flow      starting (the code is not there yet) | waiting (waits for confirmation, with code and address) |
//           done | failed | cancelled. At most one at a time. A finished flow stays until the next one
//           begins. A failed one names the reason as an id (`why`), so the interface can say it in its language:
//           late (not confirmed in time) | denied (declined in the browser) | github (GitHub reported an
//           error or was unreachable; what it said is in `error` verbatim, otherwise `error` is null).
// Token     Valid for eight hours and renewed 5 minutes before it expires, likewise when GitHub rejects it. Each
//           refresh key is valid only once: the new one is saved first, then used, and only one renewal runs
//           at a time. If GitHub no longer accepts the key (revoked, unused for half a year), the
//           user is signed out.
// Storage   Encrypted via `secrets` (main.js supplies Electron's safeStorage, DPAPI on Windows) in `github.token`
//           in the data folder. Without `secrets` (the backend alone) only in memory: after a restart, sign in again.
// Sign-out  Forgets the token on this machine. Revoking it at GitHub would need the app's secret,
//           and RunClub doesn't have it; for that the interface names the page on GitHub (`revoke`).
// Log       Only that someone signed in or out, and as whom. Code and token stay out.

const fs = require('node:fs');
const path = require('node:path');
const { SECOND, MINUTE } = require('./units');
const { API, apiHeaders } = require('./github');
const { msg, Fault, reason } = require('./messages');

// The GitHub App “RunClub” (https://github.com/settings/apps/runclub-runners). The client ID is not a secret.
const CLIENT_ID = 'Iv23liMHlB06HEzY8bPM';
const APP_SLUG = 'runclub-runners';
// Where the app is installed for another account or organization, and where the user revokes its authorization.
const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
const REVOKE_URL = 'https://github.com/settings/apps/authorizations';
// Where to enter the one-time code. The address is fixed and not read from the reply: the interface turns it
// into a link.
const DEVICE_URL = 'https://github.com/login/device';
const CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const FILE = 'github.token';

const STATE = { UNKNOWN: 'unknown', OUT: 'out', IN: 'in' };
const FLOW = { STARTING: 'starting', WAITING: 'waiting', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' };
const WHY = { LATE: 'late', DENIED: 'denied', GITHUB: 'github' };
const FLOW_TIMEOUT = 15 * MINUTE; // how long the one-time code is valid at GitHub; if GitHub says less, that applies
const EARLY = 5 * MINUTE; // how long before expiry the token is renewed
const SLOW_DOWN = 5 * SECOND; // how much longer to wait when GitHub asks for slower polling
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/; // what an account on GitHub looks like
const SECRET = /^[\w.-]{10,512}$/; // a token or key as GitHub issues them; nothing dangerous for a header
// How GitHub rejects a refresh key that is no longer valid. An already used one it answers (actually
// tried on 18.10.2026) with `incorrect_client_credentials`, not with the documented `bad_refresh_token`.
const REJECTED = ['bad_refresh_token', 'incorrect_client_credentials'];
const USER_TRIES = 3; // how often the account is asked for after confirmation before the flow fails
const RENAME_TRIES = 5; // Windows sometimes briefly holds a file just written (virus scanner, indexer)

// Waits `ms`, or until `signal` aborts.
function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// What an error while asking says, as outside text.
const said = (error) => String(error?.cause?.code ?? error?.message ?? error ?? '').slice(0, 300) || null;

//   file, secrets           where the token lives and how it is encrypted and decrypted ({ encrypt(buffer), decrypt(buffer) });
//                           without both only in memory
//   log(text)               writes to the log
//   onAccount()             a different token applies (after a successful sign-in): re-read rate limit and repos
//   fetch, now, wait        like Node's and `pause`; controllable in tests
function createAuth({ clientId = CLIENT_ID, file = null, secrets = null, fetch = globalThis.fetch, log = () => {}, onAccount = () => {}, now = Date.now, timeout = MINUTE, flowTimeout = FLOW_TIMEOUT, wait = pause, version = '0' }) {
  let held = null; // { token, expiresAt, refresh, refreshExpiresAt, login } or null
  let current = { state: STATE.UNKNOWN, login: null }; // until storage is read
  let checked = false; // the saved token was checked at GitHub
  let checking = null; // the running check
  let renewing = null; // the running renewal; at most one runs
  let flow = null; // the running or the last finished flow
  let closed = false; // the app is ending: nothing new begins

  const accountChanged = () => { try { onAccount(); } catch { /* the state applies anyway */ } };
  const running = () => flow?.state === FLOW.STARTING || flow?.state === FLOW.WAITING;

  // --- Storage ---

  // Checks what comes from the file or from GitHub; null if it is not a usable sign-in.
  function valid(entry) {
    if (!entry || typeof entry !== 'object' || !SECRET.test(String(entry.token))) return null;
    const time = (value) => (Number.isFinite(value) && value > 0 ? value : null);
    return {
      token: entry.token, expiresAt: time(entry.expiresAt), refresh: SECRET.test(String(entry.refresh)) ? entry.refresh : null,
      refreshExpiresAt: time(entry.refreshExpiresAt), login: LOGIN.test(String(entry.login)) ? entry.login : null,
    };
  }

  const draft = () => `${file}.new`;
  // Up to 0.1.0-beta.4 the draft was called `.neu`; one left behind still counts and goes on signing out.
  const legacy = () => `${file}.neu`;
  function read(name) {
    try { return { entry: valid(JSON.parse(secrets.decrypt(fs.readFileSync(name)).toString('utf8'))), at: fs.statSync(name).mtimeMs }; } catch { return null; }
  }
  // If a new state could not be moved into place, it still lies next to it (see `keep`); then the newer one applies.
  function load() {
    if (!file || !secrets) return null;
    const found = [read(file), read(draft()), read(legacy())].filter((item) => item?.entry).sort((a, b) => b.at - a.at);
    return found[0]?.entry ?? null;
  }

  function settle(name) {
    for (let tries = 1; ; tries += 1) {
      try { fs.renameSync(name, file); return; } catch (error) { if (tries >= RENAME_TRIES) throw error; }
    }
  }

  // Save first, then it applies: a new refresh key must not get lost after the old one is used up.
  function keep(entry) {
    if (file && secrets) {
      try {
        if (entry) {
          fs.writeFileSync(draft(), secrets.encrypt(Buffer.from(JSON.stringify(entry), 'utf8')));
          settle(draft());
        } else {
          // Each on its own: if one stayed behind, the user would be signed in again after the next start.
          for (const name of [draft(), legacy(), file]) {
            try { fs.rmSync(name, { force: true }); } catch (error) { log(msg('m_tokenNotRemoved', path.basename(name), reason(error))); }
          }
        }
      } catch (error) {
        // The new state then at least lies next to it and applies at the next start (see `load`).
        log(msg('m_tokenNotSaved', reason(error)));
      }
    }
    held = entry;
    current = entry ? { state: STATE.IN, login: entry.login } : { state: STATE.OUT, login: null };
  }

  // GitHub no longer accepts the sign-in.
  function lost() {
    const login = held?.login;
    keep(null);
    checked = false;
    if (login) log(msg('m_signInLost', login));
  }

  // --- Requests to GitHub ---

  // A form to github.com/login/…; GitHub answers with JSON, even on errors (`error`).
  async function post(url, form, signal) {
    const limit = AbortSignal.timeout(timeout);
    const response = await fetch(url, {
      method: 'POST', body: new URLSearchParams(form),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': `RunClub/${version}` },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    let answer = null;
    try { answer = JSON.parse(await response.text()); } catch { /* below */ }
    if (!answer || typeof answer !== 'object') throw new Error(`HTTP ${response.status}`);
    return answer;
  }

  // The account for the token. Throws with `status` if GitHub refuses.
  async function userOf(token, signal) {
    const limit = AbortSignal.timeout(timeout);
    const response = await fetch(`${API}/user`, { headers: apiHeaders(token, version), signal: signal ? AbortSignal.any([signal, limit]) : limit });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const login = String((await response.json())?.login ?? '');
    if (!LOGIN.test(login)) throw new Fault('m_githubNoAccount');
    return login;
  }

  // The sign-in from the reply carrying the token; null if there is none in it.
  function granted(answer, login) {
    const at = (seconds) => (Number(seconds) > 0 ? now() + Number(seconds) * SECOND : null);
    return valid({ token: answer?.access_token, expiresAt: at(answer?.expires_in), refresh: answer?.refresh_token, refreshExpiresAt: at(answer?.refresh_token_expires_in), login });
  }

  // --- Token ---

  async function renewNow() {
    const before = held;
    if (!before?.refresh || (before.refreshExpiresAt && now() >= before.refreshExpiresAt)) {
      // Without a valid key nothing can be renewed; an expired token is then lost.
      if (before && before.expiresAt && now() >= before.expiresAt) lost();
      return held?.token ?? null;
    }
    let answer;
    try { answer = await post(TOKEN_URL, { client_id: clientId, grant_type: 'refresh_token', refresh_token: before.refresh }); } catch { return null; }
    if (held !== before) return held?.token ?? null; // signed out or in anew meanwhile
    if (REJECTED.includes(answer.error)) { lost(); return null; }
    const next = granted(answer, before.login);
    if (!next) return null;
    keep(next);
    return next.token;
  }

  // Renew; at most one runs, a second call gets the same result.
  function renewOnce() {
    renewing ??= renewNow().finally(() => { renewing = null; });
    return renewing;
  }

  // The token for a request, or null without sign-in. Shortly before expiry it is renewed first.
  async function token() {
    if (!held) return null;
    if (held.expiresAt && now() >= held.expiresAt - EARLY) await renewOnce();
    return held?.token ?? null;
  }

  // GitHub rejected `rejected`. If a different one already applies, that's it; otherwise renew. Without a key to
  // renew with, the sign-in is lost.
  async function renew(rejected) {
    if (!held) return null;
    if (held.token !== rejected) return held.token;
    if (!held.refresh || (held.refreshExpiresAt && now() >= held.refreshExpiresAt)) { lost(); return null; }
    return renewOnce();
  }

  // Check the saved token once at GitHub and read the account along the way. If GitHub is unreachable, the
  // state stays and it is tried again next time.
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
    } catch { /* unreachable: try again later */ }
  }

  // For the regular tick: confirm the state once at GitHub after the start.
  function poll() {
    if (held && !checked) checking ??= check().finally(() => { checking = null; });
    return (checking ?? Promise.resolve()).then(view);
  }

  // --- Signing in ---

  function end(mine, state, why = null, error = null) {
    Object.assign(mine, { state, why, error, code: null, url: null });
    if (state === FLOW.FAILED && why !== WHY.DENIED) log(msg('m_loginFailed', why === WHY.LATE ? msg('m_loginLate') : error ?? msg('m_noReason')));
  }

  // Asks until the user has confirmed in the browser, declined, or the code has expired.
  async function confirm(mine, device) {
    let interval = Math.max(Number(device.interval) || 5, 1) * SECOND;
    const deadline = now() + Math.min((Number(device.expires_in) || Infinity) * SECOND, flowTimeout);
    for (;;) {
      await wait(interval, mine.controller.signal);
      if (mine.state !== FLOW.WAITING) return;
      if (now() >= deadline) { end(mine, FLOW.FAILED, WHY.LATE); return; }
      let answer;
      try { answer = await post(TOKEN_URL, { client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT }, mine.controller.signal); } catch { continue; } // briefly unreachable: keep asking
      if (mine.state !== FLOW.WAITING) return;
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') { interval = Number(answer.interval) > 0 ? Number(answer.interval) * SECOND : interval + SLOW_DOWN; continue; }
      if (answer.error === 'expired_token') { end(mine, FLOW.FAILED, WHY.LATE); return; }
      if (answer.error === 'access_denied') { end(mine, FLOW.FAILED, WHY.DENIED); return; }
      if (answer.error) { end(mine, FLOW.FAILED, WHY.GITHUB, String(answer.error_description ?? answer.error).slice(0, 300)); return; }
      // Confirmed: from now on there is nothing left to cancel (see `cancel`).
      mine.settled = true;
      const entry = granted(answer, null);
      if (!entry) { end(mine, FLOW.FAILED, WHY.GITHUB); return; }
      // The token is granted; a brief hiccup while asking for the account should not discard it.
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

  // Answers as soon as the code is there or the flow ended.
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

  // Cancels the running flow. If the user has already confirmed, that holds: then the sign-in is just finished.
  async function cancel() {
    if (!running()) return;
    const mine = flow;
    if (!mine.settled) {
      end(mine, FLOW.CANCELLED);
      mine.controller.abort();
    }
    await mine.ended;
  }

  // Forgets the token on this machine (see above).
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

  // The app is ending: end a waiting flow and begin no new one.
  // An already confirmed flow ends too: the program should not wait for the account to be asked for.
  function close() {
    closed = true;
    if (flow?.settled && running()) flow.controller.abort();
    return cancel();
  }

  // The signed-in account, or null.
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
