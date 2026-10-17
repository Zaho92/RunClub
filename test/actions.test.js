const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActions } = require('../src/actions');
const { createSettings, PARALLEL_MAX } = require('../src/settings');
const limitRules = require('../src/limits');
const { GB } = require('../src/units');
const { errorLog } = require('../src/journal');
const { GitHubError } = require('../src/github');
const { turn, until, rendered } = require('./support');

const REPO = 'owner/App';

// Everything around the calls faked; the settings are real (in an empty folder). `calls` holds in
// short form what the calls trigger.
function world({ pools: repos = [REPO] } = {}) {
  const w = { calls: [], logs: [], timers: [], ready: true, info: {}, answers: {}, routingState: { uses: 'variable', here: false, error: null }, plan: null, stale: 1 };
  w.settings = createSettings({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-actions-')), log: () => {} });
  w.pools = new Map();
  for (const repo of repos) {
    w.settings.addPool(repo, 2);
    w.pools.set(repo, { repo, slots: [{ name: 'idle' }], reserve: [], removed: false });
  }
  const call = (name) => async (...args) => { w.calls.push([name, ...args.filter((arg) => typeof arg !== 'object' && typeof arg !== 'function')].join(' ')); };
  const runners = {
    pools: w.pools,
    slots: { abortIdle: (slot) => w.calls.push(`abortIdle ${slot.name}`) },
    discardReserve: async (pool) => w.calls.push(`discardReserve ${pool.repo}`),
    reconcile: (pool) => w.calls.push(`reconcile ${pool.repo}`),
    startPool: (repo) => w.calls.push(`startPool ${repo}`),
    withPoolAtRest: async (pool, work) => { w.calls.push(`atRest ${pool.repo}`); return work(); },
    renewReserve: (pool) => w.calls.push(`renewReserve ${pool.repo}`),
    staleCount: () => w.stale,
    rebuildIdle: async (pool) => w.calls.push(`rebuildIdle ${pool.repo}`),
    caches: { removeCaches: async (repo, parts) => { w.calls.push(`removeCaches ${repo} ${Object.keys(parts).filter((key) => parts[key]).join('+')}`); if (w.cachesFail) throw new Error(w.cachesFail); }, prepareCaches: call('prepareCaches'), measureSizes: async (pool) => w.calls.push(`measureSizes ${pool.repo}`) },
    seed: { forget: call('forgetSeed'), refreshSeed: call('refreshSeed') },
  };
  const { actions, guard } = createActions({
    github: { get: async (url) => { w.calls.push(`get ${url}`); const answer = w.answers[url]; return answer === undefined ? w.info : typeof answer === 'function' ? answer() : answer; } },
    settings: w.settings, runners,
    remote: { refreshAll: call('refreshAll'), markChecked: (repo) => w.calls.push(`markChecked ${repo}`), forget: (repo) => w.calls.push(`remote.forget ${repo}`), rerun: call('rerun') },
    routing: { check: async (repo) => { w.calls.push(`routing.check ${repo}`); return w.routingState; }, set: async (repo, on) => { w.calls.push(`routing.set ${repo} ${on}`); }, forget: (repo) => w.calls.push(`routing.forget ${repo}`) },
    waiting: { forget: (repo) => w.calls.push(`waiting.forget ${repo}`) },
    metrics: { forget: (repo) => w.calls.push(`metrics.forget ${repo}`) },
    account: { login: call('login'), cancel: call('cancel'), logout: call('logout') },
    dockerWatch: { ready: () => w.ready, removeRegistrations: call('removeRegistrations') },
    limitRange: () => limitRules.bounds({ dockerMemory: 16 * GB, dockerCpus: 8 }),
    limitPlan: () => w.plan,
    log: (...entry) => w.logs.push(rendered(entry)),
    logError: errorLog((...entry) => w.logs.push(rendered(entry))),
    shutdown: () => w.calls.push('shutdown'),
    timer: (work, ms) => w.timers.push({ work, ms }),
  });
  Object.assign(w, { actions, guard });
  return w;
}

test('pool/add checks name, admin right, duplicate, name clash and visibility before anything is created', async () => {
  const w = world({ pools: ['owner/Tool'] });
  const add = (repo, info) => { w.info = info; return w.actions['pool/add']({ repo, parallel: 1 }); };
  const own = { full_name: 'owner/New', permissions: { admin: true }, private: true };
  await assert.rejects(add('--help', own), { message: 'Give the repo as owner/name.' });
  await assert.rejects(add('owner/New', { ...own, permissions: { admin: false } }), /admin rights/);
  await assert.rejects(add('OWNER/tool', { ...own, full_name: 'owner/Tool' }), { message: 'This repo already has a pool.' });
  await assert.rejects(add('other/tool', { ...own, full_name: 'other/tool' }), { message: 'A pool for owner/Tool uses the same name for caches and build service. Two repos with the same name cannot be served at once.' });
  await assert.rejects(add('owner/New', { ...own, private: false }), /public/);
  w.pools.get('owner/Tool').removed = true;
  w.settings.removePool('owner/Tool');
  await assert.rejects(add('owner/tool', { ...own, full_name: 'owner/Tool' }), { message: 'This pool is being removed. Please wait until that is done.' });
  assert.deepEqual(w.settings.repos(), []);
  assert.equal(w.calls.some((name) => name.startsWith('startPool')), false);
});

test('pool/add creates the repo as GitHub writes it, starts the pool and routes the jobs if the workflows read the variable', async () => {
  const w = world({ pools: [] });
  w.info = { full_name: 'Owner/New', permissions: { admin: true }, private: true };
  await w.actions['pool/add']({ repo: 'owner/new', parallel: 99 });
  await until(() => w.calls.includes('routing.set Owner/New true'));
  assert.deepEqual(w.settings.config.pools, [{ repo: 'Owner/New', parallel: PARALLEL_MAX, cache: true, paused: false, preload: [] }]);
  assert.deepEqual(w.calls.slice(0, 6), ['get repos/owner/new', 'waiting.forget Owner/New', 'markChecked Owner/New', 'startPool Owner/New', 'refreshAll', 'routing.check Owner/New']);
  assert.deepEqual(w.logs.map(([text]) => text), ['Pool created', 'CI_RUNNER set – jobs run on your own runners']);
});

test('pool/set: slots capped, pausing ends idle pairs and the reserve, a changed cache is provided at rest', async () => {
  const w = world();
  await w.actions['pool/set']({ repo: REPO, parallel: '3', paused: true, cache: false });
  await turn();
  assert.deepEqual(w.settings.settingsOf(REPO), { repo: REPO, parallel: 3, cache: false, paused: true, preload: [] });
  assert.deepEqual(w.calls, ['abortIdle idle', `discardReserve ${REPO}`, `reconcile ${REPO}`, `atRest ${REPO}`, `prepareCaches ${REPO}`]);
  assert.deepEqual(w.logs, [['3 slots, paused, cache off', REPO]]);
  await assert.rejects(w.actions['pool/set']({ repo: 'owner/Unknown', parallel: 1 }), { message: 'There is no such pool.' });
});

test('a repo that became public: neither resume nor route jobs until it is private again', async () => {
  const w = world();
  Object.assign(w.settings.settingsOf(REPO), { paused: true, pausedPublic: true });
  await assert.rejects(w.actions['pool/set']({ repo: REPO, paused: false, parallel: 4 }), /public/);
  assert.deepEqual([w.settings.settingsOf(REPO).paused, w.settings.settingsOf(REPO).parallel], [true, 2]);
  await assert.rejects(w.actions['pool/routing']({ repo: REPO, on: true }), /public/);
  await w.actions['pool/routing']({ repo: REPO, on: false }); // back to GitHub always works
  for (const paused of [0, '', null]) await assert.rejects(w.actions['pool/set']({ repo: REPO, paused }), /public/); // any falsy value would resume
  w.guard.unblock(REPO, 'public');
  assert.equal(w.settings.settingsOf(REPO).pausedPublic, undefined);
  assert.equal(w.logs.at(-1)[0], 'The repo is private again; the pool can be resumed.');
  await w.actions['pool/set']({ repo: REPO, paused: false });
  assert.equal(w.settings.settingsOf(REPO).paused, false);
});

test('fork PRs in an org repo: pool paused, loud in the log; neither resume nor route until they are switched off', async () => {
  const w = world();
  await w.guard.block(REPO, 'forks', 'Workflows from forks may run');
  assert.deepEqual([w.settings.settingsOf(REPO).paused, w.settings.settingsOf(REPO).pausedForks], [true, true]);
  assert.deepEqual(w.calls, ['abortIdle idle', `discardReserve ${REPO}`, `routing.set ${REPO} false`]);
  assert.match(w.logs[0][0], /^Workflows from forks may run. /);
  assert.equal(w.logs[0][2], 'error');
  await assert.rejects(w.actions['pool/set']({ repo: REPO, paused: false }), /forks/);
  await assert.rejects(w.actions['pool/routing']({ repo: REPO, on: true }), /forks/);
  w.guard.unblock(REPO, 'forks');
  assert.equal(w.settings.settingsOf(REPO).pausedForks, undefined);
  await w.actions['pool/set']({ repo: REPO, paused: false });
  assert.equal(w.settings.settingsOf(REPO).paused, false);
  w.calls.length = 0;
  w.pools.get(REPO).removed = true;
  await w.guard.block(REPO, 'forks', 'x');
  assert.deepEqual(w.calls, []);
});

test('if one reason goes away while the other applies, the pool stays blocked, and the log says why', async () => {
  const w = world();
  await w.guard.block(REPO, 'public');
  await w.guard.block(REPO, 'forks', 'Workflows from forks may run');
  w.guard.unblock(REPO, 'public');
  assert.match(w.logs.at(-1)[0], /^The repo is private again; the pool stays blocked: Pull requests from forks/);
  await assert.rejects(w.actions['pool/set']({ repo: REPO, paused: false }), /forks/);
  w.guard.unblock(REPO, 'forks');
  assert.equal(w.logs.at(-1)[0], 'Workflows from forks no longer run in this repo; the pool can be resumed.');
});

test('a pool whose repo cannot be checked rests: idle pairs and reserve go; removed ones stay untouched', async () => {
  const w = world();
  w.guard.restUnchecked(REPO);
  assert.deepEqual(w.calls, ['abortIdle idle', `discardReserve ${REPO}`]);
  w.calls.length = 0;
  w.pools.get(REPO).removed = true;
  w.guard.restUnchecked(REPO);
  w.guard.restUnchecked('owner/Unknown');
  assert.deepEqual(w.calls, []);
});

test('pool/add refuses an org repo in which fork PRs may run or that cannot be read', async () => {
  const w = world({ pools: [] });
  const forks = 'repos/company/App/actions/permissions/fork-pr-workflows-private-repos';
  w.info = { full_name: 'company/App', private: true, permissions: { admin: true }, owner: { type: 'Organization' } };
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true, require_approval_for_fork_pr_workflows: true };
  await assert.rejects(w.actions['pool/add']({ repo: 'company/App', parallel: 1 }), /fork pull requests/);
  w.answers[forks] = () => { throw new GitHubError(403, 'Forbidden'); };
  await assert.rejects(w.actions['pool/add']({ repo: 'company/App', parallel: 1 }), /Forbidden \(HTTP 403\)/);
  assert.deepEqual(w.settings.repos(), []);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: false };
  await w.actions['pool/add']({ repo: 'company/App', parallel: 1 });
  assert.deepEqual(w.settings.repos(), ['company/App']);
});

