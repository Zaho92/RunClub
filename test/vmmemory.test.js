const test = require('node:test');
const assert = require('node:assert/strict');
const { createVmMemory, read, COMMAND, MAX_AGE } = require('../src/vmmemory');

const KB = 1024;
const TOTAL = 16337408; // kB, wie in /proc/meminfo

// Eine Uhr zum Stellen und ein Mitschnitt dessen, was gemeldet wird.
function fresh() {
  const clock = { at: 1000000 };
  const changes = [];
  const vm = createVmMemory({ now: () => clock.at, onChange: (tight, sample) => changes.push([tight, sample && sample.available]) });
  // Ein Block, wie ihn der Dauerprozess schreibt; `free` ist der freie Anteil.
  const probe = (free) => {
    clock.at += 2000;
    vm.line(`MemTotal:       ${TOTAL} kB`);
    vm.line(`MemAvailable:   ${Math.round(TOTAL * free)} kB`);
    vm.line('.');
  };
  return { vm, clock, changes, probe };
}

test('ein Block wird zu Gesamt, frei und belegt in Bytes', () => {
  const { vm, clock } = fresh();
  assert.equal(vm.current(), null);
  vm.line('MemTotal:       16337408 kB');
  vm.line('MemAvailable:   14282916 kB');
  assert.equal(vm.current(), null, 'erst der Punkt schließt den Block ab');
  vm.line('.');
  assert.deepEqual(vm.current(), { total: 16337408 * KB, available: 14282916 * KB, used: (16337408 - 14282916) * KB, at: clock.at });
});

test('fremde Zeilen stören nicht, die Reihenfolge ist gleich', () => {
  const { vm } = fresh();
  for (const line of ['MemFree:         9000000 kB', 'MemAvailable:   4000000 kB', '', 'Cached:          3000000 kB', 'MemTotal:       8000000 kB', '.']) vm.line(line);
  assert.equal(vm.current().used, 4000000 * KB);
});

test('unlesbare und unvollständige Blöcke werden übergangen', () => {
  const { vm, probe } = fresh();
  probe(0.5);
  const before = vm.current();
  // Nur eine der beiden Zeilen
  vm.line('MemTotal:       16337408 kB');
  vm.line('.');
  // Text statt Zahlen (etwa die Fehlermeldung von wsl.exe), ein leerer Block
  vm.line('MemTotal:       viel kB');
  vm.line('There is no distribution with the supplied name.');
  vm.line('.');
  vm.line('.');
  // Mehr frei als vorhanden, nichts vorhanden
  for (const line of ['MemTotal:       100 kB', 'MemAvailable:   200 kB', '.', 'MemTotal:       0 kB', 'MemAvailable:   0 kB', '.']) vm.line(line);
  assert.deepEqual(vm.current(), before);
});

test('ein halber Block mischt sich nicht in den nächsten', () => {
  const { vm } = fresh();
  vm.line('MemAvailable:   100 kB');
  vm.line('.');
  vm.line('MemTotal:       1000 kB');
  vm.line('.');
  assert.equal(vm.current(), null);
});

test('read lehnt ab, was nicht zusammenpasst', () => {
  assert.deepEqual(read({ MemTotal: 10, MemAvailable: 4 }), { total: 10, available: 4, used: 6 });
  assert.deepEqual(read({ MemTotal: 10, MemAvailable: 0 }), { total: 10, available: 0, used: 10 });
  assert.equal(read({ MemTotal: 10 }), null);
  assert.equal(read({ MemAvailable: 4 }), null);
  assert.equal(read({ MemTotal: 4, MemAvailable: 10 }), null);
  assert.equal(read({}), null);
});

test('eng ist es erst nach drei knappen Proben in Folge', () => {
  const { vm, changes, probe } = fresh();
  probe(0.1);
  probe(0.1);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes, []);
  probe(0.12);
  assert.equal(vm.tight(), true);
  assert.deepEqual(changes, [[true, Math.round(TOTAL * 0.12) * KB]]);
  probe(0.05);
  assert.deepEqual(changes.length, 1, 'gemeldet wird nur der Wechsel');
});

test('eine Probe mit genug Luft unterbricht die Folge', () => {
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

test('genau an der Grenze ist es nicht eng', () => {
  const { vm } = fresh();
  for (let i = 0; i < 5; i += 1) for (const line of ['MemTotal: 1000 kB', 'MemAvailable: 150 kB', '.']) vm.line(line);
  assert.equal(vm.tight(), false);
  for (let i = 0; i < 3; i += 1) for (const line of ['MemTotal: 1000 kB', 'MemAvailable: 149 kB', '.']) vm.line(line);
  assert.equal(vm.tight(), true);
});

test('eine Probe darüber hebt die Warnung auf', () => {
  const { vm, changes, probe } = fresh();
  for (let i = 0; i < 3; i += 1) probe(0.1);
  probe(0.2);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes, [[true, Math.round(TOTAL * 0.1) * KB], [false, Math.round(TOTAL * 0.2) * KB]]);
  // Danach braucht es wieder drei.
  probe(0.1);
  probe(0.1);
  assert.equal(vm.tight(), false);
});

test('ein übergangener Block zählt weder für noch gegen die Folge', () => {
  const { vm, probe } = fresh();
  probe(0.1);
  probe(0.1);
  vm.line('MemTotal:       16337408 kB');
  vm.line('.');
  assert.equal(vm.tight(), false);
  probe(0.1);
  assert.equal(vm.tight(), true);
});

test('ein alter Messwert gilt nicht mehr und nimmt die Warnung mit', () => {
  const { vm, clock, changes, probe } = fresh();
  for (let i = 0; i < 3; i += 1) probe(0.1);
  clock.at += MAX_AGE;
  assert.ok(vm.current(), 'an der Grenze gilt er noch');
  clock.at += 1;
  assert.equal(vm.current(), null);
  assert.equal(vm.tight(), false);
  assert.deepEqual(changes.at(-1), [false, null]);
  // Kommt die Messung wieder, beginnt die Folge von vorn.
  probe(0.1);
  assert.equal(vm.tight(), false);
});

test('fällt die Messung aus, gibt es keinen Wert und keine Warnung', () => {
  const { vm, changes, probe } = fresh();
  probe(0.5);
  vm.drop();
  assert.equal(vm.current(), null);
  assert.deepEqual(changes, [], 'ohne Warnung gibt es nichts zu melden');
  for (let i = 0; i < 3; i += 1) probe(0.1);
  vm.drop();
  assert.deepEqual(changes.map(([tight]) => tight), [true, false]);
});

test('der Befehl schreibt beide Zeilen und den Punkt und endet, wenn das Schreiben scheitert', () => {
  assert.match(COMMAND, /MemTotal\|MemAvailable/);
  assert.match(COMMAND, /&& echo \.; do sleep \d+; done$/);
});
