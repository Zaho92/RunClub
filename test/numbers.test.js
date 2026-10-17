const test = require('node:test');
const assert = require('node:assert/strict');
const { median } = require('../src/numbers');

test('the median: null without values, otherwise the middle; with an even count unrounded between the two middle ones', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const values = [3, 1, 2];
  median(values);
  assert.deepEqual(values, [3, 1, 2]); // the input stays as it is
});
