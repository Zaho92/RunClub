const test = require('node:test');
const assert = require('node:assert/strict');
const { median } = require('../src/numbers');

test('der Median: ohne Werte null, sonst die Mitte; bei gerader Anzahl ungerundet zwischen den beiden mittleren', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const values = [3, 1, 2];
  median(values);
  assert.deepEqual(values, [3, 1, 2]); // die Eingabe bleibt, wie sie ist
});
