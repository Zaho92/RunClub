const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaches, SERVICE_FAILED } = require('../src/caches');
const { MINUTE } = require('../src/units');

const REPO = 'wer/App';
const OLD = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };
const NEW = { ...OLD, dockerMemory: '6g' };
const KEY_OLD = `4/${8 * 1073741824}`;
const KEY_NEW = `4/${6 * 1073741824}`;

// Ein Aufruf von Docker in Kurzform: bei `run` nur der Name des Containers (das Werkzeug für das Volume hat keinen),
// beim Netz ohne das zufällige Subnetz.
function brief(args) {
  if (args[0] === 'run') return args.includes('--name') ? `run ${args[args.indexOf('--name') + 1]}` : 'run chown';
  if (args[0] === 'network' && args[1] === 'create') return `network create ${args.at(-1)}`;
  return args.join(' ');
}

// Docker und der Rest von backend.js nachgestellt. `calls` hält die Aufrufe an Docker in ihrer Reihenfolge,
// `answer(name, args)` kann einem Aufruf ein Ergebnis geben (sonst gelingt er).
function world() {
  const w = {
    calls: [], details: [], logs: [], stopping: false, ready: true, limits: OLD, answer: () => undefined,
    settings: { repo: REPO, parallel: 2, cache: true, paused: false },
    pool: { repo: REPO, slots: [], reserve: [], hold: false, prepared: true, removed: false }, // wie `startPool`, schon vorbereitet
    livePairs: new Map(),
  };
  w.caches = createCaches({
    docker: async (args) => {
      const name = brief(args);
      w.calls.push(name);
      w.details.push({ name, args });
      return { code: 0, stdout: '', stderr: '', ...(await w.answer(name, args)) };
    },
    log: (...entry) => w.logs.push(entry),
    dind: 'dind:test', buildkit: 'buildkit:test',
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => w.limits,
    poolOf: (repo) => (repo === REPO ? w.pool : undefined),
    cacheVolume: () => 'rc-cache-app', buildVolume: () => 'rc-build-app', buildService: () => 'rc-buildkit-app', buildNetwork: () => 'rc-buildnet-app',
    livePairs: w.livePairs, stopping: () => w.stopping, linuxReady: () => w.ready,
  });
  return w;
}

const PREPARE = ['rm -f rc-buildkit-app', 'volume create rc-cache-app', 'run chown', 'volume create rc-build-app', 'network create rc-buildnet-app', 'run rc-buildkit-app'];

test('bereitstellen legt Paket-Cache, Netz und Build-Dienst mit den Limits des Docker-Daemons an', async () => {
  const w = world();
  const before = Date.now();
  await w.caches.prepareCaches(REPO);
  assert.deepEqual(w.calls, PREPARE);
  assert.deepEqual(w.details.find((call) => call.name === 'run chown').args,
    ['run', '--rm', '-v', 'rc-cache-app:/c', '--entrypoint', 'sh', 'dind:test', '-c', 'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
  assert.deepEqual(w.details.find((call) => call.name === 'run rc-buildkit-app').args,
    ['run', '-d', '--name', 'rc-buildkit-app', '--privileged', '--restart', 'no', '--network', 'rc-buildnet-app', '--cpus', '4', '--memory', '8g',
      '-v', 'rc-build-app:/var/lib/buildkit', 'buildkit:test', '--addr', 'tcp://0.0.0.0:1234']);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.equal(w.pool.serviceFailures, 0);
  assert.ok(w.pool.serviceRetryAt >= before + MINUTE);
  assert.deepEqual(w.logs, []);
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
  assert.ok(w.calls.includes('run rc-buildkit-app'));
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.deepEqual(w.logs, []);
});

test('lässt sich das Netz nicht anlegen, startet der Build-Dienst nicht, und es steht im Protokoll', async () => {
  const w = world();
  w.answer = (name) => (name.startsWith('network create') ? { code: 1, stderr: 'Error response from daemon: kaputt' } : undefined);
  await w.caches.prepareCaches(REPO);
  assert.equal(w.calls.includes('run rc-buildkit-app'), false);
  assert.equal(w.pool.serviceBuilt, SERVICE_FAILED);
  assert.equal(w.logs.length, 1);
  assert.match(w.logs[0][0], /^Netz für den Build-Dienst lässt sich nicht anlegen – /);
  assert.deepEqual(w.logs[0].slice(1), [REPO, 'error']);
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
  assert.equal(w.pool.serviceBuilt, SERVICE_FAILED);
  assert.deepEqual(w.logs[0], ['Build-Dienst startet nicht – docker: Error response from daemon: kein Platz.', REPO, 'error']);

  // Gelingt es wieder, beginnt die Zählung von vorn.
  w.answer = () => undefined;
  await w.caches.prepareCaches(REPO);
  assert.equal(w.pool.serviceFailures, 0);
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

test('mit neuen Limits entsteht der Build-Dienst neu und hängt wieder in den Netzen der stehenden Paare', async () => {
  const w = world();
  w.pool.serviceBuilt = KEY_OLD;
  w.pool.slots = [{ state: 'bereit' }, { state: 'startet' }];
  w.livePairs.set('rc-app-1', REPO).set('rc-fremd-1', 'wer/Fremd').set('rc-app-2', REPO);
  w.limits = NEW;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, [...PREPARE, 'network connect --alias buildkit rc-app-1 rc-buildkit-app', 'network connect --alias buildkit rc-app-2 rc-buildkit-app']);
  assert.equal(w.pool.serviceBuilt, KEY_NEW);
  assert.equal(w.pool.renewingService, false);
  assert.deepEqual(w.logs, [['Lege den Build-Dienst mit den neuen Limits an', REPO]]);
});

test('solange im Pool gebaut wird oder er anderweitig beschäftigt ist, wartet das Erneuern', async () => {
  const blocked = [
    (w) => { w.pool.slots = [{ state: 'arbeitet' }]; },
    (w) => { w.pool.slots = [{ state: 'räumt auf' }]; },
    (w) => { w.pool.hold = true; },
    (w) => { w.pool.removed = true; },
    (w) => { w.pool.prepared = false; },
    (w) => { w.pool.renewingService = true; },
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
  w.pool.serviceBuilt = SERVICE_FAILED;
  w.pool.serviceRetryAt = Date.now() + MINUTE;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, []);

  w.pool.serviceRetryAt = Date.now() - 1;
  await w.caches.renewService(w.pool);
  assert.deepEqual(w.calls, PREPARE);
  assert.equal(w.pool.serviceBuilt, KEY_OLD);
  assert.deepEqual(w.logs, [['Versuche erneut, den Build-Dienst anzulegen', REPO]]);
});

test('zwei Aufrufe kurz nacheinander erneuern nur einmal', async () => {
  const w = world();
  w.pool.serviceBuilt = KEY_OLD;
  w.limits = NEW;
  await Promise.all([w.caches.renewService(w.pool), w.caches.renewService(w.pool)]);
  assert.deepEqual(w.calls, PREPARE);
});
