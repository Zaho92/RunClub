const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chooseTag, keysOf, missingAssets, releaseNotes } = require('../scripts/release');
const { isInside } = require('../scripts/keygen');
const { feed } = require('../scripts/passphrase');

test('the tag to release: the only one on HEAD, or the one named when there are several', () => {
  assert.deepEqual(chooseTag(['v0.2.0-beta.1'], undefined), { tag: 'v0.2.0-beta.1' });
  // Stable on the approved beta's commit: both tags on HEAD.
  // git lists them by name, the stable one first; the suggestion is the newest.
  assert.match(chooseTag(['v0.2.0', 'v0.2.0-beta.2'], undefined).error, /npm run release -- v0\.2\.0$/);
  assert.match(chooseTag(['v0.2.0-beta.2', 'v0.2.0'], undefined).error, /npm run release -- v0\.2\.0$/);
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

test('the release notes are the section of the version in CHANGELOG.md; a beta falls back to Unreleased', () => {
  const changelog = ['# Changelog', '', 'Intro.', '', '## [Unreleased]', '', '### Fixed', '', '- next', '', '## [0.2.0] - 2026-11-01', '',
    '### Added', '', '- two', '', '## [0.1.0] - 2026-10-18', '', '- one', '', '[Unreleased]: https://example.com/compare',
    '[0.1.0]: https://example.com/v0.1.0', ''].join('\r\n');
  assert.deepEqual(releaseNotes(changelog, '0.2.0'), { notes: '### Added\n\n- two', section: '0.2.0' });
  assert.deepEqual(releaseNotes(changelog, '0.2.0-beta.3'), { notes: '### Added\n\n- two', section: '0.2.0' });
  assert.deepEqual(releaseNotes(changelog, '0.3.0-beta.1'), { notes: '### Fixed\n\n- next', section: 'Unreleased' });
  // The link definitions at the end are not part of the last section.
  assert.deepEqual(releaseNotes(changelog, '0.1.0'), { notes: '- one', section: '0.1.0' });
  // A stable version needs its own section, and an empty one counts as missing.
  assert.match(releaseNotes(changelog, '0.3.0').error, /no section “0\.3\.0”/);
  assert.match(releaseNotes('## [Unreleased]\n\n## [0.1.0]\n\n- one\n', '0.2.0-beta.1').error, /“Unreleased” in CHANGELOG\.md is empty/);
  assert.match(releaseNotes('', '0.2.0-beta.1').error, /no section “0\.2\.0” or “Unreleased”/);
  assert.ok(releaseNotes(changelog, 'latest').error);
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
  // A lone Esc doesn't swallow the next character.
  const lone = { text: '', escape: 0 };
  feed(lone, 'a\u001bbc');
  assert.equal(lone.text, 'abc');
});
