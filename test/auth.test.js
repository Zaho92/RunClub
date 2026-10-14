const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, parseHosts, parseText } = require('../src/auth');
const { run: realRun } = require('../src/run');
const { GH_ENV } = require('../src/github');

const CODE = 'AB12-CD34';
const DEVICE = 'https://github.com/login/device';
const { MINUTE } = require('../src/units');
// Was `gh auth status --active --hostname github.com --json hosts` schreibt (so von gh 2.96.0 abgelesen).
const hosts = (scopes, extra) => JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'Zaho92', tokenSource: 'keyring', scopes, gitProtocol: 'https', ...extra }] } });
const SIGNED_IN = hosts('gist, project, read:org, repo, workflow');
const WITH_USER = hosts('gist, project, read:org, repo, user, workflow');
const SIGNED_OUT = JSON.stringify({ hosts: {} });
const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false });
const settle = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

// Ein nachgestelltes `gh`. `world.status` ist, was `gh auth status` gerade antwortet. Anmelden und Ergänzen bleiben
// offen, bis der Test sie beendet (`world.flows`): `say` schreibt eine Zeile auf die Fehlerausgabe, `end` beendet.
function fake(status = SIGNED_IN) {
  const world = { status: ok(status), logout: ok(''), flows: [], now: 1791900000000, successes: 0 };
  const calls = [];
  const logs = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input, timeout: options.timeout });
    assert.equal(options.env, GH_ENV); // kein Token, kein Host und kein Mitschreiben aus der Umgebung
    if (args[1] === 'status') return Promise.resolve(typeof world.status === 'function' ? world.status(args) : world.status);
    if (args[1] === 'logout') return typeof world.logout === 'function' ? world.logout() : Promise.resolve(world.logout);
    return new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: 'abgebrochen', timedOut: false, aborted: true }));
      world.flows.push({ say: (line) => options.onErrLine(line), end: (result) => resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...result }) });
    });
  };
  const auth = createAuth({ run, log: (text) => logs.push(text), onAccount: () => { world.successes += 1; }, now: () => world.now, startWait: 40 });
  // Die beiden Zeilen, die `gh` schreibt, bevor es auf die Bestätigung im Browser wartet.
  const prompt = (flow = world.flows.at(-1)) => { flow.say(`! First copy your one-time code: ${CODE}`); flow.say(`Open this URL to continue in your web browser: ${DEVICE}`); };
  const flowCalls = () => calls.filter((call) => call.args[1] !== 'status');
  return { auth, world, calls, logs, prompt, flowCalls };
}

// Beginnt einen Ablauf und lässt das nachgestellte `gh` Code und Adresse schreiben.
async function start(env, begin) {
  const begun = begin();
  await settle();
  env.prompt();
  return begun;
}

test('liest Konto und Rechte aus der Ausgabe von gh', () => {
  assert.deepEqual(parseHosts(SIGNED_IN), { state: 'in', login: 'Zaho92', scopes: ['gist', 'project', 'read:org', 'repo', 'workflow'] });
  assert.deepEqual(parseHosts(SIGNED_OUT), { state: 'out', login: null, scopes: null });
  assert.deepEqual(parseHosts(hosts('', { state: 'error', error: 'HTTP 401' })), { state: 'out', login: null, scopes: null });
  assert.equal(parseHosts(hosts('repo', { state: 'timeout' })), null); // GitHub war nicht erreichbar: kein Stand
  assert.equal(parseHosts('kein JSON'), null);
  assert.equal(parseHosts('null'), null);
  assert.equal(parseHosts(hosts('')).scopes, null); // ein Token ohne lesbare Rechte
});

