const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsage, parseStatsLine, SAMPLE_EVERY, STATS_MAX_AGE, STATS_RESTART } = require('../src/usage');
const { MB, GB } = require('../src/units');
const { turn } = require('./support');

const statsLine = (name, cpu, memory) => JSON.stringify({ Name: name, CPUPerc: `${cpu}%`, MemUsage: `${memory} / 7.6GiB` });

test('eine Zeile von docker stats: Name, CPU in Kernen, Speicher in Bytes; Kopfzeile und Bruchstücke zählen nicht', () => {
  assert.deepEqual(parseStatsLine(statsLine('rc-app-1-runner', 150, '512MiB')), { name: 'rc-app-1-runner', cpu: 1.5, memory: 512 * MB });
  assert.deepEqual(parseStatsLine(`\u001b[2J\u001b[H${statsLine('x', 0, '1.5GiB')}`), { name: 'x', cpu: 0, memory: 1.5 * GB });
  assert.equal(parseStatsLine(statsLine('x', 1, '2kB')).memory, 2000);
  assert.equal(parseStatsLine('CONTAINER ID   NAME   CPU %'), null);
  assert.equal(parseStatsLine('{"Name": "x", "CPUPerc"'), null);
  assert.equal(parseStatsLine(JSON.stringify({ Name: 'x', CPUPerc: '1%', MemUsage: 'unsinn' })), null);
});

// Docker, die VM und die Uhr nachgestellt. `feed(line)` schreibt eine Zeile in das laufende `docker stats`, `endStats()`
// beendet es; ebenso `vmLine` und `endVm` für den Messprozess in der VM.
function world() {
  const w = { time: 1000000, samples: [], logs: [], timers: [], stopping: false, pools: [], statsCalls: 0, vmCalls: 0, cores: [{ times: { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 } }] };
  const docker = (args, options) => {
    assert.deepEqual(args, ['stats', '--format', '{{json .}}']);
    assert.equal(options.timeout, 0);
    w.statsCalls += 1;
    w.feed = options.onLine;
    return new Promise((resolve) => { w.endStats = () => resolve({ code: 0 }); });
  };
  const inVm = (script, options) => {
    w.vmCalls += 1;
    w.vmLine = options.onLine;
    return new Promise((resolve) => { w.endVm = () => resolve({ code: 0 }); });
  };
  w.usage = createUsage({
    docker, inVm, metrics: { sample: (point) => w.samples.push(point) }, pools: () => w.pools,
    log: (...entry) => w.logs.push(entry), stopping: () => w.stopping,
    timer: (work, ms) => w.timers.push({ work, ms }), now: () => w.time, cpus: () => w.cores, memoryUsed: () => 3 * GB,
  });
  return w;
}
const vmBlock = (w, totalKb, availableKb) => { w.vmLine(`MemTotal: ${totalKb} kB`); w.vmLine(`MemAvailable: ${availableKb} kB`); w.vmLine('.'); };

test('eigene und fremde Container werden getrennt gezählt; ein verstummter Container fällt nach einer Weile heraus', () => {
  const w = world();
  w.usage.onDockerReady();
  w.feed(statsLine('rc-app-1-runner', 100, '1GiB'));
  w.feed(statsLine('rc-app-1-dind', 50, '2GiB'));
  w.feed(statsLine('fremd', 25, '512MiB'));
  w.usage.measure();
  assert.deepEqual({ ...w.usage.view(), hostCpu: undefined }, { hostCpu: undefined, vmCpu: 1.5, vmMemory: 3 * GB, vmUsed: 3.5 * GB, otherCpu: 0.25, otherMemory: 512 * MB });
  assert.deepEqual(w.usage.statsOf('rc-app-1-runner'), { cpu: 1, memory: GB, at: w.time });
  assert.equal(w.usage.statsOf('fremd'), undefined); // nur eigene Container

  w.usage.forget('rc-app-1-runner');
  w.time += STATS_MAX_AGE + 1;
  w.feed(statsLine('rc-app-1-dind', 10, '1GiB'));
  w.usage.measure();
  assert.deepEqual([w.usage.view().vmCpu, w.usage.view().otherMemory], [0.1, 0]);
});

