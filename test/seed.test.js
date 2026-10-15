const test = require('node:test');
const assert = require('node:assert/strict');
const { DAEMON_FLAGS, DAEMON_COMMAND, DATA_ROOT } = require('../src/dind');
const { createSeed, LEARNED_DAYS, LEARNED_MAX } = require('../src/seed');
const { DAY } = require('../src/units');
const { createEngine } = require('../src/engine');
const { turn, settle } = require('./support');

const REPO = 'wer/App';
const SEED = 'rc-seed-app';
const LOADER = `${SEED}-loader`;
const MARK = 'runclub.runner=test';
const GONE = 'Error response from daemon: manifest for weg:1 not found: manifest unknown: manifest unknown';
const BUSY = 'toomanyrequests: You have reached your unauthenticated pull rate limit.';

const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

// Ein Aufruf von Docker in Kurzform: im Lade-Daemon nur, was dort geschieht.
function brief(args) {
  if (args[0] === 'run') return args.includes('--name') ? `run ${args[args.indexOf('--name') + 1]}` : 'run prepare';
  if (args[0] === 'exec') return `exec ${args.slice(args.indexOf('docker') + 1).filter((arg) => !['-q', '-f', '--format', 'ok', '{{.Repository}}:{{.Tag}}', '-H', 'unix:///sock/docker.sock'].includes(arg)).join(' ')}`;
  return args.join(' ');
}

// Docker und der Rest nachgestellt. `calls` hält die Aufrufe an Docker in ihrer Reihenfolge,
// `answer(name, args, options)` kann einem Aufruf ein Ergebnis geben (sonst gelingt er ohne Ausgabe).
// Zeit vergeht ohne Warten: `sleep` gibt nur einmal an alles andere ab und merkt sich die Dauer.
function world() {
  const w = {
    calls: [], details: [], logs: [], slept: [], saved: 0, answer: () => undefined,
    settings: { repo: REPO, preload: [] },
    state: { learned: {}, rejected: {} },
    pool: { repo: REPO, seeded: new Set() },
  };
  // Docker über engine.js, wie im Betrieb; nachgestellt ist nur `run`.
  const run = async (command, args, options = {}) => {
    const name = brief(args);
    w.calls.push(name);
    w.details.push({ name, args, options });
    return { code: 0, stdout: '', stderr: '', ...(await w.answer(name, args, options)) };
  };
  const { docker, dockerList } = createEngine({ run, timeout: 99 });
  w.seed = createSeed({
    docker, dockerList,
    log: (...entry) => w.logs.push(entry),
    sleep: async (ms) => { w.slept.push(ms); await turn(); },
    mark: MARK, dind: 'dind:test', longTimeout: 1234,
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    seedVolume: () => SEED,
    poolOf: (repo) => (repo === REPO ? w.pool : undefined),
    state: w.state, saveState: () => { w.saved += 1; },
  });
  return w;
}

test('gewünscht sind die festen Abbilder und die gelernten, die jüngsten zuerst', () => {
  const w = world();
  w.settings.preload = ['fest:1', 'beides:1'];
  w.state.learned[REPO] = { 'alt:1': daysAgo(3), 'neu:1': daysAgo(1), 'beides:1': daysAgo(2), 'vergessen:1': daysAgo(LEARNED_DAYS + 1) };
  assert.deepEqual(w.seed.wantedImages(REPO), ['fest:1', 'beides:1', 'neu:1', 'alt:1']);
  assert.deepEqual(w.seed.wantedImages('wer/Anderes'), []);
});

test('mehr als die Höchstzahl kommt nicht in die Vorlage; die ältesten bleiben draußen', () => {
  const w = world();
  w.state.learned[REPO] = Object.fromEntries(Array.from({ length: LEARNED_MAX + 3 }, (_, index) => [`bild${index}:1`, daysAgo(index / 100)]));
  const wanted = w.seed.wantedImages(REPO);
  assert.equal(wanted.length, LEARNED_MAX);
  assert.equal(wanted[0], 'bild0:1');
  assert.equal(wanted.includes(`bild${LEARNED_MAX}:1`), false);
});

