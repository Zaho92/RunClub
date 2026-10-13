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
