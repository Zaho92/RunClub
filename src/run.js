// Startet ein Programm und sammelt, was es schreibt. Wirft nie: Auch ein fehlendes Programm oder eine
// überschrittene Zeitgrenze enden mit einem Ergebnis (`code` -1).
//
//   input     wird dem Programm auf die Standardeingabe gegeben
//   env       zusätzliche Umgebungsvariablen
//   onLine    bekommt jede Zeile der Standardausgabe, sobald sie da ist; `stdout` bleibt dann leer
//   timeout   Millisekunden, nach denen das Programm beendet wird; 0 heißt ohne Grenze

const { spawn } = require('node:child_process');

function run(command, args, { input, env, onLine, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; child.kill(); }, timeout) : null;
    const done = (result) => { clearTimeout(timer); resolve(result); };
    // Ein Fehler beim Auswerten einer Zeile darf das Programm nicht mitreißen.
    const emit = (line) => { try { onLine(line); } catch { /* die Zeile wird übergangen */ } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onLine) { stdout += chunk; return; }
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { emit(pending.slice(0, end).trim()); pending = pending.slice(end + 1); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => { /* das Programm hat seine Eingabe schon geschlossen */ });
    child.on('error', (error) => done({ code: -1, stdout, stderr: String(error.message), timedOut }));
    child.on('close', (code) => done(timedOut
      ? { code: -1, stdout, stderr: `keine Antwort nach ${Math.round(timeout / 1000)} s`, timedOut }
      : { code, stdout, stderr, timedOut }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

module.exports = { run };