test('kopiert wird gleichzeitig, aufgefrischt nur allein', async () => {
  const w = world();
  const order = [];
  const gates = [];
  const work = (name) => () => new Promise((resolve) => { order.push(`${name} beginnt`); gates.push(() => { order.push(`${name} endet`); resolve(name); }); });
  const first = w.seed.withSeed(REPO, false, work('Kopie 1'));
  const second = w.seed.withSeed(REPO, false, work('Kopie 2'));
  const refresh = w.seed.withSeed(REPO, true, work('Auffrischen'));
  const other = w.seed.withSeed('wer/Anderes', true, work('fremdes Repo'));
  await settle();
  assert.deepEqual(order, ['Kopie 1 beginnt', 'Kopie 2 beginnt', 'fremdes Repo beginnt']);

  gates[0]();
  await settle();
  assert.equal(order.includes('Auffrischen beginnt'), false); // die zweite Kopie läuft noch
  gates[1]();
  await settle();
  assert.equal(order.at(-1), 'Auffrischen beginnt');

  // Solange aufgefrischt wird, wartet auch eine neue Kopie.
  const third = w.seed.withSeed(REPO, false, work('Kopie 3'));
  await settle();
  assert.equal(order.includes('Kopie 3 beginnt'), false);
  gates[3]();
  await settle();
  assert.equal(order.at(-1), 'Kopie 3 beginnt');
  gates[4]();
  gates[2]();
  assert.deepEqual(await Promise.all([first, second, refresh, third, other]), ['Kopie 1', 'Kopie 2', 'Auffrischen', 'Kopie 3', 'fremdes Repo']);
  assert.ok(w.slept.every((ms) => ms === 500));
});

test('scheitert die Arbeit an der Vorlage, ist sie danach wieder frei', async () => {
  const w = world();
  await assert.rejects(w.seed.withSeed(REPO, true, async () => { throw new Error('kaputt'); }), /kaputt/);
  await assert.rejects(w.seed.withSeed(REPO, false, async () => { throw new Error('auch kaputt'); }), /auch kaputt/);
  assert.equal(await w.seed.withSeed(REPO, true, async () => 'frei'), 'frei');
  assert.deepEqual(w.slept, []);
});

test('ohne gewünschte Abbilder verschwindet die Vorlage', async () => {
  const w = world();
  w.pool.seeded = new Set(['alt:1']);
  await w.seed.refreshSeed(REPO);
  assert.deepEqual(w.calls, [`rm -f ${LOADER}`, `volume rm -f ${SEED}`]);
  assert.deepEqual([...w.pool.seeded], []);
  assert.deepEqual(w.logs, []);
  assert.equal(w.saved, 0);
});

test('auffrischen lädt das Gewünschte, entfernt das Überholte und merkt sich, was in der Vorlage liegt', async () => {
  const w = world();
  w.settings.preload = ['fest:1'];
  w.state.learned[REPO] = { 'neu:1': daysAgo(1), 'vergessen:1': daysAgo(LEARNED_DAYS + 1) };
  w.state.rejected[REPO] = { 'lange-her:1': daysAgo(LEARNED_DAYS + 1), 'neulich:1': daysAgo(1) };
  w.answer = (name) => (name === 'exec image ls' ? { stdout: 'fest:1\nneu:1\nvergessen:1\n<none>:<none>\n' } : undefined);
  await w.seed.refreshSeed(REPO);
  assert.deepEqual(w.calls, [
    `rm -f ${LOADER}`, `volume create ${SEED}`, 'run prepare', `run ${LOADER}`, 'exec info',
    'exec pull fest:1', 'exec pull neu:1', 'exec image ls', 'exec rmi vergessen:1', 'exec image prune',
    `stop ${LOADER}`, `rm ${LOADER}`,
  ]);
  const loader = w.details.find((call) => call.name === `run ${LOADER}`).args;
  // Ohne Rechte wie der Daemon eines Paars; eine Vorlage aus der Zeit mit Rechten wird vorher einmal geleert.
  assert.deepEqual(loader, ['run', '-d', '--label', MARK, '--name', LOADER, ...DAEMON_FLAGS, '-v', `${SEED}:${DATA_ROOT}`, 'dind:test', ...DAEMON_COMMAND]);
  assert.deepEqual(w.details.find((call) => call.name === 'run prepare').args, ['run', '--rm', '-v', `${SEED}:/d`, '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c',
    '[ "$(stat -c %u /d)" = 1001 ] || { find /d -mindepth 1 -delete; chown 1001:1001 /d; }']);
  assert.equal(loader.includes('--privileged'), false);
  assert.equal(w.details.find((call) => call.name === 'exec pull fest:1').options.timeout, 1234);
  assert.deepEqual([...w.pool.seeded], ['fest:1', 'neu:1']);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['neu:1']);
  assert.deepEqual(Object.keys(w.state.rejected[REPO]), ['neulich:1']);
  assert.equal(w.saved, 1);
  assert.deepEqual(w.logs, [['Frische die Vorlage auf (2 Abbilder) …', REPO]]);
});

