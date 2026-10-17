// What RunClub asks GitHub: runs and jobs of the repos with a pool (for the network map and the slots), the
// rate limit, the account's repos, waiting runs in repos without a pool, the visibility of the repos with a pool and
// whether pull requests from forks may run there. Plus re-running a run or job.
//
// Per repo the latest state is available (`view`): { jobs, runs, error, notFound (GitHub answered 404) }. A query that fails keeps jobs and
// runs of the previous state and only carries the error.

const { MINUTE, SECOND } = require('./units');
const { STATE: QUOTA, PAGE_MAX } = require('./github');
const { candidates } = require('./waiting');
const { noteWorkflows } = require('./slots');
const { SLOT } = require('./states');
const { forkExposure } = require('./forks');
const { BLOCKS } = require('./blocks');
const { msg, Fault, reason } = require('./messages');

const RUNS_PER_REPO = 20;
const REPO_LIST_MAX_AGE = 5 * MINUTE; // the list of the account's repos holds this long
const EMPTY_LIST_MAX_AGE = 15 * SECOND; // … and an empty one this long: right after installing the app it should fill up
const REPO_PAGES_MAX = 10;
const RERUN_SETTLE = 3 * SECOND; // roughly how long GitHub takes until a rerun shows as running again
const WAITING_INTERVAL = 5 * MINUTE; // how often to look for waiting runs without a pool (timer in backend.js)
const CHECK_STALE = 25 * MINUTE; // a successful check holds this long; housekeeping checks every 10 minutes (backend.js)
const CHECK_RETRY = MINUTE; // how soon to check again while a pool rests because the check fails

