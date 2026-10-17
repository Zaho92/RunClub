// Das GitHub-Konto: die Anmeldung (über die GitHub-App, siehe auth.js) und das Minuten-Kontingent von GitHub Actions
// (siehe minutes.js). Beide laufen im selben Takt, die Anmeldung zuerst: Das Kontingent braucht ihren Stand.

const { createMinutes } = require('./minutes');

//   auth                    die Anmeldung (siehe auth.js); sie entsteht vorher, weil der Zugang zu GitHub ihr Token braucht
//   github                  Zugang zu GitHub (siehe github.js): `get`, `mayPoll(key)`
//   log(text, repo, kind), logError(repo, what), stopping()
//   makeMinutes             wie `createMinutes`; in Tests steuerbar
function createAccount({ auth, github, log, logError, stopping, makeMinutes = createMinutes }) {
  // Ein Fehler beim Lesen des Kontingents steht einmal im Protokoll (siehe minutes.js).
  const minutes = makeMinutes({ github, log: (text) => log(text, null, 'error') });

  // Wann wieder gelesen wird, entscheidet minutes.js; `atOnce` liest sofort. Ist das Anfragelimit knapp, höchstens im
  // Abstand, den github.js dafür vorsieht; ist es aufgebraucht, gar nicht.
  function watchMinutes(atOnce = false) {
    const login = auth.signedIn();
    if (!login || stopping() || !github.mayPoll('GitHub-Minuten')) return Promise.resolve();
    return atOnce ? minutes.refresh(login) : minutes.poll(login);
  }

  const watch = () => auth.poll().catch(logError(null, 'Anmeldung bei GitHub')).then(() => watchMinutes());

  return {
    watch,
    // Nach einem gelungenen Anmelden: das Kontingent des neuen Kontos gleich lesen.
    changed: () => watchMinutes(true),
    // Anmelden antwortet, sobald der Einmalcode im Stand steht; bestätigt wird im Browser (siehe auth.js).
    login: () => auth.login(),
    cancel: () => auth.cancel(),
    logout: () => auth.logout(),
    // Ein Ablauf, der noch auf die Bestätigung im Browser wartet, bliebe sonst nach dem Ende zurück.
    close: () => auth.close().catch(() => {}),
    authView: () => auth.view(),
    minutesView: () => minutes.view(auth.signedIn()),
  };
}

module.exports = { createAccount };
