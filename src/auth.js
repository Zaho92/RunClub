// Die Anmeldung bei GitHub. Es ist die von `gh`: dieselbe, die auch das Terminal nutzt. RunClub liest ihren Stand und
// führt Anmelden, Ergänzen eines Rechts und Abmelden, indem es `gh auth …` startet.
//
// Stand     unknown (noch nicht gelesen) | missing (`gh` ist nicht installiert) | out (nicht angemeldet, oder die
//           Anmeldung gilt nicht mehr) | in (angemeldet; dann mit Konto und Rechten).
// Ablauf    Anmelden und Ergänzen laufen über den Browser: `gh` schreibt einen Einmalcode und eine Adresse auf die
//           Fehlerausgabe und wartet, bis dort bestätigt ist. Höchstens einer zugleich, mit Zeitgrenze.
//           starting (der Code ist noch nicht da) | waiting (wartet auf die Bestätigung, mit Code und Adresse) |
//           done | failed | cancelled. Ein beendeter Ablauf bleibt stehen, bis der nächste beginnt. Ein gescheiterter
//           nennt den Grund als Kennung (`why`), damit die Oberfläche ihn in ihrer Sprache sagt: late (nicht rechtzeitig
//           bestätigt) | silent (`gh` gab keinen Code aus) | gh (`gh` meldete einen Fehler). Was `gh` dazu zuletzt
//           schrieb, steht wörtlich in `error`; schrieb es nichts, ist `error` null.
// Zugleich  Anmelden, Ergänzen und Abmelden schließen einander aus. Nach `close` (die App endet) beginnt nichts mehr.
// Protokoll Hinein kommt nur, dass an- oder abgemeldet wurde und als wer. Der Einmalcode und alles, was `gh`
//           schreibt, bleiben draußen; die Meldung eines gescheiterten Ablaufs steht nur im Stand.

const { lastLine, ESCAPES } = require('./run');
const { SECOND, MINUTE } = require('./units');
const { GH_ENV } = require('./github');
const { SCOPE: MINUTES_SCOPE } = require('./minutes');
const { msg, Fault } = require('./messages');

const HOST = 'github.com';
const STATE = { UNKNOWN: 'unknown', MISSING: 'missing', OUT: 'out', IN: 'in' };
const FLOW = { STARTING: 'starting', WAITING: 'waiting', DONE: 'done', FAILED: 'failed', CANCELLED: 'cancelled' };
const WHY = { LATE: 'late', SILENT: 'silent', GH: 'gh' };
// Ohne sie kann RunClub nicht arbeiten. `repo` genügt für alles, was es mit den Runnern tut: Runner an- und abmelden,
// Läufe lesen und erneut starten, die Variable CI_RUNNER setzen. `gh` ergänzt von sich aus `read:org` und `gist`,
// und die Oberfläche sagt das dazu.
const REQUIRED = ['repo'];
// Freiwillige Rechte mit ihrem Zweck; den Satz dazu bildet die Oberfläche. `minutes`: das Minuten-Kontingent zeigen.
// Freiwillig heißt: Fehlt eines, ist das keine Störung. Das Anmelden in der App verlangt sie trotzdem gleich mit
// (Entscheidung des Nutzers, 14.10.2026: ein Schritt statt Anmelden und danach Ergänzen); ergänzt werden müssen sie
// nur nach einer Anmeldung im Terminal, die sie nicht verlangt hat.
const OPTIONAL = [{ scope: MINUTES_SCOPE, purpose: 'minutes' }];
const FLOW_TIMEOUT = 15 * MINUTE; // so lange gilt auch der Einmalcode bei GitHub
const START_WAIT = 20 * SECOND; // kommt bis dahin kein Code, gilt der Ablauf als gescheitert
const RECHECK = 10 * MINUTE; // so oft wird ein guter Stand im laufenden Betrieb nachgelesen
// Wo der Einmalcode einzugeben ist. Die Adresse steht fest und wird nicht aus der Ausgabe von `gh` gelesen: Die
// Oberfläche macht daraus einen Link, und auf github.com liegen auch Seiten Dritter.
const DEVICE_URL = 'https://github.com/login/device';
const CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/; // nichts, was `gh` als Option lesen könnte
// So begründet `gh` ein Token, das GitHub ablehnt. Bewusst eng: „401“, „invalid“ oder „expired“ allein stehen auch in
// Störungen (ein Port, eine Kennung, ein abgelaufenes Zertifikat, HTML statt JSON).
const INVALID = /\bHTTP 401\b|bad credentials/i;
const INVALID_TEXT = /token in .* is (invalid|no longer valid)/i; // dasselbe in der Ausgabe für Menschen

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

