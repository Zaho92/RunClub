// The GitHub account: the sign-in (through the GitHub App, see auth.js) and the GitHub Actions minutes quota
// (see minutes.js). Both run on the same timer, the sign-in first: the quota needs its state.

const { createMinutes } = require('./minutes');
const { msg } = require('./messages');

//   auth                    the sign-in (see auth.js); it is created beforehand because access to GitHub needs its token
//   github                  access to GitHub (see github.js): `get`, `mayPoll(key)`
//   log(text, repo, kind), logError(repo, what), stopping()
//   makeMinutes             like `createMinutes`; controllable in tests
function createAccount({ auth, github, log, logError, stopping, makeMinutes = createMinutes }) {
  // An error reading the quota is logged once (see minutes.js).
  const minutes = makeMinutes({ github, log: (text) => log(text, null, 'error') });

  // When it is read again is decided by minutes.js; `atOnce` reads right away. If the rate limit is tight, at most at the
  // interval github.js provides for it; if it is used up, not at all.
  function watchMinutes(atOnce = false) {
    const login = auth.signedIn();
    if (!login || stopping() || !github.mayPoll('GitHub minutes')) return Promise.resolve();
    return atOnce ? minutes.refresh(login) : minutes.poll(login);
  }

  const watch = () => auth.poll().catch(logError(null, msg('m_whatSignIn'))).then(() => watchMinutes());

  return {
    watch,
    // After a successful sign-in: read the new account's quota right away.
    changed: () => watchMinutes(true),
    // Signing in answers as soon as the one-time code is in the state; it is confirmed in the browser (see auth.js).
    login: () => auth.login(),
    cancel: () => auth.cancel(),
    logout: () => auth.logout(),
    // A flow still waiting for confirmation in the browser would otherwise be left behind after the end.
    close: () => auth.close().catch(() => {}),
    authView: () => auth.view(),
    minutesView: () => minutes.view(auth.signedIn()),
  };
}

module.exports = { createAccount };