test('liest dasselbe aus der Ausgabe für Menschen', () => {
  const text = "github.com\n  ✓ Logged in to github.com account Zaho92 (keyring)\n  - Active account: true\n  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'\n";
  assert.deepEqual(parseText(text), { state: 'in', login: 'Zaho92', scopes: ['gist', 'project', 'read:org', 'repo', 'workflow'] });
  assert.deepEqual(parseText('You are not logged into any GitHub hosts. To log in, run: gh auth login'), { state: 'out', login: null, scopes: null });
  assert.equal(parseText('irgendetwas'), null);
  // Auch hier meldet nur ein abgelehntes Token ab, keine Störung.
  assert.deepEqual(parseText('github.com\n  X Failed to log in to github.com account Zaho92 (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n'), { state: 'out', login: null, scopes: null });
  assert.equal(parseText('github.com\n  X Failed to log in to github.com account Zaho92 (keyring)\n  - Active account: true\n'), null);
  assert.equal(parseText('github.com\n  X Timeout trying to log in to github.com account Zaho92 (keyring)\n'), null);
});

test('angemeldet ohne das freiwillige Recht: nichts fehlt, eines lässt sich ergänzen', async () => {
  const { auth, calls } = fake();
  assert.equal(auth.view().state, 'unknown');
  assert.deepEqual(await auth.refresh(), {
    state: 'in', login: 'Zaho92', scopes: ['gist', 'project', 'read:org', 'repo', 'workflow'], required: ['repo'], extra: ['gist', 'project', 'read:org', 'workflow'],
    missing: [], optional: [{ scope: 'user', purpose: 'minutes' }], flow: null,
  });
  assert.deepEqual(calls[0], { command: 'gh', args: ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'], input: undefined, timeout: MINUTE });
});

test('fehlt ein Pflichtrecht, steht es unter `missing`; mit allen Rechten bleibt nichts offen', async () => {
  const { auth, world } = fake(hosts('gist, read:org'));
  assert.deepEqual((await auth.refresh()).missing, ['repo']);
  world.status = ok(WITH_USER);
  const view = await auth.refresh();
  assert.deepEqual([view.missing, view.optional], [[], []]);
  assert.deepEqual(view.extra, ['gist', 'project', 'read:org', 'workflow']); // `user` nutzt RunClub, wenn es da ist
  // Lassen sich die Rechte nicht lesen, gilt nichts als fehlend.
  world.status = ok(hosts(''));
  const unreadable = await auth.refresh();
  assert.deepEqual([unreadable.state, unreadable.scopes, unreadable.missing, unreadable.optional], ['in', null, [], []]);
});

test('gh ist nicht installiert: eigener Stand, und anmelden lässt sich nichts', async () => {
  // So meldet run.js ein fehlendes Programm wirklich.
  const real = await realRun('gibt-es-nicht-runclub', []);
  assert.match(real.stderr, /ENOENT/);
  const { auth, world, flowCalls } = fake();
  world.status = { ...real };
  const view = await auth.refresh();
  assert.deepEqual([view.state, view.login, view.missing, view.optional], ['missing', null, [], []]);
  await assert.rejects(auth.login(), /nicht installiert/);
  await assert.rejects(auth.grant('user'), /anmelden/);
  await assert.rejects(auth.logout(), /nicht bei GitHub angemeldet/);
  assert.deepEqual(flowCalls(), []);
});

test('das Konto für ein Recht: nur angemeldet und wenn das Recht nicht fehlt', async () => {
  const { auth, world } = fake();
  assert.equal(auth.loginWith('user'), null); // noch nicht gelesen
  await auth.refresh();
  assert.equal(auth.loginWith('repo'), 'Zaho92');
  assert.equal(auth.loginWith('user'), null);
  world.status = ok(WITH_USER);
  await auth.refresh();
  assert.equal(auth.loginWith('user'), 'Zaho92');
  // Lassen sich die Rechte nicht lesen, zeigt erst die Abfrage, ob es reicht.
  world.status = ok(hosts(''));
  await auth.refresh();
  assert.equal(auth.loginWith('user'), 'Zaho92');
  world.status = ok(SIGNED_OUT);
  await auth.refresh();
  assert.equal(auth.loginWith('user'), null);
});

test('scheitert das Lesen des Stands ganz, bleibt er stehen, und das nächste Lesen ist frei', async () => {
  const { auth, world, calls } = fake();
  await auth.refresh();
  world.status = () => { throw new Error('kaputt'); };
  assert.equal((await auth.refresh()).login, 'Zaho92');
  world.status = ok(SIGNED_OUT);
  assert.equal((await auth.refresh()).state, 'out');
  assert.equal(calls.length, 3);
});

test('nicht angemeldet; und was sich nicht lesen lässt, ändert den Stand nicht', async () => {
  const { auth, world } = fake(SIGNED_OUT);
  assert.deepEqual(await auth.refresh(), { state: 'out', login: null, scopes: null, required: ['repo'], extra: [], missing: [], optional: [], flow: null });
  world.status = ok(SIGNED_IN);
  assert.equal((await auth.refresh()).state, 'in');
  world.status = { code: -1, stdout: '', stderr: 'keine Antwort nach 60 s', timedOut: true };
  assert.equal((await auth.refresh()).login, 'Zaho92');
  world.status = { code: 1, stdout: '', stderr: 'irgendein Fehler', timedOut: false };
  assert.equal((await auth.refresh()).state, 'in');
});

test('ein gh ohne --json wird über die Ausgabe für Menschen gelesen', async () => {
  const { auth, world, calls } = fake();
  world.status = (args) => (args.includes('--json') ? { code: 1, stdout: '', stderr: 'unknown flag: --json', timedOut: false }
    : { code: 0, stdout: '', stderr: "github.com\n  ✓ Logged in to github.com as Zaho92 (keyring)\n  ✓ Token scopes: repo, workflow\n", timedOut: false });
  const view = await auth.refresh();
  assert.deepEqual([view.state, view.login, view.scopes], ['in', 'Zaho92', ['repo', 'workflow']]);
  assert.deepEqual(calls[1].args, ['auth', 'status', '--hostname', 'github.com']);
});

test('anmelden: der Aufruf antwortet mit Code und Adresse, und nach der Bestätigung gilt der neue Stand', async () => {
  const env = fake(SIGNED_OUT);
  const { auth, world, logs, flowCalls } = env;
  await auth.refresh();
  const begun = auth.login();
  await settle();
  assert.deepEqual(auth.view().flow, { kind: 'login', scopes: ['repo', 'user'], state: 'starting', code: null, url: null, why: null, error: null });
  env.prompt();
  const view = await begun;
  assert.deepEqual(view.flow, { kind: 'login', scopes: ['repo', 'user'], state: 'waiting', code: CODE, url: DEVICE, why: null, error: null });
  assert.equal(view.state, 'out');
  assert.deepEqual(flowCalls(), [{ command: 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--web', '-s', 'repo,user'], input: '\n', timeout: 15 * MINUTE }]);
  // Höchstens ein Ablauf zugleich.
  await assert.rejects(auth.login(), /läuft schon/);
  await assert.rejects(auth.logout(), /abbrechen/);
  assert.equal(flowCalls().length, 1);

  world.status = ok(SIGNED_IN);
  world.flows[0].end({ code: 0, stderr: `! First copy your one-time code: ${CODE}\n✓ Authentication complete.\n` });
  await settle();
  const after = auth.view();
  assert.deepEqual([after.state, after.login], ['in', 'Zaho92']);
  assert.deepEqual(after.flow, { kind: 'login', scopes: ['repo', 'user'], state: 'done', code: null, url: null, why: null, error: null });
  assert.equal(world.successes, 1);
  // Ins Protokoll kommt nur, dass angemeldet wurde und als wer.
  assert.deepEqual(logs, ['Bei GitHub angemeldet als Zaho92.']);
  await assert.rejects(auth.login(), /schon als Zaho92 angemeldet/);
});

test('die Adresse zum Bestätigen steht fest, was immer gh schreibt', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  const begun = env.auth.login();
  await settle();
  env.world.flows[0].say('Open this URL to continue in your web browser: https://example.com/login/device');
  env.world.flows[0].say('see https://github.com/fremd/repo/blob/main/x.html');
  env.world.flows[0].say(`\u001b[33m!\u001b[0m First copy your one-time code: ${CODE}`);
  env.world.flows[0].say('Open this URL to continue in your web browser: https://github.com/fremd/repo');
  assert.deepEqual((await begun).flow, { kind: 'login', scopes: ['repo', 'user'], state: 'waiting', code: CODE, url: DEVICE, why: null, error: null });
  await env.auth.cancel();
});

test('anmelden nur, wenn sicher niemand angemeldet ist: Ein unbekannter Stand wird erst gelesen', async () => {
  const env = fake(SIGNED_IN);
  await assert.rejects(env.auth.login(), /schon als Zaho92 angemeldet/);
  assert.deepEqual(env.flowCalls(), []);
  // Lässt sich der Stand nicht lesen (kein Netz), beginnt nichts.
  const blind = fake();
  blind.world.status = { code: 1, stdout: '', stderr: 'irgendein Fehler', timedOut: false };
  await assert.rejects(blind.auth.login(), /noch nicht lesen/);
  assert.deepEqual(blind.flowCalls(), []);
  // Wer sich inzwischen im Terminal angemeldet hat, wird nicht noch einmal angemeldet: Der Stand wird davor gelesen.
  const late = fake(SIGNED_OUT);
  await late.auth.refresh();
  late.world.status = ok(SIGNED_IN);
  await assert.rejects(late.auth.login(), /schon als Zaho92 angemeldet/);
  assert.deepEqual(late.flowCalls(), []);
  // Nicht angemeldet: Der Ablauf beginnt auch ohne vorheriges Lesen.
  const out = fake(SIGNED_OUT);
  const begun = start(out, () => out.auth.login());
  assert.equal((await begun).flow.state, 'waiting');
  await out.auth.cancel();
});

test('bleibt der Code aus, scheitert der Ablauf bald, statt stumm zu warten', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  const view = await env.auth.login();
  assert.deepEqual(view.flow, { kind: 'login', scopes: ['repo', 'user'], state: 'failed', code: null, url: null, why: 'silent', error: null });
  // Danach ist ein neuer Versuch möglich.
  await start(env, () => env.auth.login());
  assert.equal(env.auth.view().flow.state, 'waiting');
  await env.auth.cancel();
});

test('gescheitert: die Meldung von gh ohne den Code, nichts im Protokoll; ein neuer Stand räumt sie weg', async () => {
  const env = fake(SIGNED_OUT);
  const { auth, world, logs } = env;
  await auth.refresh();
  await start(env, () => auth.login());
  world.flows[0].end({ code: 1, stderr: `! First copy your one-time code: ${CODE}\nOpen this URL to continue in your web browser: ${DEVICE}\nfailed to authenticate via web browser: code ${CODE} was denied\nRun 'gh auth login --help' for more information\n` });
  await settle();
  assert.deepEqual(auth.view().flow, { kind: 'login', scopes: ['repo', 'user'], state: 'failed', code: null, url: null, why: 'gh', error: 'failed to authenticate via web browser: code … was denied' });
  assert.equal(auth.view().state, 'out');
  assert.deepEqual(logs, []);
  assert.equal(world.successes, 0);
  // Unverändert gelesen bleibt die Meldung stehen; meldet sich der Nutzer im Terminal an, ist sie überholt.
  assert.equal((await auth.refresh()).flow.state, 'failed');
  world.status = ok(SIGNED_IN);
  assert.equal((await auth.refresh()).flow, null);
});

test('schreibt gh zu seinem Scheitern nichts, bleibt die Meldung leer: Den Satz dazu bildet die Oberfläche', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  await start(env, () => env.auth.login());
  env.world.flows[0].end({ code: 4, stderr: `! First copy your one-time code: ${CODE}\n` });
  await settle();
  assert.deepEqual([env.auth.view().flow.why, env.auth.view().flow.error], ['gh', null]);
});

test('die Zeitgrenze beendet den Ablauf mit einer eigenen Kennung', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  await start(env, () => env.auth.login());
  env.world.flows[0].end({ code: -1, stderr: 'keine Antwort nach 900 s', timedOut: true });
  await settle();
  assert.deepEqual(env.auth.view().flow, { kind: 'login', scopes: ['repo', 'user'], state: 'failed', code: null, url: null, why: 'late', error: null });
});

test('abbrechen beendet das wartende gh; danach lässt sich neu beginnen', async () => {
  const env = fake(SIGNED_OUT);
  const { auth, world, logs, flowCalls } = env;
  await auth.refresh();
  await auth.cancel(); // ohne Ablauf geschieht nichts
  await start(env, () => auth.login());
  await auth.cancel();
  assert.deepEqual(auth.view().flow, { kind: 'login', scopes: ['repo', 'user'], state: 'cancelled', code: null, url: null, why: null, error: null });
  assert.deepEqual([logs, world.successes], [[], 0]);
  const again = await start(env, () => auth.login());
  assert.equal(again.flow.state, 'waiting');
  assert.equal(flowCalls().length, 2);
  await auth.cancel();
});

test('ist gh schon zu Ende und wird nur noch der Stand gelesen, verwirft ein Abbruch die Bestätigung nicht mehr', async () => {
  const env = fake(SIGNED_OUT);
  const { auth, world } = env;
  await auth.refresh();
  await start(env, () => auth.login());
  // Das Lesen des neuen Stands bleibt offen, bis der Test es freigibt.
  let open;
  world.status = () => new Promise((resolve) => { open = () => resolve(ok(SIGNED_IN)); });
  world.flows[0].end({ code: 0 });
  await settle();
  assert.equal(auth.view().flow.state, 'waiting');
  const cancelled = auth.cancel();
  await settle();
  open();
  await cancelled;
  assert.deepEqual([auth.view().flow.state, auth.view().login, world.successes], ['done', 'Zaho92', 1]);
});

test('nach dem Schließen endet ein wartendes gh, und es beginnt nichts mehr', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  await start(env, () => env.auth.login());
  await env.auth.close();
  assert.equal(env.auth.view().flow.state, 'cancelled');
  await assert.rejects(env.auth.login(), /beendet/);
  const signedIn = fake();
  await signedIn.auth.refresh();
  await signedIn.auth.close();
  await assert.rejects(signedIn.auth.grant('user'), /beendet/);
  await assert.rejects(signedIn.auth.logout(), /beendet/);
  assert.deepEqual(signedIn.flowCalls(), []);
});

