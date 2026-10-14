// Was die Oberfläche auslösen kann (`POST /api/<name>`): Pools anlegen, einstellen, leeren und entfernen, Limits
// setzen, Läufe erneut starten, sich bei GitHub an- und abmelden. Jeder Aufruf bekommt das JSON-Objekt aus der Anfrage
// und wirft mit einer Meldung für die Oberfläche, wenn er nicht geht. Was länger dauert (ein Pool wird entfernt, ein
// Cache geleert), läuft nach der Antwort weiter und meldet sich im Protokoll.
//
// Dazu `pauseForPublic`: was geschieht, wenn ein Repo mit Pool öffentlich geworden ist (siehe remote.js).

const limitRules = require('./limits');
const { VARIABLE } = require('./routing');
const { sameRepo, clashes } = require('./images');
const { clampParallel, REPO_NAME } = require('./settings');

const CACHE_PARTS = { packages: 'den Paket-Cache', build: 'die Build-Layer', images: 'die gelernten Abbilder', all: 'alle Caches' };
const SHUTDOWN_DELAY = 100; // ms: erst antworten, dann beenden
const NO_POOL = 'Diesen Pool gibt es nicht.';

//   gh(args)                Aufruf der GitHub-API
//   settings                siehe settings.js
//   runners                 siehe runners.js
//   remote, routing, waiting, metrics, account   siehe die gleichnamigen Module
//   docker                  `ready()`, `removeRegistrations(repo)` (die Docker-Überwachung aus linux.js)
//   limitRange(), limitPlan()   siehe status.js
//   log(text, repo, kind), logError(repo, what)
//   shutdown()              RunClub beenden
//   timer                   wie `setTimeout`; in Tests steuerbar
function createActions({ gh, settings, runners, remote, routing, waiting, metrics, account, docker, limitRange, limitPlan, log, logError, shutdown, timer = setTimeout }) {
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
    if (!docker.ready()) throw new Error('Docker ist noch nicht bereit; die Grenzen der Docker-VM sind noch unbekannt.');
  }
  // Freie Paare beenden und die Reserve abbauen, damit ein pausierter Pool nichts mehr annimmt.
  function rest(repo, pool) {
    pool.slots.forEach((slot) => runners.slots.abortIdle(slot));
    runners.discardReserve(pool).catch(logError(repo));
  }
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
        if (found.here) { await routing.set(repo, false); log(`${VARIABLE} entfernt – die Jobs gehen wieder an GitHubs Runner`, repo); }
      })().catch(logError(repo, `${VARIABLE} bleibt, wie es ist`));
      routing.forget(repo);
      await docker.removeRegistrations(repo);
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

  // Ein Repo mit Pool ist öffentlich geworden: Fremde Pull Requests liefen sonst auf diesem Rechner. Der Pool pausiert
  // und die Jobs gehen zurück an GitHubs Runner; fortsetzen lässt er sich erst, wenn das Repo wieder privat ist.
  async function pauseForPublic(repo) {
    const own = settingsOf(repo);
    const pool = pools.get(repo);
    if (!own || !pool || pool.removed) return;
    own.paused = true;
    saveConfig();
    rest(repo, pool);
    log('Das Repo ist öffentlich geworden. Damit keine fremden Pull Requests auf diesem Rechner laufen, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner.', repo, 'error');
    await routing.set(repo, false).catch(logError(repo, `${VARIABLE} bleibt, wie es ist`));
  }

  const actions = {
    async 'pool/add'({ repo, parallel }) {
      if (!REPO_NAME.test(String(repo))) throw new Error('Das Repo wird als besitzer/name angegeben.');
      const info = await gh(['api', `repos/${repo}`]);
      if (!info.permissions?.admin) throw new Error('Für dieses Repo fehlen dir die Verwaltungsrechte; ohne sie lässt sich kein Runner anmelden.');
      // Erst hier prüfen, mit dem Namen, wie GitHub ihn schreibt, und ohne weiteres Warten bis zum Eintrag:
      // sonst entstünde bei anderer Schreibweise oder zwei Anfragen kurz nacheinander ein zweiter Pool.
      const taken = [...settings.repos(), ...pools.keys()];
      if (taken.some((other) => sameRepo(other, info.full_name))) throw new Error(pools.get(info.full_name)?.removed ? 'Dieser Pool wird gerade entfernt. Bitte warten, bis das abgeschlossen ist.' : 'Für dieses Repo gibt es schon einen Pool.');
      const clash = clashes(info.full_name, taken);
      if (clash) throw new Error(`Ein Pool für ${clash} belegt denselben Namen für Caches und Build-Dienst. Zwei Repos mit gleichem Namen lassen sich nicht zugleich bedienen.`);
      // Fremde Pull Requests eines öffentlichen Repos würden auf diesem Rechner Code ausführen (siehe Kopf von backend.js).
      if (info.private === false) throw new Error('Das Repo ist öffentlich. Auf den eigenen Runnern darf nur Code laufen, dem du vertraust; Pools gibt es deshalb nur für private Repos.');
      settings.addPool(info.full_name, parallel);
      waiting.forget(info.full_name);
      log('Pool angelegt', info.full_name);
      runners.startPool(info.full_name);
      remote.refreshAll();
      // Die Jobs des Repos auf die eigenen Runner leiten, wenn seine Workflows die Variable lesen.
      routing.check(info.full_name).then(async (found) => {
        if (found.uses === 'variable' && !found.here) { await routing.set(info.full_name, true); log(`${VARIABLE} gesetzt – die Jobs laufen jetzt auf den eigenen Runnern`, info.full_name); }
        else if (found.uses === 'none') log(`Die Workflows lesen ${VARIABLE} nicht – die Jobs gehen weiter an GitHubs Runner`, info.full_name);
      }).catch(logError(info.full_name, VARIABLE));
    },
    async 'pool/set'({ repo, parallel, paused, cache }) {
      const { own, pool } = poolOf(repo);
      if (paused === false && remote.isPublic(repo)) throw new Error('Das Repo ist öffentlich. Der Pool lässt sich erst fortsetzen, wenn es wieder privat ist.');
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
        await runners.caches.removeCaches(repo, { packages: all || what === 'packages', build: all || what === 'build' });
        if (all || what === 'images') await runners.seed.forget(repo);
        await runners.caches.prepareCaches(repo);
        await runners.seed.refreshSeed(repo);
        await runners.caches.measureSizes(pool);
        log('Geleert; der nächste Lauf füllt wieder auf', repo);
      }).catch(logError(repo));
    },
    async 'pool/routing'({ repo, on }) {
      if (!settingsOf(repo)) throw new Error(NO_POOL);
      await routing.set(repo, Boolean(on));
      log(`${VARIABLE} ${on ? 'gesetzt – die Jobs laufen auf den eigenen Runnern' : 'entfernt – die Jobs gehen an GitHubs Runner'}`, repo);
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
      else { config.limits = { ...config.limits, ...limitRules.normalize(input, config.limits, limitRange()) }; log(`Limits je Job: ${limitsText(config.limits)}`); }
      saveConfig();
      // Vorbereitete Paare tragen noch die alten Limits: verwerfen, die Reserve füllt sich mit den neuen.
      for (const pool of pools.values()) runners.renewReserve(pool);
    },
    // Übernimmt den Vorschlag aus den Messwerten als Ganzes: den Standard für alle und eigene Limits für die Ausreißer.
    // Gemessene Projekte, die nicht als Ausreißer gelten, verlieren dabei ihre eigenen Werte.
    async 'limits/plan'() {
      requireDocker();
      const found = limitPlan();
      if (!found) throw new Error('Für einen Vorschlag fehlen noch Messwerte.');
      config.limits = { ...config.limits, ...limitRules.normalize(found.shared, config.limits, limitRange()) };
      for (const own of config.pools) {
        if (!found.measured.includes(own.repo)) continue; // zu wenige Läufe: Was der Nutzer eingestellt hat, bleibt
        if (found.own[own.repo]) own.limits = limitRules.normalize(found.own[own.repo], limitsOf(own.repo), limitRange()); else delete own.limits;
      }
      saveConfig();
      const outliers = Object.keys(found.own);
      log(`Limits aus den Messwerten übernommen: Standard Runner ${config.limits.runnerMemory}, Docker ${config.limits.dockerMemory}${outliers.length ? `; eigene Limits für ${outliers.join(', ')}` : ''}`);
      for (const pool of pools.values()) runners.renewReserve(pool);
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

  return { actions, pauseForPublic };
}

module.exports = { createActions, CACHE_PARTS };
