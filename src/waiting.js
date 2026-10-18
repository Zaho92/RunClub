// Runs without a pool that do not move on: repos of the account for which RunClub has no pool and in which jobs wait
// for one of our own runners or runs failed because GitHub's quota is used up. Both would otherwise stay silent until someone
// looks. Nothing is triggered here.
//
// The search is frugal: only in private repos with admin rights that moved recently, and only for runs that GitHub
// lists as queued or in progress (in a running run a later job can wait). Unchanged answers do not count against the rate limit (see github.js).
//
// Quota: if the workflows pick the runner through the repo variable CI_RUNNER, jobs without a pool go to GitHub's
// runners. Once the minutes there are used up, nothing waits: the run fails at once, its job has no steps, and
// GitHub attaches the reason as an annotation. For this the latest completed runs of the last day are looked at, back
// to the last successful one (after it there was quota again), with at most one annotations request per run. The
// verdict on a run is remembered; a known run costs no further request.

const { DAY } = require('./units');
const { PAGE_MAX } = require('./github');
const RECENT_DAYS = 14; // older repos have no waiting runs that anyone misses
const REPOS_MAX = 20;
const RUNS_MAX = 5; // runs per repo and state whose jobs are looked at
const DONE_MAX = 15; // latest completed runs per repo that are checked for a used-up quota
const JOBS_MAX = 3; // jobs per run that never started whose annotations are read
const VERDICTS_MAX = 400; // remembered verdicts on completed runs
const OPEN = ['queued', 'in_progress']; // states of a run in which one of its jobs can wait
const REASON = { RUNNER: 'runner', MINUTES: 'minutes' }; // why nothing runs in a repo without a pool
// This is how GitHub explains a job that never started in the annotation when money is the reason: payment failed,
// spending limit or budget reached, account locked over billing. The exact wording varies.
const NOT_STARTED = /job was not started because.*(billing|payment|spending|budget)/i;

// Which repos are worth looking at: those that could have a pool (`free`, see listRepos in remote.js) and that moved
// recently.
function candidates(repos, now = Date.now()) {
  return repos
    .filter((entry) => entry.free && now - new Date(entry.pushedAt) < RECENT_DAYS * DAY)
    .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
    .slice(0, REPOS_MAX)
    .map((entry) => entry.repo);
}

// Does the job wait for one of our own Linux runners? What waits for GitHub's runners is none of RunClub's business.
function wantsOwnRunner(job) {
  const labels = (job.labels ?? []).map((label) => String(label).toLowerCase());
  return job.status === 'queued' && labels.includes('self-hosted') && !labels.includes('windows') && !labels.includes('macos');
}

// Did the job fail without a runner ever touching it? Only then is a look at the annotations worth it.
const neverStarted = (job) => job.conclusion === 'failure' && !(job.steps ?? []).length;
// Do a job's annotations name the quota as the reason?
const minutesNote = (annotations) => (Array.isArray(annotations) ? annotations : []).some((note) => note.annotation_level === 'failure' && NOT_STARTED.test(String(note.message)));

function createWaiting({ github, now = Date.now }) {
  // One entry per repo, the oldest first: { repo, reason: 'runner', jobs: [name, …], since (ISO), url } or
  // { repo, reason: 'minutes', runs: count, since (ISO), url }.
  let found = [];
  // "repo/run@updated" -> failed on the quota? A completed run only changes by being restarted.
  const verdicts = new Map();

  const jobsOf = async (repo, run) => (await github.get(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=${PAGE_MAX}`)).jobs ?? [];
  // When the run last began: a restarted run keeps its `created_at`.
  const startOf = (run) => run.run_started_at ?? run.created_at;

  async function waitingIn(repo) {
    const runs = [];
    for (const status of OPEN) runs.push(...((await github.get(`repos/${repo}/actions/runs?status=${status}&per_page=${RUNS_MAX}`)).workflow_runs ?? []));
    const jobs = [];
    for (const run of runs) {
      const waiting = (await jobsOf(repo, run)).filter(wantsOwnRunner);
      jobs.push(...waiting.map((job) => ({ name: job.name, since: job.created_at ?? run.created_at })));
    }
    if (!jobs.length) return null;
    return { repo, reason: REASON.RUNNER, jobs: jobs.map((job) => job.name), since: jobs.map((job) => job.since).sort()[0], url: `https://github.com/${repo}/actions?query=is%3Aqueued` };
  }

  async function outOfMinutes(repo, run) {
    const key = `${repo}/${run.id}@${run.updated_at}`;
    if (!verdicts.has(key)) {
      let hit = false;
      for (const job of (await jobsOf(repo, run)).filter(neverStarted).slice(0, JOBS_MAX)) {
        if (minutesNote(await github.get(`repos/${repo}/check-runs/${job.id}/annotations`))) { hit = true; break; }
      }
      verdicts.set(key, hit);
      if (verdicts.size > VERDICTS_MAX) verdicts.delete(verdicts.keys().next().value);
    }
    return verdicts.get(key);
  }

  // The request names no time: so its path stays the same, and an unchanged answer costs nothing.
  // Counted per workflow is what failed since its last successful run: another workflow that succeeds says nothing
  // about whether this one starts again.
  async function minutesIn(repo) {
    // The answer is frozen (see github.js): a copy is sorted.
    const runs = [...((await github.get(`repos/${repo}/actions/runs?status=completed&per_page=${DONE_MAX}`)).workflow_runs ?? [])]
      .sort((a, b) => String(startOf(b)).localeCompare(String(startOf(a))));
    const recovered = new Set(); // workflows for which a more recent successful run has already been seen
    const failed = [];
    for (const run of runs) {
      if (run.conclusion === 'success') recovered.add(run.workflow_id);
      else if (run.conclusion === 'failure' && !recovered.has(run.workflow_id) && now() - new Date(startOf(run)) < DAY) failed.push(run);
    }
    const hit = [];
    for (const run of failed) if (await outOfMinutes(repo, run)) hit.push(run);
    if (!hit.length) return null;
    return { repo, reason: REASON.MINUTES, runs: hit.length, since: hit.map(startOf).sort()[0], url: `https://github.com/${repo}/actions?query=is%3Afailure` };
  }

  // Looks at the repos in turn. If a job waits for one of our own runners, that is the reason, and the quota is no longer
  // checked. For a repo that cannot be read right now (no network, rate limit) the last state stays, but an entry
  // about the quota for at most a day; what is no longer looked at drops out.
  async function scan(repos) {
    const next = [];
    for (const repo of repos) {
      const known = found.find((entry) => entry.repo === repo);
      let entry;
      try {
        entry = await waitingIn(repo);
        if (!entry) entry = await minutesIn(repo).catch(() => (known?.reason === REASON.MINUTES ? known : null));
      } catch { entry = known; }
      if (entry?.reason === REASON.MINUTES && now() - new Date(entry.since) >= DAY) entry = null;
      if (entry) next.push(entry);
    }
    found = next.sort((a, b) => String(a.since).localeCompare(String(b.since)));
    return found;
  }

  return { scan, list: () => found, forget: (repo) => { found = found.filter((entry) => entry.repo !== repo); } };
}

module.exports = { createWaiting, candidates, wantsOwnRunner, neverStarted, minutesNote };
