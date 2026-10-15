const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShutdown, FILE } = require('../src/shutdown');

// Zwei Projekte mit Pool; `left` hält, was dort noch steht, die Uhr steht, bis der Test sie stellt.
function world(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-shutdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (saved !== undefined) fs.writeFileSync(path.join(dir, FILE), typeof saved === 'string' ? saved : JSON.stringify(saved));
  const w = { dir, at: 1_000_000, left: { 'wer/App': { pairs: 3, job: 'Integrationstests' }, 'wer/Zwei': { pairs: 2, job: null } } };
  w.shutdown = createShutdown({ dataDir: dir, repos: () => Object.keys(w.left), remaining: (repo) => w.left[repo] ?? null, wait: 30_000, now: () => w.at });
  return w;
}
const iso = (ms) => new Date(ms).toISOString();

test('ohne Beenden gibt es keinen Stand', (t) => {
  assert.equal(world(t).shutdown.view(), null);
});

test('der Abbau zählt je Projekt, was schon weg ist, und nennt den Job, der abgebrochen wird', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.at += 4000;
  w.left['wer/Zwei'] = { pairs: 0, job: null };
  w.left['wer/App'] = { pairs: 2, job: 'Integrationstests' };
  let view = w.shutdown.view();
  assert.equal(view.startedAt, iso(1_000_000));
  assert.deepEqual(view.projects, [
    { repo: 'wer/App', total: 3, removed: 1, job: 'Integrationstests', endedAt: null },
    { repo: 'wer/Zwei', total: 2, removed: 2, job: null, endedAt: iso(1_004_000) },
  ]);
  assert.equal(view.cleanup.state, 'wait');
  assert.equal(view.signoff.state, 'wait');
  assert.equal(view.signoff.total, 2); // vor dem Abmelden: je Projekt eines
  // Ohne gespeicherte Dauer keine Schätzung.
  assert.equal(view.finishAt, null);
  assert.equal(view.last, null);
  assert.equal(view.over, false);
  assert.equal(view.wait, 30);
  assert.equal(view.cleanup.estimate, null);

  // Ein Projekt, das schon fertig war, bleibt es, auch wenn es nicht mehr gefragt wird.
  w.at += 1000;
  view = w.shutdown.view();
  assert.equal(view.projects[1].endedAt, iso(1_004_000));
});

test('das Aufräumen beendet den Abbau; was dann noch steht, gilt als abgebaut', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.at += 30000;
  w.shutdown.step('cleanup');
  const view = w.shutdown.view();
  assert.deepEqual(view.projects.map((project) => [project.removed, project.endedAt]), [[3, iso(1_030_000)], [2, iso(1_030_000)]]);
  assert.deepEqual(view.cleanup, { state: 'run', startedAt: iso(1_030_000), endedAt: null, estimate: null });
});

test('das Abmelden zählt die Projekte; am Ende wird die Dauer jeder Stufe abgelegt', (t) => {
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

test('mit der Dauer des letzten Beendens: Restzeit, Schätzung je Stufe und die Dauer insgesamt', (t) => {
  const w = world(t, { dismantle: 8000, cleanup: 2000, signoff: 1000 });
  w.shutdown.begin();
  w.at += 3000;
  let view = w.shutdown.view();
  assert.equal(view.last, 11);
  assert.equal(view.finishAt, iso(w.at + 5000 + 2000 + 1000));
  assert.equal(view.cleanup.estimate, 2);
  assert.equal(view.signoff.estimate, 1);

  // Dauert der Abbau länger als beim letzten Mal, zählen nur noch die wartenden Stufen, …
  w.at += 20000;
  view = w.shutdown.view();
  assert.equal(view.finishAt, iso(w.at + 3000));
  // … und ist auch das überschritten, gibt es keine Restzeit mehr, sondern den Hinweis darauf.
  assert.equal(view.over, false);
  w.shutdown.step('cleanup');
  w.shutdown.step('signoff', 2);
  w.at += 5000;
  view = w.shutdown.view();
  assert.deepEqual([view.finishAt, view.over], [null, true]);
});

test('eine kaputte oder unvollständige Datei heißt: keine Schätzung', (t) => {
  for (const saved of ['{kaputt', { dismantle: 8000, cleanup: 2000 }, { dismantle: -1, cleanup: 2000, signoff: 1000 }]) {
    const w = world(t, saved);
    w.shutdown.begin();
    assert.equal(w.shutdown.view().finishAt, null);
  }
});

test('ein zweites begin ändert nichts; step und finish ohne Beenden auch nicht', (t) => {
  const w = world(t);
  w.shutdown.step('cleanup');
  w.shutdown.finish();
  assert.equal(fs.existsSync(path.join(w.dir, FILE)), false);
  w.shutdown.begin();
  w.at += 5000;
  w.shutdown.begin();
  assert.equal(w.shutdown.view().startedAt, iso(1_000_000));
});

test('ein Paar, das nach dem Beginn noch entsteht, zählt mit', (t) => {
  const w = world(t);
  w.shutdown.begin();
  w.left['wer/Zwei'] = { pairs: 3, job: null };
  assert.deepEqual(w.shutdown.view().projects[1], { repo: 'wer/Zwei', total: 3, removed: 0, job: null, endedAt: null });
});
