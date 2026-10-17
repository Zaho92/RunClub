const test = require('node:test');
const assert = require('node:assert/strict');
const { createPools } = require('../src/pools');
const { createRunners } = require('../src/runners');
const { createNames, DEFAULT_PORT } = require('../src/names');
const { runnerView } = require('../src/status');
const limitRules = require('../src/limits');
const { turn, until, settle, rendered } = require('./support');

const REPO = 'owner/App';
const MARK = 'runclub.runner=test';
const OLD = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };
const NEW = { ...OLD, dockerMemory: '6g' };
const NEWER = { ...OLD, dockerMemory: '5g' };

function basics() {
  return {
    calls: [], logs: [], slept: [], stopping: false, ready: true, limits: OLD, onSleep: () => {},
    settings: { repo: REPO, parallel: 2, cache: true, paused: false },
    pool: { repo: REPO, slots: [], reserve: [], leaving: 0, hold: false, prepared: true, removed: false, seeded: new Set(), sizes: null }, // like `startPool`, already prepared
  };
}

// The slots from slots.js and the rest faked. `calls` holds, in order, what the reserve
// asks of the slots. A build (`builds`) stays open until the test ends it with `finish` or `fail`.
// Time passes without waiting: `sleep` only yields once to everything else and remembers the duration.
function world() {
  const w = { ...basics(), builds: [], loops: [], aborted: [], removing: () => {}, caches: () => {}, vetted: true };
  w.pools = createPools({
    log: (...entry) => w.logs.push(rendered(entry)),
    sleep: async (ms) => { w.slept.push(ms); w.onSleep(ms); await turn(); },
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => w.limits,
    stopping: () => w.stopping, dockerReady: () => w.ready, vetted: () => w.vetted,
    provision: (pool, cancelled) => {
      const number = w.builds.length + 1;
      const build = { cancelled, pair: { id: String(number), base: `rc-app-${number}` } };
      build.promise = new Promise((resolve, reject) => { build.finish = (pair = build.pair) => resolve(pair); build.fail = reject; });
      w.builds.push(build);
      w.calls.push(`provision ${number}`);
      return build.promise;
    },
    removePair: async (repo, base, runnerId) => {
      assert.equal(repo, REPO);
      assert.equal(runnerId, null); // a reserve pair was never registered
      w.calls.push(`remove ${base}`);
      await w.removing(base);
      w.calls.push(`removed ${base}`);
    },
    abort: async (slot) => { slot.aborted = true; w.calls.push(`teardown ${slot.name}`); },
    slotLoop: (pool, slot) => { w.loops.push(slot); },
    abortIdle: async (slot) => { w.aborted.push(slot); w.calls.push(`abort ${slot.name ?? w.pool.slots.indexOf(slot) + 1}`); },
    prepareCaches: async (repo) => { w.calls.push(`caches ${repo}`); await w.caches(); },
    pools: new Map([[REPO, w.pool]]), refreshSeed: async () => {}, measureSizes: async () => {},
  });
  return w;
}

// A gate: holds up until the test opens it.
function gate() {
  let open = null;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test('the reserve fills up to the wanted size and not beyond', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2']);
  assert.deepEqual(w.pool.reserve.map(({ cancel, ready, built }) => ({ cancel, ready, built })),
    [{ cancel: false, ready: false, built: limitRules.key(OLD) }, { cancel: false, ready: false, built: limitRules.key(OLD) }]);

  w.builds[0].finish();
  assert.equal(await w.pool.reserve[0].promise, w.builds[0].pair);
  assert.deepEqual(w.pool.reserve.map((entry) => entry.ready), [true, false]);

  // If a slot takes a pair out, exactly one new one arises.
  w.pool.reserve.shift();
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2', 'provision 3']);
  assert.equal(w.pool.reserve.length, 2);
  assert.deepEqual(w.logs, []);
});

test('the size of the reserve: as set, otherwise as many as slots, at most two', () => {
  const w = world();
  const size = (settings) => { w.settings = settings; return w.pools.reserveSize(w.pool); };
  assert.equal(size({ parallel: 1 }), 1);
  assert.equal(size({ parallel: 2 }), 2);
  assert.equal(size({ parallel: 4 }), 2);
  assert.equal(size({ parallel: 4, reserve: 3 }), 3);
  assert.equal(size({ parallel: 4, reserve: 0 }), 0);
  assert.equal(size({}), 0);
  assert.equal(w.pools.reserveSize({ repo: 'owner/Other' }), 0); // no pool in the settings
});

