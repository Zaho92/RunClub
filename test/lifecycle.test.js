const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLifecycle } = require('../src/lifecycle');

// Alles, was Start und Ende berühren, nachgestellt: `steps` hält die Reihenfolge, `timers` die gesetzten Takte.
function world() {
  const w = { steps: [], logs: [], timers: new Map(), next: 1 };
  w.lifecycle = createLifecycle({
    log: (...entry) => w.logs.push(entry),
    beforeStop: () => w.steps.push(`sichern (stopping: ${w.lifecycle.stopping()}, Takte: ${w.timers.size})`),
    dismantle: async () => { w.steps.push('abbauen'); },
    removeLeftovers: async () => { w.steps.push('Reste'); },
    releaseIdle: async () => { w.steps.push('abmelden'); },
    onExit: () => w.steps.push('Ende'),
    schedule: { set: (work, ms) => { const id = w.next++; w.timers.set(id, { work, ms }); return id; }, clear: (id) => w.timers.delete(id) },
  });
  return w;
}

test('every arbeitet sofort und dann im Takt, everyAfter erst nach dem ersten Abstand', () => {
  const w = world();
  const ran = [];
  w.lifecycle.every(1000, () => ran.push('sofort'));
  w.lifecycle.everyAfter(2000, () => ran.push('später'));
  assert.deepEqual(ran, ['sofort']);
  assert.deepEqual([...w.timers.values()].map((timer) => timer.ms), [1000, 2000]);
});

test('Beenden hält die Takte an, sichert, baut ab, räumt Reste ab und endet; ein zweites Mal geschieht nichts', async () => {
  const w = world();
  w.lifecycle.every(1000, () => {});
  assert.equal(w.lifecycle.stopping(), false);
  await Promise.all([w.lifecycle.shutdown(), w.lifecycle.shutdown()]);
  assert.deepEqual(w.steps, ['sichern (stopping: true, Takte: 0)', 'abbauen', 'Reste', 'Ende']);
  assert.deepEqual(w.logs.map(([text]) => text), ['Beende die Runner …', 'Beendet.']);
});

test('beim Abmelden von Windows nur die freien Runner abmelden; Beenden bleibt danach möglich', async () => {
  const w = world();
  await w.lifecycle.release();
  await w.lifecycle.release(); // schon angehalten: nichts mehr
  assert.deepEqual(w.steps, ['sichern (stopping: true, Takte: 0)', 'abmelden']);
  await w.lifecycle.shutdown();
  assert.deepEqual(w.steps.slice(2), ['sichern (stopping: true, Takte: 0)', 'abbauen', 'Reste', 'Ende']);
});

test('startPools startet jeden Pool und protokolliert, wenn CI_RUNNER sich nicht lesen lässt', async () => {
  const w = world();
  const started = [];
  w.lifecycle.startPools(['wer/App', 'wer/Zwei'], {
    startPool: (repo) => started.push(`Pool ${repo}`),
    checkRouting: async (repo) => { if (repo === 'wer/Zwei') throw new Error('gh: Not Found (HTTP 404)'); },
    watchVisibility: (repo) => started.push(`Sichtbarkeit ${repo}`),
  });
  await new Promise(setImmediate);
  assert.deepEqual(started, ['Pool wer/App', 'Sichtbarkeit wer/App', 'Pool wer/Zwei', 'Sichtbarkeit wer/Zwei']);
  assert.deepEqual(w.logs, [['CI_RUNNER ließ sich nicht lesen – gh: Not Found (HTTP 404)', 'wer/Zwei', 'error']]);
});

test('saveKey legt den Schlüssel als Datei ab und meldet, wenn das nicht geht', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = world();
  assert.equal(w.lifecycle.saveKey(path.join(dir, 'access.key'), 'schluessel'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'access.key'), 'utf8'), 'schluessel\n');
  assert.equal(w.lifecycle.saveKey(path.join(dir, 'fehlt', 'access.key'), 'schluessel'), false);
});
