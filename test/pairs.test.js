const test = require('node:test');
const assert = require('node:assert/strict');
const { baseOf, orphaned } = require('../src/pairs');

test('erkennt das Paar hinter einem Container, Volume oder Netz', () => {
  assert.equal(baseOf('rc-jade-71dcf1-runner'), 'rc-jade-71dcf1');
  assert.equal(baseOf('/rc-jade-71dcf1-dind'), 'rc-jade-71dcf1');
  assert.equal(baseOf('rc-what-to-wear-0a1b2c-docker'), 'rc-what-to-wear-0a1b2c');
  assert.equal(baseOf('rc-jade-71dcf1'), 'rc-jade-71dcf1');
});

test('nur was zu keinem stehenden Paar gehört, gilt als Rest', () => {
  const live = new Set(['rc-jade-71dcf1']);
  assert.deepEqual(orphaned(['rc-jade-71dcf1-dind', 'rc-jade-aaaaaa-dind', 'rc-jade-aaaaaa-work', 'rc-jade-aaaaaa', 'rc-jade-71dcf1', ''], live), ['rc-jade-aaaaaa-dind', 'rc-jade-aaaaaa-work', 'rc-jade-aaaaaa']);
});

test('der Lade-Container der Vorlage ist kein Paar', () => {
  assert.deepEqual(orphaned(['rc-seed-jade-loader'], new Set()), []);
});