test('pool/remove: out of the settings at once; then caches, template, variable, registrations, what was learned; then the name is free', async () => {
  const w = world();
  w.routingState = { here: true, error: null };
  const pool = w.pools.get(REPO);
  await w.actions['pool/remove']({ repo: REPO });
  assert.equal(pool.removed, true);
  assert.deepEqual(w.settings.repos(), []);
  await until(() => !w.pools.has(REPO));
  assert.deepEqual(w.calls, [`atRest ${REPO}`, `removeCaches ${REPO} packages+build`, `forgetSeed ${REPO}`, `routing.check ${REPO}`, `routing.set ${REPO} false`, `routing.forget ${REPO}`, `removeRegistrations ${REPO}`, `metrics.forget ${REPO}`, `remote.forget ${REPO}`]);
  assert.deepEqual(w.logs.map(([text]) => text), ['Removing pool', 'CI_RUNNER removed – jobs go back to GitHub’s runners', 'Pool and its caches are removed']);
});

test('pool/remove: what could not be deleted is in the log; if the variable cannot be read, it stays', async () => {
  const w = world();
  w.cachesFail = 'Caches could not be deleted – volume is in use';
  w.routingState = { error: 'HTTP 502' };
  await w.actions['pool/remove']({ repo: REPO });
  await until(() => !w.pools.has(REPO));
  assert.deepEqual(w.logs.slice(1), [
    ['CI_RUNNER stays as it is – HTTP 502', REPO, 'error'],
    ['Pool removed, but not everything: Caches could not be deleted – volume is in use', REPO, 'error'],
  ]);
  assert.equal(w.calls.includes(`routing.set ${REPO} false`), false);
});