test('ein Recht ergänzen: nur ein bekanntes, das fehlt; gelungen steht es im Stand, aber nicht im Protokoll', async () => {
  const env = fake();
  const { auth, world, logs, flowCalls } = env;
  await assert.rejects(auth.grant('user'), /anmelden/); // der Stand ist noch nicht gelesen
  await auth.refresh();
  await assert.rejects(auth.grant('admin:org'), /lässt sich hier nicht ergänzen/);
  await assert.rejects(auth.grant('repo'), /lässt sich hier nicht ergänzen/);
  await assert.rejects(auth.grant(), /fehlt kein Recht/);
  assert.deepEqual(flowCalls(), []);

  const view = await start(env, () => auth.grant('user'));
  assert.deepEqual(view.flow, { kind: 'scope', scopes: ['user'], state: 'waiting', code: CODE, url: DEVICE, why: null, error: null });
  assert.deepEqual(flowCalls(), [{ command: 'gh', args: ['auth', 'refresh', '-h', 'github.com', '-s', 'user'], input: '\n', timeout: 15 * MINUTE }]);
  world.status = ok(WITH_USER);
  world.flows[0].end({ code: 0 });
  await settle();
  assert.deepEqual([auth.view().optional, auth.view().flow.state, world.successes, logs], [[], 'done', 1, []]);
});

