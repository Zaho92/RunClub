// Start und Ende eines Programmlaufs: die Takte (`every`, `everyAfter`), der Start der Pools (`startPools`), das Ablegen
// des Schlüssels (`saveKey`), das Beenden (`shutdown`) und das schnelle Abmelden beim Abmelden von Windows (`release`).
// `stopping()` sagt allen Modulen, dass RunClub endet; es wird früh gebraucht, die Arbeit beim Beenden erst spät.

const fs = require('node:fs');
const { VARIABLE } = require('./routing');
const { msg, reason } = require('./messages');

//   log(text, repo, kind)
//   beforeStop()            beim Beenden, nach dem Anhalten der Takte (Messung sichern, wartendes `gh` beenden)
//   dismantle()             alle Runner abbauen (pools.js)
//   removeLeftovers(step)   danach übrig Gebliebenes abräumen, auch Build-Dienste und ihre Netze (dockerwatch.js)
//   releaseIdle()           die freien Runner bei GitHub abmelden (runners.js)
//   progress                `{ begin, step, finish }`: der Stand des Beendens für die Oberfläche (shutdown.js)
//   onExit()                nach dem Beenden
//   schedule                `{ set, clear }` wie `setInterval` und `clearInterval`
const quiet = { begin: () => {}, step: () => {}, finish: () => {} };

function createLifecycle({ log, beforeStop, dismantle, removeLeftovers, releaseIdle, progress = quiet, onExit, schedule = { set: setInterval, clear: clearInterval } }) {
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
    progress.begin();
    log(msg('m_stopping'));
    await dismantle();
    await removeLeftovers(progress.step);
    progress.finish();
    log(msg('m_stopped'));
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
  // Variable nicht (`error` im Ergebnis, siehe routing.js), steht das im Protokoll; der Pool arbeitet trotzdem.
  function startPools(repos, { startPool, checkRouting, watchVisibility }) {
    for (const repo of repos) {
      startPool(repo);
      const failed = (why) => log(msg('m_withReason', msg('m_variableUnreadable', VARIABLE), why), repo, 'error');
      checkRouting(repo).then((info) => { if (info?.error) failed(info.error); }, (error) => failed(reason(error)));
      watchVisibility(repo);
    }
  }

  // Der Schlüssel steht nur in der Konsole und in einer Datei im Datenordner des Nutzers, nie im Protokoll, das die
  // Oberfläche zeigt. Scheitert das Schreiben, gälte sonst still ein alter Schlüssel in der Datei: Das kommt ins
  // Protokoll, und es bleibt nur die Konsole.
  function saveKey(file, key) {
    try {
      fs.writeFileSync(file, `${key}\n`);
      return true;
    } catch (error) {
      log(msg('m_keyNotSaved', error.message), null, 'error');
      return false;
    }
  }

  return { stopping: () => stopping, every, everyAfter, shutdown, release, startPools, saveKey };
}

module.exports = { createLifecycle };
