// Measuring: load of Windows and the Docker VM, the consumption of each container and from that of each job.
//
//   Containers  `docker stats` runs continuously and reports CPU and memory per container. Our own containers
//               (name begins with `rc-`) and others in the same VM are counted separately.
//   Docker VM   What the VM really uses is read by a second long-running process in the VM itself (see vmmemory.js);
//               the sum of the containers leaves out kernel and daemon. This only works if the daemon runs in a WSL
//               distro (see engine.js). If the distro does not exist, the call ends without a value: then it quietly
//               stays with the sum of the containers until Docker is prepared anew. It is only restarted when Docker
//               has just answered (`onDockerReady`, `onDockerAlive` from dockerwatch.js): otherwise the call would boot a stopped distro
//               itself.
//   Per job     Each measuring interval passes the consumption of runner and daemon of a working slot to its meter
//               (`slot.meter`, see metrics.js); every third interval becomes a point in the history.
//
// CPU is in cores, memory in bytes.

const os = require('node:os');
const { ESCAPES } = require('./run');
const { SECOND, MINUTE, MB, GB } = require('./units');
const { createVmMemory, COMMAND: VM_COMMAND } = require('./vmmemory');
const { msg } = require('./messages');

const SAMPLE_EVERY = 3; // every third measuring interval becomes a point in the history
const STATS_MAX_AGE = 15 * SECOND; // a stopped container does not sign off: its last value applies for this long
const STATS_RESTART = 5 * SECOND; // pause before an ended `docker stats` restarts
const VM_FEED_MAX = 60 * MINUTE; // the measuring process in the VM ends hourly: if it hung silently, no value would ever come again
const UNITS = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: MB, GB: 1e9, GiB: GB };

const gb = (bytes) => Math.round(bytes / GB * 10) / 10; // for messages

// A line of `docker stats --format '{{json .}}'`: `{ name, cpu, memory }` or `null` (header, incomplete).
// Control characters with which `docker stats` redraws are skipped.
function parseStatsLine(raw) {
  const line = String(raw).replace(ESCAPES, '').trim();
  if (!line.startsWith('{')) return null;
  try {
    const entry = JSON.parse(line);
    const [value, unit] = entry.MemUsage.split('/')[0].trim().match(/^([\d.]+)\s*(\w+)$/).slice(1);
    return { name: entry.Name, cpu: (parseFloat(entry.CPUPerc) || 0) / 100, memory: Number(value) * (UNITS[unit] ?? 1) };
  } catch { return null; }
}

//   docker(args, options), inVm(script, options)   from engine.js
//   metrics                 `sample(point)` (see metrics.js)
//   pools()                 the existing pools; their working slots carry `meter` and `base`
//   log(text, repo, kind), stopping()
//   timer (like `setTimeout`), now (clock in ms), cpus (like `os.cpus`), memoryUsed() (memory used by Windows)
function createUsage({
  docker, inVm, metrics, pools, log, stopping,
  timer = setTimeout, now = Date.now, cpus = () => os.cpus(), memoryUsed = () => os.totalmem() - os.freemem(),
}) {
  const own = new Map(); // own containers: name -> { cpu, memory, at }
  const others = new Map(); // other containers in the same Docker VM
  // `vmMemory` and `otherMemory` are the sums of our own and the other containers; `vmUsed` is the memory use of the
  // Docker VM as a whole: measured in the VM as long as the value is fresh, otherwise the two sums.
  const usage = { hostCpu: 0, vmCpu: 0, vmMemory: 0, vmUsed: 0, otherCpu: 0, otherMemory: 0 };
  let hostTicks = null;
  let round = 0;

  let statsFeed = false; // at most one runs
  function startStatsFeed() {
    if (statsFeed) return;
    statsFeed = true;
    // `docker stats` writes continuously, hence without a time limit.
    docker(['stats', '--format', '{{json .}}'], {
      timeout: 0,
      onLine: (raw) => {
        const parsed = parseStatsLine(raw);
        if (parsed) (parsed.name.startsWith('rc-') ? own : others).set(parsed.name, { cpu: parsed.cpu, memory: parsed.memory, at: now() });
      },
    }).then(() => {
      statsFeed = false;
      own.clear();
      others.clear();
      if (!stopping()) timer(startStatsFeed, STATS_RESTART);
    });
  }

  const vmProbe = createVmMemory({
    now,
    onChange: (tight, sample) => {
      if (tight) log(msg('m_vmTight', gb(sample.available), gb(sample.total)), null, 'error');
      else log(sample ? msg('m_vmFree', gb(sample.available)) : msg('m_vmUnmeasured'));
    },
  });
  let vmFeed = false; // at most one runs
  let vmFeedMissing = false; // the last attempt brought no value
  function startVmFeed() {
    if (vmFeed || vmFeedMissing || stopping()) return;
    vmFeed = true;
    let seen = false;
    inVm(VM_COMMAND, { timeout: VM_FEED_MAX, onLine: (line) => { vmProbe.line(line); seen ||= Boolean(vmProbe.current()); } })
      .then(() => { vmFeed = false; vmFeedMissing = !seen; vmProbe.drop(); });
  }

  // Docker is prepared (again): start both measurements, also the one in the VM if it last stayed without a value.
  function onDockerReady() {
    startStatsFeed();
    vmFeedMissing = false;
    startVmFeed();
  }

  function measure() {
    // Windows: share of the time in which the cores were not idle.
    const cores = cpus();
    const ticks = cores.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle }), { idle: 0, total: 0 });
    if (hostTicks && ticks.total > hostTicks.total) usage.hostCpu = (1 - (ticks.idle - hostTicks.idle) / (ticks.total - hostTicks.total)) * cores.length;
    hostTicks = ticks;

    // Docker VM: our own containers and whatever else runs in it.
    const time = now();
    for (const stats of [own, others]) {
      for (const [name, entry] of stats) if (time - entry.at > STATS_MAX_AGE) stats.delete(name);
    }
    const sum = (stats, field) => [...stats.values()].reduce((total, entry) => total + entry[field], 0);
    Object.assign(usage, { vmCpu: sum(own, 'cpu'), vmMemory: sum(own, 'memory'), otherCpu: sum(others, 'cpu'), otherMemory: sum(others, 'memory') });
    usage.vmUsed = vmProbe.current()?.used ?? usage.vmMemory + usage.otherMemory;

    for (const pool of pools()) {
      for (const slot of pool.slots) if (slot.meter && slot.base) slot.meter.add(own.get(`${slot.base}-runner`), own.get(`${slot.base}-dind`));
    }
    round += 1;
    if (round % SAMPLE_EVERY === 0) metrics.sample({ hostCpu: usage.hostCpu, hostMemory: memoryUsed(), vmCpu: usage.vmCpu + usage.otherCpu, vmMemory: usage.vmUsed });
  }

  // `{ free }` when the Docker VM has hardly any memory free, otherwise null.
  const vmTight = () => { const sample = vmProbe.tight() ? vmProbe.current() : null; return sample ? { free: sample.available } : null; };

  return {
    onDockerReady, onDockerAlive: startVmFeed, measure, vmTight,
    view: () => usage,
    statsOf: (name) => own.get(name), // consumption of one of our own containers or undefined
    forget: (name) => own.delete(name),
  };
}

module.exports = { createUsage, parseStatsLine, SAMPLE_EVERY, STATS_MAX_AGE, STATS_RESTART };