test('fehlende Pflichtrechte werden zusammen ergänzt', async () => {
  const env = fake(hosts('gist, read:org'));
  await env.auth.refresh();
  await start(env, () => env.auth.grant());
  assert.deepEqual(env.flowCalls()[0].args, ['auth', 'refresh', '-h', 'github.com', '-s', 'repo']);
  await env.auth.cancel();
});

test('abmelden: nennt gh das Konto, liest den Stand neu und schreibt ins Protokoll, wer abgemeldet wurde', async () => {
  const { auth, world, logs, flowCalls } = fake();
  await auth.refresh();
  world.logout = { code: 1, stdout: '', stderr: 'not logged in to any hosts\n', timedOut: false };
  await assert.rejects(auth.logout(), /not logged in to any hosts/);
  assert.deepEqual(logs, []);
  world.logout = ok('');
  world.status = ok(SIGNED_OUT);
  await auth.logout();
  assert.deepEqual(flowCalls().at(-1), { command: 'gh', args: ['auth', 'logout', '--hostname', 'github.com', '--user', 'Zaho92'], input: '\n', timeout: MINUTE });
  assert.deepEqual(auth.view(), { state: 'out', login: null, scopes: null, required: ['repo'], extra: [], missing: [], optional: [], flow: null });
  assert.deepEqual(logs, ['Bei GitHub abgemeldet (Zaho92).']);
  await assert.rejects(auth.logout(), /nicht bei GitHub angemeldet/);
});