// Dasselbe aus der Ausgabe für Menschen, für ein `gh`, das `--json` noch nicht kennt. Auch hier meldet nur ein
// abgelehntes Token ab: „Failed to log in“ allein schreibt `gh` bei jeder Störung.
function parseText(text) {
  const login = String(text ?? '').match(/Logged in to github\.com (?:account|as) (\S+)/);
  if (!login) return /not logged in/i.test(text) || (/Failed to log in/i.test(text) && INVALID_TEXT.test(text)) ? signedOut() : null;
  return { state: STATE.IN, login: login[1], scopes: scopeList(String(text).match(/Token scopes: (.*)/)?.[1]) };
}

// `run` wie in run.js. `log(text)` schreibt ins Protokoll. `onAccount()` läuft, sobald mit einem anderen Token
// gearbeitet wird und der neue Stand gelesen ist: nach jedem gelungenen Ablauf und nach einem Abmelden, wenn `gh`
// danach von selbst ein weiteres Konto nutzt.
function createAuth({ run, log = () => {}, onAccount = () => {}, now = Date.now, timeout = MINUTE, flowTimeout = FLOW_TIMEOUT, startWait = START_WAIT }) {
  let current = { state: STATE.UNKNOWN, login: null, scopes: null };
  let readAt = -Infinity; // wann der Stand zuletzt gelesen wurde
  let reading = null; // das laufende Lesen; es läuft höchstens eines
  let flow = null; // der laufende oder der zuletzt beendete Ablauf
  let leaving = false; // es wird gerade abgemeldet
  let closed = false; // die App endet: Es beginnt nichts mehr

  // `gh` starten, ohne dass die Umgebung die Anmeldung umgeht oder mitschreibt (siehe GH_ENV in github.js).
  const gh = (args, options) => run('gh', args, { ...options, env: GH_ENV });
  const accountChanged = () => { try { onAccount(); } catch { /* der Stand gilt trotzdem */ } };
  const running = () => flow?.state === FLOW.STARTING || flow?.state === FLOW.WAITING;

  function view() {
    const signedIn = current.state === STATE.IN;
    const lacks = (scope) => signedIn && Boolean(current.scopes) && !current.scopes.includes(scope);
    const known = [...REQUIRED, ...OPTIONAL.map((entry) => entry.scope)];
    return {
      state: current.state, login: current.login, scopes: current.scopes,
      required: [...REQUIRED], // die Pflichtrechte, damit die Oberfläche sie beim Namen nennt
      extra: (current.scopes ?? []).filter((scope) => !known.includes(scope)), // Rechte, die RunClub nicht nutzt (`gh` verlangt von sich aus mehr)
      missing: REQUIRED.filter(lacks), // fehlende Pflichtrechte
      optional: OPTIONAL.filter((entry) => lacks(entry.scope)).map((entry) => ({ ...entry })), // fehlende freiwillige
      // `scopes`: die Rechte, um die es im Ablauf geht
      flow: flow ? { kind: flow.kind, scopes: [...flow.scopes], state: flow.state, code: flow.code, url: flow.url, why: flow.why, error: flow.error } : null,
    };
  }

  // Das Konto, wenn es angemeldet ist und ihm das Recht nicht fehlt, sonst null. Lassen sich die Rechte nicht lesen,
  // gilt es als vorhanden: Dann zeigt erst die Abfrage, ob es reicht.
  function loginWith(scope) {
    return current.state === STATE.IN && !(current.scopes && !current.scopes.includes(scope)) ? current.login : null;
  }

  async function read() {
    const json = await gh(['auth', 'status', '--active', '--hostname', HOST, '--json', 'hosts'], { timeout });
    if (json.code === -1 && !json.timedOut && /ENOENT/.test(json.stderr)) return { state: STATE.MISSING, login: null, scopes: null };
    if (json.code === 0) return parseHosts(json.stdout);
    if (!/unknown flag/.test(json.stderr)) return null;
    const plain = await gh(['auth', 'status', '--hostname', HOST], { timeout });
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

  // Was `gh` zuletzt als Fehler schrieb, ohne den Code und die Aufforderung; leer, wenn es nichts schrieb.
  function said(stderr, code) {
    const lines = String(stderr ?? '').replace(ESCAPES, '').split('\n').filter((line) => !CODE.test(line) && !/^\W*Open this URL/i.test(line));
    const text = lastLine(lines.join('\n'));
    return code ? text.split(code).join('…') : text;
  }

  // Startet `gh` mit den Argumenten und führt den Ablauf. Antwortet, sobald der Code da ist oder der Ablauf endete,
  // spätestens nach `startWait`.
  function begin(kind, scopes, args) {
    if (closed) throw new Fault('m_closing');
    if (leaving) throw new Fault('m_leaving');
    if (running()) throw new Fault('m_loginRunning');
    const controller = new AbortController();
    const mine = { kind, scopes, state: FLOW.STARTING, code: null, url: null, why: null, error: null, controller, ended: null, settled: false, silent: false, heard: '' };
    flow = mine;
    let show;
    const shown = new Promise((resolve) => { show = resolve; });
    const onText = (raw) => {
      if (mine.state !== FLOW.STARTING && mine.state !== FLOW.WAITING) return;
      const line = String(raw).replace(ESCAPES, '');
      const code = line.match(CODE);
      // Was `gh` statt des Codes schreibt, erklärt später, warum keiner kam.
      if (!code) { mine.heard = said(line) || mine.heard; return; }
      mine.code = code[1];
      mine.url = DEVICE_URL;
      mine.state = FLOW.WAITING;
      show();
    };
    // Die leere Zeile beantwortet die Rückfrage, mit der `gh` sonst auf die Eingabetaste wartet.
    mine.ended = gh(args, { input: '\n', timeout: flowTimeout, signal: controller.signal, onLine: onText, onErrLine: onText }).then(async (result) => {
      // `gh` ist zu Ende: Ab jetzt gibt es nichts mehr abzubrechen (siehe `cancel`).
      mine.settled = true;
      // Erst den neuen Stand lesen, dann den Ablauf beenden: sonst stünde kurz „gelungen“ neben „nicht angemeldet“.
      await fresh().catch(() => {});
      const code = mine.code;
      mine.code = null;
      mine.url = null;
      if (mine.silent) {
        // Das Programm wurde beendet; sein Ergebnis sagt dann nichts mehr. Es zählt, was es bis dahin schrieb.
        Object.assign(mine, { state: FLOW.FAILED, why: WHY.SILENT, error: mine.heard || null });
      } else if (mine.state !== FLOW.CANCELLED) {
        mine.state = result.code === 0 ? FLOW.DONE : FLOW.FAILED;
        if (result.code !== 0) Object.assign(mine, result.timedOut ? { why: WHY.LATE } : { why: WHY.GH, error: said(result.stderr, code) || null });
      }
      if (mine.state === FLOW.DONE) {
        if (kind === 'login' && current.state === STATE.IN) log(msg('m_loggedIn', current.login));
        accountChanged();
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

  // Nur wer sicher nicht angemeldet ist, meldet sich an: Ein Anmelden über eine bestehende Anmeldung hinweg ersetzte
  // deren Token, auch für das Terminal. Der Stand wird deshalb unmittelbar davor frisch gelesen (der letzte kann eine
  // Minute alt sein, und im Terminal kann sich inzwischen jemand angemeldet haben). Das Protokoll für Git
  // (`--git-protocol`) bleibt, wie der Nutzer es in `gh` eingestellt hat.
  async function login() {
    if (closed) throw new Fault('m_closing');
    if (!running() && !leaving) await fresh();
    if (current.state === STATE.MISSING) throw new Fault('m_ghMissing');
    if (current.state === STATE.IN) throw new Fault('m_alreadyIn', current.login);
    if (current.state !== STATE.OUT) throw new Fault('m_authUnknown');
    const scopes = [...REQUIRED, ...OPTIONAL.map((entry) => entry.scope)];
    return begin('login', scopes, ['auth', 'login', '--hostname', HOST, '--web', '-s', scopes.join(',')]);
  }

  // Ein Recht ergänzen: ohne Angabe alle fehlenden Pflichtrechte, sonst das genannte freiwillige.
  async function grant(scope) {
    if (current.state !== STATE.IN) throw new Fault('m_loginFirst');
    const open = view();
    const scopes = scope ? open.optional.filter((entry) => entry.scope === scope).map((entry) => entry.scope) : open.missing;
    if (!scopes.length) throw new Fault(scope ? 'm_scopeNotMissing' : 'm_noScopeMissing');
    return begin('scope', scopes, ['auth', 'refresh', '-h', HOST, '-s', scopes.join(',')]);
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
    if (closed) throw new Fault('m_closing');
    if (leaving) throw new Fault('m_leavingAlready');
    if (running()) throw new Fault('m_finishLogin');
    if (current.state !== STATE.IN) throw new Fault('m_notIn');
    const login = current.login;
    if (!LOGIN.test(String(login))) throw new Fault('m_loginUnknown');
    leaving = true;
    try {
      const result = await gh(['auth', 'logout', '--hostname', HOST, '--user', login], { input: '\n', timeout });
      await fresh();
      if (result.code !== 0) throw result.timedOut ? new Fault('m_ghSilent') : said(result.stderr) ? new Error(said(result.stderr)) : new Fault('m_ghExit', result.code);
      flow = null;
    } finally { leaving = false; }
    // Kennt `gh` ein weiteres Konto, nutzt es nach dem Abmelden von selbst dieses.
    if (current.state !== STATE.IN) { log(msg('m_loggedOut', login)); return; }
    log(msg('m_loggedOutSwitch', login, current.login));
    accountChanged();
  }

  // Die App endet: ein wartendes `gh` beenden und keinen neuen Ablauf mehr beginnen.
  function close() {
    closed = true;
    return cancel();
  }

  return { view, loginWith, refresh, poll, login, grant, cancel, logout, close };
}

module.exports = { createAuth, parseHosts, parseText, STATE, FLOW, WHY, REQUIRED, OPTIONAL };
