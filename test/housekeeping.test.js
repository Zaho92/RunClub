const test = require('node:test');
const assert = require('node:assert/strict');
const { createHousekeeping } = require('../src/housekeeping');

test('Pflege: je Pool die Sichtbarkeit immer, verwaiste Runner mit eigenem Schlüssel für das Anfragelimit; entfernte Pools nicht', () => {
  const calls = [];
  const pools = [
    { repo: 'wer/a', removed: false, slots: [{ name: 'PC-linux-1', base: 'rc-a-1' }, { name: 'PC-linux-2', base: null }] },
    { repo: 'wer/b', removed: true, slots: [] },
    { repo: 'wer/c', removed: false, slots: [] },
  ];
  const housekeep = createHousekeeping({
    pools: () => pools,
    mayPoll: (key, gap) => { calls.push(`mayPoll ${key} ${gap}`); return key !== 'pflege:wer/c'; },
    gap: 600000,
    watchVisibility: (repo) => calls.push(`sichtbar ${repo}`),
    removeRegistrations: (repo, { keep, offline }) => calls.push(`abmelden ${repo} ${[...keep()].join(',')} ${offline}`),
  });
  housekeep();
  assert.deepEqual(calls, ['sichtbar wer/a', 'mayPoll pflege:wer/a 600000', 'abmelden wer/a PC-linux-1 true', 'sichtbar wer/c', 'mayPoll pflege:wer/c 600000']);
});
