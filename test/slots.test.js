const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlots } = require('../src/slots');

const REPO = 'wer/App';
const BASE = 'rc-app-a1b2c3'; // `rc-<repo>-<kennung>`
const RUNNER = 'PC-linux-a1b2c3';
const MARK = 'runclub.runner=test';
const LIMITS = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };

// Ein Aufruf von Docker in Kurzform: bei `run` nur der Name des Containers, beim Netz ohne das zufällige Subnetz.
function brief(args) {
  if (args[0] === 'run') return `run ${args[args.indexOf('--name') + 1]}`;
  if (args[0] === 'network' && args[1] === 'create') return `network create ${args.at(-1)}`;
  if (args[0] === 'exec') return `exec ${args[1]} ${args.includes('info') ? 'info' : args.slice(2).join(' ')}`;
  return args.join(' ');
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  for (let turns = 0; turns < 1000; turns += 1) { if (condition()) return; await turn(); }
  throw new Error('Die Bedingung trat nicht ein.');
}

// Docker, GitHub und der Rest von backend.js nachgestellt. `calls` hält die Aufrufe an Docker und GitHub in ihrer
// Reihenfolge, `answer(name, args, options)` kann einem Docker-Aufruf ein Ergebnis geben (sonst gelingt er).
// Zeit vergeht ohne Warten: `sleep` gibt nur einmal an alles andere ab und merkt sich die Dauer.
function world() {
  const w = {
    calls: [], details: [], logs: [], slept: [], timers: [], refreshed: [], recorded: [], forgotten: [], learned: [], replenished: [], discarded: 0,
    stopping: false, ready: true, resting: false, settings: { repo: REPO, parallel: 1, cache: true, paused: false },
    answer: () => undefined, onSleep: () => {}, jit: { runner: { id: 77 }, encoded_jit_config: 'geheim' },
  };
  const docker = async (args, options = {}) => {
    const name = brief(args);
    w.calls.push(name);
    w.details.push({ name, args, options });
    return { code: 0, stdout: '', stderr: '', ...(await w.answer(name, args, options)) };
  };
  const gh = async (args, body) => {
    w.calls.push(`gh ${args.slice(1).join(' ')}`);
    if (body) w.body = JSON.parse(body);
    if (w.ghFails) throw new Error(w.ghFails);
    return args.at(-1).endsWith('/generate-jitconfig') ? w.jit : null;
  };
  w.slots = createSlots({
    docker, gh,
    log: (...entry) => w.logs.push(entry),
    sleep: async (ms) => { w.slept.push(ms); w.onSleep(ms); await turn(); },
    timer: (work, ms) => w.timers.push({ work, ms }),
    newId: () => 'a1b2c3',
    host: 'PC', mark: MARK, image: 'runner:test', dind: 'dind:test', longTimeout: 1234,
    metrics: { meter: () => ({ finish: () => ({ peakMemory: 5 }) }), recordJob: (repo, record) => w.recorded.push([repo, record]) },
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => LIMITS,
    seedVolume: () => 'rc-seed-app', cacheVolume: () => 'rc-cache-app', buildService: () => 'rc-buildkit-app',
    stopping: () => w.stopping, linuxReady: () => w.ready, poolResting: () => w.resting,
    withSeed: (repo, exclusive, work) => { assert.equal(exclusive, false); return work(); },
    learnImages: async (pool, slot) => { w.learned.push(slot.job); w.onLearn?.(pool, slot); },
    replenish: (pool) => w.replenished.push(pool.repo),
    discardReserve: async () => { w.discarded += 1; },
    refreshRepo: (repo) => w.refreshed.push(repo),
    forgetStats: (name) => w.forgotten.push(name),
  });
  w.pool = { repo: REPO, slots: [], reserve: [], seeded: new Set(), removed: false };
  w.slot = { repo: REPO, state: 'startet', jobs: 0 }; // wie `reconcile` in backend.js einen Platz anlegt
  w.pool.slots.push(w.slot);
  return w;
}