test('no refilling when the program ends, the pool is being removed, Docker is missing or the pool rests', () => {
  const cases = [
    (w) => { w.stopping = true; },
    (w) => { w.pool.removed = true; },
    (w) => { w.ready = false; },
    (w) => { w.pool.prepared = false; },
    (w) => { w.pool.hold = true; },
    (w) => { w.settings.paused = true; },
  ];
  for (const prepare of cases) {
    const w = world();
    prepare(w);
    w.pools.replenish(w.pool);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.pool.reserve, []);
  }
});

test('a pool rests while it is not prepared, or is held or paused', () => {
  const w = world();
  assert.ok(!w.pools.poolResting(w.pool));
  assert.ok(w.pools.poolResting({ ...w.pool, prepared: false }));
  assert.ok(w.pools.poolResting({ ...w.pool, hold: true }));
  w.settings.paused = true;
  assert.ok(w.pools.poolResting(w.pool));
  assert.ok(!w.pools.poolResting({ repo: 'owner/Other', prepared: true, hold: false }));
  w.settings.paused = false;
  w.vetted = false; // without a fresh check of the repo (see remote.js)
  assert.ok(w.pools.poolResting(w.pool));
});

test('a failed build leaves the reserve and is in the log; a cancelled one goes quietly', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  const [failed, cancelled] = w.pool.reserve;
  w.builds[0].fail(new Error('Docker daemon does not start: no space left on device'));
  assert.equal(await failed.promise, null); // whoever has already taken the pair gets no error
  assert.deepEqual(w.pool.reserve, [cancelled]);
  assert.deepEqual(w.logs, [['Preparing a pair – Docker daemon does not start: no space left on device', REPO, 'error']]);
  assert.equal(failed.ready, false);

  w.builds[1].finish(null); // this is how `provision` ends after a cancel
  assert.equal(await cancelled.promise, null);
  assert.deepEqual(w.pool.reserve, []);
  assert.equal(w.logs.length, 1);

  w.pools.replenish(w.pool); // the next timer refills
  assert.deepEqual(w.calls, ['provision 1', 'provision 2', 'provision 3', 'provision 4']);
});

test('a build for the reserve counts as cancelled when its entry is discarded or the program ends', () => {
  const w = world();
  w.pools.replenish(w.pool);
  assert.equal(w.builds[0].cancelled(), false);
  w.pool.reserve[0].cancel = true;
  assert.equal(w.builds[0].cancelled(), true);
  assert.equal(w.builds[1].cancelled(), false);
  w.stopping = true;
  assert.equal(w.builds[1].cancelled(), true);
});

test('discardReserve without `keep`: finished pairs are removed, running builds cancelled and awaited', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  const entries = [...w.pool.reserve];
  w.builds[0].finish();
  await entries[0].promise;

  let done = false;
  const discarding = w.pools.discardReserve(w.pool).then(() => { done = true; });
  assert.deepEqual(w.pool.reserve, []); // empty at once: a slot takes nothing more from it
  assert.deepEqual(entries.map((entry) => entry.cancel), [true, true]);
  await settle();
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'removed rc-app-1']);
  assert.equal(done, false); // the second build is still running

  w.builds[1].finish(null);
  await discarding;
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'removed rc-app-1']);

  // If a build still finishes despite the cancel, this pair goes too.
  w.pools.replenish(w.pool);
  const late = w.pools.discardReserve(w.pool);
  w.builds[2].finish();
  w.builds[3].finish(null);
  await late;
  assert.deepEqual(w.calls.slice(6), ['remove rc-app-3', 'removed rc-app-3']);
  assert.deepEqual(w.logs, []);
});

test('discardReserve with `keep`: what is kept stays untouched in the reserve', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  const [first, second] = w.pool.reserve;
  w.builds[0].finish();
  w.builds[1].finish();
  await w.pools.discardReserve(w.pool, (entry) => entry === second);
  assert.deepEqual(w.pool.reserve, [second]);
  assert.deepEqual([first.cancel, second.cancel], [true, false]);
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'removed rc-app-1']);
});

test('renewReserve replaces only entries with old limits', async () => {
  const w = world();
  w.settings.reserve = 1;
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  const old = w.pool.reserve[0];

  await w.pools.renewReserve(w.pool); // nothing changed: the reserve stays
  assert.deepEqual(w.pool.reserve, [old]);
  assert.deepEqual(w.calls, ['provision 1']);

  w.limits = NEW;
  await w.pools.renewReserve(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'remove rc-app-1', 'removed rc-app-1', 'provision 2']);
  assert.deepEqual(w.pool.reserve.map((entry) => entry.built), [limitRules.key(NEW)]);
  assert.equal(old.cancel, true);

  // With two entries: only the old one goes.
  w.settings.reserve = 2;
  w.pools.replenish(w.pool);
  const [fresh, stale] = w.pool.reserve;
  stale.built = limitRules.key(OLD);
  w.builds[1].finish();
  w.builds[2].finish();
  await w.pools.renewReserve(w.pool);
  assert.equal(w.pool.reserve[0], fresh);
  assert.deepEqual(w.calls.slice(4), ['provision 3', 'remove rc-app-3', 'removed rc-app-3', 'provision 4']);
  assert.deepEqual(w.logs, []);
});

