const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatus, runnerView } = require('../src/status');
const { SLOT } = require('../src/states');
const { GB } = require('../src/units');

const REPO = 'wer/App';
const stats = { 'rc-app-1-runner': { cpu: 1, memory: 100 }, 'rc-app-1-dind': { cpu: 0.5, memory: 50 } };
const view = (slot, jobs = []) => runnerView({ slot, index: 1, repo: REPO, jobs, statsOf: (name) => stats[name], cpus: 6 });

test('ein Platz mit Paar: Name, Nummer, Verbrauch von Runner und Daemon zusammen, Jobs und letztes Ergebnis', () => {
  const lastResult = { job: 'Bauen', result: 'Succeeded' };
  const runner = view({ base: 'rc-app-1', name: 'PC-linux-1', state: SLOT.READY, jobs: 2, lastResult });
  assert.deepEqual(runner, {
    kind: 'Linux', name: 'PC-linux-1', seat: 2, state: SLOT.READY, retiring: false, job: null,
    cpu: 25, cores: 1.5, memory: 150, jobs: 2, lastResult, error: null,
  });
});

test('ohne Paar hat der Platz keinen Namen, nur seine Nummer, und verbraucht nichts; der Fehler bleibt eine Meldung', () => {
  const error = { key: 'm_daemonFailed', args: ['kaputt'] };
  const runner = view({ base: null, state: SLOT.BROKEN, jobs: 1, error });
  assert.deepEqual([runner.name, runner.seat, runner.cores, runner.memory, runner.error], [null, 2, 0, 0, error]);
});

test('ein auslaufender Platz behält seinen Zustand und ist als auslaufend markiert, außer er ist schon aus', () => {
  assert.deepEqual([view({ state: SLOT.WORKING, retired: true, jobs: 0 }).state, view({ state: SLOT.WORKING, retired: true, jobs: 0 }).retiring], [SLOT.WORKING, true]);
  assert.equal(view({ state: SLOT.OFF, retired: true, jobs: 0 }).retiring, false);
});

test('ein arbeitender Platz zeigt seinen Job von GitHub, sonst was der Runner selbst weiß', () => {
  const slot = { base: 'rc-app-1', name: 'PC-linux-1', state: SLOT.WORKING, jobs: 0, job: 'Bauen', jobStartedAt: 'jetzt' };
  const known = { workflow: 'CI', job: 'Bauen', runner: 'PC-linux-1' };
  assert.equal(view(slot, [{ runner: 'anderer' }, known]).job, known);
  assert.deepEqual(view(slot).job, { workflow: '', job: 'Bauen', branch: '', startedAt: 'jetzt', url: `https://github.com/${REPO}/actions` });
});

// Alles drumherum nachgestellt, so knapp wie möglich.
function world() {
  const w = { ready: true, error: null, settings: { repo: REPO, parallel: 2, paused: false, cache: true, preload: ['node:22'] } };
  const pool = { repo: REPO, slots: [{ base: 'rc-app-1', name: 'PC-linux-1', state: SLOT.WORKING, jobs: 0, job: 'Bauen' }], reserve: [{ ready: true }, { ready: false }], hold: false, seeded: new Set(['b:1', 'a:1']), sizes: null };
  w.status = createStatus({
    settings: { config: { limits: { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' }, pools: [w.settings] }, limitsOf: () => ({ runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' }), settingsOf: (repo) => (repo === REPO ? w.settings : undefined) },
    runners: { pools: new Map([[REPO, pool]]), reserveSize: () => 2, staleCount: () => 0 },
    remote: { vetted: () => true, view: () => ({ jobs: [{ status: 'queued' }, { status: 'in_progress', runner: 'PC-linux-1', job: 'Bauen' }], runs: [{ id: 1 }], error: null }) },
    pipelines: { view: (repo, slots) => [{ slots }], lastOf: () => null, waitOf: () => null },
    metrics: { jobsView: () => [], series: () => [] },
    usage: { statsOf: () => undefined, view: () => ({ hostCpu: 1 }), vmTight: () => null },
    routing: { of: () => ({ here: true }) },
    waiting: { list: () => [{ repo: REPO, reason: 'runner' }, { repo: 'wer/ohne', reason: 'minutes' }] },
    account: { minutesView: () => null, authView: () => ({ state: 'in' }) },
    githubApi: { quota: () => null },
    dockerWatch: { ready: () => w.ready, error: () => w.error, cpus: () => 6, memory: () => 16 * GB },
    setup: { view: () => w.setup ?? null },
    buildService: (repo) => `rc-buildkit-${repo}`,
    logStamp: () => '1-2', uiFile: 'gibt-es-nicht.html', shutdown: () => w.shutdown ?? null, extra: () => ({ app: { autostart: true } }),
  });
  return w;
}

test('der Stand: je Repo mit Pool Plätze, Reserve, Einstellungen; Repos mit Pool zählen nicht als unbedient', () => {
  const w = world();
  const status = w.status.status();
  const [repo] = status.repos;
  assert.equal(repo.waiting, 1);
  assert.deepEqual(repo.pipelines, [{ slots: 2 }]);
  assert.deepEqual([repo.pool.reserve, repo.pool.reserveWanted, repo.pool.images, repo.pool.preload], [1, 2, ['a:1', 'b:1'], ['node:22']]);
  assert.deepEqual(repo.runners.map((runner) => [runner.name, runner.state, runner.job.job]), [['PC-linux-1', SLOT.WORKING, 'Bauen']]);
  assert.deepEqual(status.unserved, [{ repo: 'wer/ohne', reason: 'minutes' }]);
  assert.deepEqual(status.machine.docker, { ready: true, error: null, setup: null });
  assert.deepEqual([status.logStamp, status.ui, status.app, status.shutdown], ['1-2', 0, { autostart: true }, null]);
  w.shutdown = { startedAt: 'jetzt' }; // beim Beenden: der Stand aus shutdown.js
  assert.deepEqual(w.status.status().shutdown, { startedAt: 'jetzt' });

  w.settings.paused = true;
  assert.deepEqual(w.status.status().repos[0].pipelines, [{ slots: 0 }]); // ein pausierter Pool nimmt keine Jobs
  assert.deepEqual([repo.pool.blocked, repo.pool.checked], [null, true]);
  w.settings.pausedForks = true; // gesperrt (siehe blocks.js): die Oberfläche nennt den Grund
  assert.equal(w.status.status().repos[0].pool.blocked, 'forks');
});

test('Docker: bereit, mit Fehler oder noch am Starten', () => {
  const w = world();
  w.ready = false;
  assert.deepEqual(w.status.status().machine.docker, { ready: false, error: null, setup: null });
  w.error = 'Docker ist nicht erreichbar';
  w.setup = { missing: ['start'], app: true }; // was dem Rechner fehlt (siehe setup.js)
  assert.deepEqual(w.status.status().machine.docker, { ready: false, error: 'Docker ist nicht erreichbar', setup: { missing: ['start'], app: true } });
  w.ready = true; // bereit: Was die letzte Prüfung fand, gilt nicht mehr
  assert.equal(w.status.status().machine.docker.setup, null);
});