test('kennt gh ein weiteres Konto, steht das im Protokoll, und es gilt als neues Konto', async () => {
  const { auth, world, logs } = fake();
  await auth.refresh();
  world.status = ok(hosts('repo', { login: 'Zweitkonto' }));
  await auth.logout();
  assert.deepEqual(logs, ['Bei GitHub abgemeldet (Zaho92). gh nutzt jetzt das Konto Zweitkonto.']);
  assert.deepEqual([auth.view().login, world.successes], ['Zweitkonto', 1]);
});

test('während abgemeldet wird, beginnt kein Ablauf und kein zweites Abmelden', async () => {
  const env = fake();
  const { auth, world, flowCalls } = env;
  await auth.refresh();
  let finish;
  world.logout = () => new Promise((resolve) => { finish = () => resolve(ok('')); });
  const leaving = auth.logout();
  await settle();
  await assert.rejects(auth.grant('user'), /abgemeldet/);
  await assert.rejects(auth.logout(), /schon abgemeldet/);
  assert.equal(flowCalls().length, 1);
  world.status = ok(SIGNED_OUT);
  finish();
  await leaving;
  assert.equal(auth.view().state, 'out');
  // Danach ist der Weg wieder frei, auch nach einem gescheiterten Abmelden.
  world.status = ok(SIGNED_IN);
  await auth.refresh();
  world.logout = { code: -1, stdout: '', stderr: 'keine Antwort nach 60 s', timedOut: true };
  await assert.rejects(auth.logout(), /gh antwortet nicht/);
  world.logout = { code: 3, stdout: '', stderr: '', timedOut: false };
  await assert.rejects(auth.logout(), /gh endete mit 3/);
});

