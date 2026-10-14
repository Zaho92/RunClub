const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunners } = require('../src/runners');
const { createNames, DEFAULT_PORT } = require('../src/names');
const { turn } = require('./support');

const REPO = 'wer/App';
const LIMITS = { runnerCpus: 2, runnerMemory: '2g', dockerCpus: 2, dockerMemory: '2g' };

// Docker und GitHub nachgestellt: `calls` hält die Aufrufe in Kurzform, `ghFails(path)` lässt einen GitHub-Aufruf scheitern.
function world() {
  const w = { calls: [], ready: true, ghFails: () => null };
  w.runners = createRunners({
    docker: async (args) => { w.calls.push(args.slice(0, 2).join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    dockerList: async (args) => { w.calls.push(`list ${args.slice(0, 2).join(' ')}`); return []; },
    gh: async (args) => { const at = args.at(-1); w.calls.push(`gh ${args[2]} ${at}`); const fail = w.ghFails(at); if (fail) throw new Error(fail); return null; },
    log: () => {}, sleep: turn, timer: () => {}, newId: () => 'a1',
    host: 'PC', names: createNames({ dataDir: 'C:/Daten', port: DEFAULT_PORT }), image: 'runner:test', dind: 'dind:test', buildkit: 'buildkit:test', longTimeout: 1,
    settings: { settingsOf: () => ({ repo: REPO, parallel: 1, cache: false, paused: false }), limitsOf: () => LIMITS, state: { learned: {}, rejected: {} }, saveState: () => {} },
    metrics: {}, stopping: () => false, dockerReady: () => w.ready, refreshRepo: () => {}, forgetStats: () => {},
  });
  w.pool = { repo: REPO, slots: [], reserve: [], leaving: 0, hold: false, prepared: true, removed: false, seeded: new Set(), sizes: null };
  w.runners.pools.set(REPO, w.pool);
  return w;
}

test('der Minutentakt füllt die Reserve nach', async () => {
  const w = world();
  w.runners.tick();
  assert.equal(w.pool.reserve.length, 1);
  await turn();
  assert.ok(w.calls.includes('network create'));
});

test('gemessen wird nur, wenn Docker bereit ist, und kein ruhender Pool', async () => {
  const w = world();
  w.ready = false;
  w.runners.measureAll();
  w.ready = true;
  w.pool.hold = true;
  w.runners.measureAll();
  assert.deepEqual(w.calls, []);
  w.pool.hold = false;
  w.runners.measureAll();
  await turn();
  assert.deepEqual(w.calls, ['list volume ls']);
});

test('beim Abmelden von Windows gehen die freien Runner bei GitHub; Fehler halten nichts auf', async () => {
  const w = world();
  w.pool.slots = [{ repo: REPO, runnerId: 7, job: null }, { repo: REPO, runnerId: 8, job: 'Bauen' }, { repo: REPO, runnerId: 9, job: null }];
  w.ghFails = (path) => (path.endsWith('/7') ? 'HTTP 500' : null);
  await w.runners.releaseIdle();
  assert.deepEqual(w.calls, [`gh DELETE repos/${REPO}/actions/runners/7`, `gh DELETE repos/${REPO}/actions/runners/9`]);
});
