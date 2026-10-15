// Was RunClub bei GitHub abfragt: Läufe und Jobs der Repos mit Pool (für den Netzplan und die Plätze), das
// Anfragelimit, die Repos des Kontos, wartende Läufe in Repos ohne Pool, die Sichtbarkeit der Repos mit Pool. Dazu
// das erneute Starten eines Laufs oder Jobs.
//
// Je Repo steht der letzte Stand bereit (`view`): { jobs, runs, error }. Eine Abfrage, die scheitert, behält Jobs und
// Läufe des vorigen Stands und trägt nur den Fehler.

const { MINUTE, SECOND } = require('./units');
const { STATE: QUOTA, PAGE_MAX } = require('./github');
const { candidates } = require('./waiting');
const { noteWorkflows } = require('./slots');
const { SLOT } = require('./states');

const RUNS_PER_REPO = 20;
const REPO_LIST_MAX_AGE = 5 * MINUTE; // so lange gilt die Liste der Repos des Kontos
const REPO_PAGES_MAX = 10;
const RERUN_SETTLE = 3 * SECOND; // so lange braucht GitHub etwa, bis ein erneut gestarteter Lauf wieder als laufend erscheint
const WAITING_INTERVAL = 5 * MINUTE; // so oft wird nach wartenden Läufen ohne Pool gesucht (Takt in backend.js)

