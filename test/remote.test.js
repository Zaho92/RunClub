const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemote, RERUN_SETTLE, WAITING_INTERVAL, REPO_LIST_MAX_AGE, CHECK_STALE, CHECK_RETRY } = require('../src/remote');
const { STATE: QUOTA, GitHubError } = require('../src/github');
const { BLOCKS } = require('../src/blocks');
const { turn, rendered } = require('./support');
const { render, reason } = require('../src/messages');

const REPO = 'wer/App';

// GitHub und der Rest nachgestellt. `answers[pfad]` liefert die Antwort auf `get(pfad)` (eine Funktion darf
// werfen oder ein Promise liefern); `calls` hält die gelesenen Pfade und die geschriebenen als `send <Methode> <pfad>`
// in ihrer Reihenfolge.
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
    // Wie actions.js: Sperren pausiert und markiert, Aufheben nimmt nur die Markierung.
    guard: {
      block: async (repo, kind, reason) => { w.guarded.push(['block', kind, reason]); Object.assign(w.settings[repo], { paused: true, [BLOCKS[kind]]: true }); },
      unblock: (repo, kind) => { w.guarded.push(['unblock', kind]); delete w.settings[repo][BLOCKS[kind]]; },
      restUnchecked: (repo) => w.guarded.push(['rest', repo]),
    },
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
  w.pools[REPO].slots = [{ name: 'PC-linux-1', state: 'working', workflow: '' }];
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
  w.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new GitHubError(502, 'Bad Gateway'); };
  await w.remote.refreshRepo(REPO);
  assert.equal(w.remote.view(REPO).error, 'Bad Gateway (HTTP 502)');
  assert.equal(w.remote.view(REPO).jobs.length, 1);
  const fresh = world();
  fresh.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new Error('kein Netz'); };
  await fresh.remote.refreshRepo(REPO);
  assert.deepEqual(fresh.remote.view(REPO), { jobs: [], runs: [], error: 'kein Netz', notFound: false });
  // 404: GitHub kennt das Repo nicht, oder die GitHub-App ist dort nicht installiert.
  fresh.answers[`repos/${REPO}/actions/runs?per_page=20`] = () => { throw new GitHubError(404, 'Not Found'); };
  await fresh.remote.refreshRepo(REPO);
  assert.equal(fresh.remote.view(REPO).notFound, true);
  assert.equal(w.remote.view(REPO).notFound, false);
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
  w.pools = { 'wer/a': { slots: [{ state: 'working' }] }, 'wer/b': { slots: [{ state: 'ready' }] }, 'wer/c': { slots: [] } };
  w.answers['repos/wer/c/actions/runs?per_page=20'] = { workflow_runs: [RUN] };
  w.pipelines = [{ ...PIPELINE, jobs: [{ name: 'Bauen', status: 'queued', own: true }] }];
  await w.remote.refreshRepo('wer/c');
  w.calls.length = 0;
  w.answers['repos/wer/a/actions/runs?per_page=20'] = { workflow_runs: [] };
  w.remote.refreshActive();
  await turn();
  assert.deepEqual(w.calls.sort(), ['repos/wer/a/actions/runs?per_page=20', 'repos/wer/c/actions/runs?per_page=20']);
});

const AT_1705 = new Date(2026, 9, 13, 17, 5).toISOString(); // als Uhrzeit dieses Rechners 17:05

test('das Anfragelimit: Meldung nur, wenn es kippt; nach dem Aufbrauchen wird CI_RUNNER nachgelesen', async () => {
  const cases = [
    [{ paused: true, resetAt: AT_1705 }, 'GitHub bittet um eine Pause (zu viele Anfragen in kurzer Zeit). Bis 17:05 wird nicht mehr abgefragt.'],
    [{ state: QUOTA.OUT, remaining: 10, limit: 5000, resetAt: AT_1705 }, 'GitHub-Anfragen sind aufgebraucht (10 von 5.000 frei). Bis 17:05 wird nicht mehr abgefragt; der Rest bleibt für das Anmelden neuer Runner.'],
    [{ state: QUOTA.TIGHT, remaining: 400, limit: 5000, resetAt: AT_1705 }, 'GitHub-Anfragen werden knapp (400 von 5.000 frei). Bis 17:05 wird seltener abgefragt.'],
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

test('ein öffentlich gewordenes Repo sperrt den Pool, einmal; wieder privat hebt die Sperre auf', async () => {
  const w = world();
  w.answers[`repos/${REPO}`] = { private: false };
  await w.remote.watchVisibility(REPO);
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded, [['block', 'public', undefined]]);
  assert.equal(w.calls.some((path) => path.includes('fork-pr')), false); // öffentlich: Forks zählen dann nicht mehr
  w.settings[REPO].paused = false; // von Hand fortgesetzt, an der Sperre vorbei: wird nachgezogen
  await w.remote.watchVisibility(REPO);
  assert.equal(w.guarded.length, 2);
  w.answers[`repos/${REPO}`] = { private: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.at(-1), ['unblock', 'public']);
  await w.remote.watchVisibility('wer/ohnePool');
  assert.equal(w.calls.includes('repos/wer/ohnePool'), false);
});

test('ein Org-Repo, in dem Fork-PRs laufen dürfen, sperrt den Pool; nicht lesbar ist ein eigener Grund, der „erlaubt“ nicht ablöst', async () => {
  const w = world();
  const forks = `repos/${REPO}/actions/permissions/fork-pr-workflows-private-repos`;
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'Organization' } };
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.map(([what, kind]) => [what, kind]), [['block', 'forks']]);
  assert.match(render(w.guarded[0][2]), /Forks/);
  w.answers[forks] = () => { throw new GitHubError(403, 'Forbidden'); }; // nicht lesbar: „erlaubt“ bleibt der Grund
  await w.remote.watchVisibility(REPO);
  assert.equal(w.guarded.length, 1);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: false };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.at(-1), ['unblock', 'forks']);
  w.answers[forks] = () => { throw new GitHubError(502, 'Bad Gateway'); }; // ohne bekannte Gefahr: eigener Grund
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.at(-1).slice(0, 2), ['block', 'forksUnknown']);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true }; // jetzt gelesen und erlaubt: Grund wechselt
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.slice(-2).map(([what, kind]) => [what, kind]), [['block', 'forks'], ['unblock', 'forksUnknown']]);
  delete w.settings[REPO].pausedForks;
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'User' } };
  const before = w.guarded.length;
  await w.remote.watchVisibility(REPO);
  assert.equal(w.guarded.length, before);
});

