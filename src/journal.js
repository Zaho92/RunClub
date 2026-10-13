// Protokoll: Jede Meldung ist ein Eintrag `{ at, repo, text, kind }`, zu einem Job dazu `job` und `runner`. Die letzten bleiben für die Oberfläche im
// Speicher, alle stehen als lesbare Zeile in der Datei im Datenordner.
//
//   at     Zeitpunkt (ISO)
//   repo   das Projekt, zu dem die Meldung gehört, oder null
//   text   die Meldung ohne Zeit und Projekt
//   kind   info | error | run | done | fail | cancel   (die letzten vier: Beginn und Ergebnis eines Jobs)
//   job    bei Meldungen zu einem Job sein Name, bei `run` dazu `runner`: Daraus bildet die Oberfläche den Satz in
//          ihrer Sprache; `text` ist derselbe Satz deutsch, für die Datei.

const fs = require('node:fs');

const KEEP = 300; // Einträge im Speicher
const FILE_MAX = 2 * 1048576; // darüber beginnt eine neue Datei; die alte bleibt als `.1` liegen
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

// Die Zeile der Datei aus einem Eintrag: Zeit, Projekt, Meldung.
const line = (entry) => `${new Date(entry.at).toLocaleString('de-DE')} ${entry.repo ? `${entry.repo}: ` : ''}${entry.text}`;

function createJournal({ file, keep = KEEP, fileMax = FILE_MAX, now = () => new Date(), echo = () => {} }) {
  const entries = [];
  const old = `${file}.1`;
  let count = 0; // Einträge seit dem Start; daran erkennt die Oberfläche, dass etwas dazugekommen ist
  let size = 0; // Größe der Datei, mitgezählt
  try { size = fs.statSync(file).size; } catch { /* noch keine Datei */ }

  function write(text) {
    // Lässt sich die volle Datei nicht beiseitelegen (die alte ist gesperrt), wird trotzdem weitergeschrieben.
    if (size > fileMax) { try { fs.renameSync(file, old); size = 0; } catch { /* beim nächsten Mal wieder versuchen */ } }
    try {
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch { /* Protokoll ist Beiwerk */ }
  }

  function add(text, { repo = null, kind = 'info', job, runner } = {}) {
    const entry = { at: now().toISOString(), repo: repo || null, text: clean(text), kind: KINDS.includes(kind) ? kind : 'info' };
    if (job) entry.job = clean(job);
    if (job && runner) entry.runner = clean(runner);
    entries.push(entry);
    if (entries.length > keep) entries.shift();
    count += 1;
    echo(line(entry));
    write(`${line(entry)}\n`);
    return entry;
  }

  const content = (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return ''; } };

  return {
    add,
    recent: () => [...entries],
    count: () => count,
    // Alles für den Export: die beiseitegelegte Datei und die laufende.
    read: () => content(old) + content(file),
  };
}

module.exports = { createJournal, resultKind, resultText, line };
