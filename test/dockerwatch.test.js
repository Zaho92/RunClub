const test = require('node:test');
const assert = require('node:assert/strict');
const { createDockerWatch, MISSES, READY_PAUSE, WAIT_PAUSE, MISS_PAUSE } = require('../src/dockerwatch');
const { PROBE_TIMEOUT } = require('../src/dind');
const { createEngine } = require('../src/engine');
const { rendered } = require('./support');

const MARK = 'runclub.runner=test';
const SERVICE_MARK = 'runclub.service=test';
const IMAGE = 'runner:test';

// Ein Aufruf von Docker in Kurzform.
const brief = (args) => args.join(' ');

// Docker, GitHub und der Rest nachgestellt. `calls` hält die Aufrufe an Docker und GitHub in ihrer
// Reihenfolge; `answer(name)` kann einem Docker-Aufruf ein Ergebnis geben (sonst gelingt er ohne Ausgabe).
// `sleep` merkt sich die Dauer und ruft `onSleep`, mit dem ein Test die Schleife steuert oder beendet.
// Die eigenen Abbilder: das des Runners und das des Docker-Daemons, gebaut auf dem festgenagelten Abbild.
const BUILDS = [
  { image: IMAGE, dir: 'C:/rc/linux', what: 'Das Runner-Abbild' },
  { image: 'dind:test', dir: 'C:/rc/linux/dind', args: ['--build-arg', 'BASE=docker:pin'], what: 'Das Abbild des Docker-Daemons' },
];
const BUILT = ['build --pull -q -t runner:test C:/rc/linux', 'build --pull -q --build-arg BASE=docker:pin -t dind:test C:/rc/linux/dind'];

function world() {
  const w = {
    calls: [], logs: [], slept: [], prepared: [], ready: 0, alive: 0, stopping: false, answer: () => undefined, onSleep: () => {},
    runners: { runners: [] }, ghFails: null, livePairs: new Map(), repos: ['wer/App'], pools: [{ repo: 'wer/App', prepared: true }],
  };
  // Docker über engine.js, wie im Betrieb; nachgestellt ist nur `run`.
  const run = async (command, args, options = {}) => {
    w.calls.push(brief(args));
    return { code: 0, stdout: '', stderr: '', ...(await w.answer(brief(args), options)) };
  };
  const { docker, dockerList, unreachable } = createEngine({ run, timeout: 99 });
  w.watch = createDockerWatch({
    docker, dockerList,
    gh: async (args) => { w.calls.push(`gh ${args.join(' ')}`); if (w.ghFails) throw new Error(w.ghFails); return w.runners; },
    log: (...entry) => w.logs.push(rendered(entry)),
    sleep: async (ms) => { w.slept.push(ms); await w.onSleep(ms); },
    host: 'PC', mark: MARK, serviceMark: SERVICE_MARK, builds: BUILDS, requiredImages: ['buildkit:test'], longTimeout: 1234,
    unreachable, exposure: async () => w.exposure ?? null,
    buildService: (repo) => `rc-buildkit-${repo.split('/')[1].toLowerCase()}`, buildNetwork: (repo) => `rc-buildnet-${repo.split('/')[1].toLowerCase()}`,
    livePairs: w.livePairs, repos: () => w.repos, pools: () => w.pools,
    preparePool: async (pool) => { w.prepared.push(pool.repo); assert.equal(pool.prepared, false); },
    stopping: () => w.stopping,
    onReady: () => { w.ready += 1; }, onAlive: () => { w.alive += 1; },
  });
  return w;
}

// Lässt die Schleife laufen, bis `rounds` Pausen vergangen sind; `each(round)` läuft vor jeder Pause.
async function loopFor(w, rounds, each = () => {}) {
  let round = 0;
  w.onSleep = () => { each(round); round += 1; if (round >= rounds) w.stopping = true; };
  await w.watch.watch();
}

const PREPARE = [
  'info --format {{.NCPU}} {{.MemTotal}}', ...BUILT, 'pull -q buildkit:test',
];
const NAMED = (repo) => [`rm -f rc-buildkit-${repo}`, `network inspect rc-buildnet-${repo} --format {{range .Containers}}{{println .Name}}{{end}}`, `network rm rc-buildnet-${repo}`];
const LEFTOVERS = [
  ...NAMED('app'),
  `ps -aq --filter label=${MARK}`, `ps -aq --filter label=${SERVICE_MARK}`, `volume ls -q --filter label=${MARK}`,
  `network ls -q --filter label=${MARK}`, `network ls -q --filter label=${SERVICE_MARK}`, 'gh api repos/wer/App/actions/runners?per_page=100',
];
const ORPHANS = [`ps -a --filter label=${MARK} --format {{.Names}}`, `volume ls -q --filter label=${MARK}`, `network ls --filter label=${MARK} --format {{.Name}}`];

