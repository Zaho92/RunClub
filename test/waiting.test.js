const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaiting, candidates, wantsOwnRunner, neverStarted, quotaNote } = require('../src/waiting');

const NOW = new Date('2026-10-13T12:00:00Z').getTime();
const daysAgo = (days) => new Date(NOW - days * 24 * 3600000).toISOString();

test('angesehen werden nur Repos, für die ein Pool möglich ist und die zuletzt bewegt wurden', () => {
  const repos = [
    { repo: 'wer/alt', private: true, pushedAt: daysAgo(30), free: true },
    { repo: 'wer/pool', private: true, pushedAt: daysAgo(1), free: false },
    { repo: 'wer/offen', private: false, pushedAt: daysAgo(1), free: false },
    { repo: 'wer/gestern', private: true, pushedAt: daysAgo(1), free: true },
    { repo: 'wer/heute', private: true, pushedAt: daysAgo(0), free: true },
  ];
  assert.deepEqual(candidates(repos, NOW), ['wer/heute', 'wer/gestern']);
});

test('höchstens zwanzig Repos, die zuletzt bewegten zuerst', () => {
  const repos = Array.from({ length: 30 }, (_, i) => ({ repo: `wer/r${i}`, private: true, pushedAt: new Date(NOW - i * 60000).toISOString(), free: true }));
  const picked = candidates(repos, NOW);
  assert.equal(picked.length, 20);
  assert.equal(picked[0], 'wer/r0');
});

test('ein Job zählt nur, wenn er auf einen eigenen Linux-Runner wartet', () => {
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['self-hosted', 'Linux'] }), true);
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['Self-Hosted'] }), true);
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['ubuntu-latest'] }), false);
  assert.equal(wantsOwnRunner({ status: 'queued', labels: ['self-hosted', 'Windows'] }), false);
  assert.equal(wantsOwnRunner({ status: 'in_progress', labels: ['self-hosted', 'Linux'] }), false);
  assert.equal(wantsOwnRunner({ status: 'queued' }), false);
});