test('several renewReserve in quick succession run one after another: remove first, then build anew', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  const first = gate();
  w.removing = (base) => (base === 'rc-app-1' ? first.promise : undefined);

  w.limits = NEW;
  w.pools.renewReserve(w.pool);
  w.limits = NEWER; // the next slider, before the first renewal is done
  const second = w.pools.renewReserve(w.pool);
  assert.equal(w.pool.renewing, second);
  await settle();
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'remove rc-app-2', 'removed rc-app-2']); // while an old pair stands, nothing new arises
  assert.deepEqual(w.pool.reserve, []);

  first.open();
  await until(() => w.builds.length === 4);
  // The first renewal built with the limits now in force; nothing is left for the second to do.
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'remove rc-app-2', 'removed rc-app-2', 'removed rc-app-1', 'provision 3', 'provision 4']);
  await second;
  assert.deepEqual(w.pool.reserve.map((entry) => entry.built), [limitRules.key(NEWER), limitRules.key(NEWER)]);
  assert.equal(w.builds.length, 4);
});

test('a renewal that meets a build still running waits for it; an error is in the log and does not hold up the next one', async () => {
  const w = world();
  w.settings.reserve = 1;
  w.pools.replenish(w.pool);
  w.limits = NEW;
  let done = false;
  w.pools.renewReserve(w.pool).then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  assert.deepEqual(w.calls, ['provision 1']);
  w.builds[0].finish(null);
  await until(() => done);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2']);

  w.builds[1].finish();
  w.limits = NEWER;
  w.removing = () => { throw new Error('Docker does not answer'); };
  await w.pools.renewReserve(w.pool);
  assert.deepEqual(w.logs, [['Clearing the reserve – Docker does not answer', REPO, 'error']]);
  assert.deepEqual(w.calls.slice(-2), ['remove rc-app-2', 'provision 3']); // refilled even after the error
  assert.deepEqual(w.pool.reserve.map((entry) => entry.built), [limitRules.key(NEWER)]);

  w.removing = () => {};
  await w.pools.renewReserve(w.pool); // the reserve is already fresh
  assert.equal(w.builds.length, 3);
  assert.equal(w.logs.length, 1);
});

test('staleCount counts idle pairs and reserve with old limits, but not working and cleaning slots', () => {
  const w = world();
  const old = limitRules.key(OLD);
  const current = limitRules.key(NEW);
  w.limits = NEW;
  assert.equal(w.pools.staleCount(w.pool), 0);
  w.pool.slots = [
    { state: 'ready', base: 'rc-app-1', built: old }, // counts
    { state: 'starting', base: 'rc-app-2', built: old }, // counts
    { state: 'ready', base: 'rc-app-3', built: current },
    { state: 'working', base: 'rc-app-4', built: old },
    { state: 'cleaning', base: 'rc-app-5', built: old },
    { state: 'waiting', base: null, built: old }, // no pair any more
    { state: 'starting', base: 'rc-app-6' }, // not stated yet
  ];
  assert.equal(w.pools.staleCount(w.pool), 2);
  w.pool.reserve = [{ built: old }, { built: current }, { built: old }];
  assert.equal(w.pools.staleCount(w.pool), 4);
  w.limits = OLD;
  assert.equal(w.pools.staleCount(w.pool), 2); // now the others are the old ones: an idle slot and a reserve entry
});