test('vor der ersten Antwort ist Docker nicht bereit, mit der Grenze von einem Kern und ohne Speicher', () => {
  const w = world();
  assert.deepEqual([w.watch.ready(), w.watch.error(), w.watch.cpus(), w.watch.memory()], [false, null, 1, 0]);
});

test('antwortet Docker, wird es vorbereitet: Grenzen lesen, Abbild bauen, Abbilder laden, Reste des vorigen Laufs abräumen, Pools vorbereiten', async () => {
  const w = world();
  w.answer = (name, options) => {
    if (name.startsWith('info --format {{.NCPU}}')) { assert.equal(options.timeout, PROBE_TIMEOUT); return { stdout: '12 16000000000\n' }; }
    if (name.startsWith('build') || name.startsWith('pull')) assert.equal(options.timeout, 1234);
    return undefined;
  };
  await loopFor(w, 1);
  assert.deepEqual(w.calls, [...PREPARE, ...LEFTOVERS]);
  assert.deepEqual([w.watch.ready(), w.watch.error(), w.watch.cpus(), w.watch.memory()], [true, null, 12, 16000000000]);
  assert.deepEqual([w.ready, w.prepared], [1, ['wer/App']]);
  assert.deepEqual(w.slept, [READY_PAUSE]);
  assert.deepEqual(w.logs, [['Baue die Abbilder von Runner (mit dem neuesten Runner von GitHub) und Docker-Daemon …']]);
});

test('antwortet Docker nicht, steht der Grund einmal im Protokoll, und es wird in Abständen weiter versucht', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('info') ? { code: 1, stderr: 'error during connect' } : undefined);
  await loopFor(w, 3);
  assert.deepEqual(w.logs, [['Docker ist nicht erreichbar – läuft Docker Desktop?', null, 'error']]);
  assert.deepEqual(w.watch.error(), { key: 'm_dockerUnreachableDesktop', args: [] }); // die Oberfläche übersetzt
  assert.deepEqual(w.slept, [WAIT_PAUSE, WAIT_PAUSE, WAIT_PAUSE]);
  assert.deepEqual([w.watch.ready(), w.ready, w.prepared], [false, 0, []]);
});

test('erst nach mehreren ausbleibenden Antworten in Folge gilt Docker als weg; danach wird neu vorbereitet, ohne gekennzeichnete Paare abzuräumen', async () => {
  const w = world();
  let down = 0; // so viele der nächsten Prüfungen bleiben ohne Antwort
  w.answer = (name) => {
    if (name !== 'info --format ok') return undefined;
    if (down > 0) { down -= 1; return { code: 1 }; }
    return undefined;
  };
  await loopFor(w, 1);
  assert.equal(w.watch.ready(), true);

  // Eine Antwort bleibt aus, dann ist Docker wieder da: nichts geschieht außer einer kurzen Pause.
  down = 1;
  w.stopping = false;
  await loopFor(w, 2);
  assert.deepEqual(w.slept.slice(-2), [MISS_PAUSE, READY_PAUSE]);
  assert.deepEqual([w.watch.ready(), w.logs.length, w.alive], [true, 1, 1]);

  // Bleiben MISSES Antworten in Folge aus, warten die Plätze, und Docker wird neu vorbereitet.
  down = MISSES;
  w.stopping = false;
  w.calls.length = 0;
  w.pools[0].prepared = true;
  let readyDuring = [];
  await loopFor(w, MISSES + 1, () => readyDuring.push(w.watch.ready()));
  assert.deepEqual(readyDuring, [true, true, false, true]);
  assert.deepEqual(w.logs.at(-1), ['Baue die Abbilder von Runner (mit dem neuesten Runner von GitHub) und Docker-Daemon …']);
  assert.ok(w.logs.some((entry) => entry[0] === 'Docker antwortet nicht mehr – die Linux-Runner warten.'));
  // Diesmal nur, was zu keinem stehenden Paar gehört, und keine Abmeldung bei GitHub.
  assert.deepEqual(w.calls.slice(-(PREPARE.length + ORPHANS.length)), [...PREPARE, ...ORPHANS]);
  assert.equal(w.calls.some((name) => name.startsWith('gh ')), false);
  assert.deepEqual([w.ready, w.prepared], [2, ['wer/App', 'wer/App']]);
});

