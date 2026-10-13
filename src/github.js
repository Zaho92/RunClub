// GitHub über das Programm `gh`, sparsam mit dem Anfragelimit des Kontos (5.000 je Stunde).
//
// Lesen     Jede einfache Abfrage (`['api', pfad]`) merkt sich Antwort und Kennung (ETag) und fragt beim nächsten Mal
//           bedingt. Hat sich nichts geändert, antwortet GitHub mit 304; das zählt nicht gegen das Limit.
// Limit     Der Stand kommt aus den Kopfzeilen jeder Antwort und aus `rate_limit` (zählt ebenfalls nicht). Das Limit
//           gilt für das ganze Konto: Auch `gh` im Terminal und andere Werkzeuge verbrauchen daraus.
// Pause     Bittet GitHub um Ruhe (403/429 mit `retry-after`, das zweite Limit), wird bis dahin nicht gelesen.
// Zustand   ok | tight (weniger als 15 % frei: seltener abfragen) | out (nur noch die Reserve: nicht mehr lesen,
//           der Rest bleibt für das Anmelden neuer Runner) | unknown (kein Stand, oder das Fenster ist abgelaufen
//           und der neue Stand noch nicht da).

const { lastLine } = require('./run');
const { SECOND, MINUTE, DAY } = require('./units');

