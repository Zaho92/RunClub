const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../src/store');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-store-'));

test('eine fehlende Datei ergibt den Ersatzwert', () => {
  assert.deepEqual(readJson(path.join(folder(), 'x.json'), { leer: true }), { data: { leer: true }, broken: null });
});

test('schreibt vollständig und liest dasselbe wieder', () => {
  const file = path.join(folder(), 'x.json');
  writeJson(file, { pools: [{ repo: 'a/b' }] });
  assert.deepEqual(readJson(file, {}).data, { pools: [{ repo: 'a/b' }] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
});

test('eine beschädigte Datei verhindert den Start nicht und bleibt als Kopie liegen', () => {
  const file = path.join(folder(), 'x.json');
  fs.writeFileSync(file, '{ "pools": [');
  const result = readJson(file, {});
  assert.deepEqual(result.data, {});
  assert.equal(fs.readFileSync(result.broken, 'utf8'), '{ "pools": [');
});
