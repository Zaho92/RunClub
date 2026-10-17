// A pool as a whole: what goes beyond a single slot but is not yet a cache or a template. This is
// where a pool comes into being and is prepared (`startPool`, `preparePool`), how the reserve fills up
// (`replenish`), is renewed (`renewReserve`) and torn down (`discardReserve`), how the number of slots follows the
// setting (`reconcile`) and how a pool comes to rest so its caches can be worked on
// (`quiesce`, `withPoolAtRest`, `rebuildIdle`).
//
// The life cycle of a slot lives in slots.js. Both sides need each other: the reserve builds pairs with
// `provision` and removes them with `removePair`, a slot refills the reserve and tears it down when the pool rests.
// Neither file loads the other; runners.js hands each side the functions of the other.
//
//   Pool     { repo, slots, reserve, leaving, hold, prepared, removed, renewing, … }   (created in `startPool`)
//   Reserve  entries { cancel, ready, built, promise }; `promise` yields the pair or `null`, never an error.
//            `leaving` counts the pairs already taken out of the reserve but still being torn down.

const limitRules = require('./limits');
const { errorLog } = require('./journal');
const { msg } = require('./messages');
const { SLOT, busy } = require('./states');
const { SECOND } = require('./units');

const POLL_PAUSE = SECOND / 2; // how often whoever waits for a pool to come to rest takes a look