test('reconcile creates missing slots and lets surplus ones retire', () => {
  const w = world();
  w.pools.reconcile(w.pool);
  assert.deepEqual(w.pool.slots, [{ repo: REPO, state: 'starting', jobs: 0 }, { repo: REPO, state: 'starting', jobs: 0 }]);
  assert.deepEqual(w.loops, w.pool.slots);
  const [first, second] = w.pool.slots;

  w.pools.reconcile(w.pool); // already matching
  assert.equal(w.pool.slots.length, 2);
  assert.deepEqual(w.aborted, []);

  w.settings.parallel = 1;
  w.pools.reconcile(w.pool);
  assert.deepEqual([first.retired, second.retired], [undefined, true]);
  assert.deepEqual(w.aborted, [second]);
  assert.equal(w.pool.slots.length, 2); // the retiring slot only goes when its loop ends

  // If raised again, the retiring slot stays first; only for the third does a new one arise.
  w.settings.parallel = 3;
  w.pools.reconcile(w.pool);
  assert.equal(w.pool.slots.length, 3);
  assert.equal(w.loops.length, 3);
  assert.deepEqual(w.pool.slots.map((slot) => Boolean(slot.retired)), [false, false, false]);
  assert.deepEqual(w.pool.slots.slice(0, 2), [first, second]);
  assert.deepEqual(w.aborted, [second]);

  // Without an entry in the settings, all retire.
  w.settings = undefined;
  w.pools.reconcile(w.pool);
  assert.deepEqual(w.pool.slots.map((slot) => slot.retired), [true, true, true]);
  assert.equal(w.aborted.length, 4);
  w.pools.reconcile(w.pool); // slots already retiring are not aborted again
  assert.equal(w.aborted.length, 4);
});

test('reconcile takes back only retiring slots whose loop is still running, and no more than wanted', () => {
  const w = world();
  w.settings.parallel = 4;
  w.pools.reconcile(w.pool);
  const [first, second, third, fourth] = w.pool.slots;
  w.settings.parallel = 1;
  w.pools.reconcile(w.pool);
  second.state = 'off'; // its loop has already ended
  third.state = 'working';

  w.settings.parallel = 2;
  w.pools.reconcile(w.pool);
  assert.deepEqual([first, second, third, fourth].map((slot) => Boolean(slot.retired)), [false, true, false, true]);
  assert.equal(w.loops.length, 4); // no new slot

  w.settings.parallel = 4;
  w.pools.reconcile(w.pool);
  assert.deepEqual([first, second, third, fourth].map((slot) => Boolean(slot.retired)), [false, true, false, false]);
  assert.equal(w.loops.length, 5); // the ended slot does not come back: a new one arises for it
});

test('quiesce tears down reserve and idle pairs and waits until nothing is left', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  const working = { name: 'working', state: 'working', base: 'rc-app-8' };
  const building = { name: 'building', state: 'starting', building: true };
  w.pool.slots = [working, building];
  w.onSleep = () => {
    if (w.slept.length === 2) building.building = false;
    if (w.slept.length === 4) working.base = null; // the job is over, the pair cleaned up
  };
  await w.pools.quiesce(w.pool);

  assert.deepEqual(w.calls.slice(2), ['abort working', 'abort building', 'remove rc-app-1', 'remove rc-app-2', 'removed rc-app-1', 'removed rc-app-2']);
  assert.deepEqual(w.slept, [500, 500, 500, 500]);
  assert.deepEqual(w.pool.reserve, []);

  // If nothing is left, there is no waiting. As long as something is still in the reserve, there is.
  const empty = world();
  await empty.pools.quiesce(empty.pool);
  assert.deepEqual(empty.slept, []);
  const refilled = world();
  refilled.removing = () => { refilled.pool.reserve.push({}); };
  refilled.pools.replenish(refilled.pool);
  refilled.builds[0].finish();
  refilled.builds[1].finish(null);
  refilled.onSleep = () => { if (refilled.slept.length === 3) refilled.pool.reserve = []; };
  await refilled.pools.quiesce(refilled.pool);
  assert.deepEqual(refilled.slept, [500, 500, 500]);
});

