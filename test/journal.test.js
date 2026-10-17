const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJournal, resultKind, resultText, line, errorLog } = require('../src/journal');
const { rendered } = require('./support');
const { msg, render, Fault } = require('../src/messages');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-journal-')), 'runclub.log');
const at = new Date(2026, 9, 13, 15, 34, 28);

test('an entry carries time, project, message and kind separately', () => {
  const journal = createJournal({ file: file(), now: () => at });
  journal.add('Pool created', { repo: 'owner/repo' });
  journal.add('Docker no longer responds', { kind: 'error' });
  assert.deepEqual(journal.recent(), [
    { at: at.toISOString(), repo: 'owner/repo', text: 'Pool created', kind: 'info' },
    { at: at.toISOString(), repo: null, text: 'Docker no longer responds', kind: 'error' },
  ]);
  assert.equal(journal.count(), 2);
});

test('a message carries key and values for the interface, the English sentence for the file', () => {
  const journal = createJournal({ file: file(), now: () => at });
  assert.deepEqual(journal.add(msg('m_jobRun', 'Tests', 'pc-linux-1'), { repo: 'owner/repo', kind: 'run' }),
    { at: at.toISOString(), repo: 'owner/repo', text: 'Job “Tests” is running on pc-linux-1', kind: 'run', msg: { key: 'm_jobRun', args: ['Tests', 'pc-linux-1'] } });
  const done = journal.add(msg('m_jobEnd', 'Tests', resultText('Succeeded')), { repo: 'owner/repo', kind: 'done' });
  assert.equal(done.text, 'Job “Tests” – done');
  assert.deepEqual(done.msg.args[1], { key: 'm_resDone', args: [] });
  // A text from outside stays text, without a key.
  assert.deepEqual(Object.keys(journal.add('error during connect')), ['at', 'repo', 'text', 'kind']);
});

test('the file gets a readable line per entry', () => {
  const target = file();
  const journal = createJournal({ file: target, now: () => at });
  journal.add('Job “Tests” – Succeeded', { repo: 'owner/repo', kind: 'done' });
  journal.add('Stopped.');
  assert.equal(journal.read(), '13/10/2026, 15:34:28 owner/repo: Job “Tests” – Succeeded\n13/10/2026, 15:34:28 Stopped.\n');
  assert.equal(fs.readFileSync(target, 'utf8'), journal.read());
});

test('a multi-line message stays one line in the file', () => {
  const journal = createJournal({ file: file(), now: () => at });
  assert.equal(line(journal.add('first\r\n  second')), '13/10/2026, 15:34:28 first second');
  assert.equal(journal.read(), '13/10/2026, 15:34:28 first second\n');
});

test('only the latest entries stay in memory, all are counted', () => {
  const journal = createJournal({ file: file(), keep: 3 });
  for (let i = 1; i <= 5; i += 1) journal.add(`Message ${i}`);
  assert.deepEqual(journal.recent().map((entry) => entry.text), ['Message 3', 'Message 4', 'Message 5']);
  assert.equal(journal.count(), 5);
});

test('an unknown kind becomes an ordinary message', () => {
  const journal = createJournal({ file: file() });
  assert.equal(journal.add('x', { kind: 'loud' }).kind, 'info');
});

test('the runner result becomes the kind of the entry', () => {
  assert.equal(resultKind('Succeeded'), 'done');
  assert.equal(resultKind('Failed'), 'fail');
  assert.equal(resultKind('Canceled'), 'cancel');
  assert.equal(resultKind('Skipped'), 'info');
});

test('the result is a word of the interface; an unknown one stays as the runner names it', () => {
  assert.equal(render(resultText('Succeeded')), 'done');
  assert.equal(render(resultText('Failed')), 'failed');
  assert.deepEqual(resultText('Canceled'), { key: 'm_resCancel', args: [] });
  assert.equal(resultText('Skipped'), 'Skipped');
});