// GitHub nachgestellt: je Repo Läufe mit ihren Jobs (ein Lauf ohne `state` gilt als wartend); ein Job trägt seine
// Anmerkungen in `notes`. Ein Repo in `broken` lässt sich nicht lesen.
function fakeGitHub(runsOf, broken = []) {
  const calls = [];
  const gh = async ([, path]) => {
    calls.push(path);
    const repo = path.match(/^repos\/([^/]+\/[^/]+)\//)[1];
    if (broken.includes(repo)) throw new Error('gh: Not Found (HTTP 404)');
    const notes = path.match(/check-runs\/(\d+)\/annotations/);
    if (notes) return runsOf[repo].flatMap((run) => run.jobs).find((job) => String(job.id) === notes[1]).notes ?? [];
    const job = path.match(/runs\/(\d+)\/jobs/);
    if (job) return { jobs: runsOf[repo].find((run) => String(run.id) === job[1]).jobs.map(({ notes: _, ...rest }) => rest) };
    const status = path.match(/status=([a-z_]+)/)[1];
    return { workflow_runs: (runsOf[repo] ?? []).filter((run) => (run.state ?? 'queued') === status).map(({ jobs: _, state: __, ...run }) => run) };
  };
  return { gh, calls };
}

const own = (name, created_at) => ({ name, status: 'queued', labels: ['self-hosted', 'Linux'], created_at });

test('findet die wartenden Jobs je Repo, das am längsten wartende zuerst', async () => {
  const github = fakeGitHub({
    'wer/neu': [{ id: 1, created_at: daysAgo(0), jobs: [own('Bauen', '2026-10-13T11:50:00Z'), { name: 'Lint', status: 'queued', labels: ['ubuntu-latest'] }] }],
    'wer/lange': [{ id: 2, created_at: daysAgo(0), jobs: [own('Tests', '2026-10-13T09:00:00Z'), own('Paket', '2026-10-13T09:05:00Z')] }],
    'wer/nichts': [],
  });
  const waiting = createWaiting({ gh: github.gh });
  assert.deepEqual(await waiting.scan(['wer/neu', 'wer/lange', 'wer/nichts']), [
    { repo: 'wer/lange', reason: 'runner', jobs: ['Tests', 'Paket'], since: '2026-10-13T09:00:00Z', url: 'https://github.com/wer/lange/actions?query=is%3Aqueued' },
    { repo: 'wer/neu', reason: 'runner', jobs: ['Bauen'], since: '2026-10-13T11:50:00Z', url: 'https://github.com/wer/neu/actions?query=is%3Aqueued' },
  ]);
  assert.ok(github.calls.includes('repos/wer/nichts/actions/runs?status=queued&per_page=5'));
  assert.equal(waiting.list().length, 2);
});

test('ein unlesbares Repo wird übergangen; scheitert alles, bleibt der letzte Stand', async () => {
  const runs = { 'wer/a': [{ id: 1, created_at: daysAgo(0), jobs: [own('Bauen', '2026-10-13T11:00:00Z')] }], 'wer/b': [] };
  const first = createWaiting({ gh: fakeGitHub(runs, ['wer/b']).gh });
  assert.deepEqual((await first.scan(['wer/a', 'wer/b'])).map((entry) => entry.repo), ['wer/a']);

  let down = false;
  const github = fakeGitHub(runs);
  const waiting = createWaiting({ gh: async (args) => { if (down) throw new Error('kein Netz'); return github.gh(args); } });
  await waiting.scan(['wer/a']);
  down = true;
  assert.deepEqual((await waiting.scan(['wer/a'])).map((entry) => entry.repo), ['wer/a']);
});

test('ein Repo lässt sich aus dem Stand nehmen, sobald es einen Pool bekommt', async () => {
  const waiting = createWaiting({ gh: fakeGitHub({ 'wer/a': [{ id: 1, created_at: daysAgo(0), jobs: [own('Bauen', '2026-10-13T11:00:00Z')] }] }).gh });
  await waiting.scan(['wer/a']);
  waiting.forget('wer/a');
  assert.deepEqual(waiting.list(), []);
});

test('auch in einem laufenden Lauf kann ein späterer Job auf einen eigenen Runner warten', async () => {
  const github = fakeGitHub({ 'wer/a': [{ id: 7, state: 'in_progress', created_at: daysAgo(0), jobs: [{ name: 'Bauen', status: 'in_progress', labels: ['ubuntu-latest'] }, own('Ausliefern', '2026-10-13T11:30:00Z')] }] });
  const waiting = createWaiting({ gh: github.gh });
  assert.deepEqual((await waiting.scan(['wer/a'])).map((entry) => entry.jobs), [['Ausliefern']]);
  assert.ok(github.calls.includes('repos/wer/a/actions/runs?status=in_progress&per_page=5'));
});

test('ein Repo, das nicht mehr angesehen wird, fällt aus dem Stand', async () => {
  const waiting = createWaiting({ gh: fakeGitHub({ 'wer/a': [{ id: 1, created_at: daysAgo(0), jobs: [own('Bauen', '2026-10-13T11:00:00Z')] }] }).gh });
  await waiting.scan(['wer/a']);
  assert.deepEqual(await waiting.scan([]), []);
});

// --- Am Kontingent gescheitert ---
// Vorlage ist der Lauf 38468791627 in Zaho92/RunClub: ein Job ohne Schritte und ohne Runner, der nach zwei Sekunden
// als gescheitert endet, und zwei Anmerkungen an seinem Check-Run.
const QUOTA_NOTE = { path: '.github', blob_href: 'https://github.com/wer/a/blob/e302c12/.github', start_line: 1, start_column: null, end_line: 1, end_column: null, annotation_level: 'failure', title: '', message: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings", raw_details: '' };
const NOTICE = { ...QUOTA_NOTE, annotation_level: 'notice', message: '"The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026. For more information, see https://github.com/actions/runner-images/issues/14748"' };
const unstarted = (id, notes = [QUOTA_NOTE, NOTICE]) => ({ id, name: 'Syntax und Tests', status: 'completed', conclusion: 'failure', created_at: '2026-10-13T11:00:00Z', started_at: '2026-10-13T11:00:00Z', completed_at: '2026-10-13T11:00:02Z', steps: [], labels: ['ubuntu-latest'], runner_id: 0, runner_name: '', notes });
const done = (id, conclusion, created_at, jobs = [], updated_at = created_at) => ({ id, state: 'completed', status: 'completed', conclusion, created_at, updated_at, jobs });
const at = (now) => () => now;

test('ein Job gilt als nie gestartet, wenn er ohne Schritte gescheitert ist; die Anmerkung nennt das Kontingent', () => {
  assert.equal(neverStarted(unstarted(1)), true);
  assert.equal(neverStarted({ conclusion: 'failure' }), true);
  assert.equal(neverStarted({ conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }] }), false);
  assert.equal(neverStarted({ conclusion: 'cancelled', steps: [] }), false);
  assert.equal(quotaNote([QUOTA_NOTE, NOTICE]), true);
  assert.equal(quotaNote([NOTICE]), false);
  assert.equal(quotaNote([{ ...QUOTA_NOTE, annotation_level: 'notice' }]), false);
  assert.equal(quotaNote([{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }]), false);
  assert.equal(quotaNote([]), false);
  assert.equal(quotaNote(null), false);
});

