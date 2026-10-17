const test = require('node:test');
const assert = require('node:assert/strict');
const { deepFreeze: frozen, GitHubError } = require('../src/github');
const { createWaiting, candidates, wantsOwnRunner, neverStarted, minutesNote } = require('../src/waiting');
const { DAY } = require('../src/units');

const NOW = new Date('2026-10-13T12:00:00Z').getTime();
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();

test('only repos that could have a pool and moved recently are looked at', () => {
  const repos = [
    { repo: 'owner/old', private: true, pushedAt: daysAgo(30), free: true },
    { repo: 'owner/pool', private: true, pushedAt: daysAgo(1), free: false },
    { repo: 'owner/public', private: false, pushedAt: daysAgo(1), free: false },
    { repo: 'owner/earlier', private: true, pushedAt: daysAgo(1), free: true },
    { repo: 'owner/latest', private: true, pushedAt: daysAgo(0), free: true },
  ];
  assert.deepEqual(candidates(repos, NOW), ['owner/latest', 'owner/earlier']);
});

test('at most twenty repos, the most recently moved first', () => {
  const repos = Array.from({ length: 30 }, (_, i) => ({ repo: `owner/r${i}`, private: true, pushedAt: new Date(NOW - i * 60000).toISOString(), free: true }));
  const picked = candidates(repos, NOW);
  assert.equal(picked.length, 20);
  assert.equal(picked[0], 'owner/r0');
});

test('a job only counts if it waits for one of our own Linux runners', () => {
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['self-hosted', 'Linux'] }), true);
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['Self-Hosted'] }), true);
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['ubuntu-latest'] }), false);
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['self-hosted', 'Windows'] }), false);
  assert.equal(wantsOwnRunner({ status: 'in_progress', labels: ['self-hosted', 'Linux'] }), false);
  assert.equal(wantsOwnRunner({ status: 'queued' }), false);
});

// GitHub faked: per repo runs with their jobs (a run without `state` counts as queued); a job carries its
// annotations in `notes`. A repo in `broken` cannot be read.
// The answers are frozen like the real ones from github.js (`frozen`): code that sorts or changes one in place
// shows up here instead of only in operation.