test('withPoolAtRest holds the pool until the work is done and returns its result', async () => {
  const w = world();
  const slot = { name: 'idle', state: 'ready', base: 'rc-app-9' };
  w.pool.slots = [slot];
  w.onSleep = () => { assert.equal(w.pool.hold, true); if (w.slept.length === 2) slot.base = null; };
  const seen = {};
  const result = await w.pools.withPoolAtRest(w.pool, async () => {
    Object.assign(seen, { hold: w.pool.hold, base: slot.base, slept: w.slept.length });
    w.pools.replenish(w.pool); // a held pool does not refill
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(seen, { hold: true, base: null, slept: 2 }); // the work only begins when nothing is left
  assert.equal(w.pool.hold, false);
  assert.deepEqual(w.calls, ['abort idle']);
});

test('a second withPoolAtRest waits for the first', async () => {
  const w = world();
  const first = gate();
  const order = [];
  const one = w.pools.withPoolAtRest(w.pool, async () => { order.push('one begins'); await first.promise; order.push('one ends'); });
  const two = w.pools.withPoolAtRest(w.pool, async () => { order.push('two begins'); assert.equal(w.pool.hold, true); });
  await settle();
  assert.deepEqual(order, ['one begins']);
  assert.ok(w.slept.length > 0 && w.slept.every((ms) => ms === 500));
  first.open();
  await Promise.all([one, two]);
  assert.deepEqual(order, ['one begins', 'one ends', 'two begins']);
  assert.equal(w.pool.hold, false);
});

test('`hold` is released even after an error; an error while tearing down is in the log and does not hold up the work', async () => {
  const w = world();
  await assert.rejects(w.pools.withPoolAtRest(w.pool, async () => { throw new Error('Cache cannot be cleared'); }), { message: 'Cache cannot be cleared' });
  assert.equal(w.pool.hold, false);

  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  w.removing = () => { throw new Error('Docker does not answer'); };
  let worked = false;
  await w.pools.withPoolAtRest(w.pool, async () => { worked = true; });
  assert.equal(worked, true);
  assert.equal(w.pool.hold, false);
  assert.deepEqual(w.logs, [['Clearing the reserve – Docker does not answer', REPO, 'error'], ['Clearing the reserve – Docker does not answer', REPO, 'error']]);
  assert.equal(w.pool.leaving, 0);

  w.removing = () => {};
  assert.equal(await w.pools.withPoolAtRest(w.pool, async () => 'afterwards'), 'afterwards');
});

test('rebuildIdle without a running job: the pool comes to rest and the build service is recreated', async () => {
  const w = world();
  const slot = { name: 'idle', state: 'ready', base: 'rc-app-9' };
  w.pool.slots = [slot];
  w.onSleep = () => { slot.base = null; };
  w.caches = () => { assert.equal(w.pool.hold, true); assert.equal(slot.base, null); };
  await w.pools.rebuildIdle(w.pool);
  assert.deepEqual(w.calls, ['abort idle', `caches ${REPO}`]);
  assert.equal(w.pool.hold, false);
  assert.equal(w.pool.renewing, undefined);
});

test('rebuildIdle with a running job: the reserve is renewed, idle pairs with old limits aborted, the pool not held', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  w.limits = NEW;
  const old = limitRules.key(OLD);
  w.pool.slots = [
    { name: 'working', state: 'working', base: 'rc-app-8', built: old },
    { name: 'idle', state: 'ready', base: 'rc-app-9', built: old },
    { name: 'fresh', state: 'ready', base: 'rc-app-7', built: limitRules.key(NEW) }, // already carries the new limits: stays
    { name: 'building', state: 'starting', building: true }, // builds itself, with the new limits: stays
    { name: 'takingOver', state: 'starting', building: true, built: old }, // is taking over a pair with old limits: goes
  ];
  await w.pools.rebuildIdle(w.pool);
  assert.deepEqual(w.calls.slice(2), ['abort idle', 'abort takingOver', 'remove rc-app-1', 'remove rc-app-2', 'removed rc-app-1', 'removed rc-app-2', 'provision 3', 'provision 4']);
  assert.equal(w.pool.hold, false);
  assert.deepEqual(w.slept, []);
});

test('rebuildIdle waits for `hold` and only then decides whether a job is running', async () => {
  // At the call no job is running; while the pool is held (a cache is being cleared), one begins.
  const started = world();
  const slot = { name: 'one', state: 'ready', base: 'rc-app-9' };
  started.pool.slots = [slot];
  started.pool.hold = true;
  started.onSleep = () => { if (started.slept.length === 3) { slot.state = 'working'; started.pool.hold = false; } };
  await started.pools.rebuildIdle(started.pool);
  assert.deepEqual(started.slept, [500, 500, 500]);
  assert.deepEqual(started.calls, ['provision 1', 'provision 2']); // not held, no new build service; the reserve fills
  assert.equal(started.pool.hold, false);
  assert.ok(started.pool.renewing);

  // The other way round: at the call a job is running, at the end of the wait no longer.
  const ended = world();
  const busy = { name: 'one', state: 'working', base: 'rc-app-9' };
  ended.pool.slots = [busy];
  ended.pool.hold = true;
  ended.onSleep = () => { if (ended.slept.length === 2) { Object.assign(busy, { state: 'ready', base: null }); ended.pool.hold = false; } };
  await ended.pools.rebuildIdle(ended.pool);
  assert.deepEqual(ended.slept, [500, 500]);
  assert.deepEqual(ended.calls, ['abort one', `caches ${REPO}`]);
  assert.equal(ended.pool.renewing, undefined);
});

// --- With the real slots, wired by runners.js as in operation; only Docker and GitHub are faked ---

function wired() {
  const w = { ...basics(), ends: new Map(), emit: new Map(), ids: 0 };
  const docker = async (args, options = {}) => {
    const name = args[0] === 'run' ? `run ${args[args.indexOf('--name') + 1]}` : args[0] === 'rm' ? `rm ${args.at(-1)}` : args.slice(0, 2).join(' ');
    w.calls.push(name);
    const runner = name.match(/^run (.+)-runner$/);
    if (runner) {
      w.emit.set(runner[1], options.onLine);
      options.onLine('Listening for Jobs');
      return new Promise((resolve) => { w.ends.set(runner[1], () => resolve({ code: 0, stdout: '', stderr: '' })); }); // the runner waits for a job
    }
    const removed = name.match(/^rm (.+)-runner$/);
    if (removed && args.length === 3) w.ends.get(removed[1])?.();
    return { code: 0, stdout: '', stderr: '' };
  };
  const github = {
    send: async (method, url) => {
      w.calls.push(`send ${method}`);
      return url.endsWith('/generate-jitconfig') ? { runner: { id: 70 + w.ids }, encoded_jit_config: 'secret' } : null;
    },
  };
  const sleep = async (ms) => { w.slept.push(ms); w.onSleep(ms); await turn(); };
  const log = (...entry) => w.logs.push(rendered(entry));
  w.runners = createRunners({
    docker, dockerList: async () => [], github, log, sleep, timer: () => {}, newId: () => String(w.ids += 1),
    host: 'PC', names: createNames({ dataDir: 'C:/Data', port: DEFAULT_PORT }), image: 'runner:test', dind: 'dind:test', buildkit: 'buildkit:test', longTimeout: 1234,
    settings: { settingsOf: (repo) => (repo === REPO ? w.settings : undefined), limitsOf: () => w.limits, state: { learned: {}, rejected: {} }, saveState: () => {} },
    metrics: { meter: () => ({ finish: () => ({}) }), recordJob: () => {} },
    stopping: () => w.stopping, dockerReady: () => w.ready, vetted: () => true, refreshRepo: () => {}, forgetStats: () => {},
  });
  w.abortIdle = w.runners.slots.abortIdle;
  // At the end of a test: end all loops so nothing keeps running.
  w.finish = async () => {
    w.stopping = true;
    for (const end of w.ends.values()) end();
    await until(() => !w.pool.slots.length);
  };
  return w;
}

// The slots as the interface sees them (see status.js): name, state and whether it is retiring.
const names = (w) => w.pool.slots.map((slot, index) => {
  const runner = runnerView({ slot, index, repo: REPO, jobs: [], statsOf: () => undefined, cpus: 1 });
  return `${slot.name} ${runner.state}${runner.retiring ? ', retiring' : ''}`;
});
const count = (w, call) => w.calls.filter((name) => name === call).length;

test('real slots: a slot takes its pair from the reserve, and it refills', async () => {
  const w = wired();
  w.settings.parallel = 1;
  w.runners.replenish(w.pool);
  await until(() => w.pool.reserve[0]?.ready);
  assert.equal(w.ids, 1);

  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots[0].state === 'ready' && w.pool.reserve[0]?.ready);
  assert.deepEqual(names(w), ['PC-linux-1 ready']); // the prepared pair, not a new one
  assert.equal(w.ids, 2);
  assert.equal(w.pool.reserve.length, 1);
  assert.deepEqual(w.slept, []);

  // Pausing as `pool/set` does it: runners and reserve go, the slot stays and waits.
  w.settings.paused = true;
  w.pool.slots.forEach((slot) => w.abortIdle(slot));
  w.runners.discardReserve(w.pool);
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots[0].state === 'paused');
  assert.deepEqual(w.pool.reserve, []);
  assert.equal(count(w, 'network rm'), 2);
  assert.deepEqual(w.logs, []);
  await w.finish();
});