test('eine Störung beim Laden lässt in der Vorlage, was schon dort liegt, und am Gelernten alles', async () => {
  const w = world();
  w.state.learned[REPO] = { 'da:1': daysAgo(1), 'fehlt:1': daysAgo(2) };
  w.answer = (name) => {
    if (name.startsWith('exec pull')) return { code: 1, stderr: BUSY };
    if (name === 'exec image ls') return { stdout: 'da:1\n' };
    return undefined;
  };
  await w.seed.refreshSeed(REPO);
  assert.deepEqual([...w.pool.seeded], ['da:1']);
  assert.equal(w.calls.some((name) => name.startsWith('exec rmi')), false);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['da:1', 'fehlt:1']);
  assert.deepEqual(w.state.rejected, {});
  assert.deepEqual(w.logs.slice(1), [[`da:1 kommt nicht in die Vorlage – ${BUSY}`, REPO, 'error'], [`fehlt:1 kommt nicht in die Vorlage – ${BUSY}`, REPO, 'error']]);
});

test('was es bei der Registry nicht gibt, wird abgelehnt, vergessen und aus der Vorlage entfernt', async () => {
  const w = world();
  w.state.learned[REPO] = { 'weg:1': daysAgo(1), 'gut:1': daysAgo(2) };
  w.answer = (name) => {
    if (name === 'exec pull weg:1') return { code: 1, stderr: GONE };
    if (name === 'exec image ls') return { stdout: 'weg:1\ngut:1\n' };
    return undefined;
  };
  await w.seed.refreshSeed(REPO);
  assert.deepEqual([...w.pool.seeded], ['gut:1']);
  assert.ok(w.calls.includes('exec rmi weg:1'));
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['gut:1']);
  assert.deepEqual(Object.keys(w.state.rejected[REPO]), ['weg:1']);
  assert.equal(w.saved, 1);
});

test('wird der Lade-Daemon nicht bereit, bleibt alles, wie es ist', async () => {
  const w = world();
  w.pool.seeded = new Set(['alt:1']);
  w.state.learned[REPO] = { 'neu:1': daysAgo(1) };
  w.answer = (name) => (name === 'exec info' ? { code: 1 } : undefined);
  await assert.rejects(w.seed.refreshSeed(REPO), /Der Lade-Daemon wurde nicht bereit/);
  assert.equal(w.calls.filter((name) => name === 'exec info').length, 40);
  assert.equal(w.calls.at(-1), `rm -f ${LOADER}`);
  assert.equal(w.calls.some((name) => name.startsWith('exec pull')), false);
  assert.deepEqual([...w.pool.seeded], ['alt:1']);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['neu:1']);
  assert.equal(w.saved, 0);
  // Danach ist die Vorlage wieder frei.
  assert.equal(await w.seed.withSeed(REPO, true, async () => 'frei'), 'frei');
});

test('auffrischen für ein Repo, dessen Pool schon weg ist, scheitert nicht', async () => {
  const w = world();
  w.settings = { repo: 'wer/Weg', preload: ['fest:1'] };
  const seed = createSeed({
    docker: async (args) => { w.calls.push(brief(args)); return { code: 0, stdout: '', stderr: '' }; },
    dockerList: async () => [], log: () => {}, sleep: turn, mark: MARK, dind: 'dind:test', longTimeout: 1,
    settingsOf: () => w.settings, seedVolume: () => SEED, poolOf: () => undefined, state: w.state, saveState: () => { w.saved += 1; },
  });
  await seed.refreshSeed('wer/Weg');
  assert.equal(w.saved, 1);
});

