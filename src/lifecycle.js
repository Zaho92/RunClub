// Start und Ende eines Programmlaufs: die Takte (`every`, `everyAfter`), der Start der Pools (`startPools`), das Ablegen
// des Schlüssels (`saveKey`), das Beenden (`shutdown`) und das schnelle Abmelden beim Abmelden von Windows (`release`).
// `stopping()` sagt allen Modulen, dass RunClub endet; es wird früh gebraucht, die Arbeit beim Beenden erst spät.

const fs = require('node:fs');

//   log(text, repo, kind)
//   beforeStop()            beim Beenden, nach dem Anhalten der Takte (Messung sichern, wartendes `gh` beenden)
//   dismantle()             alle Runner abbauen (pools.js)
//   removeLeftovers()       danach übrig Gebliebenes abräumen, auch Build-Dienste und ihre Netze (dockerwatch.js)
//   releaseIdle()           die freien Runner bei GitHub abmelden (runners.js)
//   onExit()                nach dem Beenden
//   schedule                `{ set, clear }` wie `setInterval` und `clearInterval`
function createLifecycle({ log, beforeStop, dismantle, removeLeftovers, releaseIdle, onExit, schedule = { set: setInterval, clear: clearInterval } }) {
  let stopping = false;
  let shuttingDown = false;
  const timers = [];

  const every = (ms, work) => { work(); timers.push(schedule.set(work, ms)); };
  const everyAfter = (ms, work) => { timers.push(schedule.set(work, ms)); }; // wie `every`, aber erst nach dem ersten Abstand

  // Keine Takte mehr; danach, was beim Beenden noch zu sichern ist.
  function stopTimers() {
    stopping = true;
    for (const timer of timers) schedule.clear(timer);
    timers.length = 0;
    beforeStop();
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    stopTimers();
    log('Beende die Runner …');
    await dismantle();
    await removeLeftovers();
    log('Beendet.');
    onExit();
  }

  // Beim Abmelden von Windows bleibt für den Abbau keine Zeit (siehe main.js). Dann nur die freien Runner bei GitHub
  // abmelden, alle zugleich, damit dort keine toten Einträge stehen bleiben; Container und Volumes räumt der nächste
  // Start ab. Beenden bleibt danach möglich: `shutdown` achtet nur auf sich selbst.
  async function release() {
    if (stopping) return;
    stopTimers();
    await releaseIdle();
  }

  // Je Repo mit Pool: den Pool starten, die Repo-Variable CI_RUNNER lesen, die Sichtbarkeit prüfen. Liest sich die
  // Variable nicht, steht das im Protokoll; der Pool arbeitet trotzdem.
  function startPools(repos, { startPool, checkRouting, watchVisibility }) {
    for (const repo of repos) {
      startPool(repo);
      checkRouting(repo).catch((error) => log(`CI_RUNNER ließ sich nicht lesen – ${error.message}`, repo, 'error'));
      watchVisibility(repo);
    }
  }

  // Der Schlüssel steht nur in der Konsole und in einer Datei im Datenordner des Nutzers, nie im Protokoll, das die
  // Oberfläche zeigt. Liefert, ob die Datei geschrieben ist; sonst bleibt nur die Konsole.
  function saveKey(file, key) {
    try { fs.writeFileSync(file, `${key}\n`); return true; } catch { return false; }
  }

  return { stopping: () => stopping, every, everyAfter, shutdown, release, startPools, saveKey };
}

module.exports = { createLifecycle };