test('real slots: surplus ones retire; the idle one is aborted, the working one stays until its job ends', async () => {
  const w = wired();
  w.settings.reserve = 0;
  w.settings.parallel = 3;
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots.every((slot) => slot.state === 'ready'));
  const [first, second, third] = w.pool.slots;
  w.emit.get(second.base)('Running job: Build');
  assert.deepEqual(names(w), ['PC-linux-1 ready', 'PC-linux-2 working', 'PC-linux-3 ready']);

  w.settings.parallel = 1;
  w.runners.reconcile(w.pool);
  assert.deepEqual([first.retired, second.retired, third.retired], [undefined, true, true]);
  await until(() => w.pool.slots.length === 2);
  assert.deepEqual(names(w), ['PC-linux-1 ready', 'PC-linux-2 working, retiring']);
  assert.equal(third.state, 'off');
  assert.equal(count(w, 'rm rc-app-3-runner'), 1);
  assert.equal(count(w, 'rm rc-app-2-runner'), 0);
  assert.equal(count(w, 'send DELETE'), 1); // only the idle runner is unregistered at GitHub

  await settle();
  assert.equal(second.state, 'working'); // the job keeps running
  w.emit.get(second.base)('Job Build completed with result: Succeeded');
  w.ends.get('rc-app-2')();
  await until(() => w.pool.slots.length === 1);
  assert.equal(second.state, 'off');
  assert.equal(second.jobs, 1);
  assert.equal(w.ids, 3); // no new pair arises for the retired slot
  assert.equal(first.state, 'ready');
  await w.finish();
});

