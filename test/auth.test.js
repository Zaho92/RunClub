const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, parseHosts, parseText } = require('../src/auth');
const { run: realRun } = require('../src/run');

const CODE = 'AB12-CD34';
const DEVICE = 'https://github.com/login/device';
const MINUTE = 60000;
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
    if (args[1] === 'status') return Promise.resolve(typeof world.status === 'function' ? world.status(args) : world.status);
    if (args[1] === 'logout') return Promise.resolve(world.logout);
    return new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve({ code: -1, stdout: '', stderr: 'abgebrochen', timedOut: false, aborted: true }));
      world.flows.push({ say: (line) => options.onErrLine(line), end: (result) => resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...result }) });
    });
  };
  const auth = createAuth({ run, log: (text) => logs.push(text), onSuccess: () => { world.successes += 1; }, now: () => world.now, startWait: 40 });
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
});

test('angemeldet ohne das freiwillige Recht: nichts fehlt, eines lässt sich ergänzen', async () => {
  const { auth, calls } = fake();
  assert.equal(auth.view().state, 'unknown');
  assert.deepEqual(await auth.refresh(), {
    state: 'in', login: 'Zaho92', scopes: ['gist', 'project', 'read:org', 'repo', 'workflow'],
    missing: [], optional: [{ scope: 'user', purpose: 'minutes' }], flow: null,
  });
  assert.deepEqual(calls[0], { command: 'gh', args: ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'], input: undefined, timeout: MINUTE });
});

test('fehlt ein Pflichtrecht, steht es unter `missing`; mit allen Rechten bleibt nichts offen', async () => {
  const { auth, world } = fake(hosts('gist, read:org, repo'));
  assert.deepEqual((await auth.refresh()).missing, ['workflow']);
  world.status = ok(WITH_USER);
  const view = await auth.refresh();
  assert.deepEqual([view.missing, view.optional], [[], []]);
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

test('nicht angemeldet; und was sich nicht lesen lässt, ändert den Stand nicht', async () => {
  const { auth, world } = fake(SIGNED_OUT);
  assert.deepEqual(await auth.refresh(), { state: 'out', login: null, scopes: null, missing: [], optional: [], flow: null });
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
  assert.deepEqual(auth.view().flow, { kind: 'login', state: 'starting', code: null, url: null, error: null });
  env.prompt();
  const view = await begun;
  assert.deepEqual(view.flow, { kind: 'login', state: 'waiting', code: CODE, url: DEVICE, error: null });
  assert.equal(view.state, 'out');
  assert.deepEqual(flowCalls(), [{ command: 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '-s', 'repo,workflow'], input: '\n', timeout: 15 * MINUTE }]);
  // Höchstens ein Ablauf zugleich.
  await assert.rejects(auth.login(), /läuft schon/);
  await assert.rejects(auth.logout(), /abbrechen/);
  assert.equal(flowCalls().length, 1);

  world.status = ok(SIGNED_IN);
  world.flows[0].end({ code: 0, stderr: `! First copy your one-time code: ${CODE}\n✓ Authentication complete.\n` });
  await settle();
  const after = auth.view();
  assert.deepEqual([after.state, after.login], ['in', 'Zaho92']);
  assert.deepEqual(after.flow, { kind: 'login', state: 'done', code: null, url: null, error: null });
  assert.equal(world.successes, 1);
  // Ins Protokoll kommt nur, dass angemeldet wurde und als wer.
  assert.deepEqual(logs, ['Bei GitHub angemeldet als Zaho92.']);
  await assert.rejects(auth.login(), /schon als Zaho92 angemeldet/);
});

test('nur eine Adresse bei GitHub wird übernommen; sonst gilt die bekannte', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  const begun = env.auth.login();
  await settle();
  env.world.flows[0].say('Open this URL to continue in your web browser: https://example.com/login/device');
  env.world.flows[0].say(`\u001b[33m!\u001b[0m First copy your one-time code: ${CODE}`);
  assert.deepEqual((await begun).flow, { kind: 'login', state: 'waiting', code: CODE, url: DEVICE, error: null });
  await env.auth.cancel();
});

test('bleibt der Code aus, antwortet der Aufruf trotzdem bald; der Ablauf läuft weiter', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  const view = await env.auth.login();
  assert.equal(view.flow.state, 'starting');
  env.prompt();
  assert.equal(env.auth.view().flow.code, CODE);
  await env.auth.cancel();
});

test('gescheitert: die Meldung von gh ohne den Code, nichts im Protokoll; ein neuer Stand räumt sie weg', async () => {
  const env = fake(SIGNED_OUT);
  const { auth, world, logs } = env;
  await auth.refresh();
  await start(env, () => auth.login());
  world.flows[0].end({ code: 1, stderr: `! First copy your one-time code: ${CODE}\nOpen this URL to continue in your web browser: ${DEVICE}\nfailed to authenticate via web browser: code ${CODE} was denied\nRun 'gh auth login --help' for more information\n` });
  await settle();
  assert.deepEqual(auth.view().flow, { kind: 'login', state: 'failed', code: null, url: null, error: 'failed to authenticate via web browser: code … was denied' });
  assert.equal(auth.view().state, 'out');
  assert.deepEqual(logs, []);
  assert.equal(world.successes, 0);
  // Unverändert gelesen bleibt die Meldung stehen; meldet sich der Nutzer im Terminal an, ist sie überholt.
  assert.equal((await auth.refresh()).flow.state, 'failed');
  world.status = ok(SIGNED_IN);
  assert.equal((await auth.refresh()).flow, null);
});

test('die Zeitgrenze beendet den Ablauf mit einer eigenen Meldung', async () => {
  const env = fake(SIGNED_OUT);
  await env.auth.refresh();
  await start(env, () => env.auth.login());
  env.world.flows[0].end({ code: -1, stderr: 'keine Antwort nach 900 s', timedOut: true });
  await settle();
  assert.deepEqual(env.auth.view().flow, { kind: 'login', state: 'failed', code: null, url: null, error: 'Nicht innerhalb von 15 Minuten bestätigt.' });
});

test('abbrechen beendet das wartende gh; danach lässt sich neu beginnen', async () => {
  const env = fake(SIGNED_OUT);
  const { auth, world, logs, flowCalls } = env;
  await auth.refresh();
  await auth.cancel(); // ohne Ablauf geschieht nichts
  await start(env, () => auth.login());
  await auth.cancel();
  assert.deepEqual(auth.view().flow, { kind: 'login', state: 'cancelled', code: null, url: null, error: null });
  assert.deepEqual([logs, world.successes], [[], 0]);
  const again = await start(env, () => auth.login());
  assert.equal(again.flow.state, 'waiting');
  assert.equal(flowCalls().length, 2);
  await auth.cancel();
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
  assert.deepEqual(view.flow, { kind: 'scope', state: 'waiting', code: CODE, url: DEVICE, error: null });
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
  assert.deepEqual(env.flowCalls()[0].args, ['auth', 'refresh', '-h', 'github.com', '-s', 'repo,workflow']);
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
  assert.deepEqual(auth.view(), { state: 'out', login: null, scopes: null, missing: [], optional: [], flow: null });
  assert.deepEqual(logs, ['Bei GitHub abgemeldet (Zaho92).']);
  await assert.rejects(auth.logout(), /nicht bei GitHub angemeldet/);
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
function program(script) {
  const state = { status: ok(SIGNED_OUT), spawned: [] };
  const run = (command, args, options) => {
    if (args[1] === 'status') return Promise.resolve(state.status);
    state.spawned.push(args);
    return realRun(process.execPath, ['-e', SCRIPT_HEAD + script], options);
  };
  const logs = [];
  return { state, logs, auth: createAuth({ run, log: (text) => logs.push(text) }) };
}

test('mit einem echten Programm: der Code kommt an, während es wartet, und sein Ende meldet an', async () => {
  // Es endet erst, wenn die leere Zeile auf der Standardeingabe angekommen ist, und dann nach einem Augenblick.
  const { auth, state, logs } = program('process.stdin.once("data", () => setTimeout(() => process.exit(0), 400));');
  await auth.refresh();
  const view = await auth.login();
  assert.deepEqual(view.flow, { kind: 'login', state: 'waiting', code: CODE, url: DEVICE, error: null });
  state.status = ok(SIGNED_IN);
  for (let round = 0; round < 100 && auth.view().flow.state === 'waiting'; round += 1) await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.deepEqual([auth.view().flow.state, auth.view().login, logs], ['done', 'Zaho92', ['Bei GitHub angemeldet als Zaho92.']]);
});

test('mit einem echten Programm: abbrechen beendet es', async () => {
  const { auth } = program('setTimeout(() => {}, 60000);');
  await auth.refresh();
  assert.equal((await auth.login()).flow.state, 'waiting');
  const started = Date.now();
  await auth.cancel();
  assert.equal(auth.view().flow.state, 'cancelled');
  assert.ok(Date.now() - started < 4000);
});
