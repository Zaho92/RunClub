const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemote, RERUN_SETTLE, WAITING_INTERVAL, REPO_LIST_MAX_AGE, CHECK_STALE, CHECK_RETRY } = require('../src/remote');
const { STATE: QUOTA, GitHubError } = require('../src/github');
const { BLOCKS } = require('../src/blocks');
const { turn, rendered } = require('./support');
const { render, reason } = require('../src/messages');

const REPO = 'owner/App';

// GitHub and the rest faked. `answers[path]` gives the answer to `get(path)` (a function may
// throw or return a promise); `calls` holds the paths read and those written as `send <method> <path>`
// in their order.
function world() {
  const w = {
    calls: [], logs: [], timers: [], guarded: [], time: 1000000, checked: [], scanned: null, stopping: false, may: () => true,
    settings: { [REPO]: { repo: REPO } }, pools: { [REPO]: { slots: [] } }, quota: null,
    answers: {}, pipelines: [], confirmed: [],
  };
  const answer = (path) => {
    const found = w.answers[path];
    return typeof found === 'function' ? found() : found;
  };
  w.remote = createRemote({
    github: {
      get: async (path) => { w.calls.push(path); return answer(path); },
      send: async (method, path) => { w.calls.push(`send ${method} ${path}`); return answer(path); },
      mayPoll: (...args) => w.may(...args), refreshQuota: async () => w.quota,
    },
    pipelines: { refresh: async () => w.pipelines, lastOf: () => w.last ?? null, finishedOf: () => w.finished ?? [] },
    confirmResults: (repo, done) => w.confirmed.push([repo, done]),
    routing: { check: async (repo) => { w.checked.push(repo); } },
    waiting: { scan: async (found) => { w.scanned = found; } },
    log: (...entry) => w.logs.push(rendered(entry)),
    logError: (repo, what) => (error) => w.logs.push([`${render(what)} – ${render(reason(error))}`, repo, 'error']),
    repos: () => Object.keys(w.settings), settingsOf: (repo) => w.settings[repo], poolOf: (repo) => w.pools[repo],
    stopping: () => w.stopping, timer: (work, ms) => w.timers.push({ work, ms }),
    now: () => w.time,
    // Like actions.js: blocking pauses and marks, lifting only removes the mark.
    guard: {
      block: async (repo, kind, reason) => { w.guarded.push(['block', kind, reason]); Object.assign(w.settings[repo], { paused: true, [BLOCKS[kind]]: true }); },
      unblock: (repo, kind) => { w.guarded.push(['unblock', kind]); delete w.settings[repo][BLOCKS[kind]]; },
      restUnchecked: (repo) => w.guarded.push(['rest', repo]),
    },
  });
  return w;
}

const RUN = { id: 5, name: 'CI', head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null, run_started_at: '2026-10-14T10:00:00Z', html_url: 'https://github.com/owner/App/actions/runs/5', display_title: 'New' };
const PIPELINE = { workflow: 'CI', branch: 'main', jobs: [
  { name: 'Build', status: 'in_progress', runner: 'PC-linux-1', own: true, startedAt: 'x', url: 'u', estimate: 60, step: null },
  { name: 'Check', status: 'pending' }, { name: 'Done', status: 'completed' },
] };

test('querying a repo: runs, running jobs, and the working slot learns its workflow', async () => {
  const w = world();
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = { workflow_runs: [RUN] };
  w.pipelines = [PIPELINE];
  w.pools[REPO].slots = [{ name: 'PC-linux-1', state: 'working', workflow: '' }];
  await w.remote.refreshRepo(REPO);
  const view = w.remote.view(REPO);
  assert.deepEqual(view.jobs, [{ workflow: 'CI', job: 'Build', branch: 'main', status: 'in_progress', runner: 'PC-linux-1', own: true, startedAt: 'x', url: 'u', estimate: 60, step: null }]);
  assert.deepEqual(view.runs, [{ id: 5, name: 'CI', branch: 'main', event: 'push', status: 'in_progress', conclusion: null, at: RUN.run_started_at, url: RUN.html_url, title: 'New' }]);
  assert.equal(view.error, null);
  assert.equal(w.pools[REPO].slots[0].workflow, 'CI');
  assert.equal(w.remote.view('owner/Other'), null);
});

