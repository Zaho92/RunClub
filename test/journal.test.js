const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJournal, resultKind, resultText, line } = require('../src/journal');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-journal-')), 'runclub.log');
const at = new Date(2026, 9, 13, 15, 34, 28);

test('ein Eintrag trägt Zeit, Projekt, Meldung und Art getrennt', () => {
  const journal = createJournal({ file: file(), now: () => at });
  journal.add('Pool angelegt', { repo: 'wer/was' });
  journal.add('Docker antwortet nicht mehr', { kind: 'error' });
  assert.deepEqual(journal.recent(), [
    { at: at.toISOString(), repo: 'wer/was', text: 'Pool angelegt', kind: 'info' },
    { at: at.toISOString(), repo: null, text: 'Docker antwortet nicht mehr', kind: 'error' },
  ]);
  assert.equal(journal.count(), 2);
});

test('die Datei bekommt je Eintrag eine lesbare Zeile', () => {
  const target = file();
  const journal = createJournal({ file: target, now: () => at });
  journal.add('Job „Tests“ – Succeeded', { repo: 'wer/was', kind: 'done' });
  journal.add('Beendet.');
  assert.equal(journal.read(), '13.10.2026, 15:34:28 wer/was: Job „Tests“ – Succeeded\n13.10.2026, 15:34:28 Beendet.\n');
  assert.equal(fs.readFileSync(target, 'utf8'), journal.read());
});

test('eine mehrzeilige Meldung bleibt in der Datei eine Zeile', () => {
  assert.equal(line({ at: at.toISOString(), repo: null, text: 'erste\r\n  zweite' }), '13.10.2026, 15:34:28 erste zweite');
});

test('im Speicher bleiben nur die letzten Einträge, gezählt werden alle', () => {
  const journal = createJournal({ file: file(), keep: 3 });
  for (let i = 1; i <= 5; i += 1) journal.add(`Meldung ${i}`);
  assert.deepEqual(journal.recent().map((entry) => entry.text), ['Meldung 3', 'Meldung 4', 'Meldung 5']);
  assert.equal(journal.count(), 5);
});

test('eine unbekannte Art wird zur gewöhnlichen Meldung', () => {
  const journal = createJournal({ file: file() });
  assert.equal(journal.add('x', { kind: 'laut' }).kind, 'info');
});

test('das Ergebnis des Runners wird zur Art des Eintrags', () => {
  assert.equal(resultKind('Succeeded'), 'done');
  assert.equal(resultKind('Failed'), 'fail');
  assert.equal(resultKind('Canceled'), 'cancel');
  assert.equal(resultKind('Skipped'), 'info');
});

test('das Ergebnis steht in den Worten der Oberfläche im Text', () => {
  assert.equal(resultText('Succeeded'), 'fertig');
  assert.equal(resultText('Failed'), 'Fehler');
  assert.equal(resultText('Canceled'), 'abgebrochen');
  assert.equal(resultText('Skipped'), 'Skipped');
});

test('eine zu große Datei wird beim Start beiseitegelegt', () => {
  const target = file();
  fs.writeFileSync(target, 'x'.repeat(2 * 1048576 + 1));
  const journal = createJournal({ file: target });
  journal.add('neu');
  assert.equal(fs.statSync(`${target}.1`).size, 2 * 1048576 + 1);
  assert.match(journal.read(), /^\S+ \S+ neu\n$/);
});

test('ohne schreibbare Datei geht nichts kaputt', () => {
  const journal = createJournal({ file: path.join(os.tmpdir(), 'runclub-gibt-es-nicht', 'tief', 'runclub.log') });
  journal.add('trotzdem');
  assert.equal(journal.recent().length, 1);
  assert.equal(journal.read(), '');
});