test('a file that is too large is put aside, at the start as in operation; the export takes both', () => {
  const target = file();
  fs.writeFileSync(target, 'old\n'.repeat(30));
  const journal = createJournal({ file: target, fileMax: 100, now: () => at });
  journal.add('one'); // the file from the start is too large: it goes aside
  assert.equal(fs.readFileSync(`${target}.1`, 'utf8'), 'old\n'.repeat(30));
  for (let i = 0; i < 2; i += 1) journal.add('x'.repeat(40)); // grows past the limit again in operation
  journal.add('two');
  assert.match(fs.readFileSync(`${target}.1`, 'utf8'), /one\n/);
  assert.equal(fs.readFileSync(target, 'utf8'), '13/10/2026, 15:34:28 two\n');
  assert.equal(journal.read(), fs.readFileSync(`${target}.1`, 'utf8') + fs.readFileSync(target, 'utf8'));
});

test('control characters and direction changes from names from outside become spaces', () => {
  const journal = createJournal({ file: file() });
  const nasty = ['Job', String.fromCharCode(0x1b), '[2J', String.fromCharCode(0x202e), 'x', String.fromCharCode(0x2028), 'y\tz'].join('');
  assert.equal(journal.add(nasty).text, 'Job [2J x y z');
});

test('an overlong message is truncated', () => {
  const entry = createJournal({ file: file() }).add('x'.repeat(5000));
  assert.equal(entry.text.length, 2002);
  assert.ok(entry.text.endsWith(' …'));
});

test('truncation does not split a character made of two halves', () => {
  const face = String.fromCodePoint(0x1f600);
  const entry = createJournal({ file: file() }).add('x'.repeat(1999) + face + face);
  assert.equal(entry.text, `${'x'.repeat(1999)}${face} …`);
});

test('if the full file cannot be put aside, writing goes on anyway', () => {
  const target = file();
  fs.writeFileSync(target, 'old\n'.repeat(30));
  fs.mkdirSync(`${target}.1`); // a folder in place of the old file: renaming fails
  fs.writeFileSync(path.join(`${target}.1`, 'busy'), '');
  const journal = createJournal({ file: target, fileMax: 100, now: () => at });
  journal.add('anyway');
  assert.ok(fs.readFileSync(target, 'utf8').endsWith('13/10/2026, 15:34:28 anyway\n'));
});

test('without a writable file nothing breaks', () => {
  const journal = createJournal({ file: path.join(os.tmpdir(), 'runclub-does-not-exist', 'deep', 'runclub.log') });
  journal.add('anyway');
  assert.equal(journal.recent().length, 1);
  assert.equal(journal.read(), '');
});

test('the entries survive a restart, with kind and message', () => {
  const target = file();
  const first = createJournal({ file: target, now: () => at });
  first.add(msg('m_poolAdded'), { repo: 'owner/repo' });
  first.add(msg('m_jobRun', 'Tests', 'pc-linux-1'), { repo: 'owner/repo', kind: 'run' });
  first.add(msg('m_jobEnd', 'Tests', resultText('Failed')), { repo: 'owner/repo', kind: 'fail' });
  const second = createJournal({ file: target, now: () => at });
  assert.deepEqual(second.recent(), first.recent());
  assert.deepEqual(second.recent()[1], { at: at.toISOString(), repo: 'owner/repo', text: 'Job “Tests” is running on pc-linux-1', kind: 'run', msg: { key: 'm_jobRun', args: ['Tests', 'pc-linux-1'] } });
  assert.equal(second.count(), 3);
  second.add('Started.');
  assert.equal(second.count(), 4); // the interface recognises the new entry by the different number
  assert.equal(second.recent().length, 4);
  assert.equal(second.read(), fs.readFileSync(target, 'utf8')); // the export stays the readable file
});

test('at most as many entries come from the file as stay in memory', () => {
  const target = file();
  const first = createJournal({ file: target, keep: 10 });
  for (let i = 1; i <= 7; i += 1) first.add(`Message ${i}`);
  const second = createJournal({ file: target, keep: 3 });
  assert.deepEqual(second.recent().map((entry) => entry.text), ['Message 5', 'Message 6', 'Message 7']);
  assert.equal(second.count(), 3);
});