test('finished jobs of our own runners go to the metrics with the result from GitHub, also from runs that just ended and the last finished run', async () => {
  const w = world();
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = { workflow_runs: [RUN] };
  w.pipelines = [{ ...PIPELINE, jobs: [
    { name: 'Build', status: 'completed', conclusion: 'failure', own: true, runner: 'PC-linux-1' },
    { name: 'Other', status: 'completed', conclusion: 'success', own: false, runner: 'GitHub Actions 3' },
    { name: 'Test', status: 'in_progress', conclusion: null, own: true, runner: 'PC-linux-2' },
  ] }];
  w.last = { ...PIPELINE, jobs: [{ name: 'Old', status: 'completed', conclusion: 'success', own: true, runner: 'PC-linux-0' }] };
  w.finished = [{ ...PIPELINE, jobs: [{ name: 'Recent', status: 'completed', conclusion: 'success', own: true, runner: 'PC-linux-3' }] }];
  await w.remote.refreshRepo(REPO);
  assert.deepEqual(w.confirmed, [[REPO, [{ runner: 'PC-linux-1', conclusion: 'failure' }, { runner: 'PC-linux-3', conclusion: 'success' }, { runner: 'PC-linux-0', conclusion: 'success' }]]]);
});

test('if the query fails, jobs and runs stay and the error is added', async () => {
  const w = world();
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = { workflow_runs: [RUN] };
  w.pipelines = [PIPELINE];
  await w.remote.refreshRepo(REPO);
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new GitHubError(502, 'Bad Gateway'); };
  await w.remote.refreshRepo(REPO);
  assert.equal(w.remote.view(REPO).error, 'Bad Gateway (HTTP 502)');
  assert.equal(w.remote.view(REPO).jobs.length, 1);
  const fresh = world();
  fresh.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new Error('no network'); };
  await fresh.remote.refreshRepo(REPO);
  assert.deepEqual(fresh.remote.view(REPO), { jobs: [], runs: [], error: 'no network', notFound: false });
  // 404: GitHub doesn't know the repo, or the GitHub App is not installed there.
  fresh.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new GitHubError(404, 'Not Found'); };
  await fresh.remote.refreshRepo(REPO);
  assert.equal(fresh.remote.view(REPO).notFound, true);
  assert.equal(w.remote.view(REPO).notFound, false);
});

test('if a query is already running, exactly one more follows; with a tight limit none', async () => {
  const w = world();
  let release;
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => new Promise((resolve) => { release = () => resolve({ workflow_runs: [] }); });
  const first = w.remote.refreshRepo(REPO);
  await turn();
  w.remote.refreshRepo(REPO);
  w.remote.refreshRepo(REPO);
  release();
  await first;
  await turn();
  release();
  await turn();
  assert.equal(w.calls.length, 2);

  const tight = world();
  tight.may = () => false;
  await tight.remote.refreshRepo(REPO);
  assert.deepEqual(tight.calls, []);
});

test('repos are queried more often where one of our slots works or a job waits for one of our runners', async () => {
  const w = world();
  w.settings = { 'owner/a': {}, 'owner/b': {}, 'owner/c': {} };
  w.pools = { 'owner/a': { slots: [{ state: 'working' }] }, 'owner/b': { slots: [{ state: 'ready' }] }, 'owner/c': { slots: [] } };
  w.answers['repos/owner/c/actions/runs?per_page=20'] = { workflow_runs: [RUN] };
  w.pipelines = [{ ...PIPELINE, jobs: [{ name: 'Build', status: 'queued', own: true }] }];
  await w.remote.refreshRepo('owner/c');
  w.calls.length = 0;
  w.answers['repos/owner/a/actions/runs?per_page=20'] = { workflow_runs: [] };
  w.remote.refreshActive();
  await turn();
  assert.deepEqual(w.calls.sort(), ['repos/owner/a/actions/runs?per_page=20', 'repos/owner/c/actions/runs?per_page=20']);
});

const AT_1705 = new Date(2026, 9, 13, 17, 5).toISOString(); // 17:05 in this machine's local time

