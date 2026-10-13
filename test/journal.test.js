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

test('eine Meldung zu einem Job trägt Namen und Runner getrennt', () => {
  const journal = createJournal({ file: file(), now: () => at });
  assert.deepEqual(journal.add('Job „Tests“ läuft auf pc-linux-1', { repo: 'wer/was', kind: 'run', job: 'Tests', runner: 'pc-linux-1' }),
    { at: at.toISOString(), repo: 'wer/was', text: 'Job „Tests“ läuft auf pc-linux-1', kind: 'run', job: 'Tests', runner: 'pc-linux-1' });
  assert.deepEqual(Object.keys(journal.add('Job „Tests“ – fertig', { repo: 'wer/was', kind: 'done', job: 'Tests' })), ['at', 'repo', 'text', 'kind', 'job']);
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
  const journal = createJournal({ file: file(), now: () => at });
  assert.equal(line(journal.add('erste\r\n  zweite')), '13.10.2026, 15:34:28 erste zweite');
  assert.equal(journal.read(), '13.10.2026, 15:34:28 erste zweite\n');
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

test('das Ergebnis steht als deutsches Wort im Satz für die Datei', () => {
  assert.equal(resultText('Succeeded'), 'fertig');
  assert.equal(resultText('Failed'), 'Fehler');
  assert.equal(resultText('Canceled'), 'abgebrochen');
  assert.equal(resultText('Skipped'), 'Skipped');
});

test('eine zu große Datei wird beiseitegelegt, beim Start wie im Betrieb; der Export nimmt beide', () => {
  const target = file();
  fs.writeFileSync(target, 'alt\n'.repeat(30));
  const journal = createJournal({ file: target, fileMax: 100, now: () => at });
  journal.add('eins'); // die Datei vom Start ist zu groß: Sie geht beiseite
  assert.equal(fs.readFileSync(`${target}.1`, 'utf8'), 'alt\n'.repeat(30));
  for (let i = 0; i < 2; i += 1) journal.add('x'.repeat(40)); // wächst im Betrieb wieder über die Grenze
  journal.add('zwei');
  assert.match(fs.readFileSync(`${target}.1`, 'utf8'), /eins\n/);
  assert.equal(fs.readFileSync(target, 'utf8'), '13.10.2026, 15:34:28 zwei\n');
  assert.equal(journal.read(), fs.readFileSync(`${target}.1`, 'utf8') + fs.readFileSync(target, 'utf8'));
});

test('Steuerzeichen und Richtungswechsel aus Namen von außen werden zu Leerzeichen', () => {
  const journal = createJournal({ file: file() });
  const nasty = ['Job', String.fromCharCode(0x1b), '[2J', String.fromCharCode(0x202e), 'x', String.fromCharCode(0x2028), 'y\tz'].join('');
  assert.equal(journal.add(nasty).text, 'Job [2J x y z');
});

test('eine überlange Meldung wird gekürzt', () => {
  const entry = createJournal({ file: file() }).add('x'.repeat(5000));
  assert.equal(entry.text.length, 2002);
  assert.ok(entry.text.endsWith(' …'));
});

test('die Kürzung zerteilt kein Zeichen aus zwei Hälften', () => {
  const face = String.fromCodePoint(0x1f600);
  const entry = createJournal({ file: file() }).add('x'.repeat(1999) + face + face);
  assert.equal(entry.text, `${'x'.repeat(1999)}${face} …`);
});

test('lässt sich die volle Datei nicht beiseitelegen, wird trotzdem weitergeschrieben', () => {
  const target = file();
  fs.writeFileSync(target, 'alt\n'.repeat(30));
  fs.mkdirSync(`${target}.1`); // ein Ordner an der Stelle der alten Datei: Umbenennen scheitert
  fs.writeFileSync(path.join(`${target}.1`, 'belegt'), '');
  const journal = createJournal({ file: target, fileMax: 100, now: () => at });
  journal.add('trotzdem');
  assert.ok(fs.readFileSync(target, 'utf8').endsWith('13.10.2026, 15:34:28 trotzdem\n'));
});

test('ohne schreibbare Datei geht nichts kaputt', () => {
  const journal = createJournal({ file: path.join(os.tmpdir(), 'runclub-gibt-es-nicht', 'tief', 'runclub.log') });
  journal.add('trotzdem');
  assert.equal(journal.recent().length, 1);
  assert.equal(journal.read(), '');
});
