const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chooseTag, keysOf, missingAssets } = require('../scripts/release');
const { isInside } = require('../scripts/keygen');
const { feed } = require('../scripts/passphrase');

test('the tag to release: the only one on HEAD, or the one named when there are several', () => {
  assert.deepEqual(chooseTag(['v0.2.0-beta.1'], undefined), { tag: 'v0.2.0-beta.1' });
  // Stable on the approved beta's commit: both tags on HEAD.
  assert.match(chooseTag(['v0.2.0-beta.2', 'v0.2.0'], undefined).error, /npm run release -- v0\.2\.0/);
  assert.deepEqual(chooseTag(['v0.2.0-beta.2', 'v0.2.0'], 'v0.2.0'), { tag: 'v0.2.0' });
  assert.ok(chooseTag(['v0.2.0-beta.2'], 'v0.3.0').error);
  assert.ok(chooseTag(['', 'other'], undefined).error);
});

test('the public keys are read from a version of src/signature.js', () => {
  const source = "// KEYS-BEGIN\nconst KEYS = {\n  'bb96cfd4c0157b4b': 'gtX1B9OLeP8YpAjpM9DUweqEEsqtwOjAsvr1Cz8++4E=', // primary\n  '77f6c0986c055679': 'paLybVUy9dRh7Ujbgjd3sRoyOfQzLD9hyrEZL3jowg0=', // backup\n};\n// KEYS-END\n";
  assert.deepEqual(keysOf(source), ['77f6c0986c055679:paLybVUy9dRh7Ujbgjd3sRoyOfQzLD9hyrEZL3jowg0=', 'bb96cfd4c0157b4b:gtX1B9OLeP8YpAjpM9DUweqEEsqtwOjAsvr1Cz8++4E=']);
  assert.deepEqual(keysOf('// KEYS-BEGIN\nconst KEYS = {};\n// KEYS-END'), []);
  assert.deepEqual(keysOf(''), []);
});

test('a draft is only published with installer, manifest and signature in the right size', () => {
  const expected = { 'RunClub-Setup-0.2.0.exe': 100, 'runclub-update.json': 10, 'runclub-update.json.sig': 5 };
  assert.deepEqual(missingAssets([{ name: 'RunClub-Setup-0.2.0.exe', size: 100 }, { name: 'runclub-update.json', size: 10 }, { name: 'runclub-update.json.sig', size: 5 }], expected), []);
  assert.deepEqual(missingAssets([{ name: 'RunClub-Setup-0.2.0.exe', size: 99 }, { name: 'runclub-update.json', size: 10 }], expected),
    ['RunClub-Setup-0.2.0.exe has 99 bytes instead of 100', 'runclub-update.json.sig is missing']);
});

test('the key folder must lie outside the repo; another drive is outside', () => {
  const repo = path.resolve('C:/work/runclub');
  assert.equal(isInside(repo, repo), true);
  assert.equal(isInside(repo, path.join(repo, 'keys')), true);
  assert.equal(isInside(repo, path.join(repo, '..keys')), true);
  assert.equal(isInside(repo, path.resolve('C:/work/keys')), false);
  if (process.platform === 'win32') assert.equal(isInside(repo, 'D:\\keys'), false);
});

test('the passphrase prompt drops escape sequences and keeps what follows an Enter', () => {
  const state = { text: '', escape: 0 };
  assert.equal(feed(state, 'pa\u001b[Dss'), null);
  assert.equal(state.text, 'pass');
  assert.equal(feed(state, 'x\u007f\rnext\r'), 'next\r');
  assert.equal(state.text, 'pass');
  const second = { text: '', escape: 0 };
  assert.equal(feed(second, 'next\r'), '');
  assert.equal(second.text, 'next');
  assert.equal(feed({ text: '', escape: 0 }, 'a\u0003'), 'cancel');
});
