// Was dieser Rechner für die Linux-Runner braucht und noch nicht hat: WSL, Docker Desktop installiert und gestartet.
// Geprüft wird nur, solange Docker nicht antwortet; antwortet es, fehlt nichts. Die Oberfläche zeigt je fehlendem
// Stück, wie es sich beheben lässt, und kann Docker Desktop selbst starten (`launch`).
//
// Nur für Docker Desktop: Zeigt RunClub oder die CLI auf einen anderen Daemon (RUNCLUB_DOCKER_HOST, DOCKER_HOST,
// DOCKER_CONTEXT), weiß RunClub nicht, wo der läuft, und es bleibt bei der Meldung, dass Docker nicht antwortet.

const path = require('node:path');
const fs = require('node:fs');
const { spawn: spawnProcess } = require('node:child_process');
const { locate } = require('./run');
const { SECOND, MINUTE } = require('./units');
const { msg, Fault } = require('./messages');

// Was fehlen kann, in der Reihenfolge des Behebens: Ohne WSL startet Docker Desktop nicht, ohne Installation gibt es
// nichts zu starten. `engine`: Docker Desktop läuft, aber sein Daemon antwortet auch nach `ENGINE_GRACE` nicht.
const MISSING = { WSL: 'wsl', INSTALL: 'install', START: 'start', ENGINE: 'engine' };
const APP = 'Docker Desktop.exe';
const ENGINE_GRACE = 3 * MINUTE; // so lange braucht Docker Desktop nach dem Start üblicherweise höchstens
const PROBE_TIMEOUT = 20 * SECOND; // `wsl --status` kann beim ersten Aufruf nach dem Anmelden etwas brauchen

// Wo Docker Desktop liegen kann: am üblichen Ort oder, bei eigenem Installationsordner, zwei Ebenen über der CLI
// (`…\Docker\resources\bin\docker.exe`), die der Installer in PATH legt.
function appCandidates(env, findDocker) {
  const found = [env.ProgramFiles, env.ProgramW6432].filter(Boolean).map((folder) => path.win32.join(folder, 'Docker', 'Docker', APP));
  const cli = findDocker();
  if (cli && /[\\/]resources[\\/]bin[\\/]docker\.exe$/i.test(cli)) found.push(path.win32.join(path.win32.dirname(cli), '..', '..', APP));
  return [...new Set(found)];
}

// Läuft ein Prozess dieses Namens? Die Ausgabe von `tasklist` als CSV; ohne Treffer kommt nur ein Hinweis in der
// Sprache des Systems, der den Namen nicht in Anführungszeichen trägt.
const listed = (stdout, name) => stdout.toLowerCase().includes(`"${name.toLowerCase()}"`);

//   run(command, args, options)   wie in run.js
//   ready()                 ist Docker vorbereitet (siehe dockerwatch.js)? Dann wird nichts geprüft.
//   docker(args, options)   aus engine.js; antwortet der Daemon, fehlt nichts, auch wenn er noch vorbereitet wird
//   desktop                 RunClub nutzt Docker Desktop (siehe engine.js)
//   env, exists, findDocker, spawn, now   Umgebung, `fs.existsSync`, wo die CLI liegt, `child_process.spawn`, Uhr; in Tests steuerbar
//   log(text)
// Liefert:
//   check()    prüft, was fehlt (Promise); wirft nie
//   view()     für die Oberfläche: { missing: [MISSING…], app } oder null, wenn nichts fehlt oder nichts zu prüfen ist;
//              `app`: Docker Desktop ist gefunden und lässt sich starten
//   launch()   startet Docker Desktop; wirft mit einer Meldung, wenn es nicht gefunden ist
function createSetup({
  run, docker, ready, desktop, log = () => {},
  env = process.env, exists = fs.existsSync, findDocker = () => locate('docker', { env }), spawn = spawnProcess, now = Date.now,
}) {
  // Ein anderer Daemon aus der Umgebung des Benutzers: siehe oben.
  const own = !desktop || Boolean(String(env.DOCKER_HOST ?? '').trim() || String(env.DOCKER_CONTEXT ?? '').trim());
  let missing = [];
  let app = null;
  let wslFound = false; // einmal gefunden, bleibt es; WSL zu installieren verlangt ohnehin einen Neustart
  let runningSince = null; // seit wann Docker Desktop läuft, ohne dass sein Daemon antwortet
  let checking = false;

  async function hasWsl() {
    if (wslFound) return true;
    const result = await run('wsl', ['--status'], { timeout: PROBE_TIMEOUT });
    if (result.timedOut) return true; // keine Antwort ist kein Beleg, dass es fehlt
    wslFound = result.code === 0;
    return wslFound;
  }

  // Antwortet der Daemon? Beim ersten Start baut RunClub minutenlang Abbilder, bevor Docker als vorbereitet gilt.
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
        if (tasks.code !== 0) runningSince = null; // nicht feststellbar: nichts behaupten
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
    // Losgelöst: Docker Desktop läuft weiter, wenn RunClub endet, und RunClub wartet nicht auf sein Ende.
    const child = spawn(target, [], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log(msg('m_desktopStartFailed', String(error.message))));
    child.unref();
    log(msg('m_desktopStarting'));
    // Ab jetzt läuft es: „Starten“ verschwindet, bis die nächste Prüfung es sieht.
    missing = missing.filter((entry) => entry !== MISSING.START);
    runningSince = now();
  }

  return { check, view, launch };
}

module.exports = { createSetup, appCandidates, MISSING, ENGINE_GRACE };
