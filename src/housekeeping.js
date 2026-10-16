// Seltene Pflege der Pools: ob ein Repo öffentlich geworden ist oder Pull Requests aus Forks zulässt (siehe
// remote.js) und ob verwaiste Runner bei GitHub stehen (siehe dockerwatch.js). Ein Paar, das mitten im Job endet (beim
// Beenden, nach einem Absturz), kann seinen Runner nicht abmelden: GitHub führt ihn noch eine Weile als beschäftigt.
// Ist er frei und ohne Verbindung, wird er hier abgemeldet.

const { pairNames } = require('./slots');

//   pools()                 die stehenden Pools
//   mayPoll(key, gap)       darf jetzt bei GitHub gefragt werden? (siehe github.js)
//   gap                     Abstand der Pflege; bei knappem Limit höchstens so oft je Repo verwaiste Runner suchen
//   watchVisibility(repo), removeRegistrations(repo, options)   aus remote.js und dockerwatch.js
function createHousekeeping({ pools, mayPoll, gap, watchVisibility, removeRegistrations }) {
  return function housekeep() {
    for (const pool of pools()) {
      if (pool.removed) continue;
      // Immer, auch bei knappem Limit: Ohne gelungene Prüfung ruht der Pool (siehe remote.js). Es sind zwei Anfragen.
      watchVisibility(pool.repo);
      // Ein eigener Schlüssel: Bei knappem Limit käme die Pflege sonst kaum an den Abfragen der Läufe vorbei.
      if (!mayPoll(`pflege:${pool.repo}`, gap)) continue;
      removeRegistrations(pool.repo, { keep: () => pairNames(pool), offline: true });
    }
  };
}

module.exports = { createHousekeeping };
