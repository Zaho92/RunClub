const test = require('node:test');
const assert = require('node:assert/strict');
const { baseOf, orphaned } = require('../src/pairs');

test('recognizes the pair behind a container, volume or network', () => {
  assert.equal(baseOf('rc-storefront-71dcf1-runner'), 'rc-storefront-71dcf1');
  assert.equal(baseOf('/rc-storefront-71dcf1-dind'), 'rc-storefront-71dcf1');
  assert.equal(baseOf('rc-billing-api-0a1b2c-docker'), 'rc-billing-api-0a1b2c');
  assert.equal(baseOf('rc-storefront-71dcf1'), 'rc-storefront-71dcf1');
});

test('only what belongs to no standing pair counts as a leftover', () => {
  const live = new Set(['rc-storefront-71dcf1']);
  assert.deepEqual(orphaned(['rc-storefront-71dcf1-dind', 'rc-storefront-aaaaaa-dind', 'rc-storefront-aaaaaa-work', 'rc-storefront-aaaaaa', 'rc-storefront-71dcf1', ''], live), ['rc-storefront-aaaaaa-dind', 'rc-storefront-aaaaaa-work', 'rc-storefront-aaaaaa']);
});

test('the template loader container is not a pair', () => {
  assert.deepEqual(orphaned(['rc-seed-storefront-loader'], new Set()), []);
});
