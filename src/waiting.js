// Wartende Läufe ohne Pool: Repos des Kontos, in denen Jobs auf einen eigenen Runner warten, für die RunClub aber
// keinen Pool hat. Solche Jobs warten sonst still, bis jemand nachsieht.
//
// Gesucht wird sparsam: nur in privaten Repos mit Verwaltungsrecht, die zuletzt bewegt wurden, und nur nach Läufen,
// die GitHub als wartend führt. Unveränderte Antworten zählen nicht gegen das Anfragelimit (siehe github.js).

const DAY = 24 * 3600000;
const RECENT_DAYS = 14; // ältere Repos haben keine wartenden Läufe, die jemand vermisst
const REPOS_MAX = 20;
const RUNS_MAX = 5; // wartende Läufe je Repo, deren Jobs angesehen werden

// Welche Repos sich anzusehen lohnen: ohne Pool, privat (für öffentliche legt RunClub keinen an), zuletzt bewegt.
function candidates(repos, now = Date.now()) {
  return repos
    .filter((entry) => !entry.pool && entry.private !== false && now - new Date(entry.pushedAt) < RECENT_DAYS * DAY)
    .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
    .slice(0, REPOS_MAX)
    .map((entry) => entry.repo);
}

// Wartet der Job auf einen eigenen Linux-Runner? Was auf GitHubs Runner wartet, geht RunClub nichts an.
function wantsOwnRunner(job) {
  const labels = (job.labels ?? []).map((label) => String(label).toLowerCase());
  return job.status === 'queued' && labels.includes('self-hosted') && !labels.includes('windows') && !labels.includes('macos');
}

function createWaiting({ gh }) {
  let found = []; // [{ repo, jobs: [Name, …], since (ISO), url }], das am längsten wartende Repo zuerst

  async function waitingIn(repo) {
    const runs = (await gh(['api', `repos/${repo}/actions/runs?status=queued&per_page=${RUNS_MAX}`])).workflow_runs ?? [];
    const jobs = [];
    for (const run of runs) {
      const waiting = ((await gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`])).jobs ?? []).filter(wantsOwnRunner);
      jobs.push(...waiting.map((job) => ({ name: job.name, since: job.created_at ?? run.created_at })));
    }
    if (!jobs.length) return null;
    return { repo, jobs: jobs.map((job) => job.name), since: jobs.map((job) => job.since).sort()[0], url: `https://github.com/${repo}/actions?query=is%3Aqueued` };
  }

  // Sieht die Repos der Reihe nach an. Ein Repo, das sich nicht lesen lässt, wird übergangen; scheitert alles
  // (kein Netz, Anfragelimit), bleibt der letzte Stand.
  async function scan(repos) {
    const next = [];
    let answered = 0;
    for (const repo of repos) {
      try {
        const entry = await waitingIn(repo);
        answered += 1;
        if (entry) next.push(entry);
      } catch { /* dieses Repo beim nächsten Mal wieder */ }
    }
    if (answered || !repos.length) found = next.sort((a, b) => String(a.since).localeCompare(String(b.since)));
    return found;
  }

  return { scan, list: () => found, forget: (repo) => { found = found.filter((entry) => entry.repo !== repo); } };
}

module.exports = { createWaiting, candidates, wantsOwnRunner };
