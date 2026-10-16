const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemote, RERUN_SETTLE, WAITING_INTERVAL, REPO_LIST_MAX_AGE } = require('../src/remote');
const { STATE: QUOTA } = require('../src/github');
const { turn } = require('./support');

const REPO = 'wer/App';

// GitHub und der Rest nachgestellt. `answers[pfad]` liefert die Antwort auf `gh api <pfad>` (eine Funktion darf
// werfen oder ein Promise liefern); `calls` hält die Pfade in ihrer Reihenfolge.
function world() {
  const w = {
    calls: [], logs: [], timers: [], public: [], private: [], forks: [], forksClosed: [], time: 1000000, checked: [], scanned: null, stopping: false, may: () => true,
    settings: { [REPO]: { repo: REPO } }, pools: { [REPO]: { slots: [] } }, quota: null,
    answers: {}, pipelines: [], confirmed: [],
  };
  const gh = async (args) => {
    const at = args.at(-1);
    w.calls.push(args.length > 2 ? `${args[2]} ${at}` : at);
    const answer = w.answers[at];
    return typeof answer === 'function' ? answer() : answer;
  };
  w.remote = createRemote({
    gh,
    githubApi: { mayPoll: (...args) => w.may(...args), refreshQuota: async () => w.quota },
    pipelines: { refresh: async () => w.pipelines, lastOf: () => w.last ?? null, finishedOf: () => w.finished ?? [] },
    confirmResults: (repo, done) => w.confirmed.push([repo, done]),
    routing: { check: async (repo) => { w.checked.push(repo); } },
    waiting: { scan: async (found) => { w.scanned = found; } },
    log: (...entry) => w.logs.push(entry),
    logError: (repo, what) => (error) => w.logs.push([`${what} – ${error.message}`, repo, 'error']),
    repos: () => Object.keys(w.settings), settingsOf: (repo) => w.settings[repo], poolOf: (repo) => w.pools[repo],
    stopping: () => w.stopping, timer: (work, ms) => w.timers.push({ work, ms }),
    now: () => w.time, onPublic: async (repo) => { w.public.push(repo); }, onPrivate: async (repo) => { w.private.push(repo); },
    onForks: async (repo, reason) => { w.forks.push([repo, reason]); }, onForksClosed: async (repo) => { w.forksClosed.push(repo); },
  });
  return w;
}

const RUN = { id: 5, name: 'CI', head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null, run_started_at: '2026-10-14T10:00:00Z', html_url: 'https://github.com/wer/App/actions/runs/5', display_title: 'Neu' };
const PIPELINE = { workflow: 'CI', branch: 'main', jobs: [
  { name: 'Bauen', status: 'in_progress', runner: 'PC-linux-1', own: true, startedAt: 'x', url: 'u', estimate: 60, step: null },
  { name: 'Prüfen', status: 'pending' }, { name: 'Fertig', status: 'completed' },
] };

test('ein Repo abfragen: Läufe, laufende Jobs, und der arbeitende Platz erfährt seinen Workflow', async () => {
  const w = world();
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = { workflow_runs: [RUN] };
  w.pipelines = [PIPELINE];
  w.pools[REPO].slots = [{ name: 'PC-linux-1', state: 'arbeitet', workflow: '' }];
  await w.remote.refreshRepo(REPO);
  const view = w.remote.view(REPO);
  assert.deepEqual(view.jobs, [{ workflow: 'CI', job: 'Bauen', branch: 'main', status: 'in_progress', runner: 'PC-linux-1', own: true, startedAt: 'x', url: 'u', estimate: 60, step: null }]);
  assert.deepEqual(view.runs, [{ id: 5, name: 'CI', branch: 'main', event: 'push', status: 'in_progress', conclusion: null, at: RUN.run_started_at, url: RUN.html_url, title: 'Neu' }]);
  assert.equal(view.error, null);
  assert.equal(w.pools[REPO].slots[0].workflow, 'CI');
  assert.equal(w.remote.view('wer/Fremd'), null);
});