test('a damaged or half line is skipped and does not spoil the next entry', () => {
  const target = file();
  createJournal({ file: target, now: () => at }).add('intact');
  fs.appendFileSync(`${target}.entries`, 'no JSON\n"just text"\n{"at":"never","text":"no time"}\n{"at":"2026-10-13T13:34:28.000Z"}\n{"at":"2026-10-13T13:34:28.000Z","text":"hal');
  const journal = createJournal({ file: target, now: () => at });
  assert.deepEqual(journal.recent().map((entry) => entry.text), ['intact']);
  journal.add('afterwards');
  assert.deepEqual(createJournal({ file: target }).recent().map((entry) => entry.text), ['intact', 'afterwards']);
});

test('the entries file stays limited', () => {
  const target = file();
  const journal = createJournal({ file: target, keep: 3 });
  const rowCount = () => fs.readFileSync(`${target}.entries`, 'utf8').split('\n').length - 1;
  for (let i = 1; i <= 20; i += 1) {
    journal.add(`Message ${i}`);
    assert.ok(rowCount() <= 5, `${rowCount()} lines after ${i} messages`);
  }
  fs.appendFileSync(`${target}.entries`, fs.readFileSync(`${target}.entries`, 'utf8').repeat(4)); // grown from outside
  assert.equal(createJournal({ file: target, keep: 3 }).recent().length, 3);
  assert.equal(rowCount(), 3); // rewritten down to what was loaded at the start
  assert.equal(fs.existsSync(`${target}.entries.tmp`), false);
});

test('a line changed from outside arrives cleaned', () => {
  const target = file();
  const esc = String.fromCharCode(0x1b);
  const turn = String.fromCharCode(0x202e);
  const forged = { at: '2026-10-13T13:34:28Z', repo: `owner/${turn}repo`, text: `Job${esc}[2J\ntwo`, kind: 'loud', msg: { key: 'm_jobRun', args: [`Te${esc}sts`, 'pc\r\n1', { key: 'm_resDone', args: [[[1]]] }] }, more: true };
  const odd = { at: 0, repo: 7, text: 'x'.repeat(5000), kind: 'done', msg: { key: 'alert(1)', args: [] } };
  fs.writeFileSync(`${target}.entries`, `${JSON.stringify(forged)}\n${JSON.stringify(odd)}\n`);
  const [first, second] = createJournal({ file: target }).recent();
  assert.deepEqual(first, { at: '2026-10-13T13:34:28.000Z', repo: 'owner/ repo', text: 'Job [2J two', kind: 'info', msg: { key: 'm_jobRun', args: ['Te sts', 'pc 1', { key: 'm_resDone', args: [['']] }] } });
  assert.deepEqual({ ...second, text: second.text.length }, { at: '1970-01-01T00:00:00.000Z', repo: '7', text: 2002, kind: 'done' });
});

test('without a readable entries file the log starts empty', () => {
  const target = file();
  fs.mkdirSync(`${target}.entries`); // a folder in its place: neither reading nor writing works
  const journal = createJournal({ file: target });
  assert.deepEqual(journal.recent(), []);
  journal.add('anyway');
  assert.equal(journal.recent().length, 1);
});

test('of a bloated entries file only the end is read', () => {
  const target = file();
  const row = (text) => `${JSON.stringify({ at: at.toISOString(), repo: null, text, kind: 'info' })}\n`;
  fs.writeFileSync(`${target}.entries`, row('x'.repeat(300)).repeat(40) + row('last'));
  const journal = createJournal({ file: target, fileMax: 1000 });
  const texts = journal.recent().map((entry) => entry.text);
  assert.equal(texts.at(-1), 'last');
  assert.ok(texts.length < 5); // only what fits in the last 1000 bytes, without the cut-off first line
  assert.ok(fs.statSync(`${target}.entries`).size < 2000); // and the file is small again afterwards
});

test('errorLog: an error goes into the log for the project, optionally with what was attempted', () => {
  const entries = [];
  const logError = errorLog((...entry) => entries.push(rendered(entry)));
  logError('owner/App')(new Error('broken'));
  logError(null, msg('m_whatQuota'))(new Error('no answer'));
  logError(null)(new Fault('m_noPool'));
  assert.deepEqual(entries, [['broken', 'owner/App', 'error'], ['Rate limit – no answer', null, 'error'], ['There is no such pool.', null, 'error']]);
});