test('pool/clear: only known caches; cleared at rest, then provided anew and measured', async () => {
  const w = world();
  await assert.rejects(w.actions['pool/clear']({ repo: REPO, what: 'constructor' }), { message: 'Unknown cache.' });
  await w.actions['pool/clear']({ repo: REPO, what: 'images' });
  await until(() => w.logs.length === 2);
  assert.deepEqual(w.calls, [`atRest ${REPO}`, `removeCaches ${REPO} `, `forgetSeed ${REPO}`, `prepareCaches ${REPO}`, `refreshSeed ${REPO}`, `measureSizes ${REPO}`]);
  assert.deepEqual(w.logs.map(([text]) => text), ['Clearing the learned images …', 'Cleared; the next run fills it again']);
  // If deleting fails, it is in the log, and caches, build service and template are ready again anyway.
  w.calls.length = 0;
  w.logs.length = 0;
  w.cachesFail = 'Caches could not be deleted – volume is in use';
  await w.actions['pool/clear']({ repo: REPO, what: 'build' });
  await until(() => w.logs.length === 2);
  assert.deepEqual(w.calls.slice(-3), [`prepareCaches ${REPO}`, `refreshSeed ${REPO}`, `measureSizes ${REPO}`]);
  assert.deepEqual(w.logs[1], [w.cachesFail, REPO, 'error']);
  w.cachesFail = null;
  w.calls.length = 0;
  await w.actions['pool/clear']({ repo: REPO, what: 'all' });
  await until(() => w.calls.includes(`measureSizes ${REPO}`));
  assert.equal(w.calls[1], `removeCaches ${REPO} packages+build`);
});

