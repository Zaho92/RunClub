// GitHub über das Programm `gh`, sparsam mit dem Anfragelimit des Kontos (5.000 je Stunde).
//
// Lesen     Jede einfache Abfrage (`['api', pfad]`) merkt sich Antwort und Kennung (ETag) und fragt beim nächsten Mal
//           bedingt. Hat sich nichts geändert, antwortet GitHub mit 304; das zählt nicht gegen das Limit.
// Limit     Der Stand kommt aus den Kopfzeilen jeder Antwort und aus `rate_limit` (zählt ebenfalls nicht). Das Limit
//           gilt für das ganze Konto: Auch `gh` im Terminal und andere Werkzeuge verbrauchen daraus.
// Zustand   ok | tight (weniger als 15 % frei: seltener abfragen) | out (nur noch die Reserve: nicht mehr abfragen,
//           der Rest bleibt für das Anmelden neuer Runner) | unknown (noch kein Stand).

const TIGHT = 0.15;
const RESERVE = 0.02;
const CACHE_MAX = 200; // gemerkte Antworten; jede Abfrage der Jobs eines Laufs ist eine eigene

const lastLine = (text) => String(text ?? '').trim().split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';

// Zerlegt, was `gh api -i` schreibt: Statuszeile, Kopfzeilen, Leerzeile, Inhalt.
function parseResponse(text) {
  const raw = String(text ?? '');
  const head = raw.match(/^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n/);
  if (!head) return { status: 0, headers: {}, body: raw };
  const headers = {};
  for (const line of head[2].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number(head[1]), headers, body: raw.slice(head[0].length) };
}

function createGitHub({ run, timeout = 60000, now = () => Date.now() }) {
  const cache = new Map(); // Pfad -> { etag, data }, der zuletzt benutzte am Ende
  let quota = null; // { limit, remaining, resetAt (ms) }

  function note(limit, remaining, reset) {
    const values = [limit, remaining, reset].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[0] <= 0) return;
    quota = { limit: values[0], remaining: Math.max(0, values[1]), resetAt: values[2] * 1000 };
  }

  function state() {
    if (!quota) return 'unknown';
    if (now() >= quota.resetAt) return 'ok'; // das Fenster hat neu begonnen; der genaue Stand folgt
    if (quota.remaining <= quota.limit * RESERVE) return 'out';
    return quota.remaining < quota.limit * TIGHT ? 'tight' : 'ok';
  }

  async function read(path) {
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
      cache.set(path, { etag: headers.etag, data });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return data;
  }

  // Wie bisher: Argumente für `gh`, optional ein Objekt als Eingabe; liefert die Antwort als Objekt oder wirft.
  // Wer eine Antwort bekommt, darf sie nicht verändern: Dieselbe geht bei 304 an den nächsten.
  async function call(args, input) {
    if (input === undefined && args.length === 2 && args[0] === 'api') return read(args[1]);
    const result = await run('gh', input === undefined ? args : [...args, '--input', '-'], { input, timeout });
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || `gh endete mit ${result.code}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }

  // Den Stand ausdrücklich holen; nötig, solange sonst nichts abgefragt wird.
  async function refreshQuota() {
    const result = await run('gh', ['api', 'rate_limit'], { timeout });
    if (result.code !== 0) return;
    try { const core = JSON.parse(result.stdout).resources.core; note(core.limit, core.remaining, core.reset); } catch { /* dann bleibt der letzte Stand */ }
  }

  return {
    call, refreshQuota, state,
    quota: () => (quota ? { limit: quota.limit, remaining: now() >= quota.resetAt ? quota.limit : quota.remaining, resetAt: new Date(quota.resetAt).toISOString(), state: state() } : null),
  };
}

module.exports = { createGitHub, parseResponse };