test('eine Antwort zwischendurch setzt die Zählung der ausbleibenden zurück', async () => {
  const w = world();
  await loopFor(w, 1);
  // Zweimal keine Antwort, einmal eine, wieder zweimal keine: Nie sind es MISSES in Folge.
  const pattern = [false, false, true, false, false, true];
  assert.ok(MISSES > 2);
  w.answer = (name) => (name === 'info --format ok' && pattern.shift() === false ? { code: 1 } : undefined);
  w.stopping = false;
  await loopFor(w, 6);
  assert.equal(w.watch.ready(), true);
  assert.equal(w.logs.some((entry) => entry[0].startsWith('Docker antwortet nicht mehr')), false);
});

test('lässt sich das Abbild nicht bauen, wird mit dem vorhandenen weitergearbeitet; ohne eines geht es nicht', async () => {
  const w = world();
  let present = true;
  w.answer = (name) => {
    if (name.startsWith('build')) return { code: 1, stderr: 'ERROR: failed to solve: kein Netz\n' };
    if (name.startsWith('image inspect')) return present ? undefined : { code: 1 };
    return undefined;
  };
  await w.watch.prepareDocker();
  assert.deepEqual(w.logs.filter(([, , kind]) => kind === 'error'), [
    ['Das Runner-Abbild ließ sich nicht neu bauen (ERROR: failed to solve: kein Netz); die Runner nutzen das vorhandene.', null, 'error'],
    ['Das Abbild des Docker-Daemons ließ sich nicht neu bauen (ERROR: failed to solve: kein Netz); die Runner nutzen das vorhandene.', null, 'error'],
  ]);
  present = false;
  await assert.rejects(w.watch.prepareDocker(), /Das Runner-Abbild ließ sich nicht bauen: ERROR: failed to solve: kein Netz/);
});

test('das tägliche Neubauen geschieht nur, wenn Docker bereit ist und RunClub nicht endet', async () => {
  const w = world();
  await w.watch.refreshImage();
  assert.deepEqual(w.calls, []);
  await loopFor(w, 1);
  w.calls.length = 0;
  w.stopping = false;
  await w.watch.refreshImage();
  assert.deepEqual(w.calls, BUILT);
  assert.deepEqual(w.logs.at(-1), ['Baue die Abbilder von Runner und Docker-Daemon neu (tägliche Auffrischung) …']);
  w.stopping = true;
  w.calls.length = 0;
  await w.watch.refreshImage();
  assert.deepEqual(w.calls, []);
});

test('Reste eines früheren Laufs: alles Gekennzeichnete samt Build-Diensten, Netze samt ihren Mitgliedern, freie Runner des Rechners bei GitHub', async () => {
  const w = world();
  w.repos = ['wer/App', 'wer/Zwei'];
  w.answer = (name) => ({
    [`ps -aq --filter label=${MARK}`]: { stdout: 'c1\nc2\n' },
    [`ps -aq --filter label=${SERVICE_MARK}`]: { stdout: 'b1\n' },
    [`volume ls -q --filter label=${MARK}`]: { stdout: 'v1\n' },
    [`network ls -q --filter label=${MARK}`]: { stdout: 'n1\n' },
    [`network ls -q --filter label=${SERVICE_MARK}`]: { stdout: 'n2\n' },
    'network inspect n1 --format {{range .Containers}}{{println .Name}}{{end}}': { stdout: 'rc-fremd\n' },
  })[name];
  w.runners = { runners: [
    { id: 1, name: 'PC-linux-a1', busy: false }, { id: 2, name: 'PC-linux-b2', busy: true }, { id: 3, name: 'ANDERER-linux-c3', busy: false },
  ] };
  // Beim Beenden meldet es, wie weit es ist (siehe shutdown.js).
  await w.watch.removeLeftovers((name, count) => w.calls.push(`Stufe ${name}${count === undefined ? '' : ` ${count}`}`));
  assert.deepEqual(w.calls, [
    'Stufe cleanup',
    ...NAMED('app'), ...NAMED('zwei'), // ältere Versionen legten sie ohne Kennzeichen an
    `ps -aq --filter label=${MARK}`, `ps -aq --filter label=${SERVICE_MARK}`, 'rm -f -v c1 c2 b1', `volume ls -q --filter label=${MARK}`, 'volume rm -f v1',
    `network ls -q --filter label=${MARK}`, 'network inspect n1 --format {{range .Containers}}{{println .Name}}{{end}}', 'network disconnect -f n1 rc-fremd', 'network rm n1',
    `network ls -q --filter label=${SERVICE_MARK}`, 'network inspect n2 --format {{range .Containers}}{{println .Name}}{{end}}', 'network rm n2',
    'Stufe signoff 2',
    'gh api repos/wer/App/actions/runners?per_page=100', 'gh api -X DELETE repos/wer/App/actions/runners/1', 'Stufe signedOff',
    'gh api repos/wer/Zwei/actions/runners?per_page=100', 'gh api -X DELETE repos/wer/Zwei/actions/runners/1', 'Stufe signedOff',
  ]);
});

