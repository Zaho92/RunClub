const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunners } = require('../src/runners');
const { createNames, DEFAULT_PORT } = require('../src/names');
const { turn } = require('./support');
const { GitHubError } = require('../src/github');

const REPO = 'who/App';
const LIMITS = { runnerCpus: 2, runnerMemory: '2g', dockerCpus: 2, dockerMemory: '2g' };

// Docker and GitHub simulated: `calls` keeps the calls in short form, `githubFails(path)` makes a GitHub call fail.
function world() {
  const w = { calls: [], ready: true, githubFails: () => null, settings: { repo: REPO, parallel: 1, cache: false, paused: false } };
  w.runners = createRunners({
    docker: async (args) => { w.calls.push(args.slice(0, 2).join(' ')); return { code: 0, stdout: args[0] === 'image' ? 'sha256:runner' : '', stderr: '' }; },
    dockerList: async (args) => { w.calls.push(`list ${args.slice(0, 2).join(' ')}`); return []; },
    github: { send: async (method, url) => { w.calls.push(`send ${method} ${url}`); const fail = w.githubFails(url); if (fail) throw fail; return null; } },
    log: () => {}, sleep: turn, timer: () => {}, newId: () => 'a1',
    host: 'PC', names: createNames({ dataDir: 'C:/Data', port: DEFAULT_PORT }), image: 'runner:test', dind: 'dind:test', buildkit: 'buildkit:test', longTimeout: 1,
    settings: { settingsOf: () => w.settings, limitsOf: () => LIMITS, state: { learned: {}, rejected: {} }, saveState: () => {} },
    metrics: {}, stopping: () => false, dockerReady: () => w.ready, vetted: () => true, refreshRepo: () => {}, forgetStats: () => {},
  });
  w.pool = { repo: REPO, slots: [], reserve: [], leaving: 0, hold: false, prepared: true, removed: false, seeded: new Set(), sizes: null };
  w.runners.pools.set(REPO, w.pool);
  return w;
}

test('the minute timer refills the reserve', async () => {
  const w = world();
  w.runners.tick();
  assert.equal(w.pool.reserve.length, 1);
  await turn();
  assert.ok(w.calls.includes('network create'));
});

test('the minute timer renews a build service with old limits', async () => {
  const w = world();
  w.settings.cache = true;
  w.pool.serviceBuilt = 'old limits';
  w.runners.tick();
  assert.equal(w.pool.renewingService, true);
  await turn();
  assert.ok(w.calls.includes('volume create')); // the package cache, then the build service
});

test('measuring only happens when Docker is ready, and not for a resting pool', async () => {
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

test('on Windows sign-out the idle runners are removed from GitHub; errors hold nothing up', async () => {
  const w = world();
  w.pool.slots = [{ repo: REPO, runnerId: 7, job: null }, { repo: REPO, runnerId: 8, job: 'Build' }, { repo: REPO, runnerId: 9, job: null }];
  w.githubFails = (url) => (url.endsWith('/7') ? new GitHubError(500, 'Server Error') : null);
  await w.runners.releaseIdle();
  assert.deepEqual(w.calls, [`send DELETE repos/${REPO}/actions/runners/7`, `send DELETE repos/${REPO}/actions/runners/9`]);
});
