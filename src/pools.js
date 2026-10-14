// Ein Pool im Ganzen: Was über den einzelnen Platz hinausgeht, aber noch kein Cache und keine Vorlage ist. Hier
// liegt, wie ein Pool entsteht und vorbereitet wird (`startPool`, `preparePool`), wie die Reserve sich füllt
// (`replenish`), erneuert (`renewReserve`) und abgebaut wird (`discardReserve`), wie die Zahl der Plätze der
// Einstellung folgt (`reconcile`) und wie ein Pool zur Ruhe kommt, damit an seinen Caches gearbeitet werden kann
// (`quiesce`, `withPoolAtRest`, `rebuildIdle`).
//
// Der Lebenslauf eines Platzes liegt in slots.js. Beide Seiten brauchen einander: Die Reserve baut Paare mit
// `provision` und entfernt sie mit `removePair`, ein Platz füllt die Reserve nach und baut sie ab, wenn der Pool ruht.
// Keine der beiden Dateien lädt die andere; runners.js reicht jeder Seite die Funktionen der anderen herein.
//
//   Pool     { repo, slots, reserve, leaving, hold, prepared, removed, renewing, … }   (angelegt in `startPool`)
//   Reserve  Einträge { cancel, ready, built, promise }; `promise` liefert das Paar oder `null`, nie einen Fehler.
//            `leaving` zählt die Paare, die schon aus der Reserve genommen sind, aber noch abgebaut werden.

const limitRules = require('./limits');
const { errorLog } = require('./journal');
const { SLOT, busy } = require('./states');