test('die Belegung der VM kommt aus der VM selbst, solange es einen frischen Wert gibt', () => {
  const w = world();
  w.usage.onDockerReady();
  w.feed(statsLine('rc-x', 0, '1GiB'));
  vmBlock(w, 8 * 1024 * 1024, 2 * 1024 * 1024);
  w.usage.measure();
  assert.equal(w.usage.view().vmUsed, 6 * GB);
  w.time += 20000; // der Wert ist alt
  w.feed(statsLine('rc-x', 0, '1GiB'));
  w.usage.measure();
  assert.equal(w.usage.view().vmUsed, GB);
});

test('wird es in der VM eng, steht das im Protokoll, und vmTight nennt den freien Speicher', () => {
  const w = world();
  w.usage.onDockerReady();
  for (let index = 0; index < 3; index += 1) vmBlock(w, 10 * 1024 * 1024, 1024 * 1024);
  assert.deepEqual(w.usage.vmTight(), { free: GB });
  assert.deepEqual(w.logs, [['Die Docker-VM hat nur noch 1,0 GB von 10,0 GB Arbeitsspeicher frei.', null, 'error']]);
  vmBlock(w, 10 * 1024 * 1024, 5 * 1024 * 1024);
  assert.equal(w.usage.vmTight(), null);
  assert.equal(w.logs[1][0], 'Die Docker-VM hat wieder 5,0 GB Arbeitsspeicher frei.');
});

test('jeder Messtakt gibt den Verbrauch an die Messung eines arbeitenden Platzes, jeder dritte wird ein Punkt im Verlauf', () => {
  const w = world();
  const added = [];
  w.pools = [{ slots: [{ base: 'rc-app-1', meter: { add: (...parts) => added.push(parts) } }, { base: 'rc-app-2', meter: null }, { base: null, meter: { add: () => assert.fail('ohne Paar') } }] }];
  w.usage.onDockerReady();
  w.feed(statsLine('rc-app-1-runner', 100, '1GiB'));
  for (let index = 0; index < SAMPLE_EVERY; index += 1) w.usage.measure();
  assert.equal(added.length, SAMPLE_EVERY);
  assert.deepEqual(added[0], [{ cpu: 1, memory: GB, at: w.time }, undefined]);
  assert.equal(w.samples.length, 1);
  assert.deepEqual(w.samples[0], { hostCpu: 0, hostMemory: 3 * GB, vmCpu: 1, vmMemory: GB });
});

test('die Auslastung von Windows: Anteil der Zeit außerhalb des Leerlaufs, in Kernen', () => {
  const w = world();
  w.cores = [{ times: { user: 100, nice: 0, sys: 0, irq: 0, idle: 100 } }, { times: { user: 100, nice: 0, sys: 0, irq: 0, idle: 100 } }];
  w.usage.measure();
  w.cores = [{ times: { user: 175, nice: 0, sys: 0, irq: 0, idle: 125 } }, { times: { user: 175, nice: 0, sys: 0, irq: 0, idle: 125 } }];
  w.usage.measure();
  assert.equal(w.usage.view().hostCpu, 1.5);
});

test('es läuft höchstens ein docker stats; endet es, startet es nach einer Pause neu, aber nicht beim Beenden', async () => {
  const w = world();
  w.usage.onDockerReady();
  w.usage.onDockerReady();
  assert.equal(w.statsCalls, 1);
  w.feed(statsLine('rc-x', 0, '1GiB'));
  w.endStats();
  await turn();
  assert.equal(w.usage.statsOf('rc-x'), undefined); // ohne laufende Messung gilt kein Wert
  assert.deepEqual(w.timers.map((entry) => entry.ms), [STATS_RESTART]);
  w.timers[0].work();
  assert.equal(w.statsCalls, 2);

  w.stopping = true;
  w.endStats();
  await turn();
  assert.equal(w.timers.length, 1);
});

test('der Messprozess in der VM: höchstens einer; ohne Messwert erst wieder, wenn Docker neu vorbereitet ist', async () => {
  const w = world();
  w.usage.onDockerReady();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 1);
  w.endVm(); // ohne einen einzigen Wert: Die Distro gibt es wohl nicht
  await turn();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 1);
  w.usage.onDockerReady();
  assert.equal(w.vmCalls, 2);
  vmBlock(w, 8 * 1024 * 1024, 4 * 1024 * 1024);
  w.endVm(); // mit Wert: Er darf gleich wieder starten
  await turn();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 3);
  w.stopping = true;
  w.endVm();
  await turn();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 3);
});
