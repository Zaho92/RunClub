const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaiting, candidates, wantsOwnRunner } = require('../src/waiting');

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

// GitHub nachgestellt: je Repo wartende Läufe mit ihren Jobs; ein Repo in `broken` lässt sich nicht lesen.
function fakeGitHub(runsOf, broken = []) {
  const calls = [];
  const gh = async ([, path]) => {
    calls.push(path);
    const repo = path.match(/^repos\/([^/]+\/[^/]+)\//)[1];
    if (broken.includes(repo)) throw new Error('gh: Not Found (HTTP 404)');
    const job = path.match(/runs\/(\d+)\/jobs/);
    if (job) return { jobs: runsOf[repo].find((run) => String(run.id) === job[1]).jobs };
    const status = path.match(/status=([a-z_]+)/)[1]; // ein Lauf ohne `state` gilt als wartend
    return { workflow_runs: (runsOf[repo] ?? []).filter((run) => (run.state ?? 'queued') === status).map(({ id, created_at }) => ({ id, created_at })) };
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
    { repo: 'wer/lange', jobs: ['Tests', 'Paket'], since: '2026-10-13T09:00:00Z', url: 'https://github.com/wer/lange/actions?query=is%3Aqueued' },
    { repo: 'wer/neu', jobs: ['Bauen'], since: '2026-10-13T11:50:00Z', url: 'https://github.com/wer/neu/actions?query=is%3Aqueued' },
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
