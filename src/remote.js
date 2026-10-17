// Was RunClub bei GitHub abfragt: Läufe und Jobs der Repos mit Pool (für den Netzplan und die Plätze), das
// Anfragelimit, die Repos des Kontos, wartende Läufe in Repos ohne Pool, die Sichtbarkeit der Repos mit Pool und ob
// dort Pull Requests aus Forks laufen dürften. Dazu das erneute Starten eines Laufs oder Jobs.
//
// Je Repo steht der letzte Stand bereit (`view`): { jobs, runs, error, notFound (GitHub antwortete 404) }. Eine Abfrage, die scheitert, behält Jobs und
// Läufe des vorigen Stands und trägt nur den Fehler.

const { MINUTE, SECOND } = require('./units');
const { STATE: QUOTA, PAGE_MAX } = require('./github');
const { candidates } = require('./waiting');
const { noteWorkflows } = require('./slots');
const { SLOT } = require('./states');
const { forkExposure } = require('./forks');
const { BLOCKS } = require('./blocks');
const { msg, Fault, reason } = require('./messages');

const RUNS_PER_REPO = 20;
const REPO_LIST_MAX_AGE = 5 * MINUTE; // so lange gilt die Liste der Repos des Kontos
const EMPTY_LIST_MAX_AGE = 15 * SECOND; // … und so lange eine leere: Gleich nach dem Installieren der App soll sie sich füllen
const REPO_PAGES_MAX = 10;
const RERUN_SETTLE = 3 * SECOND; // so lange braucht GitHub etwa, bis ein erneut gestarteter Lauf wieder als laufend erscheint
const WAITING_INTERVAL = 5 * MINUTE; // so oft wird nach wartenden Läufen ohne Pool gesucht (Takt in backend.js)
const CHECK_STALE = 25 * MINUTE; // so lange gilt eine gelungene Prüfung; die Pflege prüft alle 10 Minuten (backend.js)
const CHECK_RETRY = MINUTE; // so bald wird erneut geprüft, solange ein Pool ruht, weil die Prüfung scheitert

