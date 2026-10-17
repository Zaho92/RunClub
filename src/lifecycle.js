// Start and end of a program run: the beats (`every`, `everyAfter`), starting the pools (`startPools`), storing
// the key (`saveKey`), shutting down (`shutdown`) and the quick sign-off on Windows sign-out (`release`).
// `stopping()` tells all modules that RunClub is ending; it is needed early, the work on shutdown only late.

const fs = require('node:fs');
const { VARIABLE } = require('./routing');
const { msg, reason } = require('./messages');

//   log(text, repo, kind)
//   beforeStop()            on shutdown, after the beats are stopped (save measurements, end a waiting sign-in)
//   dismantle()             dismantle all runners (pools.js)
//   removeLeftovers(step)   then clear what is left over, build services and their networks too (dockerwatch.js)
//   releaseIdle()           remove the idle runners from GitHub (runners.js)
//   progress                `{ begin, step, finish }`: the state of the shutdown for the interface (shutdown.js)
//   onExit()                after the shutdown
//   schedule                `{ set, clear }` like `setInterval` and `clearInterval`
const quiet = { begin: () => {}, step: () => {}, finish: () => {} };

function createLifecycle({ log, beforeStop, dismantle, removeLeftovers, releaseIdle, progress = quiet, onExit, schedule = { set: setInterval, clear: clearInterval } }) {
  let stopping = false;
  let shuttingDown = false;
  const timers = [];

  const every = (ms, work) => { work(); timers.push(schedule.set(work, ms)); };
  const everyAfter = (ms, work) => { timers.push(schedule.set(work, ms)); }; // like `every`, but only after the first interval

  // No more beats; then whatever still needs saving on shutdown.
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

  // On Windows sign-out there is no time for dismantling (see main.js). Then only remove the idle runners from GitHub,
  // all at once, so that no dead entries are left there; containers and volumes are cleared by the next
  // start. Shutting down stays possible afterwards: `shutdown` only watches itself.
  async function release() {
    if (stopping) return;
    stopTimers();
    await releaseIdle();
  }

  // Per repo with a pool: start the pool, read the repo variable CI_RUNNER, check the visibility. If the
  // variable cannot be read (`error` in the result, see routing.js), that is logged; the pool works anyway.
  function startPools(repos, { startPool, checkRouting, watchVisibility }) {
    for (const repo of repos) {
      startPool(repo);
      const failed = (why) => log(msg('m_withReason', msg('m_variableUnreadable', VARIABLE), why), repo, 'error');
      checkRouting(repo).then((info) => { if (info?.error) failed(info.error); }, (error) => failed(reason(error)));
      watchVisibility(repo);
    }
  }

  // The key is only in the console and in a file in the user's data folder, never in the log the
  // interface shows. If writing fails, an old key in the file would otherwise silently apply: that goes into the
  // log, and only the console remains.
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
