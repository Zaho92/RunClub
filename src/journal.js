// Log: every message is an entry `{ at, repo, text, kind, msg }`. The latest stay in memory for the interface, all
// of them are a readable line in the file in the data folder. Next to it lie the latest entries as JSON
// (`<file>.entries`, one line per entry): memory fills up from it again at the next start.
//
//   at     time (ISO)
//   repo   the project the message belongs to, or null
//   text   the message without time and project, in English, for the file
//   kind   info | error | run | done | fail | cancel   (the last four: start and result of a job)
//   msg    the same message as a key with values (see messages.js): from it the interface forms the sentence in
//          its language. Missing for messages that are only text from outside, and for entries of older versions.

const fs = require('node:fs');
const { MB } = require('./units');
const { msg, isMsg, render, reason, sanitize } = require('./messages');

const KEEP = 300; // entries in memory
const FILE_MAX = 2 * MB; // above this a new file begins; the old one is kept as `.1`
const TEXT_MAX = 2000; // characters per message; job names and error texts come from outside and can be of any length
const KINDS = ['info', 'error', 'run', 'done', 'fail', 'cancel'];

// The result as the runner reports it (Succeeded, Failed, Canceled), as the kind of the entry.
const resultKind = (result) => ({ succeeded: 'done', failed: 'fail', canceled: 'cancel', cancelled: 'cancel' })[String(result).toLowerCase()] ?? 'info';
// The same as a word for the message; an unknown result stays as the runner names it.
const RESULT_WORDS = { done: 'm_resDone', fail: 'm_resFail', cancel: 'm_resCancel' };
const resultText = (result) => (RESULT_WORDS[resultKind(result)] ? msg(RESULT_WORDS[resultKind(result)]) : String(result));

// Names and error texts from outside can carry line breaks, control characters and direction changes. In the log
// they would split lines, control a terminal or flip the display: they become spaces.
const UNSAFE = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]; // ranges of code points
const unsafe = (code) => UNSAFE.some(([from, to]) => code >= from && code <= to);
// Truncation goes by whole characters, so that no character made of two halves (emoji) is split.
function clean(text) {
  const signs = Array.from(String(text).trim(), (sign) => (unsafe(sign.codePointAt(0)) ? ' ' : sign));
  const plain = (signs.length > TEXT_MAX ? [...signs.slice(0, TEXT_MAX), ' …'] : signs).join('');
  return plain.replace(/ {2,}/g, ' ').trim();
}

// An entry from raw details: the kind comes from the fixed list, all texts are cleaned. That holds for new messages
// as for those from the file, since it may have been changed from outside.
function shape({ at, repo, text, kind, msg: message }) {
  const entry = { at, repo: repo ? clean(repo) || null : null, text: clean(text), kind: KINDS.includes(kind) ? kind : 'info' };
  const safe = sanitize(message, clean);
  if (safe) entry.msg = safe;
  return entry;
}

// A line of the entries file back to the entry; null if it is none (half written, damaged).
function parse(row) {
  try {
    const raw = JSON.parse(row);
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;
    return shape({ ...raw, at: new Date(raw.at).toISOString() }); // an invalid time throws
  } catch { return null; }
}

const rows = (entries) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

// The line of the file from an entry: time, project, message.
const line = (entry) => `${new Date(entry.at).toLocaleString('en-GB')} ${entry.repo ? `${entry.repo}: ` : ''}${entry.text}`;

const bytes = (path) => { try { return fs.statSync(path).size; } catch { return 0; } };

// The end of a file, at most `max` bytes: so a file bloated from outside is not read whole. The first line, then
// probably cut off, is dropped.
function tail(path, max) {
  try {
    const { size } = fs.statSync(path);
    if (size <= max) return fs.readFileSync(path, 'utf8');
    const buffer = Buffer.alloc(max);
    const handle = fs.openSync(path, 'r');
    try { fs.readSync(handle, buffer, 0, max, size - max); } finally { fs.closeSync(handle); }
    const text = buffer.toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } catch { return ''; }
}

// `now`: the clock in milliseconds; controllable in tests.
function createJournal({ file, keep = KEEP, fileMax = FILE_MAX, now = Date.now, echo = () => {} }) {
  const old = `${file}.1`;
  const saved = `${file}.entries`; // the same entries as JSON, for the next start
  const content = (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return ''; } }; // for the export

  // The entries from the last run. What is not a whole line with an entry is skipped.
  const before = tail(saved, fileMax);
  const entries = before.split('\n').map(parse).filter(Boolean).slice(-keep);
  let count = entries.length; // loaded entries and those since the start; from this the interface sees that something was added
  let rowCount = entries.length; // lines in the entries file, counted along
  let size = bytes(file); // size of the readable file, counted along

  function write(text) {
    // If the full file cannot be put aside (the old one is locked), writing goes on anyway.
    if (size > fileMax) { try { fs.renameSync(file, old); size = 0; } catch { /* try again next time */ } }
    try {
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch { /* the log is secondary */ }
  }

  // The entries file does not grow without limit: it is rewritten down to the entries in memory, first next to it
  // and then in its place, so that a crash in between does not leave the old one half written.
  function compact() {
    try {
      const draft = `${saved}.${process.pid}.tmp`; // one per program, in case two use the same data folder
      fs.writeFileSync(draft, rows(entries));
      fs.renameSync(draft, saved);
      rowCount = entries.length;
    } catch { /* try again next time */ }
  }
  // Already at the start if the file holds more or other than what was loaded: a half last line would otherwise spoil
  // the next entry too.
  if (bytes(saved) !== Buffer.byteLength(rows(entries))) compact();

  function save(entry) {
    try {
      fs.appendFileSync(saved, rows([entry]));
      rowCount += 1;
    } catch { /* the log is secondary */ }
    if (rowCount >= keep * 2) compact();
  }

  // `message`: a message (see messages.js) or a text from outside.
  function add(message, { repo = null, kind = 'info' } = {}) {
    const entry = shape({ at: new Date(now()).toISOString(), repo, text: render(message), kind, msg: isMsg(message) ? message : null });
    entries.push(entry);
    if (entries.length > keep) entries.shift();
    count += 1;
    echo(line(entry));
    write(`${line(entry)}\n`);
    save(entry);
    return entry;
  }

  return {
    add,
    recent: () => [...entries],
    count: () => count,
    // Everything for the export: the file put aside and the current one.
    read: () => content(old) + content(file),
  };
}

// For `.catch(…)`: `errorLog(log)(repo, what)` writes an error for the project to the log, optionally with what was
// being attempted (a message or a name). `log(message, repo, kind)` as in `start` (backend.js).
const errorLog = (log) => (repo, what) => (error) => log(what ? msg('m_withReason', what, reason(error)) : reason(error), repo, 'error');

module.exports = { createJournal, resultKind, resultText, line, errorLog };