const isRunner = (name) => name === `run ${BASE}-runner`;
const PROVISION = [
  `network create ${BASE}`,
  `volume create --label ${MARK} ${BASE}-work`, `volume create --label ${MARK} ${BASE}-sock`, `volume create --label ${MARK} ${BASE}-docker`,
];
const REMOVE = [
  `rm -f -v ${BASE}-runner ${BASE}-dind ${BASE}-seed`,
  `network disconnect -f ${BASE} rc-buildkit-app`,
  `volume rm -f ${BASE}-work ${BASE}-sock ${BASE}-docker`,
  `network rm ${BASE}`,
];
const REGISTER = `gh -X POST repos/${REPO}/actions/runners/generate-jitconfig`;
const UNREGISTER = `gh -X DELETE repos/${REPO}/actions/runners/77`;

test('ein Job von Anfang bis Ende: Aufbau, Anmeldung, Runner, Abbau', async () => {
  const w = world();
  w.pool.seeded = new Set(['node:22']);
  const states = [];
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    states.push(w.slot.state);
    for (const line of ['√ Connected to GitHub', '2026-10-13 12:00:00Z: Listening for Jobs', '2026-10-13 12:00:05Z: Running job: Bauen', '2026-10-13 12:00:09Z: Job Bauen completed with result: Succeeded']) {
      onLine(line);
      states.push(w.slot.state);
    }
    assert.equal(w.slot.finished, true);
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; }; // nach diesem Job endet der Platz

  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.calls, [
    ...PROVISION,
    `run ${BASE}-seed`,
    `run ${BASE}-dind`,
    `exec ${BASE}-dind info`,
    `network connect --alias buildkit ${BASE} rc-buildkit-app`,
    REGISTER,
    `run ${BASE}-runner`,
    ...REMOVE, // ohne Abmeldung: Die Anmeldung galt für diesen einen Job
  ]);
  assert.deepEqual(states, ['startet', 'startet', 'bereit', 'arbeitet', 'arbeitet']);
  assert.deepEqual(w.body, { name: RUNNER, runner_group_id: 1, labels: ['self-hosted', 'Linux', 'X64'], work_folder: '_work' });

  const call = (name) => w.details.find((detail) => detail.name === name);
  assert.deepEqual(call(`run ${BASE}-seed`).args, ['run', '--rm', '--label', MARK, '--name', `${BASE}-seed`, '-v', 'rc-seed-app:/seed:ro', '-v', `${BASE}-docker:/var/lib/docker`,
    '--entrypoint', 'sh', 'dind:test', '-c', 'cp -a /seed/. /var/lib/docker/']);
  assert.deepEqual(call(`run ${BASE}-seed`).options, { timeout: 1234 });
  assert.deepEqual(call(`run ${BASE}-dind`).args, ['run', '-d', '--label', MARK, '--name', `${BASE}-dind`, '--privileged', '--network', BASE,
    '--cpus', '4', '--memory', '8g', '-v', `${BASE}-work:/home/runner/_work`, '-v', `${BASE}-sock:/sock`, '-v', `${BASE}-docker:/var/lib/docker`,
    '--entrypoint', 'sh', 'dind:test', '-c', 'chown 1001:1001 /home/runner/_work && exec dockerd-entrypoint.sh dockerd --host=unix:///sock/docker.sock --group=123']);
  const runner = call(`run ${BASE}-runner`);
  assert.deepEqual(runner.args.slice(0, -1), ['run', '--rm', '--label', MARK, '--name', `${BASE}-runner`, '--network', `container:${BASE}-dind`,
    '--cpus', '6', '--memory', '4g', '-v', `${BASE}-work:/home/runner/_work`, '-v', `${BASE}-sock:/sock`,
    '-v', 'rc-cache-app:/opt/rc-cache', '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm', '-e', 'RC_BUILDER=rc',
    '-e', 'JITCONFIG', 'runner:test', 'bash', '-c']);
  assert.match(runner.args.at(-1), /exec \.\/run\.sh --jitconfig "\$JITCONFIG"$/);
  assert.equal(runner.options.timeout, 0);
  assert.deepEqual(runner.options.env, { JITCONFIG: 'geheim' }); // die Anmeldung steht nicht in der Befehlszeile

  assert.deepEqual(w.logs, [
    [`Job „Bauen“ läuft auf ${RUNNER}`, REPO, 'run', { job: 'Bauen', runner: RUNNER }],
    ['Job „Bauen“ – fertig', REPO, 'done', { job: 'Bauen' }],
  ]);
  assert.equal(w.recorded.length, 1);
  const [repo, record] = w.recorded[0];
  assert.equal(repo, REPO);
  assert.equal(typeof record.duration, 'number');
  assert.deepEqual({ ...record, duration: 0 }, { job: 'Bauen', workflow: '', result: 'Succeeded', duration: 0, peakMemory: 5 });
  assert.deepEqual(w.refreshed, [REPO, REPO]); // beim Beginn und beim Ende …
  assert.deepEqual(w.timers.map((timer) => timer.ms), [4000]); // … und vier Sekunden nach dem Beginn noch einmal
  w.timers[0].work();
  assert.deepEqual(w.refreshed, [REPO, REPO, REPO]);

  assert.deepEqual(w.learned, ['Bauen']);
  assert.deepEqual(w.replenished, [REPO]);
  assert.deepEqual(w.forgotten, [`${BASE}-runner`, `${BASE}-dind`]);
  assert.equal(w.slots.livePairs.size, 0);
  assert.deepEqual(w.slept, []);
  assert.deepEqual({ state: w.slot.state, base: w.slot.base, runnerId: w.slot.runnerId, jobs: w.slot.jobs, lastResult: w.slot.lastResult, meter: w.slot.meter, error: w.slot.error },
    { state: 'aus', base: null, runnerId: null, jobs: 1, lastResult: 'Bauen: Succeeded', meter: null, error: null });
  assert.deepEqual(w.pool.slots, []); // der beendete Platz verlässt den Pool
});

