// Was die Oberfläche auslösen kann (`POST /api/<name>`): Pools anlegen, einstellen, leeren und entfernen, Limits
// setzen, Läufe erneut starten, sich bei GitHub an- und abmelden. Jeder Aufruf bekommt das JSON-Objekt aus der Anfrage
// und wirft mit einer Meldung für die Oberfläche, wenn er nicht geht. Was länger dauert (ein Pool wird entfernt, ein
// Cache geleert), läuft nach der Antwort weiter und meldet sich im Protokoll.
//
// Dazu `guard`: was geschieht, wenn ein Repo mit Pool öffentlich geworden ist, Pull Requests aus Forks auf diesem
// Rechner laufen könnten oder sich beides nicht prüfen lässt (siehe blocks.js, remote.js).

const limitRules = require('./limits');
const { VARIABLE } = require('./routing');
const { sameRepo, clashes } = require('./images');
const { clampParallel, REPO_NAME } = require('./settings');
const { SECOND } = require('./units');
const { forkExposure } = require('./forks');
const { BLOCKS, blockOf } = require('./blocks');
const { msg, Fault, reason } = require('./messages');

const CACHE_PARTS = { packages: 'm_cachePackages', build: 'm_cacheBuild', images: 'm_cacheImages', all: 'm_cacheAll' };
const SHUTDOWN_DELAY = SECOND / 10; // erst antworten, dann beenden
// Was eine Änderung an CI_RUNNER bewirkt, für das Protokoll.
const routedText = (on) => msg(on ? 'm_routedOn' : 'm_routedOff', VARIABLE);
const KEPT = msg('m_routingKept', VARIABLE);
// Wo sich Fork-PRs abschalten lassen (siehe forks.js).
const FORKS_HOW = msg('m_forksHow');

