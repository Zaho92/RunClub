// Startet ein Programm und sammelt, was es schreibt. Wirft nie: Auch ein fehlendes Programm oder eine
// überschrittene Zeitgrenze enden mit einem Ergebnis (`code` -1).
//
//   input     wird dem Programm auf die Standardeingabe gegeben
//   env       zusätzliche Umgebungsvariablen
//   onLine    bekommt jede Zeile der Standardausgabe, sobald sie da ist; `stdout` bleibt dann leer
//   timeout   Millisekunden, nach denen das Programm beendet wird; 0 heißt ohne Grenze

const { spawn } = require('node:child_process');

// Ein Job kann beliebig viel schreiben. Behalten wird nur, was gebraucht wird: das Ende der Fehlerausgabe und
// eine angefangene Zeile bis zu einer vernünftigen Länge.
const KEEP = 64 * 1024;
const LINE_MAX = 1024 * 1024;
const GRACE = 5000; // so lange darf ein beendetes Programm seine Ausgabe noch offen halten

function run(command, args, { input, env, onLine, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    } catch (error) { resolve({ code: -1, stdout: '', stderr: String(error.message), timedOut: false }); return; }
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let grace = null;
    const late = () => ({ code: -1, stdout, stderr: `keine Antwort nach ${Math.round(timeout / 1000)} s`, timedOut: true });
    const done = (result) => { clearTimeout(timer); clearTimeout(grace); resolve(result); };
    // Nach der Zeitgrenze wird das Programm beendet. Hält ein Kind von ihm die Ausgabe offen, kommt `close` nie:
    // dann endet das Warten nach einer Nachfrist von selbst.
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; child.kill(); grace = setTimeout(() => done(late()), GRACE); }, timeout) : null;
    // Ein Fehler beim Auswerten einer Zeile darf das Programm nicht mitreißen.
    const emit = (line) => { try { onLine(line); } catch { /* die Zeile wird übergangen */ } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onLine) { stdout += chunk; return; }
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { emit(pending.slice(0, end).trim()); pending = pending.slice(end + 1); }
      if (pending.length > LINE_MAX) pending = '';
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 2 * KEEP) stderr = stderr.slice(-KEEP); });
    child.stdin.on('error', () => { /* das Programm hat seine Eingabe schon geschlossen */ });
    child.on('error', (error) => done({ code: -1, stdout, stderr: String(error.message), timedOut }));
    child.on('close', (code) => done(timedOut ? late() : { code, stdout, stderr, timedOut }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

module.exports = { run };
