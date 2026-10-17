// What the interface sees (`GET /api/status`): per repo with a pool its slots, runs, pipeline view, consumption and
// settings, plus the machine, the Docker VM, the GitHub account and repos without a pool where nothing moves on.

const fs = require('node:fs');
const os = require('node:os');
const limitRules = require('./limits');
const { SLOT } = require('./states');
const { blockOf } = require('./blocks');

// A slot as the interface shows it; `name` only once it has a pair. `jobs`: the repo's running jobs at GitHub (see remote.js);
// `statsOf(name)`: the consumption of a container (see usage.js); `cpus`: cores of the Docker VM.
function runnerView({ slot, index, repo, jobs, statsOf, cpus }) {
  const parts = slot.base ? [`${slot.base}-runner`, `${slot.base}-dind`].map(statsOf).filter(Boolean) : [];
  // As long as GitHub does not report the job yet, what the runner itself knows is shown.
  const job = slot.state === SLOT.WORKING
    ? (jobs.find((j) => j.runner === slot.name) ?? { workflow: '', job: slot.job, branch: '', startedAt: slot.jobStartedAt, url: `https://github.com/${repo}/actions` })
    : null;
  const cores = parts.reduce((sum, part) => sum + part.cpu, 0);
  return {
    kind: 'Linux', name: slot.base ? slot.name : null, seat: index + 1, state: slot.state, retiring: Boolean(slot.retired) && slot.state !== SLOT.OFF, job,
    cpu: cores / cpus * 100, cores, memory: parts.reduce((sum, part) => sum + part.memory, 0),
    // Jobs since the start, the last one with its result ({ job, result }; result as the runner reports it, or null)
    // and the last error (a message or a text, see messages.js).
    jobs: slot.jobs ?? 0, lastResult: slot.lastResult ?? null, error: slot.error ?? null,
  };
}