test('wird ein Repo wieder privat, während Fork-PRs erlaubt sind, wird erst gesperrt, dann aufgehoben', async () => {
  const w = world();
  Object.assign(w.settings[REPO], { paused: true, pausedPublic: true });
  w.answers[`repos/${REPO}`] = { private: true, owner: { type: 'Organization' } };
  w.answers[`repos/${REPO}/actions/permissions/fork-pr-workflows-private-repos`] = { run_workflows_from_fork_pull_requests: true };
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded.map(([what, kind]) => [what, kind]), [['block', 'forks'], ['unblock', 'public']]);
});

test('ein Pool gilt erst nach einer gelungenen Prüfung als geprüft und nur CHECK_STALE lang; scheitert sie, ruht er und es wird bald erneut geprüft', async () => {
  const w = world();
  const fail = (error) => { w.answers[`repos/${REPO}`] = () => { throw error; }; };
  const succeed = () => { w.answers[`repos/${REPO}`] = { private: true }; };
  const retries = () => w.timers.filter(({ ms }) => ms === CHECK_RETRY);
  assert.equal(w.remote.vetted(REPO), false); // beim Start: noch keine Prüfung
  fail(new Error('kein Netz'));
  await w.remote.watchVisibility(REPO);
  assert.deepEqual(w.guarded, [['rest', REPO]]);
  assert.deepEqual(w.logs.map(([text, , kind]) => [text.slice(0, 22), kind]), [['Sichtbarkeit des Repos', 'error'], ['Ob das Repo privat ist', 'error']]);
  assert.equal(retries().length, 1);
  await w.remote.watchVisibility(REPO); // etwa die Pflege dazwischen: keine Meldung, kein zweiter Versuch
  assert.deepEqual([w.guarded.length, w.logs.length, retries().length], [1, 2, 1]);
  succeed();
  w.timers.splice(w.timers.indexOf(retries()[0]), 1).at(0).work();
  await turn();
  assert.equal(w.remote.vetted(REPO), true);
  assert.equal(w.logs.at(-1)[0], 'Die Prüfung ist wieder gelungen; der Pool nimmt wieder Jobs an.');
  const expiry = w.timers.find(({ ms }) => ms === CHECK_STALE);
  assert.ok(expiry);
  // Später scheitert sie: Es wird gleich wieder versucht, der Pool arbeitet weiter, solange die letzte frisch ist.
  fail(new GitHubError(502, 'Bad Gateway'));
  w.time += CHECK_STALE - 1;
  await w.remote.watchVisibility(REPO);
  assert.deepEqual([w.remote.vetted(REPO), w.guarded.length, retries().length], [true, 1, 1]);
  assert.equal(w.logs.at(-1)[0], 'Sichtbarkeit des Repos – Bad Gateway (HTTP 502)');
  // Läuft sie ab, ruht der Pool sofort, ohne auf den nächsten Versuch zu warten.
  w.time += 1;
  expiry.work();
  assert.deepEqual(w.guarded, [['rest', REPO], ['rest', REPO]]);
  // Ein älterer Ablauf nach einer neueren gelungenen Prüfung tut nichts.
  succeed();
  await w.remote.watchVisibility(REPO);
  expiry.work();
  assert.equal(w.guarded.length, 2);
  // Ein eben angelegter Pool ist geprüft; ein entfernter vergessen.
  w.remote.markChecked('wer/Neu');
  assert.equal(w.remote.vetted('wer/Neu'), true);
  w.remote.forget('wer/Neu');
  assert.equal(w.remote.vetted('wer/Neu'), false);
});

test('erneut starten: nur für Repos mit Pool und mit einer Kennung aus Ziffern; danach wird das Repo neu abgefragt', async () => {
  const w = world();
  await w.remote.rerun(REPO, 77, 'runs/77/rerun', 'gibt es nicht');
  assert.deepEqual(w.calls, [`send POST repos/${REPO}/actions/runs/77/rerun`]);
  assert.deepEqual(w.timers.map((entry) => entry.ms), [RERUN_SETTLE]);
  await assert.rejects(w.remote.rerun('wer/Fremd', 1, 'runs/1/rerun', 'gibt es nicht'), { message: 'gibt es nicht' });
  await assert.rejects(w.remote.rerun(REPO, '1/../../x', 'runs/1/rerun', 'gibt es nicht'), { message: 'gibt es nicht' });
  assert.equal(w.calls.length, 1);
});
