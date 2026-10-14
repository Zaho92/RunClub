// Das GitHub-Konto: die Anmeldung (die von `gh`, siehe auth.js) und das Minuten-Kontingent von GitHub Actions (siehe
// minutes.js). Beide laufen im selben Takt, die Anmeldung zuerst: Das Kontingent braucht ihren Stand und das
// freiwillige Recht dafür.

const { createAuth } = require('./auth');
const { createMinutes, SCOPE: MINUTES_SCOPE } = require('./minutes');

//   run, timeout            wie in run.js; für `gh auth …`
//   gh(args)                Aufruf der GitHub-API
//   githubApi               `mayPoll(key)` (siehe github.js)
//   log(text, repo, kind), logError(repo, what), stopping()
//   onAccount()             ein anderes Token gilt (nach einem gelungenen Anmelden oder Ergänzen, oder weil `gh` nach
//                           dem Abmelden ein weiteres Konto nutzt): Anfragelimit und Repos neu lesen
//   makeAuth, makeMinutes   wie `createAuth` und `createMinutes`; in Tests steuerbar
function createAccount({ run, timeout, gh, githubApi, log, logError, stopping, onAccount, makeAuth = createAuth, makeMinutes = createMinutes }) {
  // Ein Fehler beim Lesen des Kontingents steht einmal im Protokoll (siehe minutes.js).
  const minutes = makeMinutes({ gh, log: (text) => log(text, null, 'error') });
  const auth = makeAuth({ run, timeout, log: (text) => log(text), onAccount: () => { onAccount(); watchMinutes(true); } });
  const minutesLogin = () => auth.loginWith(MINUTES_SCOPE);

  // Wann wieder gelesen wird, entscheidet minutes.js; `atOnce` liest sofort. Ist das Anfragelimit knapp, höchstens im
  // Abstand, den github.js dafür vorsieht; ist es aufgebraucht, gar nicht.
  function watchMinutes(atOnce = false) {
    const login = minutesLogin();
    if (!login || stopping() || !githubApi.mayPoll('GitHub-Minuten')) return Promise.resolve();
    return atOnce ? minutes.refresh(login) : minutes.poll(login);
  }

  const watch = () => auth.poll().catch(logError(null, 'Anmeldung bei GitHub')).then(() => watchMinutes());

  return {
    watch,
    // Anmelden und Ergänzen antworten, sobald der Einmalcode im Stand steht; bestätigt wird im Browser (siehe auth.js).
    login: () => auth.login(),
    grant: (scope) => auth.grant(scope),
    cancel: () => auth.cancel(),
    logout: () => auth.logout(),
    // Ein `gh`, das noch auf die Bestätigung im Browser wartet, bliebe sonst nach dem Ende zurück.
    close: () => auth.close().catch(() => {}),
    authView: () => auth.view(),
    minutesView: () => minutes.view(minutesLogin()),
  };
}

module.exports = { createAccount };