function fakeGitHub(runsOf, broken = []) {
  const calls = [];
  const reply = async (path) => {
    calls.push(path);
    const repo = path.match(/^repos\/([^/]+\/[^/]+)\//)[1];
    if (broken.includes(repo)) throw new GitHubError(404, 'Not Found');
    const notes = path.match(/check-runs\/(\d+)\/annotations/);
    if (notes) return runsOf[repo].flatMap((run) => run.jobs).find((job) => String(job.id) === notes[1]).notes ?? [];
    const job = path.match(/runs\/(\d+)\/jobs/);
    if (job) return { jobs: runsOf[repo].find((run) => String(run.id) === job[1]).jobs.map(({ notes: _, ...rest }) => rest) };
    const status = path.match(/status=([a-z_]+)/)[1];
    return { workflow_runs: (runsOf[repo] ?? []).filter((run) => (run.state ?? 'queued') === status).map(({ jobs: _, state: __, ...run }) => run) };
  };
  return { get: async (path) => frozen(JSON.parse(JSON.stringify(await reply(path)))), calls };
}

const own = (name, created_at) => ({ name, status: 'queued', labels: ['self-hosted', 'Linux'], created_at });

test('finds the waiting jobs per repo, the one waiting longest first', async () => {
  const github = fakeGitHub({
    'owner/new': [{ id: 1, created_at: daysAgo(0), jobs: [own('Build', '2026-10-13T11:50:00Z'), { name: 'Lint', status: 'queued', labels: ['ubuntu-latest'] }] }],
    'owner/long': [{ id: 2, created_at: daysAgo(0), jobs: [own('Tests', '2026-10-13T09:00:00Z'), own('Package', '2026-10-13T09:05:00Z')] }],
    'owner/nothing': [],
  });
  const waiting = createWaiting({ github });
  assert.deepEqual(await waiting.scan(['owner/new', 'owner/long', 'owner/nothing']), [
    { repo: 'owner/long', reason: 'runner', jobs: ['Tests', 'Package'], since: '2026-10-13T09:00:00Z', url: 'https://github.com/owner/long/actions?query=is%3Aqueued' },
    { repo: 'owner/new', reason: 'runner', jobs: ['Build'], since: '2026-10-13T11:50:00Z', url: 'https://github.com/owner/new/actions?query=is%3Aqueued' },
  ]);
  assert.ok(github.calls.includes('repos/owner/nothing/actions/runs?status=queued&per_page=5'));
  assert.equal(waiting.list().length, 2);
});

test('an unreadable repo is skipped; if everything fails, the last state stays', async () => {
  const runs = { 'owner/a': [{ id: 1, created_at: daysAgo(0), jobs: [own('Build', '2026-10-13T11:00:00Z')] }], 'owner/b': [] };
  const first = createWaiting({ github: fakeGitHub(runs, ['owner/b']) });
  assert.deepEqual((await first.scan(['owner/a', 'owner/b'])).map((entry) => entry.repo), ['owner/a']);

  let down = false;
  const github = fakeGitHub(runs);
  const waiting = createWaiting({ github: { get: async (path) => { if (down) throw new Error('no network'); return github.get(path); } } });
  await waiting.scan(['owner/a']);
  down = true;
  assert.deepEqual((await waiting.scan(['owner/a'])).map((entry) => entry.repo), ['owner/a']);
});

test('a repo can be taken out of the state as soon as it gets a pool', async () => {
  const waiting = createWaiting({ github: fakeGitHub({ 'owner/a': [{ id: 1, created_at: daysAgo(0), jobs: [own('Build', '2026-10-13T11:00:00Z')] }] }) });
  await waiting.scan(['owner/a']);
  waiting.forget('owner/a');
  assert.deepEqual(waiting.list(), []);
});

test('even in a running run a later job can wait for one of our own runners', async () => {
  const github = fakeGitHub({ 'owner/a': [{ id: 7, state: 'in_progress', created_at: daysAgo(0), jobs: [{ name: 'Build', status: 'in_progress', labels: ['ubuntu-latest'] }, own('Deploy', '2026-10-13T11:30:00Z')] }] });
  const waiting = createWaiting({ github });
  assert.deepEqual((await waiting.scan(['owner/a'])).map((entry) => entry.jobs), [['Deploy']]);
  assert.ok(github.calls.includes('repos/owner/a/actions/runs?status=in_progress&per_page=5'));
});

test('a repo that is no longer looked at drops out of the state', async () => {
  const waiting = createWaiting({ github: fakeGitHub({ 'owner/a': [{ id: 1, created_at: daysAgo(0), jobs: [own('Build', '2026-10-13T11:00:00Z')] }] }) });
  await waiting.scan(['owner/a']);
  assert.deepEqual(await waiting.scan([]), []);
});

// --- Failed on the quota ---
// Modelled on run 38468791627 in Zaho92/RunClub: a job without steps and without a runner that ends as failed after
// two seconds, and two annotations on its check run.
const MINUTES_NOTE = { path: '.github', blob_href: 'https://github.com/owner/a/blob/e302c12/.github', start_line: 1, start_column: null, end_line: 1, end_column: null, annotation_level: 'failure', title: '', message: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings", raw_details: '' };
const NOTICE = { ...MINUTES_NOTE, annotation_level: 'notice', message: '"The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026. For more information, see https://github.com/actions/runner-images/issues/14748"' };
const unstarted = (id, notes = [MINUTES_NOTE, NOTICE]) => ({ id, name: 'Syntax and tests', status: 'completed', conclusion: 'failure', created_at: '2026-10-13T11:00:00Z', started_at: '2026-10-13T11:00:00Z', completed_at: '2026-10-13T11:00:02Z', steps: [], labels: ['ubuntu-latest'], runner_id: 0, runner_name: '', notes });
const done = (id, conclusion, created_at, jobs = [], updated_at = created_at) => ({ id, state: 'completed', status: 'completed', conclusion, created_at, updated_at, jobs });
const at = (now) => () => now;

test('a job counts as never started if it failed without steps; the annotation names the quota', () => {
  assert.equal(neverStarted(unstarted(1)), true);
  assert.equal(neverStarted({ conclusion: 'failure' }), true);
  assert.equal(neverStarted({ conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }] }), false);
  assert.equal(neverStarted({ conclusion: 'cancelled', steps: [] }), false);
  assert.equal(minutesNote([MINUTES_NOTE, NOTICE]), true);
  assert.equal(minutesNote([NOTICE]), false);
  assert.equal(minutesNote([{ ...MINUTES_NOTE, annotation_level: 'notice' }]), false);
  assert.equal(minutesNote([{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }]), false);
  assert.equal(minutesNote([]), false);
  assert.equal(minutesNote(null), false);
});

