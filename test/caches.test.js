const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaches } = require('../src/caches');
const { SECURITY_FLAGS } = require('../src/dind');
const { MINUTE } = require('../src/units');
const { createEngine } = require('../src/engine');
const { rendered } = require('./support');

const REPO = 'wer/App';
const OLD = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };
const NEW = { ...OLD, dockerMemory: '6g' };
const KEY_OLD = `4/${8 * 1073741824}`;
const KEY_NEW = `4/${6 * 1073741824}`;

// Ein Aufruf von Docker in Kurzform: bei `run` nur der Name des Containers; die Werkzeuge für die Volumes haben keinen
// und heißen nach dem, was sie vorbereiten. Beim Netz ohne das zufällige Subnetz, bei `inspect` ohne das Format.
function brief(args) {
  if (args[0] === 'run') return args.includes('--name') ? `run ${args[args.indexOf('--name') + 1]}` : args.at(-1).includes('/c/nuget') ? 'run cache' : args.at(-1).includes('du -sm') ? 'run du' : 'run volumes';
  if (args[0] === 'network' && args[1] === 'create') return `network create ${args.at(-1)}`;
  if (args[0] === 'inspect') return `inspect ${args.includes('{{.State.Running}}') ? 'running ' : ''}${args.at(-1)}`;
  return args.join(' ');
}

// Docker und der Rest nachgestellt. `calls` hält die Aufrufe an Docker in ihrer Reihenfolge,
// `answer(name, args)` kann einem Aufruf ein Ergebnis geben (sonst gelingt er).
function world() {
  const w = {
    calls: [], details: [], logs: [], stopping: false, ready: true, limits: OLD, answer: () => undefined,
    settings: { repo: REPO, parallel: 2, cache: true, paused: false },
    pool: { repo: REPO, slots: [], reserve: [], hold: false, prepared: true, removed: false }, // wie `startPool`, schon vorbereitet
  };
  // Docker über engine.js, wie im Betrieb; nachgestellt ist nur `run`.
  const run = async (command, args) => {
    const name = brief(args);
    w.calls.push(name);
    w.details.push({ name, args });
    // Ein eben gestarteter Build-Dienst läuft, wenn der Test nichts anderes sagt.
    return { code: 0, stdout: name.startsWith('inspect running') ? 'true' : '', stderr: '', ...(await w.answer(name, args)) };
  };
  const { docker, dockerList } = createEngine({ run, timeout: 99 });
  w.caches = createCaches({
    docker, dockerList, sleep: async () => {},
    log: (...entry) => w.logs.push(rendered(entry)),
    dind: 'dind:test', buildkit: 'buildkit:test', serviceMark: 'runclub.service=test',
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => w.limits,
    poolOf: (repo) => (repo === REPO ? w.pool : undefined),
    cacheVolume: () => 'rc-cache-app', seedVolume: () => 'rc-seed-app', buildVolume: () => 'rc-build-app', buildSocket: () => 'rc-buildsock-app',
    buildService: () => 'rc-buildkit-app', buildNetwork: () => 'rc-buildnet-app',
    stopping: () => w.stopping, dockerReady: () => w.ready,
  });
  return w;
}

const READY = ['volume create rc-cache-app', 'run cache', 'volume create rc-build-app', 'volume create rc-buildsock-app', 'network create rc-buildnet-app', 'inspect rc-buildkit-app'];
const SERVICE = ['rm -f rc-buildkit-app', 'run volumes', 'run rc-buildkit-app', 'inspect running rc-buildkit-app'];
const PREPARE = [...READY, ...SERVICE];
// So meldet `docker inspect` einen laufenden Build-Dienst mit diesen Limits.
const running = (key) => (name) => (name === 'inspect rc-buildkit-app' ? { stdout: `true ${key}\n` } : undefined);

