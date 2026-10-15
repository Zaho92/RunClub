// Startet ein Programm und sammelt, was es schreibt. Wirft nie: Auch ein fehlendes Programm oder eine
// überschrittene Zeitgrenze enden mit einem Ergebnis (`code` -1).
//
//   input     wird dem Programm auf die Standardeingabe gegeben
//   env       zusätzliche Umgebungsvariablen
//   onLine    bekommt jede Zeile der Standardausgabe, sobald sie da ist; `stdout` bleibt dann leer
//   onErrLine bekommt jede Zeile der Fehlerausgabe, sobald sie da ist, am Ende auch eine ohne Zeilenende;
//             `stderr` wird trotzdem gesammelt
//   timeout   Millisekunden, nach denen das Programm beendet wird; 0 heißt ohne Grenze
//   signal    ein AbortSignal, das das Programm von außen beendet; das Ergebnis trägt dann `aborted: true`
//
// Ein Programm ohne Pfad (`gh`, `docker`, `wsl`) wird unter Windows selbst über PATH gesucht (siehe `locate`).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SECOND } = require('./units');

// Ein Job kann beliebig viel schreiben. Behalten wird nur, was gebraucht wird: das Ende der Fehlerausgabe und
// eine angefangene Zeile bis zu einer vernünftigen Länge.
const KEEP = 64 * 1024;
const LINE_MAX = 1024 * 1024;
const GRACE = 5 * SECOND; // so lange darf ein beendetes Programm seine Ausgabe noch offen halten
// Steuerzeichen, mit denen Programme ihre Ausgabe im Terminal färben oder neu zeichnen.
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;

// Wo das Programm liegt. Windows sucht einen Namen ohne Pfad zuerst im Arbeitsverzeichnis und erst dann in PATH: Ein
// dort abgelegtes `gh.exe` bekäme sonst die Anmeldung samt Einmalcode. Deshalb wird der Name hier nur über die
// Ordner aus PATH aufgelöst, und nur über solche mit Laufwerk oder Rechnernamen: Alles andere hinge wieder am
// Arbeitsverzeichnis. Ein Eintrag, dessen Anführungszeichen nicht aufgehen (ein Ordner mit Semikolon im Namen), wird
// übergangen. Liefert den Pfad, den Namen unverändert (er trägt schon einen Pfad, oder es ist kein Windows) oder
// null, wenn es das Programm in PATH nicht gibt.
const EXTENSIONS = ['.exe', '.com']; // was sich ohne Kommandozeile starten lässt
const ROOTED = /^(?:[A-Za-z]:[\\/]|\\\\)/; // mit Laufwerk (C:\…) oder Rechnernamen (\\server\…)
function locate(command, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32' || /[\\/]/.test(command)) return command;
  const names = EXTENSIONS.includes(path.win32.extname(command).toLowerCase()) ? [command] : EXTENSIONS.map((extension) => command + extension);
  const folders = String(env.PATH ?? env.Path ?? '').split(';').map((folder) => folder.trim().replace(/^"(.*)"$/, '$1')).filter((folder) => !folder.includes('"') && ROOTED.test(folder));
  for (const folder of folders) {
    for (const name of names) { const found = path.win32.join(folder, name); if (exists(found)) return found; }
  }
  return null;
}

function run(command, args, { input, env, onLine, onErrLine, signal, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const program = locate(command);
      // Dieselbe Meldung, mit der auch der Start eines fehlenden Programms scheitert.
      if (!program) { resolve({ code: -1, stdout: '', stderr: `spawn ${command} ENOENT`, timedOut: false }); return; }
      child = spawn(program, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    } catch (error) { resolve({ code: -1, stdout: '', stderr: String(error.message), timedOut: false }); return; }
    let stdout = '';
    let stderr = '';
    let pending = '';
    let pendingErr = '';
    let timedOut = false;
    let aborted = false;
    let grace = null;
    const late = () => ({ code: -1, stdout, stderr: `keine Antwort nach ${Math.round(timeout / SECOND)} s`, timedOut: true });
    const stopped = () => ({ code: -1, stdout, stderr: 'abgebrochen', timedOut: false, aborted: true });
    const done = (result) => { clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort); resolve(result); };
    // Nach der Zeitgrenze oder dem Abbruch von außen wird das Programm beendet. Hält ein Kind von ihm die Ausgabe
    // offen, kommt `close` nie: dann endet das Warten nach einer Nachfrist von selbst.
    const stop = (result) => { child.kill(); grace = setTimeout(() => done(result()), GRACE); };
    const timer = timeout > 0 ? setTimeout(() => { if (aborted) return; timedOut = true; stop(late); }, timeout) : null;
    function abort() { if (aborted || timedOut) return; aborted = true; stop(stopped); }
    // Ein Fehler beim Auswerten einer Zeile darf das Programm nicht mitreißen.
    const emit = (handler, line) => { try { handler(line); } catch { /* die Zeile wird übergangen */ } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onLine) { stdout += chunk; return; }
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { emit(onLine, pending.slice(0, end).trim()); pending = pending.slice(end + 1); }
      if (pending.length > LINE_MAX) pending = '';
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 2 * KEEP) stderr = stderr.slice(-KEEP);
      if (!onErrLine) return;
      pendingErr += chunk;
      let end;
      while ((end = pendingErr.indexOf('\n')) >= 0) { emit(onErrLine, pendingErr.slice(0, end).trim()); pendingErr = pendingErr.slice(end + 1); }
      if (pendingErr.length > LINE_MAX) pendingErr = '';
    });
    child.stdin.on('error', () => { /* das Programm hat seine Eingabe schon geschlossen */ });
    child.on('error', (error) => done({ code: -1, stdout, stderr: String(error.message), timedOut }));
    child.on('close', (code) => {
      if (onErrLine && pendingErr.trim()) emit(onErrLine, pendingErr.trim());
      done(timedOut ? late() : aborted ? stopped() : { code, stdout, stderr, timedOut });
    });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// Die letzte Zeile dessen, was ein Programm als Fehler schreibt; der Hinweis auf `--help` zählt nicht.
const lastLine = (text) => String(text ?? '').trim().split('\n').map((line) => line.trim()).filter((line) => line && !/^Run '.*--help' for more information/.test(line)).pop() ?? '';

module.exports = { run, locate, lastLine, ESCAPES };