test('nach einem Job wird gelernt, was er selbst geladen hat', async () => {
  const w = world();
  w.pool.seeded = new Set(['kopiert:1', 'bekannt:1']);
  w.state.learned[REPO] = { 'kopiert:1': daysAgo(5), 'bekannt:1': daysAgo(5) };
  w.state.rejected[REPO] = { 'abgelehnt:1': daysAgo(1), 'lange-abgelehnt:1': daysAgo(LEARNED_DAYS + 1) };
  w.answer = (name) => (name === 'exec image ls' ? { stdout: 'kopiert:1\nbekannt:1\nabgelehnt:1\nlange-abgelehnt:1\n<none>:<none>\nGross:1\nbekannt:1\n\n' } : undefined);
  const before = w.state.learned[REPO]['kopiert:1'];
  await w.seed.learnImages(w.pool, { base: 'rc-app-1', copied: new Set(['kopiert:1']) });
  assert.deepEqual(w.details[0].args, ['exec', 'rc-app-1-dind', 'docker', '-H', 'unix:///sock/docker.sock', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  // Was aus der Vorlage kam, behält sein Datum; was der Job selbst lud, bekommt ein neues.
  assert.equal(w.state.learned[REPO]['kopiert:1'], before);
  assert.ok(w.state.learned[REPO]['bekannt:1'] > before);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['kopiert:1', 'bekannt:1', 'lange-abgelehnt:1']);
  assert.equal(w.saved, 1);
  // `lange-abgelehnt:1` liegt nicht in der Vorlage: Sie wird aufgefrischt.
  await settle();
  assert.ok(w.calls.includes('exec pull lange-abgelehnt:1'));
});

test('liegt alles Geladene schon in der Vorlage, wird sie nicht aufgefrischt', async () => {
  const w = world();
  w.pool.seeded = new Set(['bekannt:1']);
  w.answer = (name) => (name === 'exec image ls' ? { stdout: 'bekannt:1\n' } : undefined);
  await w.seed.learnImages(w.pool, { base: 'rc-app-1', copied: new Set() });
  await settle();
  assert.deepEqual(w.calls, ['exec image ls']);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['bekannt:1']);
});

test('antwortet der Docker-Daemon des Jobs nicht, wird nichts gelernt', async () => {
  const w = world();
  w.answer = () => ({ code: 1, stdout: 'neu:1\n' });
  await w.seed.learnImages(w.pool, { base: 'rc-app-1' });
  assert.deepEqual(w.state.learned, {});
  assert.equal(w.saved, 0);
});

test('zwei Jobs mit Neuem kurz nacheinander frischen die Vorlage nur einmal auf; ein Fehler dabei steht im Protokoll', async () => {
  const w = world();
  w.answer = (name) => {
    if (name === 'exec image ls') return { stdout: 'neu:1\n' };
    if (name === 'exec info') return { code: 1 };
    return undefined;
  };
  await w.seed.learnImages(w.pool, { base: 'rc-app-1' });
  await w.seed.learnImages(w.pool, { base: 'rc-app-2' });
  await settle();
  for (let turns = 0; turns < 200; turns += 1) await turn();
  assert.equal(w.calls.filter((name) => name === `run ${LOADER}`).length, 1);
  assert.deepEqual(w.logs.at(-1), ['Vorlage – Der Lade-Daemon wurde nicht bereit; die Vorlage bleibt unverändert.', REPO, 'error']);
  // Danach ist der Weg für das nächste Auffrischen wieder frei.
  await w.seed.learnImages(w.pool, { base: 'rc-app-3' });
  await settle();
  assert.equal(w.calls.filter((name) => name === `run ${LOADER}`).length, 2);
});

test('vergessen löscht Gelerntes und Vorlage, sobald nicht mehr kopiert wird; was sich nicht löschen lässt, wirft', async () => {
  const w = world();
  w.state.learned[REPO] = { 'node:22': daysAgo(1) };
  w.state.rejected[REPO] = { 'eigen:1': daysAgo(1) };
  w.pool.seeded = new Set(['node:22']);
  let copying = null;
  const copy = w.seed.withSeed(REPO, false, () => new Promise((resolve) => { copying = resolve; }));
  const forgotten = w.seed.forget(REPO);
  await turn();
  assert.deepEqual(w.calls, []); // die Kopie läuft noch
  copying();
  await copy;
  await forgotten;
  assert.deepEqual(w.calls, [`volume rm -f ${SEED}`]);
  assert.deepEqual([w.state.learned[REPO], w.state.rejected[REPO], [...w.pool.seeded]], [undefined, undefined, []]);
  assert.equal(w.saved, 1);

  w.answer = () => ({ code: 1, stderr: 'Error response from daemon: volume is in use\n' });
  await assert.rejects(w.seed.forget(REPO), { message: 'Die Vorlage ließ sich nicht löschen – Error response from daemon: volume is in use' });
});

test('die Vorlage eines Pools, der entfernt wird, wird nicht mehr aufgefrischt', async () => {
  const w = world();
  w.state.learned[REPO] = { 'node:22': daysAgo(1) };
  w.pool.removed = true;
  await w.seed.refreshSeed(REPO);
  assert.deepEqual(w.calls, []);
});