test('bereitstellen legt Paket-Cache, Netz und Build-Dienst ohne Rechte mit den Limits des Docker-Daemons an', async () => {
  const w = world();
  const before = Date.now();
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, PREPARE);
  const args = (name) => w.details.find((call) => call.name === name).args;
  assert.deepEqual(args('run cache'),
    ['run', '--rm', '-v', 'rc-cache-app:/c', '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c', 'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
  assert.deepEqual(args('network create rc-buildnet-app').slice(-3), ['--label', 'runclub.service=test', 'rc-buildnet-app']);
  // Build-Layer des früheren Dienstes mit Rechten gehören root: Sie werden geleert, dann gehören beide Volumes dem Dienst.
  assert.deepEqual(args('run volumes'), ['run', '--rm', '-v', 'rc-build-app:/b', '-v', 'rc-buildsock-app:/s', '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c',
    '[ "$(stat -c %u /b)" = 1000 ] || find /b -mindepth 1 -delete; chown 1000:1000 /b /s']);
  assert.deepEqual(args('run rc-buildkit-app', 'inspect running rc-buildkit-app'),
    ['run', '-d', '--name', 'rc-buildkit-app', '--label', 'runclub.service=test', '--label', `runclub.limits=${KEY_OLD}`,
      '--restart', 'no', '--network', 'rc-buildnet-app', '--cpus', '4', '--memory', '8g', '--pids-limit', '8192',
      ...SECURITY_FLAGS,
      '-v', 'rc-build-app:/home/user/.local/share/buildkit', '-v', 'rc-buildsock-app:/run/rc-buildkit',
      'buildkit:test', '--addr', 'unix:///run/rc-buildkit/buildkitd.sock']); // mit Sandbox der Build-Schritte
  assert.equal(args('run rc-buildkit-app', 'inspect running rc-buildkit-app').includes('--privileged'), false);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.equal(w.pool.serviceFailed, false);
  assert.equal(w.pool.serviceFailures, 0);
  assert.ok(w.pool.serviceRetryAt >= before + MINUTE);
  assert.deepEqual(w.logs, []);
});

test('ein Build-Dienst, der schon mit den geltenden Limits läuft, bleibt stehen: Ein laufender Build bräche sonst ab', async () => {
  const w = world();
  w.answer = running(KEY_OLD);
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, READY);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);

  // Mit anderen Limits oder angehalten entsteht er neu.
  for (const answer of [running(KEY_NEW), (name) => (name === 'inspect rc-buildkit-app' ? { stdout: `false ${KEY_OLD}\n` } : undefined)]) {
    const other = world();
    other.answer = answer;
    await other.caches.prepareCaches(REPO);
    assert.deepEqual(other.calls, PREPARE);
  }
});

test('ohne Cache verschwinden Build-Dienst und Netz, und nichts wird angelegt', async () => {
  const w = world();
  w.settings.cache = false;
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, ['rm -f rc-buildkit-app', 'network rm rc-buildnet-app']);
  assert.equal(w.pool.serviceBuilt, undefined);
});

test('ein Netz, das schon steht, ist kein Fehler', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: network with name rc-buildnet-app already exists' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.ok(w.calls.includes('run rc-buildkit-app', 'inspect running rc-buildkit-app'));
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.deepEqual(w.logs, []);
});

test('lässt sich das Netz nicht anlegen, startet der Build-Dienst nicht, und es steht im Protokoll', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: kaputt' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.calls.includes('run rc-buildkit-app', 'inspect running rc-buildkit-app'), false);
  assert.equal(w.pool.serviceFailed, true);
  assert.equal(w.pool.serviceBuilt, null);
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0][0], /^Netz für den Build-Dienst lässt sich nicht anlegen – /);
  assert.deepEqual(w.logs[0].slice(1), [REPO, 'error']);
});

