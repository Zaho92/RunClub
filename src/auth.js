// Die Anmeldung bei GitHub. Es ist die von `gh`: dieselbe, die auch das Terminal nutzt. RunClub liest ihren Stand und
// führt Anmelden, Ergänzen eines Rechts und Abmelden, indem es `gh auth …` startet.
//
// Stand     unknown (noch nicht gelesen) | missing (`gh` ist nicht installiert) | out (nicht angemeldet, oder die
//           Anmeldung gilt nicht mehr) | in (angemeldet; dann mit Konto und Rechten).
// Ablauf    Anmelden und Ergänzen laufen über den Browser: `gh` schreibt einen Einmalcode und eine Adresse auf die
//           Fehlerausgabe und wartet, bis dort bestätigt ist. Höchstens einer zugleich, mit Zeitgrenze.
//           starting (der Code ist noch nicht da) | waiting (wartet auf die Bestätigung, mit Code und Adresse) |
//           done | failed (mit Meldung) | cancelled. Ein beendeter Ablauf bleibt stehen, bis der nächste beginnt.
// Protokoll Hinein kommt nur, dass an- oder abgemeldet wurde und als wer. Der Einmalcode und alles, was `gh`
//           schreibt, bleiben draußen; die Meldung eines gescheiterten Ablaufs steht nur im Stand.

const { lastLine } = require('./run');
const { SECOND, MINUTE } = require('./units');

