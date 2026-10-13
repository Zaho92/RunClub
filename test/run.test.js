const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/run');

const node = (script, options) => run(process.execPath, ['-e', script], options);

test('sammelt Ausgabe und Code', async () => {
  const result = await node('console.log("hallo"); console.error("oje"); process.exit(3)');
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'hallo');
  assert.equal(result.stderr.trim(), 'oje');
  assert.equal(result.timedOut, false);
});

test('gibt Eingabe und Umgebung weiter', async () => {
  const result = await node('process.stdin.on("data", (d) => process.stdout.write(process.env.RC_TEST + d))', { input: 'rein', env: { RC_TEST: 'x:' } });
  assert.equal(result.stdout, 'x:rein');
});

test('liefert Zeilen einzeln, und ein Fehler beim Auswerten reißt nichts mit', async () => {
  const lines = [];
  const result = await node('console.log("eins"); console.log("zwei"); console.log("drei")', { onLine: (line) => { if (line === 'zwei') throw new Error('kaputt'); lines.push(line); } });
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['eins', 'drei']);
});

test('beendet ein Programm, das nicht antwortet', async () => {
  const started = Date.now();
  const result = await node('setTimeout(() => {}, 60000)', { timeout: 300 });
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /keine Antwort/);
  assert.ok(Date.now() - started < 10000);
});

test('liefert die Zeilen der Fehlerausgabe einzeln, auch eine letzte ohne Zeilenende, und sammelt sie trotzdem', async () => {
  const lines = [];
  const result = await node('console.error("eins"); console.error("zwei"); process.stderr.write("ohne Ende")', { onErrLine: (line) => { lines.push(line); if (line === 'eins') throw new Error('kaputt'); } });
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['eins', 'zwei', 'ohne Ende']);
  assert.equal(result.stderr, 'eins\nzwei\nohne Ende');
  assert.equal(result.aborted, undefined);
});

// Die Zeile kommt an, während das Programm noch läuft: Erst sie löst hier den Abbruch aus.
test('ein Programm lässt sich von außen beenden', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = await node('console.error("bereit"); setTimeout(() => {}, 60000)', { signal: controller.signal, timeout: 30000, onErrLine: () => controller.abort() });
  assert.deepEqual({ code: result.code, timedOut: result.timedOut, aborted: result.aborted }, { code: -1, timedOut: false, aborted: true });
  assert.match(result.stderr, /abgebrochen/);
  assert.ok(Date.now() - started < 10000);
});

test('ein schon ausgelöstes Signal beendet das Programm sofort, und die Zeitgrenze gilt daneben weiter', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal((await node('setTimeout(() => {}, 60000)', { signal: controller.signal })).aborted, true);
  const late = await node('setTimeout(() => {}, 60000)', { signal: new AbortController().signal, timeout: 300 });
  assert.deepEqual({ timedOut: late.timedOut, aborted: late.aborted }, { timedOut: true, aborted: undefined });
});

test('ein fehlendes Programm endet mit einem Ergebnis statt einem Absturz', async () => {
  const result = await run('gibt-es-nicht-runclub', []);
  assert.equal(result.code, -1);
});

test('auch ein unzulässiger Aufruf endet mit einem Ergebnis', async () => {
  const result = await run(process.execPath, 'kein Feld');
  assert.equal(result.code, -1);
});

test('behält von sehr viel Fehlerausgabe nur das Ende', async () => {
  const result = await node('process.stderr.write("x".repeat(400000) + "\\nende")');
  assert.ok(result.stderr.length <= 140000);
  assert.ok(result.stderr.endsWith('ende'));
});