test('finds runs that failed on the quota: count, earliest time, link; one annotations request per run', async () => {
  const github = fakeGitHub({ 'owner/a': [
    done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120), unstarted(121)]),
    done(11, 'failure', '2026-10-13T08:00:00Z', [unstarted(110)]),
  ] });
  const waiting = createWaiting({ github, now: at(NOW) });
  assert.deepEqual(await waiting.scan(['owner/a']), [{ repo: 'owner/a', reason: 'minutes', runs: 2, since: '2026-10-13T08:00:00Z', url: 'https://github.com/owner/a/actions?query=is%3Afailure' }]);
  assert.deepEqual(github.calls.filter((path) => path.includes('annotations')), ['repos/owner/a/check-runs/120/annotations', 'repos/owner/a/check-runs/110/annotations']);
  // The request path stays the same from round to round, otherwise the conditional request would not apply.
  assert.ok(github.calls.includes('repos/owner/a/actions/runs?status=completed&per_page=15'));
});

test('counts only what names the quota as the reason: no real error, no old run, nothing before the last successful run', async () => {
  const real = { id: 300, name: 'Tests', status: 'completed', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }], labels: ['ubuntu-latest'] };
  const github = fakeGitHub({
    'owner/real': [done(30, 'failure', '2026-10-13T11:00:00Z', [real])],
    'owner/other': [done(31, 'failure', '2026-10-13T11:00:00Z', [unstarted(310, [NOTICE])])],
    'owner/old': [done(32, 'failure', daysAgo(2), [unstarted(320)])],
    'owner/fixed': [done(34, 'success', '2026-10-13T11:00:00Z'), done(33, 'failure', '2026-10-13T10:00:00Z', [unstarted(330)])],
    'owner/cancelled': [done(36, 'cancelled', '2026-10-13T11:00:00Z'), done(35, 'failure', '2026-10-13T10:00:00Z', [unstarted(350)])],
  });
  const waiting = createWaiting({ github, now: at(NOW) });
  assert.deepEqual((await waiting.scan(['owner/real', 'owner/other', 'owner/old', 'owner/fixed', 'owner/cancelled'])).map((entry) => [entry.repo, entry.runs]), [['owner/cancelled', 1]]);
  // A job with steps costs no annotations request; an old or superseded run none at all.
  assert.deepEqual(github.calls.filter((path) => /owner\/(real|old|fixed)\/.*(annotations|runs\/\d+\/jobs)/.test(path)), ['repos/owner/real/actions/runs/30/jobs?per_page=100']);
});

test('if a job waits for one of our own runners at the same time, that is the reason, and the quota is not queried', async () => {
  const github = fakeGitHub({ 'owner/a': [
    { id: 1, created_at: daysAgo(0), jobs: [own('Build', '2026-10-13T11:50:00Z')] },
    done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120)]),
  ] });
  const waiting = createWaiting({ github, now: at(NOW) });
  assert.deepEqual((await waiting.scan(['owner/a'])).map((entry) => entry.reason), ['runner']);
  assert.equal(github.calls.some((path) => path.includes('status=completed') || path.includes('annotations')), false);
});

