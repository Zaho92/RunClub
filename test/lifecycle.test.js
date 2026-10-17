const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLifecycle } = require('../src/lifecycle');
const { rendered } = require('./support');

// Everything start and end touch, simulated: `steps` keeps the order, `timers` the beats that were set.
function world() {
  const w = { steps: [], logs: [], timers: new Map(), next: 1 };
  w.lifecycle = createLifecycle({
    log: (...entry) => w.logs.push(rendered(entry)),
    beforeStop: () => w.steps.push(`save (stopping: ${w.lifecycle.stopping()}, beats: ${w.timers.size})`),
    dismantle: async () => { w.steps.push('dismantle'); },
    removeLeftovers: async (step) => { w.steps.push('leftovers'); step('cleanup'); },
    releaseIdle: async () => { w.steps.push('sign off'); },
    progress: { begin: () => w.steps.push('state'), step: (name) => w.steps.push(`stage ${name}`), finish: () => w.steps.push('store durations') },
    onExit: () => w.steps.push('end'),
    schedule: { set: (work, ms) => { const id = w.next++; w.timers.set(id, { work, ms }); return id; }, clear: (id) => w.timers.delete(id) },
  });
  return w;
}

test('every works at once and then on the beat, everyAfter only after the first interval', () => {
  const w = world();
  const ran = [];
  w.lifecycle.every(1000, () => ran.push('at once'));
  w.lifecycle.everyAfter(2000, () => ran.push('later'));
  assert.deepEqual(ran, ['at once']);
  assert.deepEqual([...w.timers.values()].map((timer) => timer.ms), [1000, 2000]);
});

test('shutting down stops the beats, saves, dismantles, clears leftovers and ends, with state for the interface; a second time nothing happens', async () => {
  const w = world();
  w.lifecycle.every(1000, () => {});
  assert.equal(w.lifecycle.stopping(), false);
  await Promise.all([w.lifecycle.shutdown(), w.lifecycle.shutdown()]);
  assert.deepEqual(w.steps, ['save (stopping: true, beats: 0)', 'state', 'dismantle', 'leftovers', 'stage cleanup', 'store durations', 'end']);
  assert.deepEqual(w.logs.map(([text]) => text), ['Stopping the runners …', 'Stopped.']);
});

test('on Windows sign-out only remove the idle runners; shutting down stays possible afterwards', async () => {
  const w = world();
  await w.lifecycle.release();
  await w.lifecycle.release(); // already stopped: nothing more
  assert.deepEqual(w.steps, ['save (stopping: true, beats: 0)', 'sign off']);
  await w.lifecycle.shutdown();
  assert.deepEqual(w.steps.slice(2), ['save (stopping: true, beats: 0)', 'state', 'dismantle', 'leftovers', 'stage cleanup', 'store durations', 'end']);
});

test('startPools starts every pool and logs when CI_RUNNER cannot be read', async () => {
  const w = world();
  const started = [];
  w.lifecycle.startPools(['who/App', 'who/Two', 'who/Three'], {
    startPool: (repo) => started.push(`pool ${repo}`),
    // This is how routing.js reports an error while reading; it should not throw, but that is logged too.
    checkRouting: async (repo) => {
      if (repo === 'who/Three') throw new Error('unexpected');
      return { value: null, error: repo === 'who/Two' ? 'Forbidden (HTTP 403)' : null };
    },
    watchVisibility: (repo) => started.push(`visibility ${repo}`),
  });
  await new Promise(setImmediate);
  assert.deepEqual(started, ['pool who/App', 'visibility who/App', 'pool who/Two', 'visibility who/Two', 'pool who/Three', 'visibility who/Three']);
  assert.deepEqual(w.logs, [
    ['Could not read CI_RUNNER – Forbidden (HTTP 403)', 'who/Two', 'error'],
    ['Could not read CI_RUNNER – unexpected', 'who/Three', 'error'],
  ]);
});

test('saveKey stores the key as a file and reports when that fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = world();
  assert.equal(w.lifecycle.saveKey(path.join(dir, 'access.key'), 'thekey'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'access.key'), 'utf8'), 'thekey\n');
  assert.equal(w.lifecycle.saveKey(path.join(dir, 'missing', 'access.key'), 'thekey'), false);
  assert.match(w.logs.at(-1)[0], /^Could not save the key – ENOENT/);
});