//   github                  access to GitHub (see github.js): `get`, `send`, `mayPoll(key, every)`, `refreshQuota()`
//   pipelines, routing, waiting   see pipeline.js, routing.js, waiting.js
//   log(text, repo, kind), logError(repo, what)   see journal.js
//   repos(), settingsOf(repo)     the repos with a pool and their settings (see settings.js)
//   poolOf(repo)            the standing pool or undefined
//   stopping(), timer (like `setTimeout`)
//   guard                   `block(repo, kind, reason)`, `unblock(repo, kind)`, `restUnchecked(repo)` (see actions.js, blocks.js)
//   confirmResults(repo, done)   results of finished jobs of our own runners, as GitHub reports them (see metrics.js)
function createRemote({
  github, pipelines, routing, waiting, log, logError,
  repos, settingsOf, poolOf, stopping, timer = setTimeout, now = Date.now, guard, confirmResults = () => {},
}) {
  const states = new Map(); // repo -> { jobs, runs, error, notFound }
  const busy = new Set(); // repos whose query is running right now
  const again = new Set(); // … and which are due once more afterwards
  const checkedAt = new Map(); // repo -> time of the last successful check (see `checkVisibility`)
  const unchecked = new Set(); // repos whose pool rests because there is no fresh check
  const failing = new Set(); // repos whose last check failed (already in the log)
  const retrying = new Set(); // … and for which a new check is pending

  // Query one repo. If a query is already running, exactly one more follows afterwards.
  async function refreshRepo(repo) {
    if (busy.has(repo)) { again.add(repo); return; }
    if (!github.mayPoll(repo)) return; // the rate limit is tight or used up (see github.js)
    busy.add(repo);
    try {
      const runs = (await github.get(`repos/${repo}/actions/runs?per_page=${RUNS_PER_REPO}`)).workflow_runs;
      const active = await pipelines.refresh(repo, runs);
      const jobs = active.flatMap((pipeline) => pipeline.jobs
        .filter((job) => job.status !== 'completed' && job.status !== 'pending')
        .map((job) => ({ workflow: pipeline.workflow, job: job.name, branch: pipeline.branch, status: job.status, runner: job.runner, own: job.own, startedAt: job.startedAt, url: job.url, estimate: job.estimate, step: job.step })));
      states.set(repo, {
        jobs, error: null, notFound: false,
        runs: runs.map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at ?? r.created_at, url: r.html_url, title: r.display_title })),
      });
      noteWorkflows(poolOf(repo), jobs);
      // Finished jobs of our own runners, also from runs that just ended and the last finished run: their result at
      // GitHub counts (see metrics.js).
      const done = [...active, ...pipelines.finishedOf(repo), pipelines.lastOf(repo)].filter(Boolean).flatMap((pipeline) => pipeline.jobs)
        .filter((job) => job.status === 'completed' && job.own && job.runner).map((job) => ({ runner: job.runner, conclusion: job.conclusion }));
      if (done.length) confirmResults(repo, done);
    } catch (error) {
      // 404: GitHub doesn't know the repo, or the GitHub App is not installed for its account.
      states.set(repo, { ...(states.get(repo) ?? { jobs: [], runs: [] }), error: reason(error), notFound: error?.status === 404 });
    } finally {
      busy.delete(repo);
      if (again.delete(repo) && !stopping()) refreshRepo(repo);
    }
  }

  // All repos one after another – the calm pace.
  async function refreshAll() {
    for (const repo of repos()) await refreshRepo(repo);
  }

  // Look more often where something is running on our own runners or waiting for them: there the state changes every
  // second. Jobs on GitHub's runners are fine with the calm pace.
  function refreshActive() {
    for (const repo of repos()) {
      const working = poolOf(repo)?.slots.some((slot) => slot.state === SLOT.WORKING);
      if (working || states.get(repo)?.jobs.some((job) => job.own)) refreshRepo(repo);
    }
  }

  // Fetch the state of the rate limit and write it to the log when it flips.
  async function checkQuota() {
    const changed = await github.refreshQuota();
    if (!changed) return;
    const until = { time: changed.resetAt };
    if (changed.paused) log(msg('m_quotaPaused', until));
    else if (changed.state === QUOTA.OUT) log(msg('m_quotaOut', changed.remaining, changed.limit, until));
    else if (changed.state === QUOTA.TIGHT) log(msg('m_quotaTight', changed.remaining, changed.limit, until));
    else if (changed.before !== QUOTA.UNKNOWN) log(msg('m_quotaFree'));
    // As long as nothing could be read, the state of CI_RUNNER stayed unknown too: catch up now.
    if (changed.before === QUOTA.OUT) for (const repo of repos()) routing.check(repo).catch(() => {});
  }
  const watchQuota = () => checkQuota().catch(logError(null, msg('m_whatQuota')));

  // Repos for which runners can be registered (admin permission), most recently pushed first. `free`: a pool is
  // possible for the repo (it has none, and public ones don't get one; see `pool/add` in actions.js).
  let repoList = { at: 0, repos: [] };
  async function listRepos() {
    if (now() - repoList.at > (repoList.repos.length ? REPO_LIST_MAX_AGE : EMPTY_LIST_MAX_AGE)) {
      const found = [];
      for (let page = 1; page <= REPO_PAGES_MAX; page += 1) {
        const batch = await github.get(`user/repos?per_page=${PAGE_MAX}&page=${page}&sort=pushed`);
        found.push(...batch.filter((r) => r.permissions?.admin && !r.archived).map((r) => ({ repo: r.full_name, private: r.private, pushedAt: r.pushed_at })));
        if (batch.length < PAGE_MAX) break;
      }
      repoList = { at: now(), repos: found };
    }
    return repoList.repos.map((r) => { const pool = Boolean(settingsOf(r.repo)); return { ...r, pool, free: !pool && r.private !== false }; });
  }

  // Look for runs that have no pool and therefore wait for a self-hosted runner or failed on GitHub's used-up
  // quota (see waiting.js). With a tight limit only every third round.
  // If the list of repos can't be read, the last state stays.
  function scanWaiting() {
    if (stopping() || !github.mayPoll('waiting runs', 3 * WAITING_INTERVAL)) return Promise.resolve();
    return listRepos().then((found) => waiting.scan(candidates(found))).catch(() => {});
  }

  // Pools exist only for private repos, and in an organization's repos only as long as workflows from pull requests
  // of forks may not run there (see forks.js). If that changes later, `guard.block` blocks the pool (see
  // blocks.js); only a successful check that finds the reason gone lifts the block (`guard.unblock`).
  // An existing block is reapplied if the pool is not paused despite it.
  //
  // A pool works only as long as the last successful check is at most CHECK_STALE old (`vetted`, see
  // pools.js): at startup only after the first one. After each failure it checks again after CHECK_RETRY. When the
  // last successful one expires, the pool rests at once (`expire`): free, already registered pairs leave instead of
  // accepting jobs until their slot's next round. An outage is logged once, not on every attempt.
  async function checkVisibility(repo) {
    const own = settingsOf(repo);
    if (!own) return;
    const info = await github.get(`repos/${repo}`);
    if (info.private === false) {
      if (!own.pausedPublic || !own.paused) await guard.block(repo, 'public');
    } else {
      // For forks at most one block applies: allowed or unreadable. Unreadable doesn't change “allowed”.
      // Block first, then lift: that way the message on lifting names a block that stays.
      const forks = await forkExposure(github, repo, info);
      const kind = !forks.exposed ? null : forks.unknown && !own.pausedForks ? 'forksUnknown' : 'forks';
      if (kind && (!own[BLOCKS[kind]] || !own.paused)) await guard.block(repo, kind, forks.reason);
      for (const other of ['forks', 'forksUnknown']) if (other !== kind && own[BLOCKS[other]]) guard.unblock(repo, other);
      if (own.pausedPublic) guard.unblock(repo, 'public');
    }
    const at = now();
    checkedAt.set(repo, at);
    timer(() => expire(repo, at), CHECK_STALE);
    failing.delete(repo);
    if (unchecked.delete(repo)) log(msg('m_checkBack'), repo);
  }
  const vetted = (repo) => now() - (checkedAt.get(repo) ?? -Infinity) < CHECK_STALE;
  // The pool rests because there is no fresh check; this is reported once.
  function rest(repo) {
    if (unchecked.has(repo) || stopping() || !settingsOf(repo)) return;
    unchecked.add(repo);
    guard.restUnchecked(repo);
    log(msg('m_unchecked'), repo, 'error');
  }
  // The check from `at` expires; if there was no successful one since, the pool rests.
  function expire(repo, at) {
    if (checkedAt.get(repo) === at) rest(repo);
  }
  function watchVisibility(repo) {
    return checkVisibility(repo).catch((error) => {
      if (!failing.has(repo)) logError(repo, msg('m_whatVisibility'))(error);
      failing.add(repo);
      if (!vetted(repo)) rest(repo);
      if (retrying.has(repo) || stopping() || !settingsOf(repo)) return;
      retrying.add(repo);
      timer(() => { retrying.delete(repo); if (!stopping()) watchVisibility(repo); }, CHECK_RETRY);
    });
  }

  // Re-run a run or job of a repo with a pool at GitHub (`endpoint` under `actions/`) and afterwards, once
  // GitHub has created the new attempt, query the repo's runs again. `missing`: the message if the run
  // or job doesn't exist (a key, see messages.js).
  async function rerun(repo, id, endpoint, missing) {
    if (!settingsOf(repo) || !/^\d+$/.test(String(id))) throw new Fault(missing);
    await github.send('POST', `repos/${repo}/actions/${endpoint}`);
    timer(() => { if (!stopping()) refreshRepo(repo); }, RERUN_SETTLE);
  }

  return {
    refreshRepo, refreshAll, refreshActive, watchQuota, listRepos, scanWaiting, watchVisibility, vetted, rerun,
    markChecked: (repo) => { const at = now(); checkedAt.set(repo, at); timer(() => expire(repo, at), CHECK_STALE); },
    view: (repo) => states.get(repo) ?? null,
    forget: (repo) => { for (const known of [states, checkedAt, unchecked, failing, retrying]) known.delete(repo); },
  };
}

module.exports = { createRemote, WAITING_INTERVAL, RERUN_SETTLE, REPO_LIST_MAX_AGE, CHECK_STALE, CHECK_RETRY };
