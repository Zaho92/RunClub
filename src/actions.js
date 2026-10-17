// What the interface can trigger (`POST /api/<name>`): add, configure, clear and remove pools, set limits,
// rerun runs, sign in to and out of GitHub. Each call gets the JSON object from the request
// and throws with a message for the interface if it doesn't work. What takes longer (a pool is removed, a
// cache cleared) carries on after the reply and reports in the log.
//
// Plus `guard`: what happens when a repo with a pool has become public, pull requests from forks could run on this
// machine, or neither can be checked (see blocks.js, remote.js).

const limitRules = require('./limits');
const { VARIABLE } = require('./routing');
const { sameRepo, clashes } = require('./images');
const { clampParallel, REPO_NAME } = require('./settings');
const { SECOND } = require('./units');
const { forkExposure } = require('./forks');
const { BLOCKS, blockOf } = require('./blocks');
const { msg, Fault, reason } = require('./messages');

const CACHE_PARTS = { packages: 'm_cachePackages', build: 'm_cacheBuild', images: 'm_cacheImages', all: 'm_cacheAll' };
const SHUTDOWN_DELAY = SECOND / 10; // reply first, then shut down
// What a change to CI_RUNNER does, for the log.
const routedText = (on) => msg(on ? 'm_routedOn' : 'm_routedOff', VARIABLE);
const KEPT = msg('m_routingKept', VARIABLE);
// Where fork PRs can be switched off (see forks.js).
const FORKS_HOW = msg('m_forksHow');