test('limits can only be set once Docker is ready; afterwards the reserve of all pools renews', async () => {
  const w = world();
  w.ready = false;
  await assert.rejects(w.actions['limits/set']({ runnerMemory: 2 }), /Docker is not ready yet/);
  await assert.rejects(w.actions['limits/plan'](), /Docker is not ready yet/);
  w.ready = true;
  await assert.rejects(w.actions['limits/plan'](), { message: 'There are not enough measurements for a suggestion yet.' });
  await assert.rejects(w.actions['limits/set']({ repo: 'owner/Unknown', runnerMemory: 2 }), { message: 'There is no such pool.' });
  await w.actions['limits/set']({ repo: REPO, runnerMemory: 2 });
  assert.equal(w.settings.settingsOf(REPO).limits.runnerMemory, '2g');
  await w.actions['limits/set']({ repo: REPO, inherit: true });
  assert.equal(w.settings.settingsOf(REPO).limits, undefined);
  assert.deepEqual(w.calls, [`renewReserve ${REPO}`, `renewReserve ${REPO}`]);
});

test('pool/rebuild only rebuilds pools with outdated pairs, none that are being removed', async () => {
  const w = world({ pools: [REPO, 'owner/Two'] });
  w.pools.get('owner/Two').removed = true;
  await w.actions['pool/rebuild']({});
  assert.deepEqual(w.calls, [`rebuildIdle ${REPO}`]);
  w.stale = 0;
  await w.actions['pool/rebuild']({ repo: REPO });
  assert.equal(w.calls.length, 1);
  await assert.rejects(w.actions['pool/rebuild']({ repo: 'owner/Unknown' }), { message: 'There is no such pool.' });
});

test('shutdown replies first and then shuts down', async () => {
  const w = world();
  await w.actions.shutdown();
  assert.deepEqual(w.calls, []);
  w.timers[0].work();
  assert.deepEqual(w.calls, ['shutdown']);
});

test('a repo that became public: pool paused, idle pairs and reserve gone, variable removed, loud in the log', async () => {
  const w = world();
  await w.guard.block(REPO, 'public');
  assert.deepEqual([w.settings.settingsOf(REPO).paused, w.settings.settingsOf(REPO).pausedPublic], [true, true]);
  assert.deepEqual(w.calls, ['abortIdle idle', `discardReserve ${REPO}`, `routing.set ${REPO} false`]);
  assert.equal(w.logs[0][2], 'error');
  w.calls.length = 0;
  w.pools.get(REPO).removed = true;
  await w.guard.block(REPO, 'public');
  assert.deepEqual(w.calls, []);
});