const STATE = { OK: 'ok', TIGHT: 'tight', OUT: 'out', UNKNOWN: 'unknown' };
const TIGHT = 0.15; // Anteil, der noch frei ist
const RESERVE = 0.02;
const TIGHT_GAP = MINUTE; // so lange liegt bei knappem Limit zwischen zwei Abfragen derselben Sache
const PAUSE_MAX_S = 3600; // Sekunden; länger lässt sich RunClub von einer Antwort nicht anhalten
const WINDOW_MAX = DAY; // ein Fensterende weiter in der Zukunft ist kein Stand, sondern Unsinn
const CACHE_MAX = 500; // gemerkte Antworten; jede Abfrage der Jobs eines Laufs ist eine eigene
// RunClub arbeitet mit der Anmeldung von `gh` bei github.com (siehe auth.js). Was `gh` aus der Umgebung läse, gilt
// deshalb nicht: ein Token, das die Anmeldung umgeht, ein anderer Host, und das Mitschreiben des Verkehrs samt Token
// auf die Fehlerausgabe (deren letzte Zeile als Fehlermeldung in die Oberfläche geht). Ein leerer Wert zählt für `gh`
// wie ein fehlender. Der Hinweis auf eine neue Version von `gh` stünde sonst ebenfalls als letzte Zeile da, und
// erzwungene Farbe (GH_FORCE_TTY, CLICOLOR_FORCE) setzte Steuerzeichen in die Antworten, die hier gelesen werden.
const GH_ENV = Object.freeze({ GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', GH_HOST: '', GH_DEBUG: '', DEBUG: '', GH_FORCE_TTY: '', CLICOLOR_FORCE: '', GH_NO_UPDATE_NOTIFIER: '1' });

// Friert eine Antwort samt allem darin ein.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// Zerlegt, was `gh api -i` schreibt: Statuszeile, Kopfzeilen, Leerzeile, Inhalt. Stehen mehrere solche Blöcke
// hintereinander (Weiterleitung), gilt der letzte.
function parseResponse(text) {
  let rest = String(text ?? '');
  let found = { status: 0, headers: {}, body: rest };
  for (;;) {
    const head = rest.match(/^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n/);
    if (!head) return found;
    const headers = {};
    for (const line of head[2].split('\n')) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    rest = rest.slice(head[0].length);
    found = { status: Number(head[1]), headers, body: rest };
    // Weiter geht es nur hinter einer Weiterleitung; der Inhalt einer Antwort wird nie als Block gelesen.
    if (found.status < 300 || found.status === 304 || found.status >= 400) return found;
  }
}

function createGitHub({ run: start, timeout = MINUTE, now = Date.now }) {
  const cache = new Map(); // Pfad -> { etag, data }, der zuletzt benutzte am Ende
  const polled = new Map(); // Schlüssel -> wann zuletzt abgefragt (nur bei knappem Limit von Belang)
  let quota = null; // { limit, remaining, resetAt (ms) }
  let pausedUntil = 0; // bis dahin hat GitHub um Ruhe gebeten (`retry-after`)
  const run = (args, input) => start('gh', args, { input, timeout, env: GH_ENV });
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

  // Das Ende des Fensters als Uhrzeit für Meldungen (die sind deutsch).
  const until = () => new Date(endsAt()).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

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

  async function read(path) {
    if (state() === STATE.OUT) throw new Error(paused() ? `GitHub bittet um eine Pause; weiter um ${until()}.` : `Das Anfragelimit von GitHub ist aufgebraucht; weiter um ${until()}.`);
    const known = cache.get(path);
    const result = await run(['api', '-i', path, ...(known ? ['-H', `If-None-Match: ${known.etag}`] : [])]);
    const { status, headers, body } = parseResponse(result.stdout);
    if ((headers['x-ratelimit-resource'] ?? 'core') === 'core') note(headers['x-ratelimit-limit'], headers['x-ratelimit-remaining'], headers['x-ratelimit-reset']);
    // Das zweite Limit von GitHub (zu viel in kurzer Zeit): Die Antwort nennt, wie lange zu warten ist.
    if ((status === 403 || status === 429) && Number(headers['retry-after']) > 0) pausedUntil = now() + Math.min(Number(headers['retry-after']), PAUSE_MAX_S) * SECOND;
    if (status === 304 && known) {
      cache.delete(path);
      cache.set(path, known);
      return known.data;
    }
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || `gh endete mit ${result.code}`);
    const data = body.trim() ? JSON.parse(body) : null;
    cache.delete(path);
    if (headers.etag) {
      cache.set(path, { etag: headers.etag, data: deepFreeze(data) });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return data;
  }

  // Wie bisher: Argumente für `gh`, optional ein Objekt als Eingabe; liefert die Antwort als Objekt oder wirft.
  // Eine einfache Abfrage (`['api', pfad]`) wird bedingt gelesen. Eine solche Antwort ist eingefroren, weil
  // dieselbe bei 304 an den nächsten geht. Schreiben geht immer durch, auch bei aufgebrauchtem Limit.
  async function call(args, input) {
    if (input === undefined && args.length === 2 && args[0] === 'api') return read(args[1]);
    const result = await run(input === undefined ? args : [...args, '--input', '-'], input);
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || `gh endete mit ${result.code}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }

  // `tightAt`: der verbrauchte Anteil, ab dem es knapp ist; die Oberfläche setzt dort ihre Marke.
  const view = () => (!windowOpen() ? null : { limit: quota.limit, remaining: quota.remaining, resetAt: new Date(endsAt()).toISOString(), state: state(), tightAt: 1 - TIGHT });

  // Den Stand ausdrücklich holen; nötig, solange sonst nichts abgefragt wird. Liefert den Stand, wenn der Zustand
  // seit dem letzten Aufruf gekippt ist (mit dem vorigen als `before` und dem Ende des Fensters als Uhrzeit `until`),
  // sonst null.
  async function refreshQuota() {
    const result = await run(['api', 'rate_limit']);
    if (result.code === 0) {
      try { const core = JSON.parse(result.stdout).resources.core; note(core.limit, core.remaining, core.reset); } catch { /* dann bleibt der letzte Stand */ }
    }
    const current = state();
    if (!windowOpen() || current === reported) return null;
    const before = reported;
    reported = current;
    return { ...view(), before, until: until(), paused: paused() };
  }

  return { call, refreshQuota, mayPoll, quota: view };
}

module.exports = { createGitHub, parseResponse, deepFreeze, STATE, GH_ENV };