test('abgeschlossene Jobs der eigenen Runner gehen mit dem Ergebnis von GitHub an die Messung, auch aus eben beendeten und dem letzten fertigen Lauf', async () => {
  const w = world();
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = { workflow_runs: [RUN] };
  w.pipelines = [{ ...PIPELINE, jobs: [
    { name: 'Bauen', status: 'completed', conclusion: 'failure', own: true, runner: 'PC-linux-1' },
    { name: 'Fremd', status: 'completed', conclusion: 'success', own: false, runner: 'GitHub Actions 3' },
    { name: 'Testen', status: 'in_progress', conclusion: null, own: true, runner: 'PC-linux-2' },
  ] }];
  w.last = { ...PIPELINE, jobs: [{ name: 'Alt', status: 'completed', conclusion: 'success', own: true, runner: 'PC-linux-0' }] };
  w.finished = [{ ...PIPELINE, jobs: [{ name: 'Eben', status: 'completed', conclusion: 'success', own: true, runner: 'PC-linux-3' }] }];
  await w.remote.refreshRepo(REPO);
  assert.deepEqual(w.confirmed, [[REPO, [{ runner: 'PC-linux-1', conclusion: 'failure' }, { runner: 'PC-linux-3', conclusion: 'success' }, { runner: 'PC-linux-0', conclusion: 'success' }]]]);
});

test('scheitert die Abfrage, bleiben Jobs und Läufe stehen und der Fehler kommt dazu', async () => {
  const w = world();
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = { workflow_runs: [RUN] };
  w.pipelines = [PIPELINE];
  await w.remote.refreshRepo(REPO);
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new Error('HTTP 502'); };
  await w.remote.refreshRepo(REPO);
  assert.equal(w.remote.view(REPO).error, 'HTTP 502');
  assert.equal(w.remote.view(REPO).jobs.length, 1);
  const fresh = world();
  fresh.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new Error('kein Netz'); };
  await fresh.remote.refreshRepo(REPO);
  assert.deepEqual(fresh.remote.view(REPO), { jobs: [], runs: [], error: 'kein Netz' });
});

test('läuft schon eine Abfrage, folgt genau eine weitere; bei knappem Limit keine', async () => {
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

test('öfter abgefragt wird, wo ein eigener Platz arbeitet oder ein Job auf einen eigenen Runner wartet', async () => {
  const w = world();
  w.settings = { 'wer/a': {}, 'wer/b': {}, 'wer/c': {} };
  w.pools = { 'wer/a': { slots: [{ state: 'arbeitet' }] }, 'wer/b': { slots: [{ state: 'bereit' }] }, 'wer/c': { slots: [] } };
  w.answers['repos/wer/c/actions/runs?per_page=20'] = { workflow_runs: [RUN] };
  w.pipelines = [{ ...PIPELINE, jobs: [{ name: 'Bauen', status: 'queued', own: true }] }];
  await w.remote.refreshRepo('wer/c');
  w.calls.length = 0;
  w.answers['repos/wer/a/actions/runs?per_page=20'] = { workflow_runs: [] };
  w.remote.refreshActive();
  await turn();
  assert.deepEqual(w.calls.sort(), ['repos/wer/a/actions/runs?per_page=20', 'repos/wer/c/actions/runs?per_page=20']);
});

test('das Anfragelimit: Meldung nur, wenn es kippt; nach dem Aufbrauchen wird CI_RUNNER nachgelesen', async () => {
  const cases = [
    [{ paused: true, until: '17:05' }, 'GitHub bittet um eine Pause (zu viele Anfragen in kurzer Zeit). Bis 17:05 wird nicht mehr abgefragt.'],
    [{ state: QUOTA.OUT, remaining: 10, limit: 5000, until: '17:05' }, 'GitHub-Anfragen sind aufgebraucht (10 von 5000 frei). Bis 17:05 wird nicht mehr abgefragt; der Rest bleibt für das Anmelden neuer Runner.'],
    [{ state: QUOTA.TIGHT, remaining: 400, limit: 5000, until: '17:05' }, 'GitHub-Anfragen werden knapp (400 von 5000 frei). Bis 17:05 wird seltener abgefragt.'],
    [{ state: QUOTA.OK, before: QUOTA.TIGHT }, 'GitHub-Anfragen sind wieder frei; es wird wieder im gewohnten Takt abgefragt.'],
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
  assert.deepEqual(first.logs, []); // der erste Stand nach dem Start ist keine Änderung

  const back = world();
  back.quota = { state: QUOTA.OK, before: QUOTA.OUT };
  await back.remote.watchQuota();
  assert.deepEqual(back.checked, [REPO]);
});

test('die Repos des Kontos: nur mit Verwaltungsrecht und nicht archiviert, seitenweise, eine Weile zwischengespeichert', async () => {
  const w = world();
  const repo = (name, more) => ({ full_name: name, private: true, pushed_at: 'p', permissions: { admin: true }, archived: false, ...more });
  w.answers['user/repos?per_page=100&page=1&sort=pushed'] = [...Array.from({ length: 98 }, (_, index) => repo(`wer/r${index}`)), repo('wer/fremd', { permissions: { admin: false } }), repo('wer/alt', { archived: true })];
  w.answers['user/repos?per_page=100&page=2&sort=pushed'] = [repo(REPO), repo('wer/offen', { private: false })];
  const found = await w.remote.listRepos();
  assert.equal(found.length, 100);
  assert.deepEqual(found.slice(-2), [
    { repo: REPO, private: true, pushedAt: 'p', pool: true, free: false },
    { repo: 'wer/offen', private: false, pushedAt: 'p', pool: false, free: false },
  ]);
  await w.remote.listRepos();
  assert.equal(w.calls.length, 2);
  w.time += REPO_LIST_MAX_AGE + 1; // danach wird neu gelesen
  await w.remote.listRepos();
  assert.equal(w.calls.length, 4);
});

test('wartende Läufe: Kandidaten aus der Liste der Repos; bei knappem Limit seltener, beim Beenden nicht', async () => {
  const w = world();
  w.answers['user/repos?per_page=100&page=1&sort=pushed'] = [];
  let asked = null;
  w.may = (key, every) => { asked = [key, every]; return true; };
  await w.remote.scanWaiting();
  assert.deepEqual(w.scanned, []);
  assert.deepEqual(asked, ['wartende Läufe', 3 * WAITING_INTERVAL]);
  w.stopping = true;
  w.scanned = null;
  await w.remote.scanWaiting();
  assert.equal(w.scanned, null);
});

test('ein öffentlich gewordenes Repo wird gemeldet, solange sein Pool nicht deshalb pausiert ist; wieder privat ebenso', async () => {
  const w = world();
  w.answers[`repos/${REPO}`] = { private: false };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.public, [REPO]);
  w.settings[REPO].pausedPublic = true; // so hält actions.js es fest
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.public, [REPO]);
  w.answers[`repos/${REPO}`] = { private: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.private, [REPO]);
  delete w.settings[REPO].pausedPublic;
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.private, [REPO]);
  await w.remote.watchVisibility('wer/ohnePool');
  assert.equal(w.calls.includes('repos/wer/ohnePool'), false);
  w.answers[`repos/${REPO}`] = () => { throw new Error('HTTP 404'); };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.logs, [['Sichtbarkeit des Repos – HTTP 404', REPO, 'error']]);
});