//   gh(args, body)          Aufruf der GitHub-API, liefert die Antwort als Objekt oder wirft
//   githubApi               `mayPoll(key, every)`, `refreshQuota()` (siehe github.js)
//   pipelines, routing, waiting   siehe pipeline.js, routing.js, waiting.js
//   log(text, repo, kind), logError(repo, what)   siehe journal.js
//   repos(), settingsOf(repo)     die Repos mit Pool und ihre Einstellungen (siehe settings.js)
//   poolOf(repo)            der stehende Pool oder undefined
//   stopping(), timer (wie `setTimeout`)
//   onPublic(repo), onPrivate(repo)   ein Repo mit Pool ist öffentlich bzw. wieder privat (siehe actions.js)
//   confirmResults(repo, done)   Ergebnisse abgeschlossener Jobs der eigenen Runner, wie GitHub sie meldet (siehe metrics.js)
function createRemote({
  gh, githubApi, pipelines, routing, waiting, log, logError,
  repos, settingsOf, poolOf, stopping, timer = setTimeout, now = Date.now, onPublic, onPrivate, confirmResults = () => {},
}) {
  const states = new Map(); // Repo -> { jobs, runs, error }
  const busy = new Set(); // Repos, deren Abfrage gerade läuft
  const again = new Set(); // … und die danach noch einmal dran sind

  // Ein Repo abfragen. Läuft schon eine Abfrage, folgt danach genau eine weitere.
  async function refreshRepo(repo) {
    if (busy.has(repo)) { again.add(repo); return; }
    if (!githubApi.mayPoll(repo)) return; // das Anfragelimit ist knapp oder aufgebraucht (siehe github.js)
    busy.add(repo);
    try {
      const runs = (await gh(['api', `repos/${repo}/actions/runs?per_page=${RUNS_PER_REPO}`])).workflow_runs;
      const active = await pipelines.refresh(repo, runs);
      const jobs = active.flatMap((pipeline) => pipeline.jobs
        .filter((job) => job.status !== 'completed' && job.status !== 'pending')
        .map((job) => ({ workflow: pipeline.workflow, job: job.name, branch: pipeline.branch, status: job.status, runner: job.runner, own: job.own, startedAt: job.startedAt, url: job.url, estimate: job.estimate, step: job.step })));
      states.set(repo, {
        jobs, error: null,
        runs: runs.map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, event: r.event, status: r.status, conclusion: r.conclusion, at: r.run_started_at ?? r.created_at, url: r.html_url, title: r.display_title })),
      });
      noteWorkflows(poolOf(repo), jobs);
      // Abgeschlossene Jobs der eigenen Runner, auch aus eben beendeten und dem letzten fertigen Lauf: Ihr Ergebnis bei
      // GitHub gilt (siehe metrics.js).
      const done = [...active, ...pipelines.finishedOf(repo), pipelines.lastOf(repo)].filter(Boolean).flatMap((pipeline) => pipeline.jobs)
        .filter((job) => job.status === 'completed' && job.own && job.runner).map((job) => ({ runner: job.runner, conclusion: job.conclusion }));
      if (done.length) confirmResults(repo, done);
    } catch (error) {
      states.set(repo, { ...(states.get(repo) ?? { jobs: [], runs: [] }), error: error.message });
    } finally {
      busy.delete(repo);
      if (again.delete(repo) && !stopping()) refreshRepo(repo);
    }
  }

  // Alle Repos der Reihe nach – der ruhige Takt.
  async function refreshAll() {
    for (const repo of repos()) await refreshRepo(repo);
  }

  // Wo gerade etwas auf den eigenen Runnern läuft oder darauf wartet, öfter nachsehen: Dort ändert sich der Stand im
  // Sekundentakt. Jobs auf GitHubs Runnern genügt der ruhige Takt.
  function refreshActive() {
    for (const repo of repos()) {
      const working = poolOf(repo)?.slots.some((slot) => slot.state === SLOT.WORKING);
      if (working || states.get(repo)?.jobs.some((job) => job.own)) refreshRepo(repo);
    }
  }

  // Den Stand des Anfragelimits holen und ins Protokoll schreiben, wenn er kippt.
  async function checkQuota() {
    const changed = await githubApi.refreshQuota();
    if (!changed) return;
    if (changed.paused) log(`GitHub bittet um eine Pause (zu viele Anfragen in kurzer Zeit). Bis ${changed.until} wird nicht mehr abgefragt.`);
    else if (changed.state === QUOTA.OUT) log(`GitHub-Anfragen sind aufgebraucht (${changed.remaining} von ${changed.limit} frei). Bis ${changed.until} wird nicht mehr abgefragt; der Rest bleibt für das Anmelden neuer Runner.`);
    else if (changed.state === QUOTA.TIGHT) log(`GitHub-Anfragen werden knapp (${changed.remaining} von ${changed.limit} frei). Bis ${changed.until} wird seltener abgefragt.`);
    else if (changed.before !== QUOTA.UNKNOWN) log('GitHub-Anfragen sind wieder frei; es wird wieder im gewohnten Takt abgefragt.');
    // Solange nichts gelesen werden durfte, blieb auch der Stand von CI_RUNNER unbekannt: jetzt nachholen.
    if (changed.before === QUOTA.OUT) for (const repo of repos()) routing.check(repo).catch(() => {});
  }
  const watchQuota = () => checkQuota().catch(logError(null, 'Anfragelimit'));

  // Repos, für die sich Runner anmelden lassen (Verwaltungsrecht), die zuletzt bewegten zuerst. `free`: Für das Repo
  // ist ein Pool möglich (es hat keinen, und öffentliche bekommen keinen; siehe `pool/add` in actions.js).
  let repoList = { at: 0, repos: [] };
  async function listRepos() {
    if (now() - repoList.at > REPO_LIST_MAX_AGE) {
      const found = [];
      for (let page = 1; page <= REPO_PAGES_MAX; page += 1) {
        const batch = await gh(['api', `user/repos?per_page=${PAGE_MAX}&page=${page}&sort=pushed`]);
        found.push(...batch.filter((r) => r.permissions?.admin && !r.archived).map((r) => ({ repo: r.full_name, private: r.private, pushedAt: r.pushed_at })));
        if (batch.length < PAGE_MAX) break;
      }
      repoList = { at: now(), repos: found };
    }
    return repoList.repos.map((r) => { const pool = Boolean(settingsOf(r.repo)); return { ...r, pool, free: !pool && r.private !== false }; });
  }

  // Nach Läufen suchen, für die es keinen Pool gibt und die deshalb auf einen eigenen Runner warten oder am
  // aufgebrauchten Kontingent von GitHub gescheitert sind (siehe waiting.js). Bei knappem Limit nur jede dritte Runde.
  // Lässt sich die Liste der Repos nicht lesen, bleibt der letzte Stand.
  function scanWaiting() {
    if (stopping() || !githubApi.mayPoll('wartende Läufe', 3 * WAITING_INTERVAL)) return Promise.resolve();
    return listRepos().then((found) => waiting.scan(candidates(found))).catch(() => {});
  }

  // Pools gibt es nur für private Repos. Wird ein Repo später öffentlich, liefen Pull Requests von Fremden auf diesem
  // Rechner: Das meldet `onPublic`. Ob ein Pool deshalb pausiert ist, steht in seinen Einstellungen (`pausedPublic`)
  // und überdauert einen Neustart; erst eine gelungene Prüfung, die das Repo wieder privat findet, hebt es auf.
  async function checkVisibility(repo) {
    const own = settingsOf(repo);
    if (!own) return;
    const info = await gh(['api', `repos/${repo}`]);
    if (info.private === false && !own.pausedPublic) await onPublic(repo);
    else if (info.private !== false && own.pausedPublic) await onPrivate(repo);
  }
  const watchVisibility = (repo) => checkVisibility(repo).catch(logError(repo, 'Sichtbarkeit des Repos'));

  // Einen Lauf oder Job eines Repos mit Pool bei GitHub erneut starten (`endpoint` unter `actions/`) und danach, wenn
  // GitHub den neuen Versuch angelegt hat, die Läufe des Repos neu abfragen. `missing`: die Meldung, wenn es den Lauf
  // oder Job nicht gibt.
  async function rerun(repo, id, endpoint, missing) {
    if (!settingsOf(repo) || !/^\d+$/.test(String(id))) throw new Error(missing);
    await gh(['api', '-X', 'POST', `repos/${repo}/actions/${endpoint}`]);
    timer(() => { if (!stopping()) refreshRepo(repo); }, RERUN_SETTLE);
  }

  return {
    refreshRepo, refreshAll, refreshActive, watchQuota, listRepos, scanWaiting, watchVisibility, rerun,
    view: (repo) => states.get(repo) ?? null,
    forget: (repo) => states.delete(repo),
  };
}

module.exports = { createRemote, WAITING_INTERVAL, RERUN_SETTLE, REPO_LIST_MAX_AGE };
