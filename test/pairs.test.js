const test = require('node:test');
const assert = require('node:assert/strict');
const { baseOf, orphaned } = require('../src/pairs');

test('recognizes the pair behind a container, volume or network', () => {
  assert.equal(baseOf('rc-jade-71dcf1-runner'), 'rc-jade-71dcf1');
  assert.equal(baseOf('/rc-jade-71dcf1-dind'), 'rc-jade-71dcf1');
  assert.equal(baseOf('rc-what-to-wear-0a1b2c-docker'), 'rc-what-to-wear-0a1b2c');
  assert.equal(baseOf('rc-jade-71dcf1'), 'rc-jade-71dcf1');
});

test('only what belongs to no standing pair counts as a leftover', () => {
  const live = new Set(['rc-jade-71dcf1']);
  assert.deepEqual(orphaned(['rc-jade-71dcf1-dind', 'rc-jade-aaaaaa-dind', 'rc-jade-aaaaaa-work', 'rc-jade-aaaaaa', 'rc-jade-71dcf1', ''], live), ['rc-jade-aaaaaa-dind', 'rc-jade-aaaaaa-work', 'rc-jade-aaaaaa']);
});

test('the template loader container is not a pair', () => {
  assert.deepEqual(orphaned(['rc-seed-jade-loader'], new Set()), []);
});
