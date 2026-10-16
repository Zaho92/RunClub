const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLifecycle } = require('../src/lifecycle');
const { rendered } = require('./support');

// Alles, was Start und Ende berühren, nachgestellt: `steps` hält die Reihenfolge, `timers` die gesetzten Takte.
function world() {
  const w = { steps: [], logs: [], timers: new Map(), next: 1 };
  w.lifecycle = createLifecycle({
    log: (...entry) => w.logs.push(rendered(entry)),
    beforeStop: () => w.steps.push(`sichern (stopping: ${w.lifecycle.stopping()}, Takte: ${w.timers.size})`),
    dismantle: async () => { w.steps.push('abbauen'); },
    removeLeftovers: async (step) => { w.steps.push('Reste'); step('cleanup'); },
    releaseIdle: async () => { w.steps.push('abmelden'); },
    progress: { begin: () => w.steps.push('Stand'), step: (name) => w.steps.push(`Stufe ${name}`), finish: () => w.steps.push('Dauer ablegen') },
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

test('Beenden hält die Takte an, sichert, baut ab, räumt Reste ab und endet, mit Stand für die Oberfläche; ein zweites Mal geschieht nichts', async () => {
  const w = world();
  w.lifecycle.every(1000, () => {});
  assert.equal(w.lifecycle.stopping(), false);
  await Promise.all([w.lifecycle.shutdown(), w.lifecycle.shutdown()]);
  assert.deepEqual(w.steps, ['sichern (stopping: true, Takte: 0)', 'Stand', 'abbauen', 'Reste', 'Stufe cleanup', 'Dauer ablegen', 'Ende']);
  assert.deepEqual(w.logs.map(([text]) => text), ['Beende die Runner …', 'Beendet.']);
});

test('beim Abmelden von Windows nur die freien Runner abmelden; Beenden bleibt danach möglich', async () => {
  const w = world();
  await w.lifecycle.release();
  await w.lifecycle.release(); // schon angehalten: nichts mehr
  assert.deepEqual(w.steps, ['sichern (stopping: true, Takte: 0)', 'abmelden']);
  await w.lifecycle.shutdown();
  assert.deepEqual(w.steps.slice(2), ['sichern (stopping: true, Takte: 0)', 'Stand', 'abbauen', 'Reste', 'Stufe cleanup', 'Dauer ablegen', 'Ende']);
});

test('startPools startet jeden Pool und protokolliert, wenn CI_RUNNER sich nicht lesen lässt', async () => {
  const w = world();
  const started = [];
  w.lifecycle.startPools(['wer/App', 'wer/Zwei', 'wer/Drei'], {
    startPool: (repo) => started.push(`Pool ${repo}`),
    // So meldet routing.js einen Fehler beim Lesen; werfen sollte es nicht, aber auch das kommt ins Protokoll.
    checkRouting: async (repo) => {
      if (repo === 'wer/Drei') throw new Error('unerwartet');
      return { value: null, error: repo === 'wer/Zwei' ? 'gh: Forbidden (HTTP 403)' : null };
    },
    watchVisibility: (repo) => started.push(`Sichtbarkeit ${repo}`),
  });
  await new Promise(setImmediate);
  assert.deepEqual(started, ['Pool wer/App', 'Sichtbarkeit wer/App', 'Pool wer/Zwei', 'Sichtbarkeit wer/Zwei', 'Pool wer/Drei', 'Sichtbarkeit wer/Drei']);
  assert.deepEqual(w.logs, [
    ['CI_RUNNER ließ sich nicht lesen – gh: Forbidden (HTTP 403)', 'wer/Zwei', 'error'],
    ['CI_RUNNER ließ sich nicht lesen – unerwartet', 'wer/Drei', 'error'],
  ]);
});

test('saveKey legt den Schlüssel als Datei ab und meldet, wenn das nicht geht', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = world();
  assert.equal(w.lifecycle.saveKey(path.join(dir, 'access.key'), 'schluessel'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'access.key'), 'utf8'), 'schluessel\n');
  assert.equal(w.lifecycle.saveKey(path.join(dir, 'fehlt', 'access.key'), 'schluessel'), false);
  assert.match(w.logs.at(-1)[0], /^Der Schlüssel ließ sich nicht ablegen – ENOENT/);
});
