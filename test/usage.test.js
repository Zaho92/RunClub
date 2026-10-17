const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsage, parseStatsLine, SAMPLE_EVERY, STATS_MAX_AGE, STATS_RESTART } = require('../src/usage');
const { MB, GB } = require('../src/units');
const { turn, rendered } = require('./support');

const statsLine = (name, cpu, memory) => JSON.stringify({ Name: name, CPUPerc: `${cpu}%`, MemUsage: `${memory} / 7.6GiB` });

test('a line of docker stats: name, CPU in cores, memory in bytes; header and fragments do not count', () => {
  assert.deepEqual(parseStatsLine(statsLine('rc-app-1-runner', 150, '512MiB')), { name: 'rc-app-1-runner', cpu: 1.5, memory: 512 * MB });
  assert.deepEqual(parseStatsLine(`\u001b[2J\u001b[H${statsLine('x', 0, '1.5GiB')}`), { name: 'x', cpu: 0, memory: 1.5 * GB });
  assert.equal(parseStatsLine(statsLine('x', 1, '2kB')).memory, 2000);
  assert.equal(parseStatsLine('CONTAINER ID   NAME   CPU %'), null);
  assert.equal(parseStatsLine('{"Name": "x", "CPUPerc"'), null);
  assert.equal(parseStatsLine(JSON.stringify({ Name: 'x', CPUPerc: '1%', MemUsage: 'nonsense' })), null);
});

// Docker, the VM and the clock faked. `feed(line)` writes a line into the running `docker stats`, `endStats()`
// ends it; likewise `vmLine` and `endVm` for the measuring process in the VM.
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
    log: (...entry) => w.logs.push(rendered(entry)), stopping: () => w.stopping,
    timer: (work, ms) => w.timers.push({ work, ms }), now: () => w.time, cpus: () => w.cores, memoryUsed: () => 3 * GB,
  });
  return w;
}
const vmBlock = (w, totalKb, availableKb) => { w.vmLine(`MemTotal: ${totalKb} kB`); w.vmLine(`MemAvailable: ${availableKb} kB`); w.vmLine('.'); };

test('own and other containers are counted separately; a container gone silent drops out after a while', () => {
  const w = world();
  w.usage.onDockerReady();
  w.feed(statsLine('rc-app-1-runner', 100, '1GiB'));
  w.feed(statsLine('rc-app-1-dind', 50, '2GiB'));
  w.feed(statsLine('foreign', 25, '512MiB'));
  w.usage.measure();
  assert.deepEqual({ ...w.usage.view(), hostCpu: undefined }, { hostCpu: undefined, vmCpu: 1.5, vmMemory: 3 * GB, vmUsed: 3.5 * GB, otherCpu: 0.25, otherMemory: 512 * MB });
  assert.deepEqual(w.usage.statsOf('rc-app-1-runner'), { cpu: 1, memory: GB, at: w.time });
  assert.equal(w.usage.statsOf('foreign'), undefined); // only own containers

  w.usage.forget('rc-app-1-runner');
  w.time += STATS_MAX_AGE + 1;
  w.feed(statsLine('rc-app-1-dind', 10, '1GiB'));
  w.usage.measure();
  assert.deepEqual([w.usage.view().vmCpu, w.usage.view().otherMemory], [0.1, 0]);
});

test('the memory use of the VM comes from the VM itself as long as there is a fresh value', () => {
  const w = world();
  w.usage.onDockerReady();
  w.feed(statsLine('rc-x', 0, '1GiB'));
  vmBlock(w, 8 * 1024 * 1024, 2 * 1024 * 1024);
  w.usage.measure();
  assert.equal(w.usage.view().vmUsed, 6 * GB);
  w.time += 20000; // the value is old
  w.feed(statsLine('rc-x', 0, '1GiB'));
  w.usage.measure();
  assert.equal(w.usage.view().vmUsed, GB);
});

test('if the VM gets tight, that is in the log, and vmTight names the free memory', () => {
  const w = world();
  w.usage.onDockerReady();
  for (let index = 0; index < 3; index += 1) vmBlock(w, 10 * 1024 * 1024, 1024 * 1024);
  assert.deepEqual(w.usage.vmTight(), { free: GB });
  assert.deepEqual(w.logs, [['The Docker VM has only 1 GB of 10 GB memory free.', null, 'error']]);
  vmBlock(w, 10 * 1024 * 1024, 5 * 1024 * 1024);
  assert.equal(w.usage.vmTight(), null);
  assert.equal(w.logs[1][0], 'The Docker VM has 5 GB memory free again.');
});

test('each measuring interval passes the consumption to the meter of a working slot, every third becomes a point in the history', () => {
  const w = world();
  const added = [];
  w.pools = [{ slots: [{ base: 'rc-app-1', meter: { add: (...parts) => added.push(parts) } }, { base: 'rc-app-2', meter: null }, { base: null, meter: { add: () => assert.fail('without a pair') } }] }];
  w.usage.onDockerReady();
  w.feed(statsLine('rc-app-1-runner', 100, '1GiB'));
  for (let index = 0; index < SAMPLE_EVERY; index += 1) w.usage.measure();
  assert.equal(added.length, SAMPLE_EVERY);
  assert.deepEqual(added[0], [{ cpu: 1, memory: GB, at: w.time }, undefined]);
  assert.equal(w.samples.length, 1);
  assert.deepEqual(w.samples[0], { hostCpu: 0, hostMemory: 3 * GB, vmCpu: 1, vmMemory: GB });
});

test('the load of Windows: share of time outside idle, in cores', () => {
  const w = world();
  w.cores = [{ times: { user: 100, nice: 0, sys: 0, irq: 0, idle: 100 } }, { times: { user: 100, nice: 0, sys: 0, irq: 0, idle: 100 } }];
  w.usage.measure();
  w.cores = [{ times: { user: 175, nice: 0, sys: 0, irq: 0, idle: 125 } }, { times: { user: 175, nice: 0, sys: 0, irq: 0, idle: 125 } }];
  w.usage.measure();
  assert.equal(w.usage.view().hostCpu, 1.5);
});

test('at most one docker stats runs; when it ends, it restarts after a pause, but not during shutdown', async () => {
  const w = world();
  w.usage.onDockerReady();
  w.usage.onDockerReady();
  assert.equal(w.statsCalls, 1);
  w.feed(statsLine('rc-x', 0, '1GiB'));
  w.endStats();
  await turn();
  assert.equal(w.usage.statsOf('rc-x'), undefined); // without a running measurement no value applies
  assert.deepEqual(w.timers.map((entry) => entry.ms), [STATS_RESTART]);
  w.timers[0].work();
  assert.equal(w.statsCalls, 2);

  w.stopping = true;
  w.endStats();
  await turn();
  assert.equal(w.timers.length, 1);
});

test('the measuring process in the VM: at most one; without a value only again once Docker is prepared anew', async () => {
  const w = world();
  w.usage.onDockerReady();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 1);
  w.endVm(); // without a single value: the distro probably does not exist
  await turn();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 1);
  w.usage.onDockerReady();
  assert.equal(w.vmCalls, 2);
  vmBlock(w, 8 * 1024 * 1024, 4 * 1024 * 1024);
  w.endVm(); // with a value: it may start again right away
  await turn();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 3);
  w.stopping = true;
  w.endVm();
  await turn();
  w.usage.onDockerAlive();
  assert.equal(w.vmCalls, 3);
});