test('real slots: if raised while slots are retiring, there are never more than set', async () => {
  const w = wired();
  w.settings.reserve = 0;
  w.settings.parallel = 3;
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots.every((slot) => slot.state === 'ready'));
  const [first, second, third] = w.pool.slots;
  w.emit.get(second.base)('Running job: Build');

  w.settings.parallel = 1;
  w.runners.reconcile(w.pool);
  w.settings.parallel = 3; // raised again right away: the working and the just aborted slot are still retiring
  w.runners.reconcile(w.pool);
  assert.deepEqual(w.pool.slots, [first, second, third]);
  assert.deepEqual(w.pool.slots.map((slot) => Boolean(slot.retired)), [false, false, false]);

  await until(() => third.state === 'ready' && third.name === 'PC-linux-4'); // the aborted slot builds anew
  assert.deepEqual(names(w), ['PC-linux-1 ready', 'PC-linux-2 working', 'PC-linux-4 ready']);
  assert.equal(w.ids, 4);

  // The slot that was meant to retire serves the next job after its own.
  w.emit.get(second.base)('Job Build completed with result: Succeeded');
  w.ends.get('rc-app-2')();
  await until(() => second.state === 'ready' && second.name === 'PC-linux-5');
  assert.equal(w.pool.slots.length, 3);
  await w.finish();
});

test('real slots: withPoolAtRest waits for a running job to end and holds the slots until then', async () => {
  const w = wired();
  w.settings.reserve = 0;
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots.every((slot) => slot.state === 'ready'));
  const [busy, idle] = w.pool.slots;
  w.emit.get(busy.base)('Running job: Build');

  let state = null;
  const rest = w.runners.withPoolAtRest(w.pool, async () => { state = names(w); return w.ids; });
  await until(() => idle.state === 'waiting');
  await settle();
  assert.equal(state, null); // while the job runs, the work does not begin
  assert.equal(busy.state, 'working');
  assert.equal(w.pool.hold, true);

  w.emit.get(busy.base)('Job Build completed with result: Succeeded');
  w.ends.get(busy.base)();
  assert.equal(await rest, 2);
  assert.deepEqual(state, ['PC-linux-1 waiting', 'PC-linux-2 waiting']);
  assert.equal(w.pool.hold, false);

  await until(() => w.pool.slots.every((slot) => slot.state === 'ready')); // afterwards the slots build up again
  assert.equal(w.ids, 4);
  await w.finish();
});

// --- creating and preparing a pool ---

// Only what `startPool` and `preparePool` need; the rest of the reserve stays out.
function starter({ ready = true, failCaches = null } = {}) {
  const s = { calls: [], logs: [], pools: new Map(), ready };
  s.api = createPools({
    log: (...entry) => s.logs.push(rendered(entry)), sleep: turn, pools: s.pools,
    settingsOf: (repo) => ({ repo, parallel: 2, cache: true, paused: false }), limitsOf: () => OLD,
    stopping: () => false, dockerReady: () => s.ready, vetted: () => true,
    provision: async () => null, removePair: async () => {}, slotLoop: (pool, slot) => s.calls.push(`loop ${pool.repo} ${pool.slots.indexOf(slot) + 1}`), abortIdle: async () => {},
    prepareCaches: async (repo) => { s.calls.push(`caches ${repo}`); if (failCaches) throw new Error(failCaches); },
    refreshSeed: async (repo) => { s.calls.push(`seed ${repo}`); },
    measureSizes: async (pool) => { s.calls.push(`sizes ${pool.repo} ${pool.prepared}`); },
  });
  return s;
}

test('a new pool is there at once with its slots and is prepared when Docker is ready', async () => {
  const s = starter();
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  assert.deepEqual({ ...pool, slots: pool.slots.length, seeded: [...pool.seeded] }, { repo: REPO, slots: 2, reserve: [], leaving: 0, hold: false, prepared: true, preparing: false, removed: false, seeded: [], sizes: null });
  assert.deepEqual(s.calls, [`loop ${REPO} 1`, `loop ${REPO} 2`, `caches ${REPO}`, `seed ${REPO}`, `sizes ${REPO} true`]);
});

