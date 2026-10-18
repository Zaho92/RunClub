// Your own Linux runners, wired up: template (seed.js), slots (slots.js), the runner's tools for container jobs
// (externals.js), caches and build service (caches.js) and
// the pools with their reserve (pools.js). Slots and reserve need each other; neither of the two files loads the
// other, the connection is made here. The slots only learn on use what the pools contribute.
//
// Returns the map of pools (`pools`, repo -> pool), the modules as `seed`, `slots` and `caches`, the functions
// from pools.js under their own names and three for the timers and the Windows sign-out: `tick` (refill the reserve,
// renew the build service), `measureAll` (measure volumes) and `releaseIdle` (remove idle runners from GitHub).

const crypto = require('node:crypto');
const { createSeed } = require('./seed');
const { createSlots, idleRegistrations } = require('./slots');
const { createExternals } = require('./externals');
const { createCaches } = require('./caches');
const { createPools } = require('./pools');
const { unregisterRunner } = require('./github');
const { errorLog } = require('./journal');

//   docker(args, options), dockerList(args)   from engine.js
//   github                  access to GitHub (see github.js)
//   log(text, repo, kind, about), sleep(ms), timer (like `setTimeout`), newId() (id of a new pair)
//   host                    name of the machine (start of the runner names)
//   names                   mark and names per repo (see names.js)
//   image, dind, buildkit   the images of runner, Docker daemon and build service
//   longTimeout             time limit for copying and loading
//   settings                `settingsOf`, `limitsOf`, `state`, `saveState` (see settings.js)
//   metrics                 `meter()`, `recordJob(repo, record)` (see metrics.js)
//   stopping(), dockerReady(), vetted(repo)   vetted: see pools.js
//   refreshRepo(repo)       fetch the repo's state from GitHub anew (see remote.js)
//   forgetStats(name)       discard a container's measurements (see usage.js)
function createRunners({
  docker, dockerList, github, log, sleep, timer = setTimeout, newId = () => crypto.randomBytes(3).toString('hex'),
  host, names, image, dind, buildkit, longTimeout,
  settings, metrics, stopping, dockerReady, vetted, refreshRepo, forgetStats,
}) {
  const pools = new Map(); // repo -> pool (see pools.js)
  const { settingsOf, limitsOf } = settings;
  const poolOf = (repo) => pools.get(repo);

  const seed = createSeed({
    docker, dockerList, log, sleep,
    mark: names.mark, dind, longTimeout,
    settingsOf, seedVolume: names.seedVolume, poolOf,
    state: settings.state, saveState: settings.saveState, stopping,
  });

  const externals = createExternals({
    docker, dockerList, image, mark: names.mark, toolsMark: names.toolsMark, toolsVolume: names.toolsVolume, longTimeout,
  });

  let reserve = null; // the functions from pools.js; they are only created after the slots they need
  const slots = createSlots({
    docker, github, log, sleep, timer, newId,
    host, mark: names.mark, dind, externals, longTimeout, metrics,
    settingsOf, limitsOf, seedVolume: names.seedVolume, cacheVolume: names.cacheVolume, buildSocket: names.buildSocket,
    stopping, dockerReady, poolResting: (pool) => reserve.poolResting(pool),
    withSeed: seed.withSeed, learnImages: seed.learnImages,
    replenish: (pool) => reserve.replenish(pool), discardReserve: (pool, keep) => reserve.discardReserve(pool, keep),
    refreshRepo, forgetStats,
  });

  const caches = createCaches({
    docker, dockerList, log, sleep,
    dind, buildkit, serviceMark: names.serviceMark,
    settingsOf, limitsOf, poolOf,
    cacheVolume: names.cacheVolume, seedVolume: names.seedVolume, buildVolume: names.buildVolume, buildSocket: names.buildSocket,
    buildService: names.buildService, buildNetwork: names.buildNetwork,
    stopping, dockerReady,
  });

  reserve = createPools({
    log, sleep, pools,
    settingsOf, limitsOf, stopping, dockerReady, vetted,
    provision: slots.provision, removePair: slots.removePair, abort: slots.abort, slotLoop: slots.slotLoop, abortIdle: slots.abortIdle,
    prepareCaches: caches.prepareCaches, refreshSeed: seed.refreshSeed, measureSizes: caches.measureSizes,
  });

  const logError = errorLog(log);

  // Every minute: refill the reserve and renew a build service with old limits.
  function tick() {
    for (const pool of pools.values()) {
      reserve.replenish(pool);
      caches.renewService(pool).catch(logError(pool.repo));
    }
  }

  // Measure the volumes of all pools; a resting pool measures by itself when its work is done.
  function measureAll() {
    if (!dockerReady()) return;
    for (const pool of pools.values()) if (!pool.hold) caches.measureSizes(pool);
  }

  // On Windows sign-out: remove the idle runners from GitHub, all at once. Errors do not count; whatever is left
  // the next start removes.
  const releaseIdle = () => Promise.all(idleRegistrations(pools.values()).map(({ repo, runnerId }) => unregisterRunner(github, repo, runnerId).catch(() => {})));

  return { pools, seed, slots, caches, ...reserve, tick, measureAll, releaseIdle };
}

module.exports = { createRunners };