test('im Betrieb: nur freie Runner ohne Verbindung, die keinem stehenden Paar gehören', async () => {
  const w = world();
  const RUNNERS = [
    { id: 1, name: 'PC-linux-a1', busy: false, status: 'offline' }, // Paar endete mitten im Job: geht
    { id: 2, name: 'PC-linux-b2', busy: true, status: 'offline' }, // GitHub führt ihn noch als beschäftigt
    { id: 3, name: 'PC-linux-c3', busy: false, status: 'online' }, // etwa eine zweite Instanz zum Ausprobieren
    { id: 4, name: 'PC-linux-d4', busy: false, status: 'offline' }, // gerade angemeldet, der Runner startet noch
    { id: 5, name: 'ANDERER-linux-e5', busy: false, status: 'offline' },
  ];
  // Wer bleibt, wird erst nach der Antwort von GitHub gefragt: Ein Platz kann sich gerade angemeldet haben.
  let asked = false;
  w.runners = { ...w.runners, get runners() { assert.equal(asked, false); return RUNNERS; } };
  await w.watch.removeRegistrations('wer/App', { keep: () => { asked = true; return new Set(['PC-linux-d4']); }, offline: true });
  assert.equal(asked, true);
  assert.deepEqual(w.calls, ['gh api repos/wer/App/actions/runners?per_page=100', 'gh api -X DELETE repos/wer/App/actions/runners/1']);
  assert.deepEqual(w.logs, [['1 verwaiste Runner bei GitHub abgemeldet', 'wer/App']]);
});

test('scheitert das Abmelden bei GitHub, steht das beim Projekt im Protokoll, und es geht weiter', async () => {
  const w = world();
  w.ghFails = 'HTTP 403: Must have admin rights';
  await w.watch.removeRegistrations('wer/App');
  assert.deepEqual(w.logs, [['Abmelden alter Runner – HTTP 403: Must have admin rights', 'wer/App', 'error']]);
});

test('nach einer Unterbrechung geht nur, was zu keinem stehenden Paar gehört', async () => {
  const w = world();
  w.livePairs.set('rc-app-1', 'wer/App');
  w.answer = (name) => ({
    [`ps -a --filter label=${MARK} --format {{.Names}}`]: { stdout: 'rc-app-1-runner\nrc-app-1-dind\nrc-app-2-runner\n' },
    [`volume ls -q --filter label=${MARK}`]: { stdout: 'rc-app-1-work\nrc-app-2-work\nrc-app-2-docker\n' },
    [`network ls --filter label=${MARK} --format {{.Name}}`]: { stdout: 'rc-app-1\nrc-app-2\n' },
  })[name];
  await w.watch.removeOrphans();
  assert.deepEqual(w.calls, [
    `ps -a --filter label=${MARK} --format {{.Names}}`, 'rm -f -v rc-app-2-runner',
    `volume ls -q --filter label=${MARK}`, 'volume rm -f rc-app-2-work rc-app-2-docker',
    `network ls --filter label=${MARK} --format {{.Name}}`, 'network inspect rc-app-2 --format {{range .Containers}}{{println .Name}}{{end}}', 'network rm rc-app-2',
  ]);
  assert.deepEqual(w.logs, [['Reste nach der Unterbrechung entfernt: 1 Container, 2 Volumes']]);

  // Liegt nichts herum, steht auch nichts im Protokoll.
  const quiet = world();
  await quiet.watch.removeOrphans();
  assert.deepEqual(quiet.logs, []);
});

test('gibt Docker seinen Daemon ohne Schutz frei, steht das nach der Vorbereitung im Protokoll', async () => {
  const w = world();
  w.exposure = 'Daemon ohne Schutz';
  await loopFor(w, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(w.logs.filter(([text]) => text === 'Daemon ohne Schutz'), [['Daemon ohne Schutz', null, 'error']]);

  const safe = world();
  await loopFor(safe, 1);
  assert.equal(safe.logs.some(([, , kind]) => kind === 'error'), false);
});
