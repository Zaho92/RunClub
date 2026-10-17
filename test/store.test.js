const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../src/store');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-store-'));

test('a missing file gives the fallback', () => {
  assert.deepEqual(readJson(path.join(folder(), 'x.json'), { empty: true }), { data: { empty: true }, broken: null });
});

test('writes completely and reads the same back', () => {
  const file = path.join(folder(), 'x.json');
  writeJson(file, { pools: [{ repo: 'a/b' }] });
  assert.deepEqual(readJson(file, {}).data, { pools: [{ repo: 'a/b' }] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
});

test('writes the draft as `.new` and renames it', () => {
  const file = path.join(folder(), 'x.json');
  const renames = [];
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([path.basename(from), path.basename(to)]); return rename(from, to); };
  try { writeJson(file, { a: 1 }); } finally { fs.renameSync = rename; }
  assert.deepEqual(renames, [['x.json.new', 'x.json']]);
});

test('a damaged file does not prevent the start and stays behind as a copy', () => {
  const file = path.join(folder(), 'x.json');
  fs.writeFileSync(file, '{ "pools": [');
  const result = readJson(file, {});
  assert.deepEqual(result.data, {});
  assert.match(path.basename(result.broken), /^x\.json\.broken-\d+$/);
  assert.equal(fs.readFileSync(result.broken, 'utf8'), '{ "pools": [');
});

test('written compactly, everything is on one line and reads the same', () => {
  const file = path.join(folder(), 'x.json');
  writeJson(file, { minutes: [1, 2] }, { compact: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"minutes":[1,2]}\n');
  assert.deepEqual(readJson(file, {}).data, { minutes: [1, 2] });
});
