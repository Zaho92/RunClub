const test = require('node:test');
const assert = require('node:assert/strict');
const { createHousekeeping } = require('../src/housekeeping');

test('upkeep: per pool always the visibility, orphaned runners with a key of their own for the rate limit; not removed pools', () => {
  const calls = [];
  const pools = [
    { repo: 'who/a', removed: false, slots: [{ name: 'PC-linux-1', base: 'rc-a-1' }, { name: 'PC-linux-2', base: null }] },
    { repo: 'who/b', removed: true, slots: [] },
    { repo: 'who/c', removed: false, slots: [] },
  ];
  const housekeep = createHousekeeping({
    pools: () => pools,
    mayPoll: (key, gap) => { calls.push(`mayPoll ${key} ${gap}`); return key !== 'housekeeping:who/c'; },
    gap: 600000,
    watchVisibility: (repo) => calls.push(`visible ${repo}`),
    removeRegistrations: (repo, { keep, offline }) => calls.push(`remove ${repo} ${[...keep()].join(',')} ${offline}`),
  });
  housekeep();
  assert.deepEqual(calls, ['visible who/a', 'mayPoll housekeeping:who/a 600000', 'remove who/a PC-linux-1 true', 'visible who/c', 'mayPoll housekeeping:who/c 600000']);
});