//   log(text, repo, kind), sleep(ms)
//   pools                   Map Repo -> Pool; `startPool` trägt neue Pools ein
//   settingsOf(repo), limitsOf(repo), stopping(), dockerReady()
//   provision(pool, cancelled), removePair(repo, base, runnerId), teardown(slot), slotLoop(pool, slot), abortIdle(slot)
//                           aus slots.js
//   prepareCaches(repo), measureSizes(pool)   Paket-Cache und Build-Dienst bereitstellen, Volumes messen (caches.js)
//   refreshSeed(repo)       die Vorlage auffrischen (seed.js)
function createPools({
  log, sleep, pools,
  settingsOf, limitsOf, stopping, dockerReady,
  provision, removePair, teardown, slotLoop, abortIdle,
  prepareCaches, refreshSeed, measureSizes,
}) {
  const logError = errorLog(log);

  // Die Reserve eines Pools: fertig vorbereitete Paare ohne Anmeldung. Ein Platz, der frei wird, nimmt eines davon
  // und ist nach wenigen Sekunden wieder bereit; die Reserve füllt sich im Hintergrund nach.
  const reserveSize = (pool) => settingsOf(pool.repo)?.reserve ?? Math.min(2, settingsOf(pool.repo)?.parallel ?? 0);

  function replenish(pool) {
    if (stopping() || pool.removed || !dockerReady() || poolResting(pool)) return;
    // Was gerade abgebaut wird, zählt mit: Sonst stünden beim Erneuern kurz doppelt so viele Paare.
    while (pool.reserve.length + pool.leaving < reserveSize(pool)) {
      const entry = { cancel: false, ready: false, built: limitRules.key(limitsOf(pool.repo)) };
      const drop = () => { pool.reserve = pool.reserve.filter((other) => other !== entry); };
      entry.promise = provision(pool, () => entry.cancel || stopping())
        .then((pair) => { entry.ready = Boolean(pair); if (!pair) drop(); return pair; })
        .catch((error) => { log(`Vorbereitung eines Paars – ${error.message}`, pool.repo, 'error'); drop(); return null; });
      pool.reserve.push(entry);
    }
  }

  // Die Reserve erneuern, soweit sie alte Limits trägt. Mehrere Aufrufe kurz nacheinander (vier Regler, vier Änderungen) laufen
  // nacheinander: Erst wenn die alten Paare samt Netz entfernt sind, entstehen neue.
  function renewReserve(pool) {
    pool.renewing = (pool.renewing ?? Promise.resolve())
      .then(async () => {
        // Nur was noch mit anderen Limits gebaut ist, geht; eine schon frische Reserve bleibt stehen.
        const current = limitRules.key(limitsOf(pool.repo));
        await discardReserve(pool, (entry) => entry.built === current);
      })
      // Auch wenn das Abbauen scheitert, wird nachgefüllt: Sonst bliebe die Reserve bis zum nächsten Minutentakt leer.
      .catch(logError(pool.repo))
      .then(() => replenish(pool))
      .catch(logError(pool.repo));
    return pool.renewing;
  }

  // Die Reserve abbauen; was `keep` behält, bleibt stehen.
  // Jeder Eintrag für sich: Scheitert einer, bleiben die übrigen Paare nicht stehen.
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
    for (const result of results) if (result.status === 'rejected') log(`Abbau der Reserve – ${result.reason.message}`, pool.repo, 'error');
  }

  // Freie Paare und Reserve, die noch mit anderen Limits gebaut sind als den jetzt geltenden.
  function staleSlots(pool) {
    const current = limitRules.key(limitsOf(pool.repo));
    return pool.slots.filter((slot) => (slot.base || slot.building) && slot.built && slot.built !== current && !busy(slot));
  }
  function staleCount(pool) {
    const current = limitRules.key(limitsOf(pool.repo));
    return staleSlots(pool).length + pool.reserve.filter((entry) => entry.built !== current).length;
  }

  const poolResting = (pool) => !pool.prepared || pool.hold || settingsOf(pool.repo)?.paused;

  // Die Zahl der Plätze an die Einstellung angleichen.
  function reconcile(pool) {
    const wanted = settingsOf(pool.repo)?.parallel ?? 0;
    const active = pool.slots.filter((slot) => !slot.retired);
    // Auslaufende Plätze, deren Schleife noch läuft, werden zuerst wieder übernommen: Sonst stünden neben ihnen
    // neue, und der Pool hätte vorübergehend mehr Runner als eingestellt.
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

  // Wartet, bis kein Paar des Pools mehr steht: freie Paare und die Reserve werden entfernt, arbeitende laufen zu Ende.
  async function quiesce(pool) {
    await Promise.all([discardReserve(pool), ...pool.slots.map((slot) => abortIdle(slot))]);
    while (pool.reserve.length || pool.leaving || pool.slots.some((slot) => slot.base || slot.building)) await sleep(500);
  }

  // Beim Beenden: alle Paare abbauen, auch die Reserve und die, die gerade entstehen; laufende Jobs enden dabei. Ein
  // Platz im Aufbau sieht den Abbruch und räumt sein Paar selbst ab; darauf wird bis `timeout` gewartet.
  async function dismantle(timeout) {
    const all = [...pools.values()];
    await Promise.all(all.flatMap((pool) => [discardReserve(pool), ...pool.slots.map((slot) => { slot.aborted = true; return teardown(slot); })]));
    const until = Date.now() + timeout;
    while (Date.now() < until && all.some((pool) => pool.leaving || pool.slots.some((slot) => slot.base || slot.building))) await sleep(500);
  }

  // Die freien Runner eines Pools neu aufbauen. Läuft ein Job, gehen nur die mit alten Limits (wie `staleCount`
  // sie zählt). Läuft kein Job, entsteht auch der Build-Dienst neu; er trägt die Limits des Docker-Daemons. Ob ein Job läuft, entscheidet sich erst, wenn der Pool nicht mehr anderweitig angehalten ist
  // (ein Cache wird geleert): Startet in der Wartezeit ein Job, würde der Pool sonst bis zu dessen Ende stillstehen.
  async function rebuildIdle(pool) {
    while (pool.hold) await sleep(500);
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
    // Ein neuer Pool kann zugleich von `startPool` und von der Schleife in `watchLoop` (dockerwatch.js) erreicht werden.
    if (pool.preparing || pool.removed) return; // ein Pool, der gerade entfernt wird, braucht nichts mehr
    pool.preparing = true;
    pool.prepared = false;
    try {
      // Ruht der Pool gerade für eine Arbeit an seinen Caches (`withPoolAtRest`), stellt diese sie danach selbst bereit.
      if (!pool.hold) await prepareCaches(pool.repo);
      await refreshSeed(pool.repo);
    } catch (error) { log(`Vorbereitung – ${error.message}`, pool.repo, 'error'); } finally { pool.prepared = true; pool.preparing = false; }
    measureSizes(pool);
  }

  // Bringt den Pool zur Ruhe und tut dann `work`. Was sonst an Caches und Volumes arbeitet (Vorbereitung, Erneuern des
  // Build-Dienstes, Messen), läuft erst zu Ende: Ein belegtes Volume ließe sich nicht löschen.
  async function withPoolAtRest(pool, work) {
    while (pool.hold || pool.preparing || pool.renewingService || pool.measuring) await sleep(500);
    pool.hold = true;
    try { await quiesce(pool); return await work(); } finally { pool.hold = false; }
  }

  return { reserveSize, replenish, renewReserve, discardReserve, staleCount, poolResting, reconcile, quiesce, dismantle, rebuildIdle, withPoolAtRest, startPool, preparePool };
}

module.exports = { createPools };
