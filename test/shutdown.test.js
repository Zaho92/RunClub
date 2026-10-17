const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShutdown, FILE } = require('../src/shutdown');

// Two projects with a pool; `left` holds what is still standing there, the clock stands still until the test sets it.
function world(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-shutdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (saved !== undefined) fs.writeFileSync(path.join(dir, FILE), typeof saved === 'string' ? saved : JSON.stringify(saved));
  const w = { dir, at: 1_000_000, left: { 'who/App': { pairs: 3, job: 'Integration tests' }, 'who/Two': { pairs: 2, job: null } } };
  w.shutdown = createShutdown({ dataDir: dir, repos: () => Object.keys(w.left), remaining: (repo) => w.left[repo] ?? null, wait: 30_000, now: () => w.at });
  return w;
}
const iso = (ms) => new Date(ms).toISOString();

test('without a shutdown there is no state', (t) => {
  assert.equal(world(t).shutdown.view(), null);
});

test('the dismantling counts per project what is already gone, and names the job being cancelled', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.at += 4000;
  w.left['who/Two'] = { pairs: 0, job: null };
  w.left['who/App'] = { pairs: 2, job: 'Integration tests' };
  let view = w.shutdown.view();
  assert.equal(view.startedAt, iso(1_000_000));
  assert.deepEqual(view.projects, [
    { repo: 'who/App', total: 3, removed: 1, job: 'Integration tests', endedAt: null },
    { repo: 'who/Two', total: 2, removed: 2, job: null, endedAt: iso(1_004_000) },
  ]);
  assert.equal(view.cleanup.state, 'wait');
  assert.equal(view.signoff.state, 'wait');
  assert.equal(view.signoff.total, 2); // before signing off: one per project
  // Without a stored duration no estimate.
  assert.equal(view.finishAt, null);
  assert.equal(view.last, null);
  assert.equal(view.over, false);
  assert.equal(view.wait, 30);
  assert.equal(view.cleanup.estimate, null);

  // A project that was already done stays so, even if it is no longer asked.
  w.at += 1000;
  view = w.shutdown.view();
  assert.equal(view.projects[1].endedAt, iso(1_004_000));
});

test('the cleanup ends the dismantling; what is still standing then counts as dismantled', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.at += 30000;
  w.shutdown.step('cleanup');
  const view = w.shutdown.view();
  assert.deepEqual(view.projects.map((project) => [project.removed, project.endedAt]), [[3, iso(1_030_000)], [2, iso(1_030_000)]]);
  assert.deepEqual(view.cleanup, { state: 'run', startedAt: iso(1_030_000), endedAt: null, estimate: null });
});

test('the sign-off counts the projects; at the end the duration of each stage is stored', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.at += 8000;
  w.shutdown.step('cleanup');
  w.at += 2000;
  w.shutdown.step('signoff', 2);
  w.shutdown.step('signedOff');
  let view = w.shutdown.view();
  assert.equal(view.cleanup.state, 'done');
  assert.deepEqual(view.signoff, { state: 'run', startedAt: iso(1_010_000), endedAt: null, estimate: null, total: 2, done: 1 });
  w.at += 1000;
  w.shutdown.step('signedOff');
  w.shutdown.finish();
  view = w.shutdown.view();
  assert.equal(view.signoff.state, 'done');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.dir, FILE), 'utf8')), { dismantle: 8000, cleanup: 2000, signoff: 1000 });
});

test('with the duration of the last shutdown: time left, estimate per stage and the total duration', (t) => {
  const w = world(t, { dismantle: 8000, cleanup: 2000, signoff: 1000 });
  w.shutdown.begin();
  w.at += 3000;
  let view = w.shutdown.view();
  assert.equal(view.last, 11);
  assert.equal(view.finishAt, iso(w.at + 5000 + 2000 + 1000));
  assert.equal(view.cleanup.estimate, 2);
  assert.equal(view.signoff.estimate, 1);

  // If the dismantling takes longer than last time, only the waiting stages still count, …
  w.at += 20000;
  view = w.shutdown.view();
  assert.equal(view.finishAt, iso(w.at + 3000));
  // … and if that is exceeded as well, there is no time left anymore, but a note saying so.
  assert.equal(view.over, false);
  w.shutdown.step('cleanup');
  w.shutdown.step('signoff', 2);
  w.at += 5000;
  view = w.shutdown.view();
  assert.deepEqual([view.finishAt, view.over], [null, true]);
});

test('a broken or incomplete file means: no estimate', (t) => {
  for (const saved of ['{broken', { dismantle: 8000, cleanup: 2000 }, { dismantle: -1, cleanup: 2000, signoff: 1000 }]) {
    const w = world(t, saved);
    w.shutdown.begin();
    assert.equal(w.shutdown.view().finishAt, null);
  }
});

test('a second begin changes nothing; neither do step and finish without a shutdown', (t) => {
  const w = world(t);
  w.shutdown.step('cleanup');
  w.shutdown.finish();
  assert.equal(fs.existsSync(path.join(w.dir, FILE)), false);
  w.shutdown.begin();
  w.at += 5000;
  w.shutdown.begin();
  assert.equal(w.shutdown.view().startedAt, iso(1_000_000));
});

test('a pair still created after the beginning counts too', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.left['who/Two'] = { pairs: 3, job: null };
  assert.deepEqual(w.shutdown.view().projects[1], { repo: 'who/Two', total: 3, removed: 0, job: null, endedAt: null });
});