//   settings                `config`, `limitsOf` (see settings.js)
//   runners                 `pools` (Map), `reserveSize(pool)`, `staleCount(pool)` (see runners.js)
//   remote                  `view(repo)`, `vetted(repo)` (see remote.js)
//   pipelines, metrics, usage, routing, waiting, account, github   see the modules of the same name
//   dockerWatch             `ready()`, `error()`, `cpus()`, `memory()` (see dockerwatch.js)
//   setup                   `view()`: what the machine lacks for Docker (see setup.js)
//   buildService(repo)      name of the build service (see names.js)
//   logStamp()              key of the log; when it changes, the interface fetches the log again
//   uiFile                  the file of the page; when it changes, the page reloads itself
//   shutdown()              the state during shutdown, otherwise null (see shutdown.js)
//   extra()                 details the app contributes (see `hooks.status` in backend.js)
function createStatus({ settings, runners, remote, pipelines, metrics, usage, routing, waiting, account, github, dockerWatch, setup = { view: () => null }, buildService, logStamp, uiFile, shutdown = () => null, extra = () => ({}) }) {
  const { config, limitsOf } = settings;

  const limitRange = () => limitRules.bounds({ dockerMemory: dockerWatch.memory(), dockerCpus: dockerWatch.cpus() });
  // The suggestion for all projects together and whether it already applies (see `plan` in limits.js).
  function limitPlan() {
    const found = limitRules.plan(config.pools.map((pool) => ({ repo: pool.repo, jobs: metrics.jobsView(pool.repo) })), limitRange());
    if (!found) return null;
    const projects = config.pools.map((pool) => ({ repo: pool.repo, own: pool.limits ? limitRules.view(limitsOf(pool.repo)) : null }));
    return { ...found, applied: limitRules.planApplied(found, limitRules.view(config.limits), projects) };
  }

  // While saving, the file can be missing for a moment; then the last known state applies.
  let uiSeenAt = 0;
  function uiChangedAt() {
    try { uiSeenAt = fs.statSync(uiFile).mtimeMs; } catch { /* back in a moment */ }
    return uiSeenAt;
  }

  function poolView(settingsOfRepo) {
    const { repo } = settingsOfRepo;
    const pool = runners.pools.get(repo);
    const jobs = metrics.jobsView(repo);
    const service = usage.statsOf(buildService(repo));
    return {
      parallel: settingsOfRepo.parallel, paused: settingsOfRepo.paused, cache: settingsOfRepo.cache, busy: Boolean(pool?.hold),
      // Why the pool is blocked (see blocks.js) and whether its repo has been checked recently (see remote.js).
      blocked: blockOf(settingsOfRepo), checked: remote.vetted(repo),
      reserve: (pool?.reserve ?? []).filter((entry) => entry.ready).length, reserveWanted: pool ? runners.reserveSize(pool) : 0,
      sizes: pool?.sizes ?? null,
      limits: {
        own: Boolean(settingsOfRepo.limits), values: limitRules.view(limitsOf(repo)),
        suggestion: limitRules.suggest(jobs, limitRange()), fit: limitRules.rate(jobs, limitRules.view(limitsOf(repo)), limitRange()), stale: pool ? runners.staleCount(pool) : 0,
      },
      routing: routing.of(repo),
      images: [...(pool?.seeded ?? [])].sort(),
      preload: settingsOfRepo.preload,
      buildService: service ? { cpu: service.cpu, memory: service.memory } : null,
    };
  }

  function repoView(settingsOfRepo) {
    const { repo } = settingsOfRepo;
    const remoteState = remote.view(repo) ?? { jobs: [], runs: [], error: null };
    return {
      repo,
      waiting: remoteState.jobs.filter((job) => job.status === 'queued').length,
      error: remoteState.error ?? null,
      notFound: remoteState.notFound ?? false, // GitHub answered 404: repo gone, or the app is missing on its account
      runs: remoteState.runs,
      pipelines: pipelines.view(repo, settingsOfRepo.paused ? 0 : settingsOfRepo.parallel),
      lastRun: pipelines.lastOf(repo),
      usage: { jobs: metrics.jobsView(repo), wait: pipelines.waitOf(repo) },
      pool: poolView(settingsOfRepo),
      runners: (runners.pools.get(repo)?.slots ?? []).map((slot, index) => runnerView({ slot, index, repo, jobs: remoteState.jobs, statsOf: usage.statsOf, cpus: dockerWatch.cpus() })),
    };
  }

  function status() {
    return {
      at: new Date().toISOString(),
      machine: {
        cores: os.cpus().length, memoryTotal: os.totalmem(), memoryFree: os.freemem(), dockerCpus: dockerWatch.cpus(), dockerMemory: dockerWatch.memory(),
        // Without an error and not ready: Docker is still starting. `setup`: what the machine lacks, { missing, app } or null (see setup.js).
        docker: { ready: dockerWatch.ready(), error: dockerWatch.ready() ? null : dockerWatch.error(), setup: dockerWatch.ready() ? null : setup.view() },
        usage: usage.view(), vmTight: usage.vmTight(), // { free } when the Docker VM has hardly any memory free, otherwise null
        limits: config.limits, series: metrics.series(),
        limitsView: { values: limitRules.view(config.limits), bounds: limitRange(), plan: limitPlan(), needRuns: limitRules.SUGGEST_RUNS, tightAt: limitRules.TIGHT },
      },
      repos: config.pools.map(repoView),
      quota: github.quota(), // rate limit of the GitHub account: { limit, remaining, resetAt, state, tightAt } or null
      minutes: account.minutesView(), // minutes quota of GitHub Actions this month: { plan | null, used, included | null, paid, cost, systems: { linux, windows, macos, other }, resetAt, state, tightAt, plans }; as long as there are no figures, only { state: 'reading' | 'failed' }; null when not signed in
      unserved: waiting.list().filter((entry) => !settings.settingsOf(entry.repo)), // repos without a pool where nothing moves on: [{ repo, reason: 'runner', jobs, since, url } | { repo, reason: 'minutes', runs, since, url }]
      auth: account.authView(), // sign-in to GitHub: { state, login, flow: { state, code, url, why, error } | null, install, revoke } (see auth.js)
      logStamp: logStamp(), // the interface fetches the log itself when the key changes
      ui: uiChangedAt(), // the page reloads itself when its file changes
      shutdown: shutdown(), // while RunClub is ending, what is still being taken down (see shutdown.js), otherwise null
      ...extra(),
    };
  }

  return { status, limitRange, limitPlan };
}

module.exports = { createStatus, runnerView };