test('the request limit: a message only when it flips; after running out CI_RUNNER is read again', async () => {
  const cases = [
    [{ paused: true, resetAt: AT_1705 }, 'GitHub asks for a pause (too many requests in a short time). No polling until 17:05.'],
    [{ state: QUOTA.OUT, remaining: 10, limit: 5000, resetAt: AT_1705 }, 'GitHub requests are used up (10 of 5,000 left). No polling until 17:05; the rest is kept for registering new runners.'],
    [{ state: QUOTA.TIGHT, remaining: 400, limit: 5000, resetAt: AT_1705 }, 'GitHub requests are getting tight (400 of 5,000 left). Polling less often until 17:05.'],
    [{ state: QUOTA.OK, before: QUOTA.TIGHT }, 'GitHub requests are available again; polling at the usual pace.'],
  ];
  for (const [changed, text] of cases) {
    const w = world();
    w.quota = changed;
    await w.remote.watchQuota();
    assert.deepEqual(w.logs, [[text]]);
  }
  const first = world();
  first.quota = { state: QUOTA.OK, before: QUOTA.UNKNOWN };
  await first.remote.watchQuota();
  assert.deepEqual(first.logs, []); // the first state after startup is not a change

  const back = world();
  back.quota = { state: QUOTA.OK, before: QUOTA.OUT };
  await back.remote.watchQuota();
  assert.deepEqual(back.checked, [REPO]);
});

test('the account repos: only with admin rights and not archived, page by page, cached for a while', async () => {
  const w = world();
  const repo = (name, more) => ({ full_name: name, private: true, pushed_at: 'p', permissions: { admin: true }, archived: false, ...more });
  w.answers['user/repos?per_page=100&page=1&sort=pushed'] = [...Array.from({ length: 98 }, (_, index) => repo(`owner/r${index}`)), repo('owner/foreign', { permissions: { admin: false } }), repo('owner/old', { archived: true })];
  w.answers['user/repos?per_page=100&page=2&sort=pushed'] = [repo(REPO), repo('owner/open', { private: false })];
  const found = await w.remote.listRepos();
  assert.equal(found.length, 100);
  assert.deepEqual(found.slice(-2), [
    { repo: REPO, private: true, pushedAt: 'p', pool: true, free: false },
    { repo: 'owner/open', private: false, pushedAt: 'p', pool: false, free: false },
  ]);
  await w.remote.listRepos();
  assert.equal(w.calls.length, 2);
  w.time += REPO_LIST_MAX_AGE + 1; // afterwards it reads again
  await w.remote.listRepos();
  assert.equal(w.calls.length, 4);
});

test('waiting runs: candidates from the list of repos; less often with a tight limit, not while shutting down', async () => {
  const w = world();
  w.answers['user/repos?per_page=100&page=1&sort=pushed'] = [];
  let asked = null;
  w.may = (key, every) => { asked = [key, every]; return true; };
  await w.remote.scanWaiting();
  assert.deepEqual(w.scanned, []);
  assert.deepEqual(asked, ['waiting runs', 3 * WAITING_INTERVAL]);
  w.stopping = true;
  w.scanned = null;
  await w.remote.scanWaiting();
  assert.equal(w.scanned, null);
});

test('a repo turned public blocks the pool, once; private again lifts the block', async () => {
  const w = world();
  w.answers[`repos/${REPO}`] = { private: false };
  await w.remote.watchVisibility(REPO);
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded, [['block', 'public', undefined]]);
  assert.equal(w.calls.some((path) => path.includes('fork-pr')), false); // public: forks don't count any more then
  w.settings[REPO].paused = false; // resumed by hand, past the block: gets reapplied
  await w.remote.watchVisibility(REPO);
  assert.equal(w.guarded.length, 2);
  w.answers[`repos/${REPO}`] = { private: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.at(-1), ['unblock', 'public']);
  await w.remote.watchVisibility('owner/noPool');
  assert.equal(w.calls.includes('repos/owner/noPool'), false);
});

test('an org repo where fork PRs may run blocks the pool; unreadable is a reason of its own that doesn\'t replace “allowed”', async () => {
  const w = world();
  const forks = `repos/${REPO}/actions/permissions/fork-pr-workflows-private-repos`;
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'Organization' } };
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.map(([what, kind]) => [what, kind]), [['block', 'forks']]);
  assert.match(render(w.guarded[0][2]), /fork pull requests/);
  w.answers[forks] = () => { throw new GitHubError(403, 'Forbidden'); }; // unreadable: “allowed” stays the reason
  await w.remote.watchVisibility(REPO);
  assert.equal(w.guarded.length, 1);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: false };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.at(-1), ['unblock', 'forks']);
  w.answers[forks] = () => { throw new GitHubError(502, 'Bad Gateway'); }; // without a known risk: a reason of its own
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.at(-1).slice(0, 2), ['block', 'forksUnknown']);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true }; // now read and allowed: the reason switches
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.slice(-2).map(([what, kind]) => [what, kind]), [['block', 'forks'], ['unblock', 'forksUnknown']]);
  delete w.settings[REPO].pausedForks;
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'User' } };
  const before = w.guarded.length;
  await w.remote.watchVisibility(REPO);
  assert.equal(w.guarded.length, before);
});