test('if Docker is not ready yet, preparation waits for the Docker watch', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  assert.equal(s.pools.get(REPO).prepared, false);
  assert.deepEqual(s.calls, [`loop ${REPO} 1`, `loop ${REPO} 2`]);
});

test('if preparation fails, that is in the log, and the pool counts as prepared anyway', async () => {
  const s = starter({ failCaches: 'no space' });
  await s.api.startPool(REPO);
  assert.equal(s.pools.get(REPO).prepared, true);
  assert.deepEqual(s.logs, [['Preparation – no space', REPO, 'error']]);
  assert.deepEqual(s.calls.slice(2), [`caches ${REPO}`, `sizes ${REPO} true`]);
});

test('a pool being removed is no longer prepared', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  pool.removed = true;
  await s.api.preparePool(pool);
  assert.equal(s.calls.some((call) => call.startsWith('caches')), false);
});

test('two preparations at once (creating and Docker watch) run only once', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  await Promise.all([s.api.preparePool(pool), s.api.preparePool(pool)]);
  assert.deepEqual(s.calls.filter((call) => call.startsWith('caches')), [`caches ${REPO}`]);
});

test('what is being torn down counts when refilling: there are never more pairs than wanted', async () => {
  const w = world();
  w.pool.leaving = 1;
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1']); // two wanted, one is still going
  w.pool.leaving = 0;
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2']);
});

test('withPoolAtRest waits until preparation, renewing the build service and measuring are done', async () => {
  for (const busy of ['preparing', 'renewingService', 'measuring']) {
    const w = world();
    w.pool[busy] = true;
    let worked = false;
    const done = w.pools.withPoolAtRest(w.pool, async () => { worked = true; });
    await settle();
    assert.equal(worked, false, busy);
    assert.equal(w.pool.hold, false, busy); // holding only starts afterwards
    w.pool[busy] = false;
    await done;
    assert.equal(worked, true, busy);
  }
});

test('if the pool rests for work on its caches, preparation leaves caches and measuring to that work', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  pool.hold = true;
  await s.api.preparePool(pool);
  assert.deepEqual(s.calls.slice(2), [`seed ${REPO}`]); // measuring happens after the work, not in between
});

test('on shutdown: reserve and pairs are torn down, one being built is awaited too', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  const working = { name: 'working', state: 'working', base: 'rc-app-9' };
  const building = { name: 'building', state: 'starting', building: true };
  w.pool.slots = [working, building];
  w.onSleep = () => { building.building = false; working.base = null; };
  const done = w.pools.dismantle(30000);
  await settle();
  assert.equal(w.builds[1].cancelled(), true); // the build for the reserve counts as cancelled …
  w.builds[1].finish(null); // … and ends without a pair
  await done;
  assert.ok(w.calls.includes('remove rc-app-1'));
  assert.ok(w.calls.includes('teardown working') && w.calls.includes('teardown building'));
  assert.equal(working.aborted && building.aborted, true);
  assert.ok(w.slept.length >= 1);

  // Without an end it waits no longer than allowed.
  const stuck = world();
  stuck.pool.slots = [{ name: 'stuck', state: 'starting', building: true }];
  await stuck.pools.dismantle(0);
  assert.deepEqual(stuck.slept, []);
});

test('on shutdown a build for the reserve that does not end holds nothing up', async () => {
  const w = world();
  w.pools.replenish(w.pool); // both builds stay open, say behind the template refresh
  await w.pools.dismantle(0);
  assert.equal(w.pool.leaving, 2); // they still count until they end
  assert.equal(w.builds.every((build) => build.cancelled()), true);
  w.builds.forEach((build) => build.finish(null));
  await settle();
  assert.equal(w.pool.leaving, 0);
});

test('remaining counts what is still left on shutdown and names the job aborted in the process', async () => {
  const w = world();
  w.pools.replenish(w.pool); // two builds for the reserve
  w.pool.slots = [
    { name: 'working', state: 'working', base: 'rc-app-9', job: 'Integration tests' },
    { name: 'building', state: 'starting', building: true },
    { name: 'empty', state: 'off' },
  ];
  assert.deepEqual(w.pools.remaining(w.pool), { pairs: 4, job: 'Integration tests' });
  w.pools.discardReserve(w.pool); // the reserve moves to `leaving` and keeps counting there
  assert.deepEqual(w.pools.remaining(w.pool), { pairs: 4, job: 'Integration tests' });
  w.builds.forEach((build) => build.finish(null));
  await settle();
  w.pool.slots[0].base = null; // the pair with the job is torn down
  assert.deepEqual(w.pools.remaining(w.pool), { pairs: 1, job: null });
});