test('findet Läufe, die am Kontingent gescheitert sind: Anzahl, ältester Zeitpunkt, Link; je Lauf eine Abfrage der Anmerkungen', async () => {
  const github = fakeGitHub({ 'wer/a': [
    done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120), unstarted(121)]),
    done(11, 'failure', '2026-10-13T08:00:00Z', [unstarted(110)]),
  ] });
  const waiting = createWaiting({ gh: github.gh, now: at(NOW) });
  assert.deepEqual(await waiting.scan(['wer/a']), [{ repo: 'wer/a', reason: 'quota', runs: 2, since: '2026-10-13T08:00:00Z', url: 'https://github.com/wer/a/actions?query=is%3Afailure' }]);
  assert.deepEqual(github.calls.filter((path) => path.includes('annotations')), ['repos/wer/a/check-runs/120/annotations', 'repos/wer/a/check-runs/110/annotations']);
  // Der Pfad der Abfrage bleibt von Runde zu Runde gleich, sonst griffe die bedingte Abfrage nicht.
  assert.ok(github.calls.includes('repos/wer/a/actions/runs?status=completed&per_page=5'));
});

test('zählt nur, was das Kontingent als Grund nennt: kein echter Fehler, kein alter Lauf, nichts vor dem letzten gelungenen Lauf', async () => {
  const real = { id: 300, name: 'Tests', status: 'completed', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }], labels: ['ubuntu-latest'] };
  const github = fakeGitHub({
    'wer/echt': [done(30, 'failure', '2026-10-13T11:00:00Z', [real])],
    'wer/anders': [done(31, 'failure', '2026-10-13T11:00:00Z', [unstarted(310, [NOTICE])])],
    'wer/alt': [done(32, 'failure', daysAgo(2), [unstarted(320)])],
    'wer/behoben': [done(34, 'success', '2026-10-13T11:00:00Z'), done(33, 'failure', '2026-10-13T10:00:00Z', [unstarted(330)])],
    'wer/abgebrochen': [done(36, 'cancelled', '2026-10-13T11:00:00Z'), done(35, 'failure', '2026-10-13T10:00:00Z', [unstarted(350)])],
  });
  const waiting = createWaiting({ gh: github.gh, now: at(NOW) });
  assert.deepEqual((await waiting.scan(['wer/echt', 'wer/anders', 'wer/alt', 'wer/behoben', 'wer/abgebrochen'])).map((entry) => [entry.repo, entry.runs]), [['wer/abgebrochen', 1]]);
  // Ein Job mit Schritten kostet keine Abfrage der Anmerkungen; ein alter oder überholter Lauf gar keine.
  assert.deepEqual(github.calls.filter((path) => /wer\/(echt|alt|behoben)\/.*(annotations|runs\/\d+\/jobs)/.test(path)), ['repos/wer/echt/actions/runs/30/jobs?per_page=100']);
});

test('wartet zugleich ein Job auf einen eigenen Runner, ist das der Grund, und das Kontingent wird nicht abgefragt', async () => {
  const github = fakeGitHub({ 'wer/a': [
    { id: 1, created_at: daysAgo(0), jobs: [own('Bauen', '2026-10-13T11:50:00Z')] },
    done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120)]),
  ] });
  const waiting = createWaiting({ gh: github.gh, now: at(NOW) });
  assert.deepEqual((await waiting.scan(['wer/a'])).map((entry) => entry.reason), ['runner']);
  assert.equal(github.calls.some((path) => path.includes('status=completed') || path.includes('annotations')), false);
});

test('ein bekannter Lauf kostet in der nächsten Runde keine Abfrage; erneut gestartet wird er neu angesehen', async () => {
  const runs = { 'wer/a': [done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120)])] };
  const github = fakeGitHub(runs);
  const waiting = createWaiting({ gh: github.gh, now: at(NOW) });
  await waiting.scan(['wer/a']);
  github.calls.length = 0;
  assert.equal((await waiting.scan(['wer/a'])).length, 1);
  assert.deepEqual(github.calls, ['repos/wer/a/actions/runs?status=queued&per_page=5', 'repos/wer/a/actions/runs?status=in_progress&per_page=5', 'repos/wer/a/actions/runs?status=completed&per_page=5']);

  // Erneut gestartet und diesmal echt gescheitert: derselbe Lauf mit neuem Stand.
  runs['wer/a'] = [done(12, 'failure', '2026-10-13T11:00:00Z', [{ id: 121, name: 'Syntax und Tests', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }], '2026-10-13T11:40:00Z')];
  assert.deepEqual(await waiting.scan(['wer/a']), []);
});

test('nach einem Tag fällt ein am Kontingent gescheiterter Lauf heraus', async () => {
  const github = fakeGitHub({ 'wer/a': [done(12, 'failure', '2026-10-13T11:00:00Z', [unstarted(120)])] });
  let now = NOW;
  const waiting = createWaiting({ gh: github.gh, now: () => now });
  assert.equal((await waiting.scan(['wer/a'])).length, 1);
  now += 24 * 3600000;
  assert.deepEqual(await waiting.scan(['wer/a']), []);
});