test('endet der Build-Dienst gleich nach dem Start, steht der Grund aus seinem Protokoll in der Meldung', async () => {
  const w = world();
  w.answer = (name) => (name === 'inspect running rc-buildkit-app' ? { stdout: 'false' }
    : name.startsWith('logs') ? { stderr: 'level=info msg="start"\nerror: unshare: operation not permitted' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.pool.serviceFailed, true);
  assert.match(w.logs[0][0], /^Build-Dienst endet gleich nach dem Start – error: unshare: operation not permitted \(womöglich verbietet das Seccomp-Profil/);
});

test('lässt sich der Zustand des Build-Diensts nach dem Start nicht lesen, sagt die Meldung das, nicht „endet gleich“', async () => {
  const w = world();
  w.answer = (name) => (name === 'inspect running rc-buildkit-app' ? { code: 1, stderr: 'Error: context deadline exceeded' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.logs[0][0], 'Build-Dienst: Zustand nach dem Start nicht lesbar – Error: context deadline exceeded');
});

test('startet der Build-Dienst nicht, wächst der Abstand bis zum nächsten Versuch', async () => {
  const w = world();
  w.answer = (name) => (name === 'run rc-buildkit-app' ? { code: 125, stderr: 'docker: Error response from daemon: kein Platz.\nRun \'docker run --help\' for more information' } : undefined);
  const waits = [];
  for (let round = 0; round < 6; round += 1) {
    const before = Date.now();
    await w.caches.prepareCaches(REPO);
    waits.push(Math.round((w.pool.serviceRetryAt - before) / MINUTE));
  }
  assert.deepEqual(waits, [2, 4, 8, 16, 30, 30]);
  assert.equal(w.pool.serviceFailed, true);
  assert.deepEqual(w.logs[0], ['Build-Dienst startet nicht – docker: Error response from daemon: kein Platz.', REPO, 'error']);

  // Gelingt es wieder, beginnt die Zählung von vorn.
  w.answer = () => undefined;
  await w.caches.prepareCaches(REPO);
  assert.equal(w.pool.serviceFailures, 0);
  assert.equal(w.pool.serviceFailed, false);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
});

test('bereitstellen für ein Repo, dessen Pool schon weg ist, scheitert nicht', async () => {
  const w = world();
  w.pool = undefined;
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, PREPARE);
});

test('der Build-Dienst mit den geltenden Limits bleibt stehen', async () => {
  const w = world();
  await w.caches.renewService(w.pool); // noch nie gebaut: Das übernimmt die Vorbereitung des Pools
  w.pool.serviceBuilt = KEY_OLD;
  await w.caches.renewService(w.pool);
  w.settings.cache = false;
  w.limits = NEW;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, []);
});

test('mit neuen Limits entsteht der Build-Dienst neu; die Paare erreichen ihn über denselben Socket', async () => {
  const w = world();
  w.pool.serviceBuilt = KEY_OLD;
  w.pool.slots = [{ state: 'ready' }, { state: 'starting' }];
  w.answer = running(KEY_OLD);
  w.limits = NEW;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, PREPARE);
  assert.equal(w.pool.serviceBuilt, KEY_NEW);
  assert.equal(w.pool.renewingService, false);
  assert.deepEqual(w.logs, [['Lege den Build-Dienst mit den neuen Limits an', REPO]]);
});

test('solange im Pool gebaut wird oder er anderweitig beschäftigt ist, wartet das Erneuern', async () => {
  const blocked = [
    (w) => { w.pool.slots = [{ state: 'working' }]; },
    (w) => { w.pool.slots = [{ state: 'cleaning' }]; },
    (w) => { w.pool.hold = true; },
    (w) => { w.pool.removed = true; },
    (w) => { w.pool.prepared = false; },
    (w) => { w.pool.renewingService = true; },
    (w) => { w.pool.preparing = true; },
    (w) => { w.stopping = true; },
    (w) => { w.ready = false; },
  ];
  for (const block of blocked) {
    const w = world();
    w.pool.serviceBuilt = KEY_OLD;
    w.limits = NEW;
    block(w);
    await w.caches.renewService(w.pool);
    assert.deepEqual(w.calls, []);
    assert.equal(w.pool.serviceBuilt, KEY_OLD);
  }
});