test('if a repo turns private again while fork PRs are allowed, it blocks first, then lifts', async () => {
  const w = world();
  Object.assign(w.settings[REPO], { paused: true, pausedPublic: true });
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'Organization' } };
  w.answers[`repos/${REPO}/actions/permissions/fork-pr-workflows-private-repos`] = { run_workflows_from_fork_pull_requests: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.map(([what, kind]) => [what, kind]), [['block', 'forks'], ['unblock', 'public']]);
});

test('a pool counts as checked only after a successful check and only for CHECK_STALE; if it fails, the pool rests and it checks again soon', async () => {
  const w = world();
  const fail = (error) => { w.answers[`repos/${REPO}`] = () => { throw error; }; };
  const succeed = () => { w.answers[`repos/${REPO}`] = { private: true }; };
  const retries = () => w.timers.filter(({ ms }) => ms === CHECK_RETRY);
  assert.equal(w.remote.vetted(REPO), false); // at startup: no check yet
  fail(new Error('no network'));
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded, [['rest', REPO]]);
  assert.deepEqual(w.logs.map(([text, , kind]) => [text.slice(0, 15), kind]), [['Repo visibility', 'error'], ['Could not check', 'error']]);
  assert.equal(retries().length, 1);
  await w.remote.watchVisibility(REPO); // e.g. housekeeping in between: no message, no second attempt
  assert.deepEqual([w.guarded.length, w.logs.length, retries().length], [1, 2, 1]);
  succeed();
  w.timers.splice(w.timers.indexOf(retries()[0]), 1).at(0).work();
  await turn();
  assert.equal(w.remote.vetted(REPO), true);
  assert.equal(w.logs.at(-1)[0], 'The check worked again; the pool accepts jobs again.');
  const expiry = w.timers.find(({ ms }) => ms === CHECK_STALE);
  assert.ok(expiry);
  // Later it fails: it retries right away, the pool keeps working as long as the last one is fresh.
  fail(new GitHubError(502, 'Bad Gateway'));
  w.time += CHECK_STALE - 1;
  await w.remote.watchVisibility(REPO);
  assert.deepEqual([w.remote.vetted(REPO), w.guarded.length, retries().length], [true, 1, 1]);
  assert.equal(w.logs.at(-1)[0], 'Repo visibility – Bad Gateway (HTTP 502)');
  // When it expires, the pool rests at once, without waiting for the next attempt.
  w.time += 1;
  expiry.work();
  assert.deepEqual(w.guarded, [['rest', REPO], ['rest', REPO]]);
  // An older expiry after a newer successful check does nothing.
  succeed();
  await w.remote.watchVisibility(REPO);
  expiry.work();
  assert.equal(w.guarded.length, 2);
  // A pool just created is checked; a removed one is forgotten.
  w.remote.markChecked('owner/New');
  assert.equal(w.remote.vetted('owner/New'), true);
  w.remote.forget('owner/New');
  assert.equal(w.remote.vetted('owner/New'), false);
});

test('re-run: only for repos with a pool and with an id of digits; afterwards the repo is queried again', async () => {
  const w = world();
  await w.remote.rerun(REPO, 77, 'runs/77/rerun', 'does not exist');
  assert.deepEqual(w.calls, [`send POST repos/${REPO}/actions/runs/77/rerun`]);
  assert.deepEqual(w.timers.map((entry) => entry.ms), [RERUN_SETTLE]);
  await assert.rejects(w.remote.rerun('owner/Other', 1, 'runs/1/rerun', 'does not exist'), { message: 'does not exist' });
  await assert.rejects(w.remote.rerun(REPO, '1/../../x', 'runs/1/rerun', 'does not exist'), { message: 'does not exist' });
  assert.equal(w.calls.length, 1);
});
