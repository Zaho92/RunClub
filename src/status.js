// Was die Oberfläche sieht (`GET /api/status`): je Repo mit Pool seine Plätze, Läufe, Netzplan, Verbrauch und
// Einstellungen, dazu der Rechner, die Docker-VM, das GitHub-Konto und Repos ohne Pool, in denen nichts vorankommt.

const fs = require('node:fs');
const os = require('node:os');
const limitRules = require('./limits');
const { SLOT } = require('./states');

// Ein Platz, wie die Oberfläche ihn zeigt. `jobs`: die laufenden Jobs des Repos bei GitHub (siehe remote.js);
// `statsOf(name)`: der Verbrauch eines Containers (siehe usage.js); `cpus`: Kerne der Docker-VM.
function runnerView({ slot, index, repo, jobs, statsOf, cpus }) {
  const parts = slot.base ? [`${slot.base}-runner`, `${slot.base}-dind`].map(statsOf).filter(Boolean) : [];
  // Solange GitHub den Job noch nicht meldet, steht da, was der Runner selbst weiß.
  const job = slot.state === SLOT.WORKING
    ? (jobs.find((j) => j.runner === slot.name) ?? { workflow: '', job: slot.job, branch: '', startedAt: slot.jobStartedAt, url: `https://github.com/${repo}/actions` })
    : null;
  const cores = parts.reduce((sum, part) => sum + part.cpu, 0);
  return {
    kind: 'Linux', name: slot.base ? slot.name : `Platz ${index + 1}`, state: slot.state, retiring: Boolean(slot.retired) && slot.state !== SLOT.OFF, job,
    cpu: cores / cpus * 100, cores, memory: parts.reduce((sum, part) => sum + part.memory, 0), cpuBase: `${cpus} Kerne der Docker-VM`,
    note: [`Platz ${index + 1}`, `${slot.jobs} Job${slot.jobs === 1 ? '' : 's'} seit dem Start`, slot.lastResult && `zuletzt ${slot.lastResult}`, slot.error && `Fehler: ${slot.error}`].filter(Boolean).join(' · '),
  };
}

//   settings                `config`, `limitsOf` (siehe settings.js)
//   runners                 `pools` (Map), `reserveSize(pool)`, `staleCount(pool)` (siehe runners.js)
//   remote                  `view(repo)` (siehe remote.js)
//   pipelines, metrics, usage, routing, waiting, account, githubApi   siehe die gleichnamigen Module
//   docker                  `ready()`, `error()`, `cpus()`, `memory()` (die Docker-Überwachung aus dockerwatch.js)
//   buildService(repo)      Name des Build-Dienstes (siehe names.js)
//   logStamp()              Kennung des Protokolls; ändert sie sich, holt die Oberfläche es neu
//   uiFile                  die Datei der Seite; ändert sie sich, lädt die Seite sich neu
//   extra()                 Angaben, die die App beisteuert (siehe `hooks.status` in backend.js)
function createStatus({ settings, runners, remote, pipelines, metrics, usage, routing, waiting, account, githubApi, docker, buildService, logStamp, uiFile, extra = () => ({}) }) {
  const { config, limitsOf } = settings;

  const limitRange = () => limitRules.bounds({ dockerMemory: docker.memory(), dockerCpus: docker.cpus() });
  // Der Vorschlag für alle Projekte zusammen und ob er schon gilt (siehe `plan` in limits.js).
  function limitPlan() {
    const found = limitRules.plan(config.pools.map((pool) => ({ repo: pool.repo, jobs: metrics.jobsView(pool.repo) })), limitRange());
    if (!found) return null;
    const projects = config.pools.map((pool) => ({ repo: pool.repo, own: pool.limits ? limitRules.view(limitsOf(pool.repo)) : null }));
    return { ...found, applied: limitRules.planApplied(found, limitRules.view(config.limits), projects) };
  }

  // Beim Speichern kann die Datei einen Augenblick fehlen; dann gilt der letzte bekannte Stand.
  let uiSeenAt = 0;
  function uiChangedAt() {
    try { uiSeenAt = fs.statSync(uiFile).mtimeMs; } catch { /* gleich wieder da */ }
    return uiSeenAt;
  }

  function poolView(settingsOfRepo) {
    const { repo } = settingsOfRepo;
    const pool = runners.pools.get(repo);
    const jobs = metrics.jobsView(repo);
    const service = usage.statsOf(buildService(repo));
    return {
      parallel: settingsOfRepo.parallel, paused: settingsOfRepo.paused, cache: settingsOfRepo.cache, busy: Boolean(pool?.hold),
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
      runs: remoteState.runs,
      pipelines: pipelines.view(repo, settingsOfRepo.paused ? 0 : settingsOfRepo.parallel),
      lastRun: pipelines.lastOf(repo),
      usage: { jobs: metrics.jobsView(repo), wait: pipelines.waitOf(repo) },
      pool: poolView(settingsOfRepo),
      runners: (runners.pools.get(repo)?.slots ?? []).map((slot, index) => runnerView({ slot, index, repo, jobs: remoteState.jobs, statsOf: usage.statsOf, cpus: docker.cpus() })),
    };
  }

  function status() {
    return {
      at: new Date().toISOString(),
      machine: {
        cores: os.cpus().length, memoryTotal: os.totalmem(), memoryFree: os.freemem(), dockerCpus: docker.cpus(), dockerMemory: docker.memory(),
        docker: { ready: docker.ready(), error: docker.ready() ? null : docker.error() }, // ohne Fehler und nicht bereit: Docker startet noch
        usage: usage.view(), vmTight: usage.vmTight(), // { free }, wenn die Docker-VM kaum noch Arbeitsspeicher frei hat, sonst null
        limits: config.limits, series: metrics.series(),
        limitsView: { values: limitRules.view(config.limits), bounds: limitRange(), plan: limitPlan(), needRuns: limitRules.SUGGEST_RUNS, tightAt: limitRules.TIGHT },
      },
      repos: config.pools.map(repoView),
      quota: githubApi.quota(), // Anfragelimit des GitHub-Kontos: { limit, remaining, resetAt, state, tightAt } oder null
      minutes: account.minutesView(), // Minuten-Kontingent von GitHub Actions in diesem Monat: { plan | null, used, included | null, paid, cost, systems: { linux, windows, macos, other }, resetAt, state, tightAt, plans }; solange es keinen Stand gibt, nur { state: 'reading' | 'failed' }; null ohne Anmeldung oder ohne das Recht dafür
      unserved: waiting.list().filter((entry) => !settings.settingsOf(entry.repo)), // Repos ohne Pool, in denen nichts vorankommt: [{ repo, reason: 'runner', jobs, since, url } | { repo, reason: 'minutes', runs, since, url }]
      auth: account.authView(), // Anmeldung bei GitHub: { state, login, scopes, required, extra, missing, optional: [{ scope, purpose }], flow: { kind, scopes, state, code, url, why, error } | null }
      logStamp: logStamp(), // das Protokoll selbst holt die Oberfläche, wenn sich die Kennung ändert
      ui: uiChangedAt(), // die Seite lädt sich neu, wenn sich ihre Datei ändert
      ...extra(),
    };
  }

  return { status, limitRange, limitPlan };
}

module.exports = { createStatus, runnerView };