//   github                  Zugang zu GitHub (siehe github.js)
//   settings                siehe settings.js
//   runners                 siehe runners.js
//   remote, routing, waiting, metrics, account   siehe die gleichnamigen Module
//   dockerWatch             `ready()`, `removeRegistrations(repo)` (siehe dockerwatch.js)
//   setup                   `launch()`: Docker Desktop starten (siehe setup.js)
//   limitRange(), limitPlan()   siehe status.js
//   log(text, repo, kind), logError(repo, what)
//   shutdown()              RunClub beenden
//   timer                   wie `setTimeout`; in Tests steuerbar
function createActions({ github, settings, runners, remote, routing, waiting, metrics, account, dockerWatch, setup, limitRange, limitPlan, log, logError, shutdown, timer = setTimeout }) {
  const { config, saveConfig, settingsOf, limitsOf } = settings;
  const { pools } = runners;

  // Einstellungen und stehender Pool eines Repos, sonst wirft es.
  function poolOf(repo) {
    const own = settingsOf(repo);
    const pool = pools.get(repo);
    if (!own || !pool) throw new Fault('m_noPool');
    return { own, pool };
  }
  function requireDocker() {
    if (!dockerWatch.ready()) throw new Fault('m_dockerNotReady');
  }
  // Freie Paare beenden und die Reserve abbauen, damit ein pausierter Pool nichts mehr annimmt.
  function rest(repo, pool) {
    pool.slots.forEach((slot) => runners.slots.abortIdle(slot));
    runners.discardReserve(pool).catch(logError(repo));
  }
  // Neue Limits für alle Projekte übernehmen (Speicher in GB, Kerne als Anzahl); was fehlt, bleibt.
  function applySharedLimits(input) {
    config.limits = { ...config.limits, ...limitRules.normalize(input, config.limits, limitRange()) };
  }
  // Vorbereitete Paare tragen noch die alten Limits: verwerfen, die Reserve füllt sich mit den neuen.
  const renewAll = () => { for (const pool of pools.values()) runners.renewReserve(pool); };
  const limitsText = (limits) => msg('m_limits', limits.runnerMemory, limits.runnerCpus, limits.dockerMemory, limits.dockerCpus);

  // Einen Pool abbauen, nachdem er aus den Einstellungen verschwunden ist: Caches und Vorlage löschen, die Jobs zurück
  // an GitHubs Runner leiten, Anmeldungen bei GitHub und Gelerntes verwerfen. Auch wenn ein Schritt scheitert, wird der
  // Name am Ende wieder frei.
  async function retire(repo, pool) {
    try {
      // Erst ruht der Pool: Was noch an Caches und Vorlage arbeitet, läuft zu Ende und legt danach nichts mehr an.
      const failures = [];
      await runners.withPoolAtRest(pool, async () => {
        await runners.caches.removeCaches(repo, { packages: true, build: true }).catch((error) => failures.push(reason(error)));
        await runners.seed.forget(repo).catch((error) => failures.push(reason(error)));
      });
      // Ohne Pool würden die Jobs ewig auf einen Runner warten: zurück zu GitHubs Runnern. Der Stand wird frisch
      // gelesen – die Variable kann inzwischen von Hand gesetzt worden sein. Lässt er sich nicht lesen, bleibt die
      // Variable, wie sie ist, und das steht im Protokoll.
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

  // Einen Pool sperren (siehe blocks.js): Er pausiert, freie Paare und Reserve gehen, und die Jobs gehen zurück an
  // GitHubs Runner. Ein Job, der schon läuft, läuft zu Ende. Aufgehoben wird die Sperre nur von einer Prüfung, die den
  // Grund weggefallen findet (siehe remote.js); fortgesetzt wird der Pool danach von Hand.
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
  // Ein Pool, dessen Repo sich seit einer Weile nicht prüfen ließ, ruht (siehe remote.js): Freie Paare und Reserve gehen.
  function restUnchecked(repo) {
    const pool = pools.get(repo);
    if (pool && !pool.removed) rest(repo, pool);
  }

  const actions = {
    async 'pool/add'({ repo, parallel }) {
      if (!REPO_NAME.test(String(repo))) throw new Fault('m_repoName');
      const info = await github.get(`repos/${repo}`);
      if (!info.permissions?.admin) throw new Fault('m_noAdmin');
      // Fremde Pull Requests eines öffentlichen Repos würden auf diesem Rechner Code ausführen (siehe Kopf von backend.js).
      if (info.private === false) throw new Fault('m_publicRefused');
      // Ein Org-Repo, in dem Workflows aus Forks laufen dürfen, bekommt keinen Pool (siehe forks.js).
      const forks = await forkExposure(github, info.full_name, info);
      if (forks.exposed) throw new Fault('m_forksRefused', forks.reason, FORKS_HOW);
      // Erst hier prüfen, mit dem Namen, wie GitHub ihn schreibt, und ohne weiteres Warten bis zum Eintrag:
      // sonst entstünde bei anderer Schreibweise oder zwei Anfragen kurz nacheinander ein zweiter Pool.
      const taken = [...settings.repos(), ...pools.keys()];
      if (taken.some((other) => sameRepo(other, info.full_name))) throw new Fault(pools.get(info.full_name)?.removed ? 'm_poolRemoving' : 'm_poolExists');
      const clash = clashes(info.full_name, taken);
      if (clash) throw new Fault('m_nameClash', clash);
      settings.addPool(info.full_name, parallel);
      waiting.forget(info.full_name);
      log(msg('m_poolAdded'), info.full_name);
      remote.markChecked(info.full_name); // eben geprüft: sichtbar privat, keine Fork-PRs
      runners.startPool(info.full_name);
      remote.refreshAll();
      // Die Jobs des Repos auf die eigenen Runner leiten, wenn seine Workflows die Variable lesen.
      routing.check(info.full_name).then(async (found) => {
        if (found.uses === 'variable' && !found.here) { await routing.set(info.full_name, true); log(routedText(true), info.full_name); }
        else if (found.uses === 'none') log(msg('m_variableUnused', VARIABLE), info.full_name);
      }).catch(logError(info.full_name, VARIABLE));
    },
    async 'pool/set'({ repo, parallel, paused, cache }) {
      const { own, pool } = poolOf(repo);
      // Jeder falsche Wert setzt fort (`Boolean(paused)` unten), nicht nur `false`.
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
    // Leert, was zwischen den Jobs bleibt. Freie Paare werden dafür beendet, arbeitende laufen erst zu Ende.
    async 'pool/clear'({ repo, what }) {
      const { pool } = poolOf(repo);
      if (!Object.hasOwn(CACHE_PARTS, what)) throw new Fault('m_unknownCache');
      const all = what === 'all';
      log(msg('m_clearing', msg(CACHE_PARTS[what])), repo);
      runners.withPoolAtRest(pool, async () => {
        // Was auch scheitert: Danach stehen Paket-Cache, Build-Dienst und Vorlage wieder bereit. Sonst fehlte etwa der
        // Build-Dienst, den das Leeren schon beendet hat, bis zum nächsten Neustart.
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
    // Einen abgeschlossenen Lauf oder Job von Hand erneut starten; das löscht nichts.
    async 'run/rerun'({ repo, id, failedOnly }) {
      await remote.rerun(repo, id, `runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, 'm_noRun');
      log(msg(failedOnly ? 'm_runRerunFailed' : 'm_runRerun', String(id)), repo);
    },
    async 'job/rerun'({ repo, id }) {
      await remote.rerun(repo, id, `jobs/${id}/rerun`, 'm_noJob');
      log(msg('m_jobRerun', String(id)), repo);
    },
    // Speicher in GB, Kerne als Anzahl. Arbeitende und schon bereite Paare behalten ihre Limits bis zum nächsten Aufbau.
    // Mit `repo` gelten sie nur für dieses Projekt; `inherit` nimmt dessen eigene Werte wieder weg.
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
    // Übernimmt den Vorschlag aus den Messwerten als Ganzes: den Standard für alle und eigene Limits für die Ausreißer.
    // Gemessene Projekte, die nicht als Ausreißer gelten, verlieren dabei ihre eigenen Werte.
    async 'limits/plan'() {
      requireDocker();
      const found = limitPlan();
      if (!found) throw new Fault('m_noSuggestion');
      applySharedLimits(found.shared);
      for (const own of config.pools) {
        if (!found.measured.includes(own.repo)) continue; // zu wenige Läufe: Was der Nutzer eingestellt hat, bleibt
        if (found.own[own.repo]) own.limits = limitRules.normalize(found.own[own.repo], limitsOf(own.repo), limitRange()); else delete own.limits;
      }
      saveConfig();
      const outliers = Object.keys(found.own);
      log(outliers.length ? msg('m_planAppliedOwn', config.limits.runnerMemory, config.limits.dockerMemory, outliers) : msg('m_planApplied', config.limits.runnerMemory, config.limits.dockerMemory));
      renewAll();
    },
    // Baut die freien Paare neu auf, damit neue Limits sofort gelten. Arbeitende Paare laufen zu Ende.
    async 'pool/rebuild'({ repo }) {
      if (repo && !pools.get(repo)) throw new Fault('m_noPool');
      for (const pool of repo ? [pools.get(repo)] : [...pools.values()]) {
        if (pool.removed || !runners.staleCount(pool)) continue;
        log(msg('m_rebuilding'), pool.repo);
        runners.rebuildIdle(pool).catch(logError(pool.repo));
      }
    },
    // Anmelden antwortet, sobald der Einmalcode im Stand steht; bestätigt wird im Browser (siehe auth.js).
    async 'auth/login'() { await account.login(); },
    async 'auth/cancel'() { await account.cancel(); },
    async 'auth/logout'() { await account.logout(); },
    // Docker Desktop starten, wenn es installiert ist und nicht läuft (siehe setup.js).
    async 'docker/start'() { setup.launch(); },
    async shutdown() { timer(shutdown, SHUTDOWN_DELAY); },
  };

  return { actions, guard: { block, unblock, restUnchecked } };
}

module.exports = { createActions };
