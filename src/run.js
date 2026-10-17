// Starts a program and collects what it writes. Never throws: a missing program or an exceeded
// time limit also end with a result (`code` -1).
//
//   input     is given to the program on standard input
//   env       additional environment variables
//   onLine    gets every line of standard output as soon as it is there; `stdout` then stays empty
//   onErrLine gets every line of error output as soon as it is there, at the end also one without a line ending;
//             `stderr` is still collected
//   timeout   milliseconds after which the program is ended; 0 means no limit
//   signal    an AbortSignal that ends the program from outside; the result then carries `aborted: true`
//
// A program without a path (`docker`, `wsl`) is looked up in PATH by this module itself on Windows (see `locate`).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SECOND } = require('./units');

// A job can write any amount. Only what is needed is kept: the end of the error output and
// an unfinished line up to a reasonable length.
const KEEP = 64 * 1024;
const LINE_MAX = 1024 * 1024;
const GRACE = 5 * SECOND; // how long an ended program may still keep its output open
// Control sequences programs use to colour or redraw their output in the terminal.
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;

// Where the program is. Windows looks for a name without a path in the working directory first and only then in PATH: a
// `docker.exe` placed there would otherwise run in its place, with access to all of Docker. So the name is only resolved here
// through the folders from PATH, and only through those with a drive or machine name: anything else would again depend on the
// working directory. An entry whose quotes do not match (a folder with a semicolon in its name) is
// skipped. Returns the path, the name unchanged (it already carries a path, or this is not Windows) or
// null if the program is not in PATH.
const EXTENSIONS = ['.exe', '.com']; // what can be started without a command shell
const ROOTED = /^(?:[A-Za-z]:[\\/]|\\\\)/; // with a drive (C:\…) or machine name (\\server\…)
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
      // The same message that starting a missing program fails with.
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
    const late = () => ({ code: -1, stdout, stderr: `no answer after ${Math.round(timeout / SECOND)} s`, timedOut: true });
    const stopped = () => ({ code: -1, stdout, stderr: 'cancelled', timedOut: false, aborted: true });
    const done = (result) => { clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort); resolve(result); };
    // After the time limit or a cancel from outside the program is ended. If a child of it keeps the output
    // open, `close` never comes: then the wait ends by itself after a grace period.
    const stop = (result) => { child.kill(); grace = setTimeout(() => done(result()), GRACE); };
    const timer = timeout > 0 ? setTimeout(() => { if (aborted) return; timedOut = true; stop(late); }, timeout) : null;
    function abort() { if (aborted || timedOut) return; aborted = true; stop(stopped); }
    // An error while handling a line must not take the program down with it.
    const emit = (handler, line) => { try { handler(line); } catch { /* the line is skipped */ } };
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
    child.stdin.on('error', () => { /* the program has already closed its input */ });
    child.on('error', (error) => done({ code: -1, stdout, stderr: String(error.message), timedOut }));
    child.on('close', (code) => {
      if (onErrLine && pendingErr.trim()) emit(onErrLine, pendingErr.trim());
      done(timedOut ? late() : aborted ? stopped() : { code, stdout, stderr, timedOut });
    });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// The last line of what a program writes as an error; the hint at `--help` does not count.
const lastLine = (text) => String(text ?? '').trim().split('\n').map((line) => line.trim()).filter((line) => line && !/^Run '.*--help' for more information/.test(line)).pop() ?? '';

module.exports = { run, locate, lastLine, ESCAPES };
