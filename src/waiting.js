// Läufe ohne Pool, die nicht vorankommen: Repos des Kontos, für die RunClub keinen Pool hat und in denen Jobs auf
// einen eigenen Runner warten oder Läufe am aufgebrauchten Kontingent von GitHub gescheitert sind. Beides bliebe
// sonst still, bis jemand nachsieht. Angestoßen wird hier nichts.
//
// Gesucht wird sparsam: nur in privaten Repos mit Verwaltungsrecht, die zuletzt bewegt wurden, und nur nach Läufen,
// die GitHub als wartend oder laufend führt (in einem laufenden Lauf kann ein späterer Job warten). Unveränderte Antworten zählen nicht gegen das Anfragelimit (siehe github.js).
//
// Kontingent: Wählen die Workflows den Runner über die Repo-Variable CI_RUNNER, gehen die Jobs ohne Pool an GitHubs
// Runner. Sind dort die Minuten aufgebraucht, wartet nichts: Der Lauf scheitert sofort, sein Job hat keine Schritte, und
// GitHub hängt den Grund als Anmerkung an. Angesehen werden dafür die jüngsten abgeschlossenen Läufe des letzten Tages
// bis zurück zum letzten gelungenen (danach war wieder Kontingent da), je Lauf mit höchstens einer Abfrage der
// Anmerkungen. Das Urteil über einen Lauf wird gemerkt; ein bekannter Lauf kostet keine Abfrage mehr.

const { DAY } = require('./units');
const { PAGE_MAX } = require('./github');
const RECENT_DAYS = 14; // ältere Repos haben keine wartenden Läufe, die jemand vermisst
const REPOS_MAX = 20;
const RUNS_MAX = 5; // Läufe je Repo und Zustand, deren Jobs angesehen werden
const DONE_MAX = 15; // jüngste abgeschlossene Läufe je Repo, die auf ein aufgebrauchtes Kontingent angesehen werden
const JOBS_MAX = 3; // nicht gestartete Jobs je Lauf, deren Anmerkungen gelesen werden
const VERDICTS_MAX = 400; // gemerkte Urteile über abgeschlossene Läufe
const OPEN = ['queued', 'in_progress']; // Zustände eines Laufs, in denen einer seiner Jobs warten kann
const REASON = { RUNNER: 'runner', MINUTES: 'minutes' }; // warum in einem Repo ohne Pool nichts läuft
// So begründet GitHub in der Anmerkung einen nicht gestarteten Job, wenn es am Geld liegt: Zahlung gescheitert,
// Ausgabengrenze oder Budget erreicht, Konto wegen der Abrechnung gesperrt. Der genaue Wortlaut wechselt.
const NOT_STARTED = /job was not started because.*(billing|payment|spending|budget)/i;

// Welche Repos sich anzusehen lohnen: solche, für die ein Pool möglich wäre (`free`, siehe listRepos in remote.js)
// und die zuletzt bewegt wurden.
function candidates(repos, now = Date.now()) {
  return repos
    .filter((entry) => entry.free && now - new Date(entry.pushedAt) < RECENT_DAYS * DAY)
    .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
    .slice(0, REPOS_MAX)
    .map((entry) => entry.repo);
}

// Wartet der Job auf einen eigenen Linux-Runner? Was auf GitHubs Runner wartet, geht RunClub nichts an.
function wantsOwnRunner(job) {
  const labels = (job.labels ?? []).map((label) => String(label).toLowerCase());
  return job.status === 'queued' && labels.includes('self-hosted') && !labels.includes('windows') && !labels.includes('macos');
}

// Ist der Job gescheitert, ohne dass ein Runner ihn je angefasst hat? Nur dann lohnt der Blick in die Anmerkungen.
const neverStarted = (job) => job.conclusion === 'failure' && !(job.steps ?? []).length;
// Nennen die Anmerkungen eines Jobs das Kontingent als Grund?
const minutesNote = (annotations) => (Array.isArray(annotations) ? annotations : []).some((note) => note.annotation_level === 'failure' && NOT_STARTED.test(String(note.message)));

function createWaiting({ gh, now = Date.now }) {
  // Je Repo ein Eintrag, der älteste zuerst: { repo, reason: 'runner', jobs: [Name, …], since (ISO), url } oder
  // { repo, reason: 'minutes', runs: Anzahl, since (ISO), url }.
  let found = [];
  // "Repo/Lauf@Stand" -> am Kontingent gescheitert? Ein abgeschlossener Lauf ändert sich nur durch erneutes Starten.
  const verdicts = new Map();

  const jobsOf = async (repo, run) => (await gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=${PAGE_MAX}`])).jobs ?? [];
  // Wann der Lauf zuletzt begann: Ein erneut gestarteter Lauf behält sein `created_at`.
  const startOf = (run) => run.run_started_at ?? run.created_at;

  async function waitingIn(repo) {
    const runs = [];
    for (const status of OPEN) runs.push(...((await gh(['api', `repos/${repo}/actions/runs?status=${status}&per_page=${RUNS_MAX}`])).workflow_runs ?? []));
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
        if (minutesNote(await gh(['api', `repos/${repo}/check-runs/${job.id}/annotations`]))) { hit = true; break; }
      }
      verdicts.set(key, hit);
      if (verdicts.size > VERDICTS_MAX) verdicts.delete(verdicts.keys().next().value);
    }
    return verdicts.get(key);
  }

  // Die Abfrage nennt keinen Zeitpunkt: So bleibt ihr Pfad gleich, und eine unveränderte Antwort kostet nichts.
  // Gezählt wird je Workflow, was seit dessen letztem gelungenen Lauf gescheitert ist: Ein anderer Workflow, der
  // durchläuft, sagt nichts darüber, ob dieser wieder startet.
  async function minutesIn(repo) {
    // Die Antwort ist eingefroren (siehe github.js): sortiert wird eine Kopie.
    const runs = [...((await gh(['api', `repos/${repo}/actions/runs?status=completed&per_page=${DONE_MAX}`])).workflow_runs ?? [])]
      .sort((a, b) => String(startOf(b)).localeCompare(String(startOf(a))));
    const recovered = new Set(); // Workflows, bei denen schon ein jüngerer gelungener Lauf gesehen wurde
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

  // Sieht die Repos der Reihe nach an. Wartet ein Job auf einen eigenen Runner, ist das der Grund, und nach dem
  // Kontingent wird nicht mehr gesehen. Für ein Repo, das sich gerade nicht lesen lässt (kein Netz, Anfragelimit),
  // bleibt der letzte Stand, ein Eintrag zum Kontingent aber höchstens einen Tag; was nicht mehr angesehen wird,
  // fällt heraus.
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

module.exports = { createWaiting, candidates, wantsOwnRunner, neverStarted, minutesNote, REASON };