test('ein gescheiterter Build-Dienst wird erst nach der Frist wieder versucht', async () => {
  const w = world();
  w.pool.serviceFailed = true;
  w.pool.serviceBuilt = null;
  w.pool.serviceRetryAt = Date.now() + MINUTE;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, []);

  w.pool.serviceRetryAt = Date.now() - 1;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, PREPARE);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.equal(w.pool.serviceFailed, false);
  assert.deepEqual(w.logs, [['Versuche erneut, den Build-Dienst anzulegen', REPO]]);
});

test('zwei Aufrufe kurz nacheinander erneuern nur einmal', async () => {
  const w = world();
  w.pool.serviceBuilt = KEY_OLD;
  w.limits = NEW;
  await Promise.all([w.caches.renewService(w.pool), w.caches.renewService(w.pool)]);
  assert.deepEqual(w.calls, PREPARE);
});

test('leeren: Paket-Cache, Build-Layer samt Dienst und Socket, je nach Wunsch; was sich nicht löschen lässt, wirft', async () => {
  const w = world();
  await w.caches.removeCaches(REPO, { packages: true });
  assert.deepEqual(w.calls, ['volume rm -f rc-cache-app']);

  w.calls.length = 0;
  await w.caches.removeCaches(REPO, { build: true });
  assert.deepEqual(w.calls, ['rm -f rc-buildkit-app', 'network rm rc-buildnet-app', 'volume rm -f rc-build-app rc-buildsock-app']);

  w.calls.length = 0;
  await w.caches.removeCaches(REPO, {});
  assert.deepEqual(w.calls, []);

  w.answer = (name) => (name.startsWith('volume rm') ? { code: 1, stderr: 'Error response from daemon: remove rc-cache-app: volume is in use\n' } : undefined);
  await assert.rejects(w.caches.removeCaches(REPO, { packages: true, build: true }), { message: 'Caches ließen sich nicht löschen – Error response from daemon: remove rc-cache-app: volume is in use' });
});

test('ein Pool, der entfernt wird oder schon gemessen wird, wird nicht gemessen', async () => {
  for (const pool of [{ repo: REPO, removed: true, sizes: null }, { repo: REPO, measuring: true, sizes: null }]) {
    const w = world();
    await w.caches.measureSizes(pool);
    assert.deepEqual(w.calls, []);
    assert.equal(pool.sizes, null);
  }
});

test('gemessen werden nur die Volumes, die es gibt, in Bytes; was fehlt, zählt 0', async () => {
  const w = world();
  const pool = { repo: REPO, sizes: null };
  const lists = { 'volume ls -q --filter name=rc-': 'rc-cache-app\nrc-build-app\nrc-cache-fremd\n' };
  w.answer = (name, args) => {
    if (name === 'volume ls -q --filter name=rc-') return { stdout: lists[name] };
    if (args[0] === 'run' && args.includes('du -sm /m/* 2>/dev/null')) return { stdout: '12\t/m/packages\n3\t/m/build\nunsinn\n' };
    return undefined;
  };
  await w.caches.measureSizes(pool);
  assert.deepEqual(pool.sizes, { packages: 12 * 1048576, images: 0, build: 3 * 1048576 });
  assert.equal(pool.measuring, false);
  const du = w.details.find((call) => call.args.includes('du -sm /m/* 2>/dev/null')).args;
  assert.deepEqual(du, ['run', '--rm', '-v', 'rc-cache-app:/m/packages:ro', '-v', 'rc-build-app:/m/build:ro', '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c', 'du -sm /m/* 2>/dev/null']);

  // Ohne ein einziges Volume wird nichts gestartet.
  const empty = world();
  const bare = { repo: REPO, sizes: null };
  await empty.caches.measureSizes(bare);
  assert.deepEqual(bare.sizes, { packages: 0, images: 0, build: 0 });
  assert.equal(empty.calls.some((name) => name.startsWith('run')), false);
});