test('während des Jobs steht der Platz mit Paar, Namen und Anmeldung da; abgebaut wird im Zustand „räumt auf“', async () => {
  const w = world();
  let during = null;
  let removing = null;
  w.answer = (name, args, { onLine }) => {
    if (name === REMOVE[0]) removing = w.slot.state;
    if (!isRunner(name)) return undefined;
    onLine('Running job: Tests');
    during = { ...w.slot, live: [...w.slots.livePairs] };
    onLine('Job Tests completed with result: Failed');
    return { code: 0 };
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual({ state: during.state, base: during.base, name: during.name, runnerId: during.runnerId, job: during.job, built: during.built, building: during.building },
    { state: 'arbeitet', base: BASE, name: RUNNER, runnerId: 77, job: 'Tests', built: `6/${4 * 1024 ** 3}/4/${8 * 1024 ** 3}`, building: false });
  assert.deepEqual(during.live, [[BASE, REPO]]);
  assert.equal(removing, 'räumt auf');
  assert.deepEqual(w.logs.at(-1), ['Job „Tests“ – Fehler', REPO, 'fail', { job: 'Tests' }]);
  assert.ok(!w.calls.includes(`run ${BASE}-seed`)); // ohne Vorlage wird nichts kopiert
});

test('ein Paar aus der Reserve wird übernommen, mit den Limits, mit denen es gebaut wurde', async () => {
  const w = world();
  const pair = { id: 'ffffff', base: 'rc-app-ffffff', copied: new Set(['node:22']), extras: ['-e', 'X=1'], limits: { ...LIMITS, runnerCpus: 2, runnerMemory: '2g' } };
  w.pool.reserve.push({ promise: Promise.resolve(pair) });
  w.answer = (name, args, { onLine }) => { if (name === 'run rc-app-ffffff-runner') onLine('Running job: Bauen'); };
  await w.slots.serveOneJob(w.pool, w.slot);

  assert.deepEqual(w.calls, [REGISTER, 'run rc-app-ffffff-runner']);
  const { args } = w.details[0];
  assert.deepEqual(args.slice(8, 12), ['--cpus', '2', '--memory', '2g']);
  assert.ok(args.join(' ').includes('-e X=1 -e JITCONFIG'));
  assert.deepEqual(w.pool.reserve, []);
  assert.deepEqual(w.replenished, [REPO]);
  assert.equal(w.slot.name, 'PC-linux-ffffff');
  assert.equal(w.slot.copied, pair.copied);
});

test('ohne Cache hängt das Paar nicht am Build-Dienst; lässt er sich nicht erreichen, baut der Job ohne ihn', async () => {
  const off = world();
  off.settings.cache = false;
  assert.deepEqual((await off.slots.provision(off.pool, () => false)).extras, []);
  assert.deepEqual(off.calls, [...PROVISION, `run ${BASE}-dind`, `exec ${BASE}-dind info`]);

  const lost = world();
  lost.answer = (name) => (name.startsWith('network connect') ? { code: 1, stderr: 'No such container' } : undefined);
  const pair = await lost.slots.provision(lost.pool, () => false);
  assert.deepEqual(pair.extras, ['-v', 'rc-cache-app:/opt/rc-cache', '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm']);
  assert.deepEqual({ id: pair.id, base: pair.base, limits: pair.limits }, { id: 'a1b2c3', base: BASE, limits: LIMITS });
  assert.deepEqual([...lost.slots.livePairs], [[BASE, REPO]]);
});

test('endet der Runner ohne Job, ist der Platz gestört: Fehler ins Protokoll, Abbau samt Abmeldung, dann Pause', async () => {
  const w = world();
  w.answer = (name) => (isRunner(name) ? { code: 1, stderr: 'docker: Error response from daemon: Conflict.\nRun \'docker run --help\' for more information\n' } : undefined);
  let paused = null;
  w.onSleep = () => { paused = { state: w.slot.state, error: w.slot.error, base: w.slot.base }; w.stopping = true; };

  await w.slots.slotLoop(w.pool, w.slot);

  const message = 'Runner endete ohne Job (docker: Error response from daemon: Conflict.)';
  assert.deepEqual(w.logs, [[message, REPO, 'error']]);
  assert.deepEqual(paused, { state: 'gestört', error: message, base: null });
  assert.deepEqual(w.calls.slice(-6), [`run ${BASE}-runner`, ...REMOVE, UNREGISTER]); // kein Job: Die Anmeldung wird zurückgenommen
  assert.deepEqual(w.slept, [1000]);
  assert.deepEqual(w.learned, []);
  assert.deepEqual(w.recorded, []);
  assert.equal(w.slot.state, 'aus');
  assert.equal(w.slot.jobs, 0);
});

test('ohne Fehlerausgabe nennt die Meldung den Code; nach der Pause versucht der Platz es wieder', async () => {
  const w = world();
  let runs = 0;
  w.answer = (name) => { if (!isRunner(name)) return undefined; runs += 1; return { code: 137 }; };
  w.onSleep = () => { if (runs === 2) w.stopping = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.logs.map(([text]) => text), ['Runner endete ohne Job (Code 137)', 'Runner endete ohne Job (Code 137)']);
  assert.equal(w.slept.length, 61); // eine Minute Pause in Sekundenschritten, dann der zweite Versuch
  assert.equal(w.calls.filter((name) => name === UNREGISTER).length, 2);
});

test('scheitert die Anmeldung bei GitHub, wird das Paar abgebaut und nichts abgemeldet', async () => {
  const w = world();
  w.ghFails = 'gh: Forbidden (HTTP 403)';
  w.onSleep = () => { w.stopping = true; };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(w.logs, [['gh: Forbidden (HTTP 403)', REPO, 'error']]);
  assert.deepEqual(w.calls.slice(-5), [REGISTER, ...REMOVE]);
  assert.equal(w.slot.error, 'gh: Forbidden (HTTP 403)');
});

test('Abbruch im Leerlauf entfernt den Runner und meldet ihn bei GitHub ab', async () => {
  const w = world();
  let end = null;
  w.answer = (name, args, { onLine }) => {
    if (name === `rm -f ${BASE}-runner`) end({ code: 137 });
    if (!isRunner(name)) return undefined;
    onLine('Listening for Jobs');
    return new Promise((resolve) => { end = resolve; }); // der Runner wartet auf einen Job
  };
  const loop = w.slots.slotLoop(w.pool, w.slot);
  await until(() => w.slot.state === 'bereit');
  assert.equal(w.slot.runnerId, 77);

  w.slot.retired = true; // wie `reconcile`, wenn ein Platz wegfällt
  await w.slots.abortIdle(w.slot);
  await loop;

  assert.deepEqual(w.calls.slice(-6), [`rm -f ${BASE}-runner`, ...REMOVE, UNREGISTER]);
  assert.deepEqual(w.slept, [1000]);
  assert.deepEqual(w.logs, []); // ein Abbruch ist kein Fehler
  assert.deepEqual(w.learned, []);
  assert.equal(w.slot.aborted, true);
  assert.equal(w.slot.state, 'aus');
  assert.equal(w.slots.livePairs.size, 0);
});

test('ein arbeitender oder aufräumender Platz wird nicht abgebrochen', async () => {
  const w = world();
  let end = null;
  let emit = null;
  w.answer = (name, args, { onLine }) => {
    if (!isRunner(name)) return undefined;
    emit = onLine;
    onLine('Running job: Bauen');
    return new Promise((resolve) => { end = resolve; });
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  const loop = w.slots.slotLoop(w.pool, w.slot);
  await until(() => w.slot.state === 'arbeitet');
  const before = w.calls.length;

  await w.slots.abortIdle(w.slot);
  assert.equal(w.calls.length, before);
  assert.equal(w.slot.aborted, false);

  emit('Job Bauen completed with result: Canceled');
  end({ code: 0 });
  await loop;
  assert.deepEqual(w.calls.slice(before), REMOVE); // nach einem Job wird nichts mehr abgemeldet
  assert.deepEqual(w.logs.at(-1), ['Job „Bauen“ – abgebrochen', REPO, 'cancel', { job: 'Bauen' }]);
  assert.deepEqual(w.learned, ['Bauen']);

  const cleaning = { repo: REPO, state: 'räumt auf', base: BASE, aborted: false };
  await w.slots.abortIdle(cleaning);
  assert.equal(cleaning.aborted, false);
  assert.equal(w.calls.length, before + REMOVE.length);
});

test('nimmt der Runner während des Abbruchs doch einen Job an, läuft der zu Ende und wird gelernt', async () => {
  const w = world();
  let end = null;
  let emit = null;
  w.answer = (name, args, { onLine }) => {
    if (name === `rm -f ${BASE}-runner`) emit('Running job: Bauen'); // zu spät: Der Job läuft schon
    if (!isRunner(name)) return undefined;
    emit = onLine;
    onLine('Listening for Jobs');
    return new Promise((resolve) => { end = resolve; });
  };
  w.onLearn = (pool, slot) => { slot.retired = true; };
  const loop = w.slots.slotLoop(w.pool, w.slot);
  await until(() => w.slot.state === 'bereit');

  await w.slots.abortIdle(w.slot);
  assert.equal(w.slot.state, 'arbeitet');
  assert.equal(w.slot.aborted, false);

  emit('Job Bauen completed with result: Succeeded');
  end({ code: 0 });
  await loop;
  assert.deepEqual(w.learned, ['Bauen']);
  assert.ok(!w.calls.includes(UNREGISTER));
});

test('Abbruch während des Aufbaus: Das halbe Paar wird entfernt, angemeldet wird nichts', async () => {
  const w = world();
  w.answer = (name) => (name === `exec ${BASE}-dind info` ? { code: 1 } : undefined); // der Daemon ist noch nicht bereit
  let building = null;
  w.onSleep = () => { building = w.slot.building; w.slot.aborted = true; };
  await w.slots.serveOneJob(w.pool, w.slot);

  assert.deepEqual(w.calls, [...PROVISION, `run ${BASE}-dind`, `exec ${BASE}-dind info`, ...REMOVE]);
  assert.equal(building, true);
  assert.equal(w.slot.building, false);
  assert.equal(w.slot.base, undefined);
  assert.equal(w.slots.livePairs.size, 0);
});

test('lässt sich das Paar nicht aufbauen, bleibt nichts davon stehen', async () => {
  const net = world();
  net.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: permission denied\n' } : undefined);
  await assert.rejects(net.slots.provision(net.pool, () => false), { message: 'Netz lässt sich nicht anlegen: Error response from daemon: permission denied' });
  assert.deepEqual(net.calls, [`network create ${BASE}`, ...REMOVE]);
  assert.equal(net.slots.livePairs.size, 0);

  const start = world();
  start.answer = (name) => (name === `run ${BASE}-dind` ? { code: 125, stderr: 'no space left on device' } : undefined);
  await assert.rejects(start.slots.provision(start.pool, () => false), { message: 'Docker-Daemon startet nicht: no space left on device' });
  assert.deepEqual(start.calls.slice(-4), REMOVE);

  const slow = world();
  slow.answer = (name) => (name === `exec ${BASE}-dind info` ? { code: 1 } : undefined);
  await assert.rejects(slow.slots.provision(slow.pool, () => false), { message: 'Docker-Daemon wurde nicht bereit' });
  assert.equal(slow.slept.length, 40);
  assert.ok(slow.slept.every((ms) => ms === 1000));
  assert.deepEqual(slow.calls.slice(-4), REMOVE);
});

test('ruht der Pool oder fehlt Docker, wartet der Platz und die Reserve wird abgebaut', async () => {
  const w = world();
  w.ready = false;
  const states = [];
  w.onSleep = () => {
    states.push(w.slot.state);
    if (states.length === 1) { w.ready = true; w.resting = true; w.settings.paused = true; }
    if (states.length === 2) w.settings.paused = false;
    if (states.length === 3) w.pool.removed = true;
  };
  await w.slots.slotLoop(w.pool, w.slot);

  assert.deepEqual(states, ['wartet auf Docker', 'pausiert', 'wartet']);
  assert.equal(w.discarded, 3);
  assert.deepEqual(w.slept, [1000, 1000, 1000]);
  assert.deepEqual(w.calls, []);
  assert.equal(w.slot.state, 'aus');
});

test('teardown: ohne Paar geschieht nichts; ohne Job wird abgemeldet, nach einem Job nicht', async () => {
  const w = world();
  await w.slots.teardown({ repo: REPO, base: null, runnerId: 5 });
  assert.deepEqual(w.calls, []);

  const idle = { repo: REPO, base: BASE, runnerId: 77, job: null };
  await w.slots.teardown(idle);
  assert.deepEqual(w.calls, [...REMOVE, UNREGISTER]);
  assert.deepEqual(idle, { repo: REPO, base: null, runnerId: null, job: null });

  w.calls.length = 0;
  await w.slots.teardown({ repo: REPO, base: BASE, runnerId: 77, job: 'Bauen' });
  assert.deepEqual(w.calls, REMOVE);

  w.calls.length = 0;
  w.ghFails = 'gh: Not Found (HTTP 404)'; // schon weg: kein Fehler
  await w.slots.teardown({ repo: REPO, base: BASE, runnerId: 77, job: null });
  assert.deepEqual(w.calls, [...REMOVE, UNREGISTER]);
  assert.deepEqual(w.logs, []);

  // Alles andere bleibt bei GitHub stehen und gehört ins Protokoll.
  w.ghFails = 'Das Anfragelimit von GitHub ist aufgebraucht; weiter um 17:05.';
  await w.slots.teardown({ repo: REPO, base: BASE, runnerId: 77, job: null });
  assert.deepEqual(w.logs, [['Runner ließ sich bei GitHub nicht abmelden – Das Anfragelimit von GitHub ist aufgebraucht; weiter um 17:05.', REPO, 'error']]);
});

test('ein Platz ist nur gewollt, solange das Programm läuft, der Pool besteht und der Platz nicht ausläuft', () => {
  const w = world();
  assert.equal(w.slots.slotWanted(w.pool, w.slot), true);
  assert.equal(w.slots.slotWanted(w.pool, { retired: true }), false);
  assert.equal(w.slots.slotWanted({ removed: true }, w.slot), false);
  w.stopping = true;
  assert.equal(w.slots.slotWanted(w.pool, w.slot), false);
});