//   github                  access to GitHub (see github.js)
//   settings                see settings.js
//   runners                 see runners.js
//   remote, routing, waiting, metrics, account   see the modules of the same name
//   dockerWatch             `ready()`, `removeRegistrations(repo)` (see dockerwatch.js)
//   setup                   `launch()`: start Docker Desktop (see setup.js)
//   limitRange(), limitPlan()   see status.js
//   log(text, repo, kind), logError(repo, what)
//   shutdown()              quit RunClub
//   timer                   like `setTimeout`; controllable in tests
function createActions({ github, settings, runners, remote, routing, waiting, metrics, account, dockerWatch, setup, limitRange, limitPlan, log, logError, shutdown, timer = setTimeout }) {
  const { config, saveConfig, settingsOf, limitsOf } = settings;
  const { pools } = runners;

  // Settings and standing pool of a repo, otherwise it throws.
  function poolOf(repo) {
    const own = settingsOf(repo);
    const pool = pools.get(repo);
    if (!own || !pool) throw new Fault('m_noPool');
    return { own, pool };
  }
  function requireDocker() {
    if (!dockerWatch.ready()) throw new Fault('m_dockerNotReady');
  }
  // End idle pairs and tear down the reserve, so a paused pool takes nothing more.
  function rest(repo, pool) {
    pool.slots.forEach((slot) => runners.slots.abortIdle(slot));
    runners.discardReserve(pool).catch(logError(repo));
  }
  // Take over new limits for all projects (memory in GB, cores as a count); whatever is missing stays.
  function applySharedLimits(input) {
    config.limits = { ...config.limits, ...limitRules.normalize(input, config.limits, limitRange()) };
  }
  // Prepared pairs still carry the old limits: discard them, the reserve fills up with the new ones.
  const renewAll = () => { for (const pool of pools.values()) runners.renewReserve(pool); };
  const limitsText = (limits) => msg('m_limits', limits.runnerMemory, limits.runnerCpus, limits.dockerMemory, limits.dockerCpus);

  // Tear down a pool after it has gone from the settings: delete caches and template, route the jobs back
  // to GitHub's runners, discard registrations at GitHub and what was learned. Even if a step fails, the
  // name becomes free again at the end.
  async function retire(repo, pool) {
    try {
      // First the pool rests: whatever still works on caches and template finishes and creates nothing afterwards.
      const failures = [];
      await runners.withPoolAtRest(pool, async () => {
        await runners.caches.removeCaches(repo, { packages: true, build: true }).catch((error) => failures.push(reason(error)));
        await runners.seed.forget(repo).catch((error) => failures.push(reason(error)));
      });
      // Without a pool the jobs would wait forever for a runner: back to GitHub's runners. The state is read
      // fresh – the variable may have been set by hand meanwhile. If it can't be read, the
      // variable stays as it is, and that goes in the log.
      await (async () => {
        const found = await routing.check(repo);
        if (found.error) throw Fault.of(found.error);
        if (found.here) { await routing.set(repo, false); log(routedText(false), repo); }
      })().catch(logError(repo, KEPT));
      routing.forget(repo);
      await dockerWatch.removeRegistrations(repo);
      metrics.forget(repo);
      remote.forget(repo);
      if (failures.length) log(msg('m_poolRemovedPartly', failures), repo, 'error');
      else log(msg('m_poolRemoved'), repo);
    } catch (error) {
      logError(repo)(error);
    } finally {
      if (pools.get(repo) === pool) pools.delete(repo);
    }
  }

  // Block a pool (see blocks.js): it pauses, idle pairs and reserve go, and the jobs go back to
  // GitHub's runners. A job already running finishes. The block is lifted only by a check that finds the
  // reason gone (see remote.js); the pool is resumed by hand afterwards.
  const BLOCK_TEXT = {
    public: { paused: () => msg('m_publicPaused'), locked: msg('m_publicLocked'), cleared: msg('m_publicCleared') },
    forks: { paused: (why) => msg('m_forksPaused', why, FORKS_HOW), locked: msg('m_forksLocked', FORKS_HOW), cleared: msg('m_forksCleared') },
    forksUnknown: { paused: (why) => msg('m_forksUnknownPaused', why), locked: msg('m_forksUnknownLocked'), cleared: msg('m_forksUnknownCleared') },
  };
  async function block(repo, kind, reason) {
    const own = settingsOf(repo);
    const pool = pools.get(repo);
    if (!own || !pool || pool.removed) return;
    Object.assign(own, { paused: true, [BLOCKS[kind]]: true });
    saveConfig();
    rest(repo, pool);
    log(BLOCK_TEXT[kind].paused(reason), repo, 'error');
    await routing.set(repo, false).catch(logError(repo, KEPT));
  }
  function unblock(repo, kind) {
    const own = settingsOf(repo);
    if (!own?.[BLOCKS[kind]]) return;
    delete own[BLOCKS[kind]];
    saveConfig();
    const still = blockOf(own);
    log(still ? msg('m_unblockStill', BLOCK_TEXT[kind].cleared, BLOCK_TEXT[still].locked) : msg('m_unblockFree', BLOCK_TEXT[kind].cleared), repo);
  }
  function refuseIfBlocked(own) {
    const kind = blockOf(own);
    if (kind) throw Fault.of(BLOCK_TEXT[kind].locked);
  }
  // A pool whose repo could not be checked for a while rests (see remote.js): idle pairs and reserve go.
  function restUnchecked(repo) {
    const pool = pools.get(repo);
    if (pool && !pool.removed) rest(repo, pool);
  }

  const actions = {
    async 'pool/add'({ repo, parallel }) {
      if (!REPO_NAME.test(String(repo))) throw new Fault('m_repoName');
      const info = await github.get(`repos/${repo}`);
      if (!info.permissions?.admin) throw new Fault('m_noAdmin');
      // Outside pull requests of a public repo would run code on this machine (see the head of backend.js).
      if (info.private === false) throw new Fault('m_publicRefused');
      // An org repo in which workflows from forks may run gets no pool (see forks.js).
      const forks = await forkExposure(github, info.full_name, info);
      if (forks.exposed) throw new Fault('m_forksRefused', forks.reason, FORKS_HOW);
      // Check only here, with the name as GitHub writes it, and without further waiting until the entry:
      // otherwise a different spelling or two requests in quick succession would create a second pool.
      const taken = [...settings.repos(), ...pools.keys()];
      if (taken.some((other) => sameRepo(other, info.full_name))) throw new Fault(pools.get(info.full_name)?.removed ? 'm_poolRemoving' : 'm_poolExists');
      const clash = clashes(info.full_name, taken);
      if (clash) throw new Fault('m_nameClash', clash);
      settings.addPool(info.full_name, parallel);
      waiting.forget(info.full_name);
      log(msg('m_poolAdded'), info.full_name);
      remote.markChecked(info.full_name); // just checked: visibly private, no fork PRs
      runners.startPool(info.full_name);
      remote.refreshAll();
      // Route the repo's jobs to our own runners if its workflows read the variable.
      routing.check(info.full_name).then(async (found) => {
        if (found.uses === 'variable' && !found.here) { await routing.set(info.full_name, true); log(routedText(true), info.full_name); }
        else if (found.uses === 'none') log(msg('m_variableUnused', VARIABLE), info.full_name);
      }).catch(logError(info.full_name, VARIABLE));
    },
    async 'pool/set'({ repo, parallel, paused, cache }) {
      const { own, pool } = poolOf(repo);
      // Any falsy value resumes (`Boolean(paused)` below), not just `false`.
      if (paused !== undefined && !paused) refuseIfBlocked(own);
      if (parallel !== undefined) own.parallel = clampParallel(parallel);
      if (paused !== undefined) own.paused = Boolean(paused);
      const cacheChanged = cache !== undefined && Boolean(cache) !== own.cache;
      if (cacheChanged) own.cache = Boolean(cache);
      saveConfig();
      if (own.paused) rest(repo, pool);
      runners.reconcile(pool);
      if (cacheChanged) runners.withPoolAtRest(pool, () => runners.caches.prepareCaches(repo)).catch(logError(repo));
      log(msg('m_poolSet', msg(own.parallel === 1 ? 'm_slotsOne' : 'm_slotsMany', own.parallel), msg(own.paused ? 'm_paused' : 'm_active'), msg(own.cache ? 'm_on' : 'm_off')), repo);
    },
    async 'pool/remove'({ repo }) {
      const { pool } = poolOf(repo);
      settings.removePool(repo);
      pool.removed = true;
      log(msg('m_poolRetiring'), repo);
      retire(repo, pool);
    },
    // Clears what stays between jobs. Idle pairs are ended for it, working ones finish first.
    async 'pool/clear'({ repo, what }) {
      const { pool } = poolOf(repo);
      if (!Object.hasOwn(CACHE_PARTS, what)) throw new Fault('m_unknownCache');
      const all = what === 'all';
      log(msg('m_clearing', msg(CACHE_PARTS[what])), repo);
      runners.withPoolAtRest(pool, async () => {
        // Whatever fails: afterwards package cache, build service and template are ready again. Otherwise, say, the
        // build service that clearing already stopped would be missing until the next restart.
        try {
          await runners.caches.removeCaches(repo, { packages: all || what === 'packages', build: all || what === 'build' });
          if (all || what === 'images') await runners.seed.forget(repo);
        } finally {
          await runners.caches.prepareCaches(repo);
          await runners.seed.refreshSeed(repo);
          await runners.caches.measureSizes(pool);
        }
        log(msg('m_cleared'), repo);
      }).catch(logError(repo));
    },
    async 'pool/routing'({ repo, on }) {
      const own = settingsOf(repo);
      if (!own) throw new Fault('m_noPool');
      if (on) refuseIfBlocked(own);
      await routing.set(repo, Boolean(on));
      log(routedText(Boolean(on)), repo);
    },
    // Rerun a finished run or job by hand; that deletes nothing.
    async 'run/rerun'({ repo, id, failedOnly }) {
      await remote.rerun(repo, id, `runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, 'm_noRun');
      log(msg(failedOnly ? 'm_runRerunFailed' : 'm_runRerun', String(id)), repo);
    },
    async 'job/rerun'({ repo, id }) {
      await remote.rerun(repo, id, `jobs/${id}/rerun`, 'm_noJob');
      log(msg('m_jobRerun', String(id)), repo);
    },
    // Memory in GB, cores as a count. Working and already ready pairs keep their limits until the next build-up.
    // With `repo` they apply only to that project; `inherit` takes its own values away again.
    async 'limits/set'({ repo, inherit, ...input }) {
      requireDocker();
      const own = repo ? settingsOf(repo) : null;
      if (repo && !own) throw new Fault('m_noPool');
      if (own && inherit) { delete own.limits; log(msg('m_limitsInherit', limitsText(config.limits)), repo); }
      else if (own) { own.limits = limitRules.normalize(input, limitsOf(repo), limitRange()); log(msg('m_limitsOwn', limitsText(own.limits)), repo); }
      else { applySharedLimits(input); log(msg('m_limitsShared', limitsText(config.limits))); }
      saveConfig();
      renewAll();
    },
    // Takes over the suggestion from the measurements as a whole: the default for all and own limits for the outliers.
    // Measured projects that don't count as outliers lose their own values in the process.
    async 'limits/plan'() {
      requireDocker();
      const found = limitPlan();
      if (!found) throw new Fault('m_noSuggestion');
      applySharedLimits(found.shared);
      for (const own of config.pools) {
        if (!found.measured.includes(own.repo)) continue; // too few runs: what the user has set stays
        if (found.own[own.repo]) own.limits = limitRules.normalize(found.own[own.repo], limitsOf(own.repo), limitRange()); else delete own.limits;
      }
      saveConfig();
      const outliers = Object.keys(found.own);
      log(outliers.length ? msg('m_planAppliedOwn', config.limits.runnerMemory, config.limits.dockerMemory, outliers) : msg('m_planApplied', config.limits.runnerMemory, config.limits.dockerMemory));
      renewAll();
    },
    // Rebuilds the idle pairs so new limits apply at once. Working pairs finish.
    async 'pool/rebuild'({ repo }) {
      if (repo && !pools.get(repo)) throw new Fault('m_noPool');
      for (const pool of repo ? [pools.get(repo)] : [...pools.values()]) {
        if (pool.removed || !runners.staleCount(pool)) continue;
        log(msg('m_rebuilding'), pool.repo);
        runners.rebuildIdle(pool).catch(logError(pool.repo));
      }
    },
    // Signing in answers as soon as the one-time code is in the state; confirmation happens in the browser (see auth.js).
    async 'auth/login'() { await account.login(); },
    async 'auth/cancel'() { await account.cancel(); },
    async 'auth/logout'() { await account.logout(); },
    // Start Docker Desktop if it is installed and not running (see setup.js).
    async 'docker/start'() { setup.launch(); },
    async shutdown() { timer(shutdown, SHUTDOWN_DELAY); },
  };

  return { actions, guard: { block, unblock, restUnchecked } };
}

module.exports = { createActions };
