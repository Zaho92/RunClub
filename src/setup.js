// What this machine needs for the Linux runners and does not have yet: WSL, Docker Desktop installed and started.
// It is only checked while Docker does not answer; if it answers, nothing is missing. The interface shows for each missing
// piece how to fix it, and can start Docker Desktop itself (`launch`).
//
// Only for Docker Desktop: if RunClub or the CLI points to another daemon (RUNCLUB_DOCKER_HOST, DOCKER_HOST,
// DOCKER_CONTEXT), RunClub does not know where it runs, and it stays with the message that Docker does not answer.

const path = require('node:path');
const fs = require('node:fs');
const { spawn: spawnProcess } = require('node:child_process');
const { locate } = require('./run');
const { SECOND, MINUTE } = require('./units');
const { msg, Fault } = require('./messages');

// What can be missing, in the order of fixing: without WSL Docker Desktop does not start, without an installation there is
// nothing to start. `engine`: Docker Desktop is running, but its daemon still does not answer after `ENGINE_GRACE`.
const MISSING = { WSL: 'wsl', INSTALL: 'install', START: 'start', ENGINE: 'engine' };
const APP = 'Docker Desktop.exe';
const ENGINE_GRACE = 3 * MINUTE; // Docker Desktop usually needs at most this long after starting
const PROBE_TIMEOUT = 20 * SECOND; // `wsl --status` can take a while on the first call after signing in

// Where Docker Desktop can be: in the usual place or, with its own installation folder, two levels above the CLI
// (`…\Docker\resources\bin\docker.exe`), which the installer puts in PATH.
function appCandidates(env, findDocker) {
  const found = [env.ProgramFiles, env.ProgramW6432].filter(Boolean).map((folder) => path.win32.join(folder, 'Docker', 'Docker', APP));
  const cli = findDocker();
  if (cli && /[\\/]resources[\\/]bin[\\/]docker\.exe$/i.test(cli)) found.push(path.win32.join(path.win32.dirname(cli), '..', '..', APP));
  return [...new Set(found)];
}

// Is a process of this name running? The output of `tasklist` as CSV; without a match there is only a note in the
// system's language that does not carry the name in quotes.
const listed = (stdout, name) => stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);

//   run(command, args, options)   as in run.js
//   ready()                 is Docker prepared (see dockerwatch.js)? Then nothing is checked.
//   docker(args, options)   from engine.js; if the daemon answers, nothing is missing, even while it is still being prepared
//   desktop                 RunClub uses Docker Desktop (see engine.js)
//   env, exists, findDocker, spawn, now   environment, `fs.existsSync`, where the CLI is, `child_process.spawn`, clock; controllable in tests
//   log(message)            writes a message (see messages.js) to the log
// Returns:
//   check()    checks what is missing (Promise); never throws
//   view()     for the interface: { missing: [MISSING…], app } or null if nothing is missing or there is nothing to check;
//              `app`: Docker Desktop is found and can be started
//   launch()   starts Docker Desktop; throws with a message if it is not found
function createSetup({
  run, docker, ready, desktop, log = () => {},
  env = process.env, exists = fs.existsSync, findDocker = () => locate('docker', { env }), spawn = spawnProcess, now = Date.now,
}) {
  // Another daemon from the user's environment: see above.
  const own = !desktop || Boolean(String(env.DOCKER_HOST ?? '').trim() || String(env.DOCKER_CONTEXT ?? '').trim());
  let missing = [];
  let app = null;
  let wslFound = false; // once found, it stays; installing WSL requires a restart anyway
  let runningSince = null; // since when Docker Desktop has been running without its daemon answering
  let checking = false;

  async function hasWsl() {
    if (wslFound) return true;
    const result = await run('wsl', ['--status'], { timeout: PROBE_TIMEOUT });
    if (result.timedOut) return true; // no answer is no proof that it is missing
    wslFound = result.code === 0;
    return wslFound;
  }

  // Does the daemon answer? On the first start RunClub builds images for minutes before Docker counts as prepared.
  const answers = async () => ready() || (await docker(['info', '--format', 'ok'], { timeout: PROBE_TIMEOUT })).code === 0;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      if (own || await answers()) { missing = []; runningSince = null; return; }
      const found = [];
      if (!await hasWsl()) found.push(MISSING.WSL);
      app = appCandidates(env, findDocker).find((candidate) => exists(candidate)) ?? null;
      if (!app) found.push(MISSING.INSTALL);
      else {
        const tasks = await run('tasklist', ['/FI', `IMAGENAME eq ${APP}`, '/FO', 'CSV', '/NH'], { timeout: PROBE_TIMEOUT });
        if (tasks.code !== 0) runningSince = null; // cannot be determined: claim nothing
        else if (!listed(tasks.stdout, APP)) { found.push(MISSING.START); runningSince = null; } else {
          runningSince ??= now();
          if (now() - runningSince >= ENGINE_GRACE) found.push(MISSING.ENGINE);
        }
      }
      missing = found;
    } finally { checking = false; }
  }

  const view = () => (missing.length ? { missing: [...missing], app: Boolean(app) } : null);

  function launch() {
    const target = app ?? appCandidates(env, findDocker).find((candidate) => exists(candidate));
    if (!target) throw new Fault('m_desktopNotFound');
    // Detached: Docker Desktop keeps running when RunClub ends, and RunClub does not wait for it to end.
    const child = spawn(target, [], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log(msg('m_desktopStartFailed', String(error.message))));
    child.unref();
    log(msg('m_desktopStarting'));
    // From now on it is running: "Start" disappears until the next check sees it.
    missing = missing.filter((entry) => entry !== MISSING.START);
    runningSince = now();
  }

  return { check, view, launch };
}

module.exports = { createSetup, appCandidates, MISSING, ENGINE_GRACE };