test('ein Kontoname, den gh als Option lesen könnte, geht nicht an gh', async () => {
  const { auth, flowCalls } = fake(hosts('repo, workflow', { login: '--hostname' }));
  await auth.refresh();
  await assert.rejects(auth.logout(), /im Terminal abmelden/);
  assert.deepEqual(flowCalls(), []);
});

test('im Takt wird ein guter Stand selten nachgelesen, jeder andere jedes Mal', async () => {
  const { auth, world, calls } = fake();
  await auth.poll();
  await auth.poll();
  world.now += 9 * MINUTE;
  await auth.poll();
  assert.equal(calls.length, 1);
  world.now += 2 * MINUTE;
  world.status = ok(SIGNED_OUT);
  assert.equal((await auth.poll()).state, 'out');
  await auth.poll();
  assert.equal(calls.length, 3);
});

// --- gegen ein echtes Programm: run.js liefert die Zeilen der Fehlerausgabe und beendet auf Wunsch ---

const SCRIPT_HEAD = `console.error("! First copy your one-time code: ${CODE}"); console.error("Open this URL to continue in your web browser: ${DEVICE}");`;
// Ein `gh` als Programm: schreibt Code und Adresse wie das echte und wartet dann.
function program(script, options = {}) {
  const state = { status: ok(SIGNED_OUT), spawned: [] };
  const run = (command, args, given) => {
    if (args[1] === 'status') return Promise.resolve(state.status);
    state.spawned.push(args);
    return realRun(process.execPath, ['-e', script], given);
  };
  const logs = [];
  return { state, logs, auth: createAuth({ run, log: (text) => logs.push(text), ...options }) };
}