//   github                  Zugang zu GitHub (siehe github.js): `get`, `send`, `mayPoll(key, every)`, `refreshQuota()`
//   pipelines, routing, waiting   siehe pipeline.js, routing.js, waiting.js
//   log(text, repo, kind), logError(repo, what)   siehe journal.js
//   repos(), settingsOf(repo)     die Repos mit Pool und ihre Einstellungen (siehe settings.js)
//   poolOf(repo)            der stehende Pool oder undefined
//   stopping(), timer (wie `setTimeout`)
//   guard                   `block(repo, kind, reason)`, `unblock(repo, kind)`, `restUnchecked(repo)` (siehe actions.js, blocks.js)
//   confirmResults(repo, done)   Ergebnisse abgeschlossener Jobs der eigenen Runner, wie GitHub sie meldet (siehe metrics.js)
function createRemote({
  github, pipelines, routing, waiting, log, logError,
  repos, settingsOf, poolOf, stopping, timer = setTimeout, now = Date.now, guard, confirmResults = () => {},
}) {
  const states = new Map(); // Repo -> { jobs, runs, error, notFound }
  const busy = new Set(); // Repos, deren Abfrage gerade läuft
  const again = new Set(); // … und die danach noch einmal dran sind
  const checkedAt = new Map(); // Repo -> Zeit der letzten gelungenen Prüfung (siehe `checkVisibility`)
  const unchecked = new Set(); // Repos, deren Pool ruht, weil keine frische Prüfung vorliegt
  const failing = new Set(); // Repos, deren letzte Prüfung scheiterte (steht schon im Protokoll)
  const retrying = new Set(); // … und für die eine neue Prüfung ansteht

  // Ein Repo abfragen. Läuft schon eine Abfrage, folgt danach genau eine weitere.
  async function refreshRepo(repo) {
    if (busy.has(repo)) { again.add(repo); return; }
    if (!github.mayPoll(repo)) return; // das Anfragelimit ist knapp oder aufgebraucht (siehe github.js)
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
      // Abgeschlossene Jobs der eigenen Runner, auch aus eben beendeten und dem letzten fertigen Lauf: Ihr Ergebnis bei
      // GitHub gilt (siehe metrics.js).
      const done = [...active, ...pipelines.finishedOf(repo), pipelines.lastOf(repo)].filter(Boolean).flatMap((pipeline) => pipeline.jobs)
        .filter((job) => job.status === 'completed' && job.own && job.runner).map((job) => ({ runner: job.runner, conclusion: job.conclusion }));
      if (done.length) confirmResults(repo, done);
    } catch (error) {
      // 404: GitHub kennt das Repo nicht, oder die GitHub-App ist für sein Konto nicht installiert.
      states.set(repo, { ...(states.get(repo) ?? { jobs: [], runs: [] }), error: reason(error), notFound: error?.status === 404 });
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
    const changed = await github.refreshQuota();
    if (!changed) return;
    const until = { time: changed.resetAt };
    if (changed.paused) log(msg('m_quotaPaused', until));
    else if (changed.state === QUOTA.OUT) log(msg('m_quotaOut', changed.remaining, changed.limit, until));
    else if (changed.state === QUOTA.TIGHT) log(msg('m_quotaTight', changed.remaining, changed.limit, until));
    else if (changed.before !== QUOTA.UNKNOWN) log(msg('m_quotaFree'));
    // Solange nichts gelesen werden durfte, blieb auch der Stand von CI_RUNNER unbekannt: jetzt nachholen.
    if (changed.before === QUOTA.OUT) for (const repo of repos()) routing.check(repo).catch(() => {});
  }
  const watchQuota = () => checkQuota().catch(logError(null, msg('m_whatQuota')));

  // Repos, für die sich Runner anmelden lassen (Verwaltungsrecht), die zuletzt bewegten zuerst. `free`: Für das Repo
  // ist ein Pool möglich (es hat keinen, und öffentliche bekommen keinen; siehe `pool/add` in actions.js).
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

  // Nach Läufen suchen, für die es keinen Pool gibt und die deshalb auf einen eigenen Runner warten oder am
  // aufgebrauchten Kontingent von GitHub gescheitert sind (siehe waiting.js). Bei knappem Limit nur jede dritte Runde.
  // Lässt sich die Liste der Repos nicht lesen, bleibt der letzte Stand.
  function scanWaiting() {
    if (stopping() || !github.mayPoll('wartende Läufe', 3 * WAITING_INTERVAL)) return Promise.resolve();
    return listRepos().then((found) => waiting.scan(candidates(found))).catch(() => {});
  }

  // Pools gibt es nur für private Repos, und in Repos einer Organisation nur, solange dort keine Workflows aus Pull
  // Requests von Forks laufen dürfen (siehe forks.js). Ändert sich das später, sperrt `guard.block` den Pool (siehe
  // blocks.js); erst eine gelungene Prüfung, die den Grund weggefallen findet, hebt die Sperre auf (`guard.unblock`).
  // Eine Sperre, die schon besteht, wird nachgezogen, wenn der Pool trotzdem nicht pausiert.
  //
  // Ein Pool arbeitet nur, solange die letzte gelungene Prüfung höchstens CHECK_STALE alt ist (`vetted`, siehe
  // pools.js): beim Start erst nach der ersten. Nach jedem Fehlschlag wird nach CHECK_RETRY erneut geprüft. Läuft die
  // letzte gelungene ab, ruht der Pool sofort (`expire`): Freie, schon angemeldete Paare gehen, statt bis zur
  // nächsten Runde ihres Platzes Jobs anzunehmen. Ein Ausfall steht einmal im Protokoll, nicht bei jedem Versuch.
  async function checkVisibility(repo) {
    const own = settingsOf(repo);
    if (!own) return;
    const info = await github.get(`repos/${repo}`);
    if (info.private === false) {
      if (!own.pausedPublic || !own.paused) await guard.block(repo, 'public');
    } else {
      // Für Forks gilt höchstens eine Sperre: erlaubt oder nicht lesbar. Nicht lesbar ändert an „erlaubt“ nichts.
      // Erst sperren, dann aufheben: So nennt die Meldung beim Aufheben eine Sperre, die bleibt.
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
  // Der Pool ruht, weil keine frische Prüfung vorliegt; gemeldet wird das einmal.
  function rest(repo) {
    if (unchecked.has(repo) || stopping() || !settingsOf(repo)) return;
    unchecked.add(repo);
    guard.restUnchecked(repo);
    log(msg('m_unchecked'), repo, 'error');
  }
  // Die Prüfung von `at` läuft ab; gab es seither keine gelungene, ruht der Pool.
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

  // Einen Lauf oder Job eines Repos mit Pool bei GitHub erneut starten (`endpoint` unter `actions/`) und danach, wenn
  // GitHub den neuen Versuch angelegt hat, die Läufe des Repos neu abfragen. `missing`: die Meldung, wenn es den Lauf
  // oder Job nicht gibt (ein Schlüssel, siehe messages.js).
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
