// Die Reserve eines Pools und sein Anhalten: Was über den einzelnen Platz hinausgeht, aber noch kein Cache und keine
// Vorlage ist. Hier liegt, wie die Reserve sich füllt (`replenish`), erneuert (`renewReserve`) und abgebaut wird
// (`discardReserve`), wie die Zahl der Plätze der Einstellung folgt (`reconcile`) und wie ein Pool zur Ruhe kommt,
// damit an seinen Caches gearbeitet werden kann (`quiesce`, `withPoolAtRest`, `rebuildIdle`).
//
// Der Lebenslauf eines Platzes liegt in slots.js. Beide Seiten brauchen einander: Die Reserve baut Paare mit
// `provision` und entfernt sie mit `removePair`, ein Platz füllt die Reserve nach und baut sie ab, wenn der Pool ruht.
// Keine der beiden Dateien lädt die andere; backend.js reicht jeder Seite die Funktionen der anderen herein.
//
//   Pool     { repo, slots, reserve, hold, prepared, removed, renewing, … }   (angelegt in `startPool` in backend.js)
//   Reserve  Einträge { cancel, ready, built, promise }; `promise` liefert das Paar oder `null`, nie einen Fehler

const limitRules = require('./limits');

//   log(text, repo, kind), sleep(ms)
//   settingsOf(repo), limitsOf(repo), stopping(), linuxReady()
//   provision(pool, cancelled), removePair(repo, base, runnerId), slotLoop(pool, slot), abortIdle(slot)   aus slots.js
//   prepareCaches(repo)     Paket-Cache und Build-Dienst eines Repos neu bereitstellen
function createPools({
  log, sleep,
  settingsOf, limitsOf, stopping, linuxReady,
  provision, removePair, slotLoop, abortIdle,
  prepareCaches,
}) {
  // Für `.catch(…)`: schreibt den Fehler zum Projekt ins Protokoll.
  const logError = (repo) => (error) => log(error.message, repo, 'error');

  // Die Reserve eines Pools: fertig vorbereitete Paare ohne Anmeldung. Ein Platz, der frei wird, nimmt eines davon
  // und ist nach wenigen Sekunden wieder bereit; die Reserve füllt sich im Hintergrund nach.
  const reserveSize = (pool) => settingsOf(pool.repo)?.reserve ?? Math.min(2, settingsOf(pool.repo)?.parallel ?? 0);

  function replenish(pool) {
    if (stopping() || pool.removed || !linuxReady() || poolResting(pool)) return;
    while (pool.reserve.length < reserveSize(pool)) {
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
  async function discardReserve(pool, keep = () => false) {
    const entries = pool.reserve.filter((entry) => !keep(entry));
    pool.reserve = pool.reserve.filter(keep);
    for (const entry of entries) entry.cancel = true;
    for (const entry of entries) {
      const pair = await entry.promise;
      if (pair) await removePair(pool.repo, pair.base, null);
    }
  }

  // Freie Paare und Reserve, die noch mit anderen Limits gebaut sind als den jetzt geltenden.
  function staleSlots(pool) {
    const current = limitRules.key(limitsOf(pool.repo));
    return pool.slots.filter((slot) => (slot.base || slot.building) && slot.built && slot.built !== current && slot.state !== 'arbeitet' && slot.state !== 'räumt auf');
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
      if (slot.retired && slot.state !== 'aus') { slot.retired = false; active.push(slot); }
    }
    for (let index = active.length; index < wanted; index += 1) {
      const slot = { repo: pool.repo, state: 'startet', jobs: 0 };
      pool.slots.push(slot);
      slotLoop(pool, slot);
    }
    for (const slot of active.slice(wanted)) { slot.retired = true; abortIdle(slot); }
  }

  // Wartet, bis kein Paar des Pools mehr steht: freie Paare und die Reserve werden entfernt, arbeitende laufen zu Ende.
  async function quiesce(pool) {
    await Promise.all([discardReserve(pool), ...pool.slots.map((slot) => abortIdle(slot))]);
    while (pool.reserve.length || pool.slots.some((slot) => slot.base || slot.building)) await sleep(500);
  }

  // Die freien Runner eines Pools neu aufbauen. Läuft ein Job, gehen nur die mit alten Limits (wie `staleCount`
  // sie zählt). Läuft kein Job, entsteht auch der Build-Dienst neu; er trägt die Limits des Docker-Daemons. Ob ein Job läuft, entscheidet sich erst, wenn der Pool nicht mehr anderweitig angehalten ist
  // (ein Cache wird geleert): Startet in der Wartezeit ein Job, würde der Pool sonst bis zu dessen Ende stillstehen.
  async function rebuildIdle(pool) {
    while (pool.hold) await sleep(500);
    if (pool.slots.some((slot) => slot.state === 'arbeitet')) return Promise.all([renewReserve(pool), ...staleSlots(pool).map((slot) => abortIdle(slot))]);
    return withPoolAtRest(pool, () => prepareCaches(pool.repo));
  }

  async function withPoolAtRest(pool, work) {
    while (pool.hold) await sleep(500);
    pool.hold = true;
    try { await quiesce(pool); return await work(); } finally { pool.hold = false; }
  }

  return { reserveSize, replenish, renewReserve, discardReserve, staleCount, poolResting, reconcile, quiesce, rebuildIdle, withPoolAtRest };
}

module.exports = { createPools };