test('mit einem echten Programm: der Code kommt an, während es wartet, und sein Ende meldet an', async () => {
  // Es endet erst, wenn die leere Zeile auf der Standardeingabe angekommen ist, und dann nach einem Augenblick.
  const { auth, state, logs } = program(`${SCRIPT_HEAD} process.stdin.once("data", () => setTimeout(() => process.exit(0), 400));`);
  await auth.refresh();
  const view = await auth.login();
  assert.deepEqual(view.flow, { kind: 'login', scopes: ['repo', 'user'], state: 'waiting', code: CODE, url: DEVICE, why: null, error: null });
  state.status = ok(SIGNED_IN);
  for (let round = 0; round < 100 && auth.view().flow.state === 'waiting'; round += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.deepEqual([auth.view().flow.state, auth.view().login, logs], ['done', 'Zaho92', ['Bei GitHub angemeldet als Zaho92.']]);
});

test('mit einem echten Programm: abbrechen beendet es', async () => {
  const { auth } = program(`${SCRIPT_HEAD} setTimeout(() => {}, 60000);`);
  await auth.refresh();
  assert.equal((await auth.login()).flow.state, 'waiting');
  const started = Date.now();
  await auth.cancel();
  assert.equal(auth.view().flow.state, 'cancelled');
  assert.ok(Date.now() - started < 4000);
});

test('mit einem echten Programm: Schreibt es statt des Codes etwas anderes und wartet, steht das als Grund da', async () => {
  const { auth } = program('console.error("error connecting to github.com: proxy says no"); setTimeout(() => {}, 60000);', { startWait: 1500 });
  await auth.refresh();
  const view = await auth.login();
  assert.deepEqual([view.flow.state, view.flow.why, view.flow.error], ['failed', 'silent', 'error connecting to github.com: proxy says no']);
});

test('ein Fehler beim Prüfen der Anmeldung (kein Netz, Störung) meldet niemanden ab; ein abgelehntes Token schon', () => {
  const host = (entry) => JSON.stringify({ hosts: { 'github.com': [{ active: true, host: 'github.com', login: 'Zaho92', ...entry }] } });
  assert.equal(parseHosts(host({ state: 'error', error: 'Get "https://api.github.com/": dial tcp: lookup api.github.com: no such host' })), null);
  assert.equal(parseHosts(host({ state: 'error', error: 'HTTP 503' })), null);
  assert.deepEqual(parseHosts(host({ state: 'error', error: 'HTTP 401: Bad credentials (https://api.github.com/)' })), { state: 'out', login: null, scopes: null });
  assert.deepEqual(parseHosts(host({ state: 'error', error: 'Bad credentials' })), { state: 'out', login: null, scopes: null });
  // Wörter und Zahlen, die auch in Störungen stehen, melden nicht ab.
  for (const error of [
    "invalid character '<' looking for beginning of value",
    'x509: certificate has expired or is not yet valid',
    'HTTP 403: API rate limit exceeded for user ID 14012345',
    'read tcp 192.168.1.5:54013->140.82.121.6:443: wsarecv: connection reset',
    'HTTP 4010',
    'token revoked?',
  ]) assert.equal(parseHosts(host({ state: 'error', error })), null, error);
});