const HOST = 'github.com';
const STATE = { UNKNOWN: 'unknown', MISSING: 'missing', OUT: 'out', IN: 'in' };
const FLOW = { STARTING: 'starting', WAITING: 'waiting', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' };
// Ohne sie kann RunClub nicht arbeiten. `repo` genügt für alles, was es tut: Runner an- und abmelden, Läufe lesen und
// erneut starten, die Variable CI_RUNNER setzen. Mehr wird nicht verlangt (`gh` ergänzt von sich aus `read:org` und `gist`).
const REQUIRED = ['repo'];
// Freiwillige Rechte mit ihrem Zweck; den Satz dazu bildet die Oberfläche. `minutes`: das Minuten-Kontingent zeigen.
const OPTIONAL = [{ scope: 'user', purpose: 'minutes' }];
const FLOW_TIMEOUT = 15 * MINUTE; // so lange gilt auch der Einmalcode bei GitHub
const START_WAIT = 20 * SECOND; // kommt bis dahin kein Code, gilt der Ablauf als gescheitert
const RECHECK = 10 * MINUTE; // so oft wird ein guter Stand im laufenden Betrieb nachgelesen
const DEVICE_URL = 'https://github.com/login/device';
const CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const ADDRESS = /(https:\/\/github\.com\/[\w/.-]*)/; // nur GitHub selbst: Die Oberfläche macht daraus einen Link
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // nichts, was `gh` als Option lesen könnte
const INVALID = /401|bad credentials|invalid|expired|revoked/i; // so begründet `gh` ein Token, das nicht mehr gilt

const signedOut = () => ({ state: STATE.OUT, login: null, scopes: null });
// Ein Token ohne lesbare Rechte (etwa ein fein abgestuftes) hat `scopes: null`: Dann gilt nichts als fehlend.
const scopeList = (text) => { const scopes = String(text ?? '').split(',').map((scope) => scope.trim().replace(/^'|'$/g, '')).filter(Boolean); return scopes.length ? scopes : null; };

// Liest, was `gh auth status --json hosts` schreibt. Null heißt: Daraus lässt sich nichts schließen (GitHub war nicht
// erreichbar, oder die Ausgabe ist keine); dann bleibt der letzte Stand.
function parseHosts(stdout) {
  let hosts;
  try { hosts = JSON.parse(stdout)?.hosts; } catch { return null; }
  if (!hosts || typeof hosts !== 'object') return null;
  const entries = Array.isArray(hosts[HOST]) ? hosts[HOST] : [];
  const entry = entries.find((found) => found?.active) ?? entries[0];
  if (!entry) return signedOut();
  if (entry.state === 'timeout') return null;
  // Abgemeldet heißt nur: GitHub hat das Token abgelehnt. Jeder andere Fehler (kein Netz, Anfragelimit, Störung bei
  // GitHub) sagt nichts über die Anmeldung; dann bleibt der letzte Stand.
  if (entry.state !== 'success') return INVALID.test(String(entry.error ?? '')) ? signedOut() : null;
  return { state: STATE.IN, login: String(entry.login ?? '') || null, scopes: scopeList(entry.scopes) };
}

// Dasselbe aus der Ausgabe für Menschen, für ein `gh`, das `--json` noch nicht kennt.
function parseText(text) {
  const login = String(text ?? '').match(/Logged in to github\.com (?:account|as) (\S+)/);
  if (!login) return /not logged in|Failed to log in/i.test(text) ? signedOut() : null;
  return { state: STATE.IN, login: login[1], scopes: scopeList(String(text).match(/Token scopes: (.*)/)?.[1]) };
}

// `run` wie in run.js. `log(text)` schreibt ins Protokoll; `onSuccess()` läuft nach jedem gelungenen Ablauf, wenn der
// neue Stand gelesen ist.
function createAuth({ run, log = () => {}, onSuccess = () => {}, now = Date.now, timeout = MINUTE, flowTimeout = FLOW_TIMEOUT, startWait = START_WAIT }) {
  let current = { state: STATE.UNKNOWN, login: null, scopes: null };
  let readAt = -Infinity; // wann der Stand zuletzt gelesen wurde
  let reading = null; // das laufende Lesen; es läuft höchstens eines
  let flow = null; // der laufende oder der zuletzt beendete Ablauf

  const running = () => flow?.state === FLOW.STARTING || flow?.state === FLOW.WAITING;

  function view() {
    const signedIn = current.state === STATE.IN;
    const lacks = (scope) => signedIn && Boolean(current.scopes) && !current.scopes.includes(scope);
    return {
      state: current.state, login: current.login, scopes: current.scopes,
      missing: REQUIRED.filter(lacks), // fehlende Pflichtrechte
      optional: OPTIONAL.filter((entry) => lacks(entry.scope)).map((entry) => ({ ...entry })), // fehlende freiwillige
      flow: flow ? { kind: flow.kind, state: flow.state, code: flow.code, url: flow.url, error: flow.error } : null,
    };
  }

  async function read() {
    const json = await run('gh', ['auth', 'status', '--active', '--hostname', HOST, '--json', 'hosts'], { timeout });
    if (json.code === -1 && !json.timedOut && /ENOENT/.test(json.stderr)) return { state: STATE.MISSING, login: null, scopes: null };
    if (json.code === 0) return parseHosts(json.stdout);
    if (!/unknown flag/.test(json.stderr)) return null;
    const plain = await run('gh', ['auth', 'status', '--hostname', HOST], { timeout });
    return parseText(`${plain.stdout}\n${plain.stderr}`);
  }

  // Den Stand lesen. Hat er sich geändert, ist die Meldung eines gescheiterten Ablaufs überholt.
  function refresh() {
    reading ??= read().catch(() => null).then((found) => { // auch ein Fehler beim Lesen gibt das nächste Lesen frei
      reading = null;
      readAt = now();
      if (found && JSON.stringify(found) !== JSON.stringify(current)) {
        current = found;
        if (flow?.state === FLOW.FAILED) flow = null;
      }
      return view();
    });
    return reading;
  }
  // … und zwar sicher nach diesem Augenblick: Ein Lesen, das schon unterwegs ist, kann den alten Stand bringen.
  const fresh = async () => { await reading; return refresh(); };
  // Für den Takt im Betrieb: `gh auth status` fragt bei GitHub nach. Ein guter Stand wird deshalb selten nachgelesen,
  // alles andere jedes Mal, damit eine Anmeldung im Terminal bald ankommt.
  const poll = () => (current.state === STATE.IN && now() - readAt < RECHECK ? Promise.resolve(view()) : refresh());

  // Warum ein Ablauf scheiterte: die letzte Zeile von `gh`, ohne den Code und die Aufforderung.
  function reason(result, code) {
    if (result.timedOut) return 'gh antwortet nicht.';
    const lines = String(result.stderr ?? '').replace(ANSI, '').split('\n').filter((line) => !CODE.test(line) && !/^\W*Open this URL/i.test(line));
    const text = lastLine(lines.join('\n')) || `gh endete mit ${result.code}`;
    return code ? text.split(code).join('…') : text;
  }

  // Startet `gh` mit den Argumenten und führt den Ablauf. Antwortet, sobald der Code da ist oder der Ablauf endete,
  // spätestens nach `startWait`.
  function begin(kind, args) {
    if (running()) throw new Error('Es läuft schon eine Anmeldung. Erst diese abschließen oder abbrechen.');
    const controller = new AbortController();
    const mine = { kind, state: FLOW.STARTING, code: null, url: null, error: null, controller, ended: null, settled: false, silent: false };
    flow = mine;
    let show;
    const shown = new Promise((resolve) => { show = resolve; });
    const onText = (raw) => {
      if (mine.state !== FLOW.STARTING && mine.state !== FLOW.WAITING) return;
      const line = String(raw).replace(ANSI, '');
      const address = line.match(ADDRESS);
      if (address) mine.url = address[1];
      const code = line.match(CODE);
      if (!code) return;
      mine.code = code[1];
      mine.url ??= DEVICE_URL;
      mine.state = FLOW.WAITING;
      show();
    };
    // Die leere Zeile beantwortet die Rückfrage, mit der `gh` sonst auf die Eingabetaste wartet.
    mine.ended = run('gh', args, { input: '\n', timeout: flowTimeout, signal: controller.signal, onLine: onText, onErrLine: onText }).then(async (result) => {
      // `gh` ist zu Ende: Ab jetzt gibt es nichts mehr abzubrechen (siehe `cancel`).
      mine.settled = true;
      // Erst den neuen Stand lesen, dann den Ablauf beenden: sonst stünde kurz „gelungen“ neben „nicht angemeldet“.
      await fresh().catch(() => {});
      const code = mine.code;
      mine.code = null;
      mine.url = null;
      if (mine.silent) {
        mine.state = FLOW.FAILED;
        mine.error = ['gh hat keinen Einmalcode ausgegeben.', result.aborted ? '' : reason(result)].filter(Boolean).join(' ');
      } else if (mine.state !== FLOW.CANCELLED) {
        mine.state = result.code === 0 ? FLOW.DONE : FLOW.FAILED;
        if (result.code !== 0) mine.error = result.timedOut ? `Nicht innerhalb von ${Math.round(flowTimeout / MINUTE)} Minuten bestätigt.` : reason(result, code);
      }
      if (mine.state === FLOW.DONE) {
        if (kind === 'login' && current.state === STATE.IN) log(`Bei GitHub angemeldet als ${current.login}.`);
        try { onSuccess(); } catch { /* der Ablauf ist trotzdem gelungen */ }
      }
      show();
    });
    let timer;
    const patience = new Promise((resolve) => { timer = setTimeout(resolve, startWait); timer.unref?.(); });
    return Promise.race([shown, patience]).then(async () => {
      clearTimeout(timer);
      // Ohne Code gibt es nichts zu bestätigen: Der Ablauf scheitert jetzt, statt eine Viertelstunde stumm zu warten.
      if (mine.state === FLOW.STARTING && !mine.settled) { mine.silent = true; controller.abort(); await mine.ended; }
      return view();
    });
  }

  async function login() {
    if (current.state === STATE.MISSING) throw new Error('Das Programm gh ist nicht installiert.');
    if (current.state === STATE.IN) throw new Error(`Du bist schon als ${current.login} angemeldet.`);
    return begin('login', ['auth', 'login', '--hostname', HOST, '--web', '--git-protocol', 'https', '-s', REQUIRED.join(',')]);
  }

  // Ein Recht ergänzen: ohne Angabe alle fehlenden Pflichtrechte, sonst das genannte freiwillige.
  async function grant(scope) {
    if (current.state !== STATE.IN) throw new Error('Erst bei GitHub anmelden.');
    const open = view();
    const scopes = scope ? open.optional.filter((entry) => entry.scope === scope).map((entry) => entry.scope) : open.missing;
    if (!scopes.length) throw new Error(scope ? 'Dieses Recht fehlt nicht oder lässt sich hier nicht ergänzen.' : 'Der Anmeldung fehlt kein Recht.');
    return begin('scope', ['auth', 'refresh', '-h', HOST, '-s', scopes.join(',')]);
  }

  // Beendet das wartende `gh`. Antwortet, wenn es beendet ist. Ist `gh` schon zu Ende und wird nur noch der neue
  // Stand gelesen, gibt es nichts mehr abzubrechen: Die Bestätigung im Browser gilt dann.
  async function cancel() {
    if (!running()) return;
    const mine = flow;
    if (mine.settled) { await mine.ended; return; }
    mine.state = FLOW.CANCELLED;
    mine.code = null;
    mine.url = null;
    mine.controller.abort();
    await mine.ended;
  }

  async function logout() {
    if (running()) throw new Error('Erst die laufende Anmeldung abschließen oder abbrechen.');
    if (current.state !== STATE.IN) throw new Error('Du bist nicht bei GitHub angemeldet.');
    const login = current.login;
    if (!LOGIN.test(String(login))) throw new Error('Das Konto lässt sich nicht bestimmen. Bitte im Terminal abmelden: gh auth logout');
    const result = await run('gh', ['auth', 'logout', '--hostname', HOST, '--user', login], { input: '\n', timeout });
    await fresh();
    if (result.code !== 0) throw new Error(reason(result));
    flow = null;
    // Kennt `gh` ein weiteres Konto, nutzt es nach dem Abmelden von selbst dieses.
    log(current.state === STATE.IN ? `Bei GitHub abgemeldet (${login}). gh nutzt jetzt das Konto ${current.login}.` : `Bei GitHub abgemeldet (${login}).`);
  }

  return { view, refresh, poll, login, grant, cancel, logout };
}

module.exports = { createAuth, parseHosts, parseText, STATE, FLOW, REQUIRED, OPTIONAL };
