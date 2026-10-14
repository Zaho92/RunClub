// Protokoll: Jede Meldung ist ein Eintrag `{ at, repo, text, kind }`, zu einem Job dazu `job` und `runner`. Die letzten bleiben für die Oberfläche im
// Speicher, alle stehen als lesbare Zeile in der Datei im Datenordner. Daneben liegen die letzten Einträge als JSON
// (`<Datei>.entries`, eine Zeile je Eintrag): Daraus füllt sich der Speicher beim nächsten Start wieder.
//
//   at     Zeitpunkt (ISO)
//   repo   das Projekt, zu dem die Meldung gehört, oder null
//   text   die Meldung ohne Zeit und Projekt
//   kind   info | error | run | done | fail | cancel   (die letzten vier: Beginn und Ergebnis eines Jobs)
//   job    bei Meldungen zu einem Job sein Name, bei `run` dazu `runner`: Daraus bildet die Oberfläche den Satz in
//          ihrer Sprache; `text` ist derselbe Satz deutsch, für die Datei.

const fs = require('node:fs');
const { MB } = require('./units');

const KEEP = 300; // Einträge im Speicher
const FILE_MAX = 2 * MB; // darüber beginnt eine neue Datei; die alte bleibt als `.1` liegen
const TEXT_MAX = 2000; // Zeichen je Meldung; Jobnamen und Fehlertexte kommen von außen und können beliebig lang sein
const KINDS = ['info', 'error', 'run', 'done', 'fail', 'cancel'];

// Das Ergebnis, wie der Runner es meldet (Succeeded, Failed, Canceled), als Art des Eintrags.
const resultKind = (result) => ({ succeeded: 'done', failed: 'fail', canceled: 'cancel', cancelled: 'cancel' })[String(result).toLowerCase()] ?? 'info';
// Dasselbe als deutsches Wort für den Satz in der Datei; ein unbekanntes Ergebnis bleibt, wie der Runner es nennt.
// Die Oberfläche bildet ihr Wort selbst aus der Art (`s_done`, `s_fail`, `s_cancel` in ui.html).
const resultText = (result) => ({ done: 'fertig', fail: 'Fehler', cancel: 'abgebrochen' })[resultKind(result)] ?? String(result);

// Namen und Fehlertexte von außen können Umbrüche, Steuerzeichen und Richtungswechsel tragen. Im Protokoll würden sie
// Zeilen teilen, ein Terminal steuern oder die Anzeige umdrehen: Sie werden zu Leerzeichen.
const UNSAFE = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]; // Bereiche von Zeichennummern
const unsafe = (code) => UNSAFE.some(([from, to]) => code >= from && code <= to);
// Gekürzt wird nach ganzen Zeichen, damit kein Zeichen aus zwei Hälften (Emoji) zerteilt wird.
function clean(text) {
  const signs = Array.from(String(text).trim(), (sign) => (unsafe(sign.codePointAt(0)) ? ' ' : sign));
  const plain = (signs.length > TEXT_MAX ? [...signs.slice(0, TEXT_MAX), ' …'] : signs).join('');
  return plain.replace(/ {2,}/g, ' ').trim();
}

// Ein Eintrag aus rohen Angaben: Die Art stammt aus der festen Liste, alle Texte sind bereinigt. Das gilt für neue
// Meldungen wie für die aus der Datei, denn die kann von außen verändert sein.
function shape({ at, repo, text, kind, job, runner }) {
  const entry = { at, repo: repo ? clean(repo) || null : null, text: clean(text), kind: KINDS.includes(kind) ? kind : 'info' };
  if (job) entry.job = clean(job);
  if (job && runner) entry.runner = clean(runner);
  return entry;
}

// Eine Zeile der Datei mit den Einträgen zurück zum Eintrag; null, wenn sie keiner ist (halb geschrieben, beschädigt).
function parse(row) {
  try {
    const raw = JSON.parse(row);
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;
    return shape({ ...raw, at: new Date(raw.at).toISOString() }); // eine ungültige Zeit wirft
  } catch { return null; }
}

const rows = (entries) => entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

// Die Zeile der Datei aus einem Eintrag: Zeit, Projekt, Meldung.
const line = (entry) => `${new Date(entry.at).toLocaleString('de-DE')} ${entry.repo ? `${entry.repo}: ` : ''}${entry.text}`;

const bytes = (path) => { try { return fs.statSync(path).size; } catch { return 0; } };

// Das Ende einer Datei, höchstens `max` Bytes: Eine von außen aufgeblähte Datei wird so nicht ganz gelesen. Die erste,
// dann wahrscheinlich angeschnittene Zeile fällt weg.
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

// `now`: die Uhr in Millisekunden; in Tests steuerbar.
function createJournal({ file, keep = KEEP, fileMax = FILE_MAX, now = Date.now, echo = () => {} }) {
  const old = `${file}.1`;
  const saved = `${file}.entries`; // dieselben Einträge als JSON, für den nächsten Start
  const content = (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return ''; } }; // für den Export

  // Die Einträge vom letzten Lauf. Was keine ganze Zeile mit einem Eintrag ist, wird übergangen.
  const before = tail(saved, fileMax);
  const entries = before.split('\n').map(parse).filter(Boolean).slice(-keep);
  let count = entries.length; // geladene Einträge und die seit dem Start; daran erkennt die Oberfläche, dass etwas dazugekommen ist
  let rowCount = entries.length; // Zeilen in der Datei mit den Einträgen, mitgezählt
  let size = bytes(file); // Größe der lesbaren Datei, mitgezählt

  function write(text) {
    // Lässt sich die volle Datei nicht beiseitelegen (die alte ist gesperrt), wird trotzdem weitergeschrieben.
    if (size > fileMax) { try { fs.renameSync(file, old); size = 0; } catch { /* beim nächsten Mal wieder versuchen */ } }
    try {
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch { /* Protokoll ist Beiwerk */ }
  }

  // Die Datei mit den Einträgen wächst nicht unbegrenzt: Sie wird auf die Einträge im Speicher zusammengeschrieben,
  // erst daneben und dann an ihre Stelle, damit ein Absturz dazwischen die alte nicht halb zurücklässt.
  function compact() {
    try {
      const draft = `${saved}.${process.pid}.tmp`; // je Programm eine eigene, falls zwei denselben Datenordner nutzen
      fs.writeFileSync(draft, rows(entries));
      fs.renameSync(draft, saved);
      rowCount = entries.length;
    } catch { /* beim nächsten Mal wieder versuchen */ }
  }
  // Schon beim Start, wenn die Datei mehr oder anderes enthält als das Geladene: Eine halbe letzte Zeile würde sonst
  // den nächsten Eintrag mit verderben.
  if (bytes(saved) !== Buffer.byteLength(rows(entries))) compact();

  function save(entry) {
    try {
      fs.appendFileSync(saved, rows([entry]));
      rowCount += 1;
    } catch { /* Protokoll ist Beiwerk */ }
    if (rowCount >= keep * 2) compact();
  }

  function add(text, { repo = null, kind = 'info', job, runner } = {}) {
    const entry = shape({ at: new Date(now()).toISOString(), repo, text, kind, job, runner });
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
    // Alles für den Export: die beiseitegelegte Datei und die laufende.
    read: () => content(old) + content(file),
  };
}

module.exports = { createJournal, resultKind, resultText, line };
