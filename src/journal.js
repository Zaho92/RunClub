// Protokoll: Jede Meldung ist ein Eintrag `{ at, repo, text, kind }`. Die letzten bleiben für die Oberfläche im
// Speicher, alle stehen als lesbare Zeile in der Datei im Datenordner.
//
//   at     Zeitpunkt (ISO)
//   repo   das Projekt, zu dem die Meldung gehört, oder null
//   text   die Meldung ohne Zeit und Projekt
//   kind   info | error | run | done | fail | cancel   (die letzten vier: Beginn und Ergebnis eines Jobs)

const fs = require('node:fs');

const KEEP = 300; // Einträge im Speicher
const FILE_MAX = 2 * 1048576; // darüber beginnt beim Start eine neue Datei; die alte bleibt als `.1` liegen
const KINDS = ['info', 'error', 'run', 'done', 'fail', 'cancel'];

// Das Ergebnis, wie der Runner es meldet (Succeeded, Failed, Canceled), als Art des Eintrags.
const resultKind = (result) => ({ succeeded: 'done', failed: 'fail', canceled: 'cancel', cancelled: 'cancel' })[String(result).toLowerCase()] ?? 'info';
// Dasselbe in den Worten der Oberfläche; ein unbekanntes Ergebnis bleibt, wie der Runner es nennt.
const resultText = (result) => ({ done: 'fertig', fail: 'Fehler', cancel: 'abgebrochen' })[resultKind(result)] ?? String(result);

// Die Zeile der Datei: Zeit, Projekt, Meldung. Umbrüche in einer Meldung würden die Zeile teilen.
const line = (entry) => `${new Date(entry.at).toLocaleString('de-DE')} ${entry.repo ? `${entry.repo}: ` : ''}${entry.text}`.replace(/\s*[\r\n]+\s*/g, ' ');

function createJournal({ file, keep = KEEP, now = () => new Date(), echo = () => {} }) {
  const entries = [];
  let count = 0; // Einträge seit dem Start; daran erkennt die Oberfläche, dass etwas dazugekommen ist
  try { if (fs.statSync(file).size > FILE_MAX) fs.renameSync(file, `${file}.1`); } catch { /* noch keine Datei */ }

  function add(text, { repo = null, kind = 'info' } = {}) {
    const entry = { at: now().toISOString(), repo: repo || null, text: String(text), kind: KINDS.includes(kind) ? kind : 'info' };
    entries.push(entry);
    if (entries.length > keep) entries.shift();
    count += 1;
    echo(line(entry));
    try { fs.appendFileSync(file, `${line(entry)}\n`); } catch { /* Protokoll ist Beiwerk */ }
    return entry;
  }

  return {
    add,
    recent: () => [...entries],
    count: () => count,
    // Die ganze Datei, für den Export.
    read: () => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } },
  };
}

module.exports = { createJournal, resultKind, resultText, line };