test('ein Org-Repo, in dem Fork-PRs laufen dürfen, wird gemeldet, solange sein Pool nicht deshalb pausiert ist; abgeschaltet ebenso', async () => {
  const w = world();
  const forks = `repos/${REPO}/actions/permissions/fork-pr-workflows-private-repos`;
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'Organization' } };
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.forks.map(([repo]) => repo), [REPO]);
  assert.match(w.forks[0][1], /Forks/);
  w.settings[REPO].pausedForks = true; // so hält actions.js es fest
  await w.remote.watchVisibility(REPO);
  assert.equal(w.forks.length, 1);
  w.answers[forks] = () => { throw new Error('HTTP 403'); }; // nicht lesbar: bleibt pausiert
  await w.remote.watchVisibility(REPO);
  assert.deepEqual([w.forks.length, w.forksClosed], [1, []]);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: false };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.forksClosed, [REPO]);
  delete w.settings[REPO].pausedForks;
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'User' } };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual([w.forks.length, w.forksClosed.length, w.public, w.private], [1, 1, [], []]);
});

test('erneut starten: nur für Repos mit Pool und mit einer Kennung aus Ziffern; danach wird das Repo neu abgefragt', async () => {
  const w = world();
  await w.remote.rerun(REPO, 77, 'runs/77/rerun', 'gibt es nicht');
  assert.deepEqual(w.calls, [`POST repos/${REPO}/actions/runs/77/rerun`]);
  assert.deepEqual(w.timers.map((entry) => entry.ms), [RERUN_SETTLE]);
  await assert.rejects(w.remote.rerun('wer/Fremd', 1, 'runs/1/rerun', 'gibt es nicht'), { message: 'gibt es nicht' });
  await assert.rejects(w.remote.rerun(REPO, '1/../../x', 'runs/1/rerun', 'gibt es nicht'), { message: 'gibt es nicht' });
  assert.equal(w.calls.length, 1);
});