test('a known run costs no request in the next round; restarted, it is looked at anew', async () => {
  const runs = { 'owner/a': [done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120)])] };
  const github = fakeGitHub(runs);
  const waiting = createWaiting({ github, now: at(NOW) });
  await waiting.scan(['owner/a']);
  github.calls.length = 0;
  assert.equal((await waiting.scan(['owner/a'])).length, 1);
  assert.deepEqual(github.calls, ['repos/owner/a/actions/runs?status=queued&per_page=5', 'repos/owner/a/actions/runs?status=in_progress&per_page=5', 'repos/owner/a/actions/runs?status=completed&per_page=15']);

  // Restarted and this time really failed: the same run with a new state.
  runs['owner/a'] = [done(12, 'failure', '2026-10-13T11:00:00Z', [{ id: 121, name: 'Syntax and tests', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }], '2026-10-13T11:40:00Z')];
  assert.deepEqual(await waiting.scan(['owner/a']), []);
});

test('after a day a run that failed on the quota drops out', async () => {
  const github = fakeGitHub({ 'owner/a': [done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120)])] });
  let now = NOW;
  const waiting = createWaiting({ github, now: () => now });
  assert.equal((await waiting.scan(['owner/a'])).length, 1);
  now += 24 * 3600000;
  assert.deepEqual(await waiting.scan(['owner/a']), []);
});

test('a restarted run counts from its last start, not from its creation', async () => {
  const rerun = { ...done(21, 'failure', '2026-10-11T08:00:00Z', [unstarted(210)], '2026-10-13T11:05:00Z'), run_started_at: '2026-10-13T11:00:00Z' };
  const waiting = createWaiting({ github: fakeGitHub({ 'owner/a': [rerun] }), now: at(NOW) });
  assert.deepEqual((await waiting.scan(['owner/a'])).map((entry) => [entry.reason, entry.since]), [['minutes', '2026-10-13T11:00:00Z']]);
});

test('counting is per workflow: another one that succeeds does not hide the failure; its own later success does', async () => {
  const runs = [
    { ...done(33, 'success', '2026-10-13T11:30:00Z'), workflow_id: 2 }, // another workflow succeeds
    { ...done(32, 'failure', '2026-10-13T11:00:00Z', [unstarted(320)]), workflow_id: 1 },
    { ...done(31, 'success', '2026-10-13T10:00:00Z'), workflow_id: 1 },
    { ...done(30, 'failure', '2026-10-13T09:00:00Z', [unstarted(300)]), workflow_id: 1 }, // before the success: superseded
  ];
  const waiting = createWaiting({ github: fakeGitHub({ 'owner/a': runs }), now: at(NOW) });
  assert.deepEqual((await waiting.scan(['owner/a'])).map((entry) => [entry.runs, entry.since]), [[1, '2026-10-13T11:00:00Z']]);
});

test('other billing wordings are recognised too, any other reason is not', () => {
  const note = (message) => [{ ...MINUTES_NOTE, message }];
  assert.equal(minutesNote(note('The job was not started because your account is locked due to a billing issue.')), true);
  assert.equal(minutesNote(note('The job was not started because the budget for Actions has been reached.')), true);
  assert.equal(minutesNote(note('The job was not started because no runner matched the labels.')), false);
});

test('the annotations of all jobs that never started are read until one matches', async () => {
  const github = fakeGitHub({ 'owner/a': [done(41, 'failure', '2026-10-13T11:00:00Z', [unstarted(410, [NOTICE]), unstarted(411)])] });
  const waiting = createWaiting({ github, now: at(NOW) });
  assert.equal((await waiting.scan(['owner/a'])).length, 1);
  assert.deepEqual(github.calls.filter((path) => path.includes('annotations')), ['repos/owner/a/check-runs/410/annotations', 'repos/owner/a/check-runs/411/annotations']);
});
