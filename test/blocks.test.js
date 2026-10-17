const test = require('node:test');
const assert = require('node:assert/strict');
const { BLOCKS, blockOf } = require('../src/blocks');

test('blockOf names the first reason a pool is blocked for, otherwise null', () => {
  assert.equal(blockOf({ paused: true }), null);
  assert.equal(blockOf(undefined), null);
  assert.equal(blockOf({ [BLOCKS.forks]: true }), 'forks');
  assert.equal(blockOf({ [BLOCKS.public]: true, [BLOCKS.forks]: true }), 'public');
});
