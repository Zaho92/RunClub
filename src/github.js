// GitHub über das Programm `gh`, sparsam mit dem Anfragelimit des Kontos (5.000 je Stunde).
//
// Lesen     Jede einfache Abfrage (`['api', pfad]`) merkt sich Antwort und Kennung (ETag) und fragt beim nächsten Mal
//           bedingt. Hat sich nichts geändert, antwortet GitHub mit 304; das zählt nicht gegen das Limit.
// Limit     Der Stand kommt aus den Kopfzeilen jeder Antwort und aus `rate_limit` (zählt ebenfalls nicht). Das Limit
//           gilt für das ganze Konto: Auch `gh` im Terminal und andere Werkzeuge verbrauchen daraus.
// Zustand   ok | tight (weniger als 15 % frei: seltener abfragen) | out (nur noch die Reserve: nicht mehr lesen,
//           der Rest bleibt für das Anmelden neuer Runner) | unknown (kein Stand, oder das Fenster ist abgelaufen
//           und der neue Stand noch nicht da).

const { lastLine } = require('./run');

const STATE = { OK: 'ok', TIGHT: 'tight', OUT: 'out', UNKNOWN: 'unknown' };
const TIGHT = 0.15; // Anteil, der noch frei ist
const RESERVE = 0.02;
const TIGHT_GAP = 60000; // so lange liegt bei knappem Limit zwischen zwei Abfragen derselben Sache
const WINDOW_MAX = 24 * 3600000; // ein Fensterende weiter in der Zukunft ist kein Stand, sondern Unsinn
const CACHE_MAX = 200; // gemerkte Antworten; jede Abfrage der Jobs eines Laufs ist eine eigene

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

function createGitHub({ run, timeout = 60000, now = () => Date.now() }) {
  const cache = new Map(); // Pfad -> { etag, data }, der zuletzt benutzte am Ende
  const polled = new Map(); // Schlüssel -> wann zuletzt abgefragt (nur bei knappem Limit von Belang)
  let quota = null; // { limit, remaining, resetAt (ms) }
  let reported = STATE.UNKNOWN; // der Zustand, den refreshQuota zuletzt gemeldet hat

  function note(limit, remaining, reset) {
    const values = [limit, remaining, reset].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[0] <= 0) return;
    const resetAt = values[2] * 1000;
    if (resetAt > now() + WINDOW_MAX) return;
    quota = { limit: values[0], remaining: Math.max(0, values[1]), resetAt };
  }

  function state() {
    if (!quota || now() >= quota.resetAt) return STATE.UNKNOWN;
    if (quota.remaining <= quota.limit * RESERVE) return STATE.OUT;
    return quota.remaining < quota.limit * TIGHT ? STATE.TIGHT : STATE.OK;
  }

  // Das Ende des Fensters als Uhrzeit für Meldungen (die sind deutsch).
  const until = () => new Date(quota.resetAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  // Darf das, was `key` benennt (ein Repo), jetzt routinemäßig abgefragt werden? Bei knappem Limit nur in
  // größerem Abstand, bei aufgebrauchtem gar nicht.
  function mayPoll(key) {
    const current = state();
    if (current === STATE.OUT) return false;
    if (current === STATE.TIGHT) {
      if (now() - (polled.get(key) ?? -Infinity) < TIGHT_GAP) return false;
      polled.set(key, now());
    }
    return true;
  }

  async function read(path) {
    if (state() === STATE.OUT) throw new Error(`Das Anfragelimit von GitHub ist aufgebraucht; weiter um ${until()}.`);
    const known = cache.get(path);
    const result = await run('gh', ['api', '-i', path, ...(known ? ['-H', `If-None-Match: ${known.etag}`] : [])], { timeout });
    const { status, headers, body } = parseResponse(result.stdout);
    if ((headers['x-ratelimit-resource'] ?? 'core') === 'core') note(headers['x-ratelimit-limit'], headers['x-ratelimit-remaining'], headers['x-ratelimit-reset']);
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
    const result = await run('gh', input === undefined ? args : [...args, '--input', '-'], { input, timeout });
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || `gh endete mit ${result.code}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }

  // `tightAt`: der verbrauchte Anteil, ab dem es knapp ist; die Oberfläche setzt dort ihre Marke.
  const view = () => (state() === STATE.UNKNOWN ? null : { limit: quota.limit, remaining: quota.remaining, resetAt: new Date(quota.resetAt).toISOString(), state: state(), tightAt: 1 - TIGHT });

  // Den Stand ausdrücklich holen; nötig, solange sonst nichts abgefragt wird. Liefert den Stand, wenn der Zustand
  // seit dem letzten Aufruf gekippt ist (mit dem vorigen als `before` und dem Ende des Fensters als Uhrzeit `until`),
  // sonst null.
  async function refreshQuota() {
    const result = await run('gh', ['api', 'rate_limit'], { timeout });
    if (result.code === 0) {
      try { const core = JSON.parse(result.stdout).resources.core; note(core.limit, core.remaining, core.reset); } catch { /* dann bleibt der letzte Stand */ }
    }
    const current = state();
    if (current === STATE.UNKNOWN || current === reported) return null;
    const before = reported;
    reported = current;
    return { ...view(), before, until: until() };
  }

  return { call, refreshQuota, mayPoll, quota: view };
}

module.exports = { createGitHub, parseResponse, STATE };
