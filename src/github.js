// GitHub über seine REST-Schnittstelle (https://api.github.com), mit dem Token der Anmeldung (siehe auth.js) und
// sparsam mit dem Anfragelimit des Kontos (5.000 je Stunde).
//
// Lesen     Jede Abfrage (`get`) merkt sich Antwort und Kennung (ETag) und fragt beim nächsten Mal bedingt. Hat sich
//           nichts geändert, antwortet GitHub mit 304; das zählt nicht gegen das Limit.
// Limit     Der Stand kommt aus den Kopfzeilen jeder Antwort und aus `rate_limit` (zählt ebenfalls nicht). Das Limit
//           gilt für das ganze Konto: Auch `gh` im Terminal und andere Werkzeuge verbrauchen daraus.
// Pause     Bittet GitHub um Ruhe (403/429 mit `retry-after`, das zweite Limit), wird bis dahin nicht gelesen.
// Zustand   ok | tight (weniger als 15 % frei: seltener abfragen) | out (nur noch die Reserve: nicht mehr lesen,
//           der Rest bleibt für das Anmelden neuer Runner) | unknown (kein Stand, oder das Fenster ist abgelaufen
//           und der neue Stand noch nicht da).
// Token     Kommt bei jeder Anfrage frisch von der Anmeldung (`token()`). Lehnt GitHub es ab (401), lässt die Anfrage
//           es einmal erneuern (`renew`) und versucht es noch einmal.
// Fehler    Eine Antwort mit Fehler wirft einen GitHubError mit `status`; Aufrufer unterscheiden nach ihm, nicht nach
//           dem Text. Der Text ist der von GitHub, mit dem Status dahinter.

const { SECOND, MINUTE, DAY } = require('./units');
const { Fault } = require('./messages');

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const STATE = { OK: 'ok', TIGHT: 'tight', OUT: 'out', UNKNOWN: 'unknown' };
const TIGHT = 0.15; // Anteil, der noch frei ist
const RESERVE = 0.02;
const TIGHT_GAP = MINUTE; // so lange liegt bei knappem Limit zwischen zwei Abfragen derselben Sache
const PAUSE_MAX_S = 3600; // Sekunden; länger lässt sich RunClub von einer Antwort nicht anhalten
const WINDOW_MAX = DAY; // ein Fensterende weiter in der Zukunft ist kein Stand, sondern Unsinn
const PAGE_MAX = 100; // so viele Einträge gibt GitHub höchstens je Seite heraus (`per_page`)
const CACHE_MAX = 500; // gemerkte Antworten; jede Abfrage der Jobs eines Laufs ist eine eigene
const PATH = /^[A-Za-z0-9]/; // ein Pfad unter API, kein absoluter

// Eine Antwort von GitHub mit Fehler. `message` ist der Text von GitHub (ein Text von außen) mit dem Status dahinter.
class GitHubError extends Error {
  constructor(status, text) {
    super(text ? `${text} (HTTP ${status})` : `HTTP ${status}`);
    this.status = status;
  }
}

// Friert eine Antwort samt allem darin ein.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// Der Inhalt einer Antwort als Objekt; leer heißt null. Was kein JSON ist, ist ein Fehler.
function parseBody(text) {
  return String(text ?? '').trim() ? JSON.parse(text) : null;
}

