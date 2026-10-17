const test = require('node:test');
const assert = require('node:assert/strict');
const { createVmMemory, read, COMMAND, MAX_AGE } = require('../src/vmmemory');

const KB = 1024;
const TOTAL = 16337408; // kB, as in /proc/meminfo

// A clock to set and a record of what is reported.
function fresh() {
  const clock = { at: 1000000 };
  const changes = [];
  const vm = createVmMemory({ now: () => clock.at, onChange: (tight, sample) => changes.push([tight, sample && sample.available]) });
  // A block as the long-running process writes it; `free` is the free share.
  const probe = (free) => {
    clock.at += 2000;
    vm.line(`MemTotal:       ${TOTAL} kB`);
    vm.line(`MemAvailable:   ${Math.round(TOTAL * free)} kB`);
    vm.line('.');
  };
  return { vm, clock, changes, probe };
}

test('a block becomes total, free and used in bytes', () => {
  const { vm, clock } = fresh();
  assert.equal(vm.current(), null);
  vm.line('MemTotal:       16337408 kB');
  vm.line('MemAvailable:   14282916 kB');
  assert.equal(vm.current(), null, 'only the dot closes the block');
  vm.line('.');
  assert.deepEqual(vm.current(), { total: 16337408 * KB, available: 14282916 * KB, used: (16337408 - 14282916) * KB, at: clock.at });
});

test('other lines do not interfere, the order does not matter', () => {
  const { vm } = fresh();
  for (const line of ['MemFree:         9000000 kB', 'MemAvailable:   4000000 kB', '', 'Cached:          3000000 kB', 'MemTotal:       8000000 kB', '.']) vm.line(line);
  assert.equal(vm.current().used, 4000000 * KB);
});

test('unreadable and incomplete blocks are skipped', () => {
  const { vm, probe } = fresh();
  probe(0.5);
  const before = vm.current();
  // Only one of the two lines
  vm.line('MemTotal:       16337408 kB');
  vm.line('.');
  // Text instead of numbers (such as the error message of wsl.exe), an empty block
  vm.line('MemTotal:       lots kB');
  vm.line('There is no distribution with the supplied name.');
  vm.line('.');
  vm.line('.');
  // More free than there is, nothing there
  for (const line of ['MemTotal:       100 kB', 'MemAvailable:   200 kB', '.', 'MemTotal:       0 kB', 'MemAvailable:   0 kB', '.']) vm.line(line);
  assert.deepEqual(vm.current(), before);
});

test('half a block does not mix into the next', () => {
  const { vm } = fresh();
  vm.line('MemAvailable:   100 kB');
  vm.line('.');
  vm.line('MemTotal:       1000 kB');
  vm.line('.');
  assert.equal(vm.current(), null);
});

test('read refuses what does not fit', () => {
  assert.deepEqual(read({ MemTotal: 10, MemAvailable: 4 }), { total: 10, available: 4, used: 6 });
  assert.deepEqual(read({ MemTotal: 10, MemAvailable: 0 }), { total: 10, available: 0, used: 10 });
  assert.equal(read({ MemTotal: 10 }), null);
  assert.equal(read({ MemAvailable: 4 }), null);
  assert.equal(read({ MemTotal: 4, MemAvailable: 10 }), null);
  assert.equal(read({}), null);
});

test('it is only tight after three short samples in a row', () => {
  const { vm, changes, probe } = fresh();
  probe(0.1);
  probe(0.1);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes, []);
  probe(0.12);
  assert.equal(vm.tight(), true);
  assert.deepEqual(changes, [[true, Math.round(TOTAL * 0.12) * KB]]);
  probe(0.05);
  assert.deepEqual(changes.length, 1, 'only the change is reported');
});

test('a sample with enough room breaks the run', () => {
  const { vm, changes, probe } = fresh();
  probe(0.1);
  probe(0.1);
  probe(0.3);
  probe(0.1);
  probe(0.1);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes, []);
  probe(0.1);
  assert.equal(vm.tight(), true);
});

test('exactly at the limit it is not tight', () => {
  const { vm } = fresh();
  for (let i = 0; i < 5; i += 1) for (const line of ['MemTotal: 1000 kB', 'MemAvailable: 150 kB', '.']) vm.line(line);
  assert.equal(vm.tight(), false);
  for (let i = 0; i < 3; i += 1) for (const line of ['MemTotal: 1000 kB', 'MemAvailable: 149 kB', '.']) vm.line(line);
  assert.equal(vm.tight(), true);
});

test('a sample above lifts the warning', () => {
  const { vm, changes, probe } = fresh();
  for (let i = 0; i < 3; i += 1) probe(0.1);
  probe(0.2);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes, [[true, Math.round(TOTAL * 0.1) * KB], [false, Math.round(TOTAL * 0.2) * KB]]);
  // After that it takes three again.
  probe(0.1);
  probe(0.1);
  assert.equal(vm.tight(), false);
});

test('a skipped block counts neither for nor against the run', () => {
  const { vm, probe } = fresh();
  probe(0.1);
  probe(0.1);
  vm.line('MemTotal:       16337408 kB');
  vm.line('.');
  assert.equal(vm.tight(), false);
  probe(0.1);
  assert.equal(vm.tight(), true);
});

test('an old measurement no longer counts and takes the warning with it', () => {
  const { vm, clock, changes, probe } = fresh();
  for (let i = 0; i < 3; i += 1) probe(0.1);
  clock.at += MAX_AGE;
  assert.ok(vm.current(), 'at the limit it still counts');
  clock.at += 1;
  assert.equal(vm.current(), null);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes.at(-1), [false, null]);
  // When the measurement comes back, the run starts over.
  probe(0.1);
  assert.equal(vm.tight(), false);
});

test('if the measurement fails, there is no value and no warning', () => {
  const { vm, changes, probe } = fresh();
  probe(0.5);
  vm.drop();
  assert.equal(vm.current(), null);
  assert.deepEqual(changes, [], 'without a warning there is nothing to report');
  for (let i = 0; i < 3; i += 1) probe(0.1);
  vm.drop();
  assert.deepEqual(changes.map(([tight]) => tight), [true, false]);
});

test('the command writes both lines and the dot and ends when writing fails', () => {
  assert.match(COMMAND, /MemTotal\|MemAvailable/);
  assert.match(COMMAND, /&& echo \.; do sleep \d+; done$/);
});