//   log(text, repo, kind), sleep(ms)
//   pools                   Map repo -> pool; `startPool` adds new pools
//   settingsOf(repo), limitsOf(repo), stopping(), dockerReady()
//   vetted(repo)            is the repo freshly checked? (see remote.js)
//   provision(pool, cancelled), removePair(repo, base, runnerId), abort(slot), slotLoop(pool, slot), abortIdle(slot)
//                           from slots.js
//   prepareCaches(repo), measureSizes(pool)   provide package cache and build service, measure volumes (caches.js)
//   refreshSeed(repo)       refresh the template (seed.js)
function createPools({
  log, sleep, pools,
  settingsOf, limitsOf, stopping, dockerReady, vetted,
  provision, removePair, abort, slotLoop, abortIdle,
  prepareCaches, refreshSeed, measureSizes,
}) {
  const logError = errorLog(log);

  // A pool's reserve: fully prepared pairs without registration. A slot that becomes free takes one of them
  // and is ready again after a few seconds; the reserve refills in the background.
  const reserveSize = (pool) => settingsOf(pool.repo)?.reserve ?? Math.min(2, settingsOf(pool.repo)?.parallel ?? 0);

  function replenish(pool) {
    if (stopping() || pool.removed || !dockerReady() || poolResting(pool)) return;
    // What is being torn down right now counts too: otherwise renewing would briefly have twice as many pairs.
    while (pool.reserve.length + pool.leaving < reserveSize(pool)) {
      const entry = { cancel: false, ready: false, built: limitRules.key(limitsOf(pool.repo)) };
      const drop = () => { pool.reserve = pool.reserve.filter((other) => other !== entry); };
      entry.promise = provision(pool, () => entry.cancel || stopping())
        .then((pair) => { entry.ready = Boolean(pair); if (!pair) drop(); return pair; })
        .catch((error) => { logError(pool.repo, msg('m_whatPairPrep'))(error); drop(); return null; });
      pool.reserve.push(entry);
    }
  }

  // Renew the reserve as far as it carries old limits. Several calls in quick succession (four sliders, four changes) run
  // one after another: only once the old pairs and their network are removed do new ones arise.
  function renewReserve(pool) {
    pool.renewing = (pool.renewing ?? Promise.resolve())
      .then(async () => {
        // Only what is still built with other limits goes; an already fresh reserve stays.
        const current = limitRules.key(limitsOf(pool.repo));
        await discardReserve(pool, (entry) => entry.built === current);
      })
      // Refill even if tearing down fails: otherwise the reserve would stay empty until the next minute timer.
      .catch(logError(pool.repo))
      .then(() => replenish(pool))
      .catch(logError(pool.repo));
    return pool.renewing;
  }

  // Tear down the reserve; whatever `keep` keeps stays.
  // Each entry on its own: if one fails, the other pairs don't stay behind.
  async function discardReserve(pool, keep = () => false) {
    const entries = pool.reserve.filter((entry) => !keep(entry));
    pool.reserve = pool.reserve.filter(keep);
    pool.leaving += entries.length;
    for (const entry of entries) entry.cancel = true;
    const results = await Promise.allSettled(entries.map(async (entry) => {
      try {
        const pair = await entry.promise;
        if (pair) await removePair(pool.repo, pair.base, null);
      } finally { pool.leaving -= 1; }
    }));
    for (const result of results) if (result.status === 'rejected') logError(pool.repo, msg('m_whatReserve'))(result.reason);
  }

  // Idle pairs and reserve still built with limits other than the ones now in force.
  function staleSlots(pool) {
    const current = limitRules.key(limitsOf(pool.repo));
    return pool.slots.filter((slot) => (slot.base || slot.building) && slot.built && slot.built !== current && !busy(slot));
  }
  function staleCount(pool) {
    const current = limitRules.key(limitsOf(pool.repo));
    return staleSlots(pool).length + pool.reserve.filter((entry) => entry.built !== current).length;
  }

  // A pool without a fresh check that its repo is private and allows no fork PRs rests as well (see remote.js).
  const poolResting = (pool) => !pool.prepared || pool.hold || settingsOf(pool.repo)?.paused || !vetted(pool.repo);

  // Match the number of slots to the setting.
  function reconcile(pool) {
    const wanted = settingsOf(pool.repo)?.parallel ?? 0;
    const active = pool.slots.filter((slot) => !slot.retired);
    // Retiring slots whose loop is still running are taken back first: otherwise new ones would stand next to
    // them, and the pool would briefly have more runners than set.
    for (const slot of pool.slots) {
      if (active.length >= wanted) break;
      if (slot.retired && slot.state !== SLOT.OFF) { slot.retired = false; active.push(slot); }
    }
    for (let index = active.length; index < wanted; index += 1) {
      const slot = { repo: pool.repo, state: SLOT.STARTING, jobs: 0 };
      pool.slots.push(slot);
      slotLoop(pool, slot);
    }
    for (const slot of active.slice(wanted)) { slot.retired = true; abortIdle(slot); }
  }

  // Does the pool still have a pair: one being torn down, one at a slot, or one a slot is building right now?
  const hasPairs = (pool) => Boolean(pool.leaving) || pool.slots.some((slot) => slot.base || slot.building);

  // Waits until no pair of the pool is left: idle pairs and the reserve are removed, working ones finish.
  async function quiesce(pool) {
    await Promise.all([discardReserve(pool), ...pool.slots.map((slot) => abortIdle(slot))]);
    while (pool.reserve.length || hasPairs(pool)) await sleep(POLL_PAUSE);
  }

  // On shutdown: tear down all pairs, including the reserve and those being built; running jobs end with it. A
  // slot being built sees the abort and cleans up its pair itself. Waits at most `timeout`: a build for
  // the reserve can hang behind the template refresh, and shutting down cleans up everything labelled anyway.
  async function dismantle(timeout) {
    const all = [...pools.values()];
    for (const pool of all) discardReserve(pool).catch(logError(pool.repo)); // counts in `leaving` right away
    await Promise.all(all.flatMap((pool) => pool.slots.map(abort)));
    const until = Date.now() + timeout;
    while (Date.now() < until && all.some(hasPairs)) await sleep(POLL_PAUSE);
  }

  // What is still left of a pool on shutdown: the pairs as in `hasPairs`, plus the reserve, which `dismantle` only
  // gradually moves into `leaving`, and the name of a job being aborted in the process (see shutdown.js).
  function remaining(pool) {
    const job = pool.slots.find((slot) => slot.state === SLOT.WORKING && slot.base && slot.job)?.job ?? null;
    return { pairs: pool.leaving + pool.reserve.length + pool.slots.filter((slot) => slot.base || slot.building).length, job };
  }

  // Rebuild a pool's idle runners. If a job is running, only those with old limits go (as `staleCount`
  // counts them). If no job is running, the build service is recreated too; it carries the Docker daemon's limits.
  // Whether a job is running is decided only once the pool is no longer held otherwise
  // (a cache being cleared): if a job started during the wait, the pool would otherwise stand still until it ends.
  async function rebuildIdle(pool) {
    while (pool.hold) await sleep(POLL_PAUSE);
    if (pool.slots.some((slot) => slot.state === SLOT.WORKING)) return Promise.all([renewReserve(pool), ...staleSlots(pool).map((slot) => abortIdle(slot))]);
    return withPoolAtRest(pool, () => prepareCaches(pool.repo));
  }

  async function startPool(repo) {
    const pool = { repo, slots: [], reserve: [], leaving: 0, hold: false, prepared: false, removed: false, seeded: new Set(), sizes: null };
    pools.set(repo, pool);
    reconcile(pool);
    if (dockerReady()) await preparePool(pool);
  }

  async function preparePool(pool) {
    // A new pool can be reached at the same time by `startPool` and by the loop in `watchLoop` (dockerwatch.js).
    if (pool.preparing || pool.removed) return; // a pool being removed needs nothing more
    pool.preparing = true;
    pool.prepared = false;
    try {
      // If the pool is resting for work on its caches (`withPoolAtRest`), that work provides them itself afterwards.
      if (!pool.hold) await prepareCaches(pool.repo);
      await refreshSeed(pool.repo);
    } catch (error) { logError(pool.repo, msg('m_whatPrep'))(error); } finally { pool.prepared = true; pool.preparing = false; }
    // If the pool is resting, the work on its caches measures itself; the measuring container would otherwise hold volumes it deletes.
    if (!pool.hold) measureSizes(pool);
  }

  // Brings the pool to rest and then does `work`. Whatever else works on caches and volumes (preparation, renewing the
  // build service, measuring) finishes first: a volume in use could not be deleted.
  async function withPoolAtRest(pool, work) {
    while (pool.hold || pool.preparing || pool.renewingService || pool.measuring) await sleep(POLL_PAUSE);
    pool.hold = true;
    try { await quiesce(pool); return await work(); } finally { pool.hold = false; }
  }

  return { reserveSize, replenish, renewReserve, discardReserve, staleCount, poolResting, reconcile, quiesce, dismantle, remaining, rebuildIdle, withPoolAtRest, startPool, preparePool };
}

module.exports = { createPools };
