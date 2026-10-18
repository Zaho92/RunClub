// Installing a downloaded update (see updater.js) when the user clicks it: only while no runner is working, since
// quitting tears all of them down. The installer starts only once teardown is done (main.js, `hooks.onExit`) and
// opens RunClub again afterwards. No side effects on load.

const { Fault } = require('./messages');
const { SLOT } = require('./states');

// Whether the update can go now. Returns the installer (`{ file, args, version }`, see `installer` in updater.js) and
// holds the updater, so no check removes the file during teardown; throws a Fault otherwise.
//   updater   from `createUpdater`
//   status    the backend's status (`repos[].runners[].state`)
function prepareInstall(updater, status) {
  if (!updater.view().ready) throw new Fault('m_noUpdate');
  const working = status.repos.flatMap((repo) => repo.runners).filter((runner) => runner.state === SLOT.WORKING).length;
  if (working) throw new Fault('m_updateBusy', working);
  const ready = updater.installer();
  if (!ready) throw new Fault('m_noUpdate');
  updater.hold();
  return ready;
}

// Starts the installer after teardown. It is verified once more right before; if the file changed or is gone,
// RunClub starts again instead of leaving the machine without runners.
//   spawn       like `child_process.spawn`
//   relaunch()  starts RunClub again once this program has ended (Electron's `app.relaunch`)
function launchInstaller(updater, { spawn, relaunch }) {
  try {
    const verified = updater.installer();
    if (verified) spawn(verified.file, verified.args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    else relaunch();
  } catch { relaunch(); } // a virus scanner holding the file, for instance
}

module.exports = { prepareInstall, launchInstaller };