//   token()                 das Token der Anmeldung, oder null, wenn niemand angemeldet ist
//   renew(rejected)         GitHub hat `rejected` abgelehnt: ein neues Token, oder null, wenn es keins gibt
//   fetch                   wie das von Node; in Tests steuerbar
//   version                 steht in der Kennung (User-Agent), die GitHub verlangt
function createGitHub({ token, renew = async () => null, fetch = globalThis.fetch, timeout = MINUTE, now = Date.now, version = '0' }) {
  const cache = new Map(); // Pfad -> { etag, data }, der zuletzt benutzte am Ende
  const polled = new Map(); // Schlüssel -> wann zuletzt abgefragt (nur bei knappem Limit von Belang)
  let quota = null; // { limit, remaining, resetAt (ms) }
  let pausedUntil = 0; // bis dahin hat GitHub um Ruhe gebeten (`retry-after`)
  let reported = STATE.UNKNOWN; // der Zustand, den refreshQuota zuletzt gemeldet hat

  function note(limit, remaining, reset) {
    const values = [limit, remaining, reset].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[0] <= 0) return;
    const resetAt = values[2] * SECOND;
    if (resetAt > now() + WINDOW_MAX) return;
    quota = { limit: values[0], remaining: Math.max(0, values[1]), resetAt };
  }

  const paused = () => now() < pausedUntil;
  const windowOpen = () => Boolean(quota) && now() < quota.resetAt; // es gibt einen Stand, und er gilt noch
  const spent = () => windowOpen() && quota.remaining <= quota.limit * RESERVE;

  // Eine erbetene Pause gilt auch über das Ende des Fensters hinaus.
  function state() {
    if (paused() || spent()) return STATE.OUT;
    if (!windowOpen()) return STATE.UNKNOWN;
    return quota.remaining < quota.limit * TIGHT ? STATE.TIGHT : STATE.OK;
  }

  // Wann es weitergeht: am Ende des Fensters; wurde nur um eine Pause gebeten, an deren Ende. Ist beides der Fall,
  // zählt das spätere.
  const endsAt = () => Math.max(paused() ? pausedUntil : 0, spent() ? quota.resetAt : 0) || quota.resetAt;

  // Darf das, was `key` benennt (ein Repo), jetzt routinemäßig abgefragt werden? Bei knappem Limit nur im Abstand `gap`,
  // bei aufgebrauchtem gar nicht.
  function mayPoll(key, gap = TIGHT_GAP) {
    const current = state();
    if (current === STATE.OUT) return false;
    if (current === STATE.TIGHT) {
      if (now() - (polled.get(key) ?? -Infinity) < gap) return false;
      polled.set(key, now());
    }
    return true;
  }

  // Eine Anfrage, einmal. Liefert die Antwort von fetch; wirft nur, wenn GitHub nicht antwortet.
  async function once(secret, method, path, { body, etag }) {
    const headers = { authorization: `Bearer ${secret}`, accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION, 'user-agent': `RunClub/${version}` };
    if (etag) headers['if-none-match'] = etag;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(`${API}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Fault('m_githubSilent');
      throw new Fault('m_githubUnreachable', String(error?.cause?.code ?? error?.message ?? error));
    }
  }

  // Eine Anfrage mit dem Token der Anmeldung; lehnt GitHub es ab, einmal mit einem erneuerten. Merkt sich Limit und
  // Pause aus der Antwort. Liefert `{ status, headers, text }`.
  async function request(method, path, options = {}) {
    // Das Token geht nur an GitHub: Eine eigene Adresse im Pfad wäre ein Fehler des Aufrufers.
    if (!PATH.test(String(path)) || new URL(path, `${API}/`).origin !== API) throw new TypeError(`Kein Pfad unter ${API}: ${path}`);
    let secret = await token();
    if (!secret) throw new Fault('m_loginFirst');
    let response = await once(secret, method, path, options);
    if (response.status === 401) {
      const next = await renew(secret).catch(() => null);
      if (next && next !== secret) { secret = next; response = await once(secret, method, path, options); }
    }
    const headers = response.headers;
    if ((headers.get('x-ratelimit-resource') ?? 'core') === 'core') note(headers.get('x-ratelimit-limit'), headers.get('x-ratelimit-remaining'), headers.get('x-ratelimit-reset'));
    // Das zweite Limit von GitHub (zu viel in kurzer Zeit): Die Antwort nennt, wie lange zu warten ist.
    const retry = Number(headers.get('retry-after'));
    if ((response.status === 403 || response.status === 429) && retry > 0) pausedUntil = now() + Math.min(retry, PAUSE_MAX_S) * SECOND;
    return { status: response.status, headers, text: await response.text() };
  }

  // Wirft für eine Antwort mit Fehler; GitHub nennt den Grund in `message`.
  function check({ status, text }) {
    if (status >= 200 && status < 300) return;
    let said = '';
    try { said = String(JSON.parse(text)?.message ?? ''); } catch { /* kein JSON: dann nur der Status */ }
    throw new GitHubError(status, said.slice(0, 300));
  }

  // Lesen. Die Antwort ist eingefroren, weil dieselbe bei 304 an den nächsten geht. Bei aufgebrauchtem Limit oder
  // erbetener Pause wird nicht gefragt.
  async function get(path) {
    if (state() === STATE.OUT) throw new Fault(paused() ? 'm_githubPause' : 'm_quotaSpent', { time: new Date(endsAt()).toISOString() });
    const known = cache.get(path);
    const response = await request('GET', path, { etag: known?.etag });
    if (response.status === 304 && known) {
      cache.delete(path);
      cache.set(path, known);
      return known.data;
    }
    check(response);
    const data = deepFreeze(parseBody(response.text));
    cache.delete(path);
    const etag = response.headers.get('etag');
    if (etag) {
      cache.set(path, { etag, data });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return data;
  }

  // Schreiben (POST, PATCH, PUT, DELETE), optional mit einem Objekt als Inhalt. Geht immer durch, auch bei
  // aufgebrauchtem Limit: Die Reserve ist für das Anmelden neuer Runner da.
  async function send(method, path, body) {
    const response = await request(method, path, { body });
    check(response);
    return parseBody(response.text);
  }

  // `tightAt`: der verbrauchte Anteil, ab dem es knapp ist; die Oberfläche setzt dort ihre Marke.
  const view = () => (!windowOpen() ? null : { limit: quota.limit, remaining: quota.remaining, resetAt: new Date(endsAt()).toISOString(), state: state(), tightAt: 1 - TIGHT });

  // Den Stand ausdrücklich holen; nötig, solange sonst nichts abgefragt wird. Liefert den Stand, wenn der Zustand
  // seit dem letzten Aufruf gekippt ist (mit dem vorigen als `before`; `resetAt` ist dann das Ende der Pause, wenn sie länger gilt),
  // sonst null.
  async function refreshQuota() {
    try {
      const response = await request('GET', 'rate_limit');
      if (response.status === 200) { const core = JSON.parse(response.text).resources.core; note(core.limit, core.remaining, core.reset); }
    } catch { /* nicht angemeldet oder nicht erreichbar: Dann bleibt der letzte Stand */ }
    const current = state();
    if (!windowOpen() || current === reported) return null;
    const before = reported;
    reported = current;
    return { ...view(), before, paused: paused() };
  }

  return { get, send, refreshQuota, mayPoll, quota: view };
}

// Einen Runner bei GitHub abmelden. 404 heißt: schon weg (etwa von selbst nach seinem Job) und ist kein Fehler.
// `github` wie createGitHub.
async function unregisterRunner(github, repo, runnerId) {
  try { await github.send('DELETE', `repos/${repo}/actions/runners/${runnerId}`); } catch (error) {
    if (error.status !== 404) throw error;
  }
}

module.exports = { createGitHub, GitHubError, deepFreeze, unregisterRunner, STATE, PAGE_MAX, API };
