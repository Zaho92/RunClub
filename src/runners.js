// Die eigenen Linux-Runner, verdrahtet: Vorlage (seed.js), Plätze (slots.js), Caches und Build-Dienst (caches.js) und
// die Pools mit ihrer Reserve (pools.js). Plätze und Reserve brauchen einander; keine der beiden Dateien lädt die
// andere, die Verbindung entsteht hier. Die Plätze erfahren erst beim Gebrauch, was die Pools beisteuern.
//
// Liefert die Map der Pools (`pools`, Repo -> Pool), die Module als `seed`, `slots` und `caches` und die Funktionen
// aus pools.js unter ihrem eigenen Namen.

const crypto = require('node:crypto');
const { createSeed } = require('./seed');
const { createSlots } = require('./slots');
const { createCaches } = require('./caches');
const { createPools } = require('./pools');

//   docker(args, options), dockerList(args)   aus engine.js
//   gh(args, body)          Aufruf der GitHub-API
//   log(text, repo, kind, about), sleep(ms), timer (wie `setTimeout`), newId() (Kennung eines neuen Paars)
//   host                    Name des Rechners (Anfang der Runner-Namen)
//   names                   Kennzeichen und Namen je Repo (siehe names.js)
//   image, dind, buildkit   die Abbilder von Runner, Docker-Daemon und Build-Dienst
//   longTimeout             Zeitgrenze für Kopieren und Laden
//   settings                `settingsOf`, `limitsOf`, `state`, `saveState` (siehe settings.js)
//   metrics                 `meter()`, `recordJob(repo, record)` (siehe metrics.js)
//   stopping(), linuxReady()
//   refreshRepo(repo)       den Stand des Repos bei GitHub neu holen (siehe remote.js)
//   forgetStats(name)       die Messwerte eines Containers verwerfen (siehe usage.js)
function createRunners({
  docker, dockerList, gh, log, sleep, timer = setTimeout, newId = () => crypto.randomBytes(3).toString('hex'),
  host, names, image, dind, buildkit, longTimeout,
  settings, metrics, stopping, linuxReady, refreshRepo, forgetStats,
}) {
  const pools = new Map(); // Repo -> Pool (siehe pools.js)
  const { settingsOf, limitsOf } = settings;
  const poolOf = (repo) => pools.get(repo);

  const seed = createSeed({
    docker, dockerList, log, sleep,
    mark: names.mark, dind, longTimeout,
    settingsOf, seedVolume: names.seedVolume, poolOf,
    state: settings.state, saveState: settings.saveState,
  });

  let reserve = null; // die Funktionen aus pools.js; sie entstehen erst nach den Plätzen, die sie brauchen
  const slots = createSlots({
    docker, gh, log, sleep, timer, newId,
    host, mark: names.mark, image, dind, longTimeout, metrics,
    settingsOf, limitsOf, seedVolume: names.seedVolume, cacheVolume: names.cacheVolume, buildSocket: names.buildSocket,
    stopping, linuxReady, poolResting: (pool) => reserve.poolResting(pool),
    withSeed: seed.withSeed, learnImages: seed.learnImages,
    replenish: (pool) => reserve.replenish(pool), discardReserve: (pool, keep) => reserve.discardReserve(pool, keep),
    refreshRepo, forgetStats,
  });

  const caches = createCaches({
    docker, dockerList, log,
    dind, buildkit, serviceMark: names.serviceMark,
    settingsOf, limitsOf, poolOf,
    cacheVolume: names.cacheVolume, seedVolume: names.seedVolume, buildVolume: names.buildVolume, buildSocket: names.buildSocket,
    buildService: names.buildService, buildNetwork: names.buildNetwork,
    stopping, linuxReady,
  });

  reserve = createPools({
    log, sleep, pools,
    settingsOf, limitsOf, stopping, linuxReady,
    provision: slots.provision, removePair: slots.removePair, teardown: slots.teardown, slotLoop: slots.slotLoop, abortIdle: slots.abortIdle,
    prepareCaches: caches.prepareCaches, refreshSeed: seed.refreshSeed, measureSizes: caches.measureSizes,
  });

  return { pools, seed, slots, caches, ...reserve };
}

module.exports = { createRunners };
