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

const CACHE_PARTS = { packages: 'den Paket-Cache', build: 'die Build-Layer', images: 'die gelernten Abbilder', all: 'alle Caches' };
const SHUTDOWN_DELAY = SECOND / 10; // erst antworten, dann beenden
const NO_POOL = 'Diesen Pool gibt es nicht.';
// Was eine Änderung an CI_RUNNER bewirkt, für das Protokoll.
const routedText = (on) => `${VARIABLE} ${on ? 'gesetzt – die Jobs laufen auf den eigenen Runnern' : 'entfernt – die Jobs gehen wieder an GitHubs Runner'}`;
const KEPT = `${VARIABLE} bleibt, wie es ist`;
// Wo sich Fork-PRs abschalten lassen (siehe forks.js).
const FORKS_HOW = 'Abschalten unter Settings → Actions → General → „Fork pull request workflows in private repositories“ („Run workflows from fork pull requests“ aus); die Organisation kann das vorgeben.';

//   gh(args)                Aufruf der GitHub-API
//   settings                siehe settings.js
//   runners                 siehe runners.js
//   remote, routing, waiting, metrics, account   siehe die gleichnamigen Module
//   dockerWatch             `ready()`, `removeRegistrations(repo)` (siehe dockerwatch.js)
//   limitRange(), limitPlan()   siehe status.js
//   log(text, repo, kind), logError(repo, what)
//   shutdown()              RunClub beenden
//   timer                   wie `setTimeout`; in Tests steuerbar
function createActions({ gh, settings, runners, remote, routing, waiting, metrics, account, dockerWatch, limitRange, limitPlan, log, logError, shutdown, timer = setTimeout }) {
  const { config, saveConfig, settingsOf, limitsOf } = settings;
  const { pools } = runners;

  // Einstellungen und stehender Pool eines Repos, sonst wirft es.
  function poolOf(repo) {
    const own = settingsOf(repo);
    const pool = pools.get(repo);
    if (!own || !pool) throw new Error(NO_POOL);
    return { own, pool };
  }
  function requireDocker() {
    if (!dockerWatch.ready()) throw new Error('Docker ist noch nicht bereit; die Grenzen der Docker-VM sind noch unbekannt.');
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
  const limitsText = (limits) => `Runner ${limits.runnerMemory} und ${limits.runnerCpus} Kerne, Docker ${limits.dockerMemory} und ${limits.dockerCpus} Kerne`;

  // Einen Pool abbauen, nachdem er aus den Einstellungen verschwunden ist: Caches und Vorlage löschen, die Jobs zurück
  // an GitHubs Runner leiten, Anmeldungen bei GitHub und Gelerntes verwerfen. Auch wenn ein Schritt scheitert, wird der
  // Name am Ende wieder frei.
  async function retire(repo, pool) {
    try {
      // Erst ruht der Pool: Was noch an Caches und Vorlage arbeitet, läuft zu Ende und legt danach nichts mehr an.
      const failures = [];
      await runners.withPoolAtRest(pool, async () => {
        await runners.caches.removeCaches(repo, { packages: true, build: true }).catch((error) => failures.push(error.message));
        await runners.seed.forget(repo).catch((error) => failures.push(error.message));
      });
      // Ohne Pool würden die Jobs ewig auf einen Runner warten: zurück zu GitHubs Runnern. Der Stand wird frisch
      // gelesen – die Variable kann inzwischen von Hand gesetzt worden sein. Lässt er sich nicht lesen, bleibt die
      // Variable, wie sie ist, und das steht im Protokoll.
      await (async () => {
        const found = await routing.check(repo);
        if (found.error) throw new Error(found.error);
        if (found.here) { await routing.set(repo, false); log(routedText(false), repo); }
      })().catch(logError(repo, KEPT));
      routing.forget(repo);
      await dockerWatch.removeRegistrations(repo);
      metrics.forget(repo);
      remote.forget(repo);
      if (failures.length) log(`Pool entfernt, aber nicht alles: ${failures.join('; ')}`, repo, 'error');
      else log('Pool und seine Caches sind entfernt', repo);
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
    public: {
      paused: () => 'Das Repo ist öffentlich geworden. Damit keine fremden Pull Requests auf diesem Rechner laufen, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner.',
      locked: 'Das Repo ist öffentlich. Der Pool lässt sich erst wieder nutzen, wenn es privat ist.',
      cleared: 'Das Repo ist wieder privat',
    },
    forks: {
      paused: (reason) => `${reason}. Damit kein Code aus Forks auf diesem Rechner läuft, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner. ${FORKS_HOW}`,
      locked: `Pull Requests aus Forks könnten auf diesem Rechner Code ausführen. ${FORKS_HOW}`,
      cleared: 'Workflows aus Forks laufen in diesem Repo nicht mehr',
    },
    forksUnknown: {
      paused: (reason) => `${reason}. Damit kein Code aus Forks auf diesem Rechner läuft, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner. Die nächste Prüfung versucht es wieder.`,
      locked: 'Ob in diesem Repo Workflows aus Forks laufen dürfen, ließ sich nicht prüfen. Die nächste Prüfung versucht es wieder.',
      cleared: 'Ob Workflows aus Forks laufen dürfen, ließ sich wieder lesen',
    },
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
    log(`${BLOCK_TEXT[kind].cleared}; ${still ? `der Pool bleibt gesperrt: ${BLOCK_TEXT[still].locked}` : 'der Pool lässt sich fortsetzen.'}`, repo);
  }
  function refuseIfBlocked(own) {
    const kind = blockOf(own);
    if (kind) throw new Error(BLOCK_TEXT[kind].locked);
  }
  // Ein Pool, dessen Repo sich seit einer Weile nicht prüfen ließ, ruht (siehe remote.js): Freie Paare und Reserve gehen.
  function restUnchecked(repo) {
    const pool = pools.get(repo);
    if (pool && !pool.removed) rest(repo, pool);
  }

  const actions = {
    async 'pool/add'({ repo, parallel }) {
      if (!REPO_NAME.test(String(repo))) throw new Error('Das Repo wird als besitzer/name angegeben.');
      const info = await gh(['api', `repos/${repo}`]);
      if (!info.permissions?.admin) throw new Error('Für dieses Repo fehlen dir die Verwaltungsrechte; ohne sie lässt sich kein Runner anmelden.');
      // Fremde Pull Requests eines öffentlichen Repos würden auf diesem Rechner Code ausführen (siehe Kopf von backend.js).
      if (info.private === false) throw new Error('Das Repo ist öffentlich. Auf den eigenen Runnern darf nur Code laufen, dem du vertraust; Pools gibt es deshalb nur für private Repos.');
      // Ein Org-Repo, in dem Workflows aus Forks laufen dürfen, bekommt keinen Pool (siehe forks.js).
      const forks = await forkExposure(gh, info.full_name, info);
      if (forks.exposed) throw new Error(`${forks.reason}. Auf den eigenen Runnern darf nur Code laufen, dem du vertraust. ${FORKS_HOW}`);
      // Erst hier prüfen, mit dem Namen, wie GitHub ihn schreibt, und ohne weiteres Warten bis zum Eintrag:
      // sonst entstünde bei anderer Schreibweise oder zwei Anfragen kurz nacheinander ein zweiter Pool.
      const taken = [...settings.repos(), ...pools.keys()];
      if (taken.some((other) => sameRepo(other, info.full_name))) throw new Error(pools.get(info.full_name)?.removed ? 'Dieser Pool wird gerade entfernt. Bitte warten, bis das abgeschlossen ist.' : 'Für dieses Repo gibt es schon einen Pool.');
      const clash = clashes(info.full_name, taken);
      if (clash) throw new Error(`Ein Pool für ${clash} belegt denselben Namen für Caches und Build-Dienst. Zwei Repos mit gleichem Namen lassen sich nicht zugleich bedienen.`);
      settings.addPool(info.full_name, parallel);
      waiting.forget(info.full_name);
      log('Pool angelegt', info.full_name);
      remote.markChecked(info.full_name); // eben geprüft: sichtbar privat, keine Fork-PRs
      runners.startPool(info.full_name);
      remote.refreshAll();
      // Die Jobs des Repos auf die eigenen Runner leiten, wenn seine Workflows die Variable lesen.
      routing.check(info.full_name).then(async (found) => {
        if (found.uses === 'variable' && !found.here) { await routing.set(info.full_name, true); log(routedText(true), info.full_name); }
        else if (found.uses === 'none') log(`Die Workflows lesen ${VARIABLE} nicht – die Jobs gehen weiter an GitHubs Runner`, info.full_name);
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
      log(`${own.parallel} ${own.parallel === 1 ? 'Platz' : 'Plätze'}, ${own.paused ? 'pausiert' : 'aktiv'}, Cache ${own.cache ? 'an' : 'aus'}`, repo);
    },
    async 'pool/remove'({ repo }) {
      const { pool } = poolOf(repo);
      settings.removePool(repo);
      pool.removed = true;
      log('Pool wird entfernt', repo);
      retire(repo, pool);
    },
    // Leert, was zwischen den Jobs bleibt. Freie Paare werden dafür beendet, arbeitende laufen erst zu Ende.
    async 'pool/clear'({ repo, what }) {
      const { pool } = poolOf(repo);
      if (!Object.hasOwn(CACHE_PARTS, what)) throw new Error('Unbekannter Cache.');
      const all = what === 'all';
      log(`Leere ${CACHE_PARTS[what]} …`, repo);
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
        log('Geleert; der nächste Lauf füllt wieder auf', repo);
      }).catch(logError(repo));
    },
    async 'pool/routing'({ repo, on }) {
      const own = settingsOf(repo);
      if (!own) throw new Error(NO_POOL);
      if (on) refuseIfBlocked(own);
      await routing.set(repo, Boolean(on));
      log(routedText(Boolean(on)), repo);
    },
    // Einen abgeschlossenen Lauf oder Job von Hand erneut starten; das löscht nichts.
    async 'run/rerun'({ repo, id, failedOnly }) {
      await remote.rerun(repo, id, `runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, 'Diesen Lauf gibt es nicht.');
      log(`Lauf ${id} erneut gestartet${failedOnly ? ' (nur die gescheiterten Jobs)' : ''}`, repo);
    },
    async 'job/rerun'({ repo, id }) {
      await remote.rerun(repo, id, `jobs/${id}/rerun`, 'Diesen Job gibt es nicht.');
      log(`Job ${id} erneut gestartet`, repo);
    },
    // Speicher in GB, Kerne als Anzahl. Arbeitende und schon bereite Paare behalten ihre Limits bis zum nächsten Aufbau.
    // Mit `repo` gelten sie nur für dieses Projekt; `inherit` nimmt dessen eigene Werte wieder weg.
    async 'limits/set'({ repo, inherit, ...input }) {
      requireDocker();
      const own = repo ? settingsOf(repo) : null;
      if (repo && !own) throw new Error(NO_POOL);
      if (own && inherit) { delete own.limits; log(`Wieder die Limits für alle (${limitsText(config.limits)})`, repo); }
      else if (own) { own.limits = limitRules.normalize(input, limitsOf(repo), limitRange()); log(`Eigene Limits – ${limitsText(own.limits)}`, repo); }
      else { applySharedLimits(input); log(`Limits je Job: ${limitsText(config.limits)}`); }
      saveConfig();
      renewAll();
    },
    // Übernimmt den Vorschlag aus den Messwerten als Ganzes: den Standard für alle und eigene Limits für die Ausreißer.
    // Gemessene Projekte, die nicht als Ausreißer gelten, verlieren dabei ihre eigenen Werte.
    async 'limits/plan'() {
      requireDocker();
      const found = limitPlan();
      if (!found) throw new Error('Für einen Vorschlag fehlen noch Messwerte.');
      applySharedLimits(found.shared);
      for (const own of config.pools) {
        if (!found.measured.includes(own.repo)) continue; // zu wenige Läufe: Was der Nutzer eingestellt hat, bleibt
        if (found.own[own.repo]) own.limits = limitRules.normalize(found.own[own.repo], limitsOf(own.repo), limitRange()); else delete own.limits;
      }
      saveConfig();
      const outliers = Object.keys(found.own);
      log(`Limits aus den Messwerten übernommen: Standard Runner ${config.limits.runnerMemory}, Docker ${config.limits.dockerMemory}${outliers.length ? `; eigene Limits für ${outliers.join(', ')}` : ''}`);
      renewAll();
    },
    // Baut die freien Paare neu auf, damit neue Limits sofort gelten. Arbeitende Paare laufen zu Ende.
    async 'pool/rebuild'({ repo }) {
      if (repo && !pools.get(repo)) throw new Error(NO_POOL);
      for (const pool of repo ? [pools.get(repo)] : [...pools.values()]) {
        if (pool.removed || !runners.staleCount(pool)) continue;
        log('Baue die freien Runner mit den neuen Limits auf', pool.repo);
        runners.rebuildIdle(pool).catch(logError(pool.repo));
      }
    },
    // Anmelden und Ergänzen antworten, sobald der Einmalcode im Stand steht; bestätigt wird im Browser (siehe auth.js).
    // `scope` nennt ein freiwilliges Recht; ohne Angabe werden die fehlenden Pflichtrechte ergänzt.
    async 'auth/login'() { await account.login(); },
    async 'auth/scope'({ scope }) { await account.grant(scope === undefined ? undefined : String(scope)); },
    async 'auth/cancel'() { await account.cancel(); },
    async 'auth/logout'() { await account.logout(); },
    async shutdown() { timer(shutdown, SHUTDOWN_DELAY); },
  };

  return { actions, guard: { block, unblock, restUnchecked } };
}

module.exports = { createActions };
