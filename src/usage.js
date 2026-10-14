// Messung: Auslastung von Windows und der Docker-VM, der Verbrauch jedes Containers und daraus jedes Jobs.
//
//   Container   `docker stats` läuft fortlaufend und meldet je Container CPU und Arbeitsspeicher. Eigene Container
//               (Name beginnt mit `rc-`) und fremde in derselben VM werden getrennt gezählt.
//   Docker-VM   Was die VM wirklich belegt, liest ein zweiter Dauerlauf in der VM selbst (siehe vmmemory.js); die Summe
//               der Container lässt Kernel und Daemon aus. Das geht nur, wenn der Daemon in einer WSL-Distro läuft
//               (siehe engine.js). Gibt es die Distro nicht, endet der Aufruf ohne Messwert: Dann bleibt es still bei
//               der Summe der Container, bis Docker neu vorbereitet wird. Neu gestartet wird nur, wenn Docker gerade
//               geantwortet hat (`dockerReady`, `dockerAlive` aus linux.js): Der Aufruf würde eine angehaltene Distro
//               sonst selbst hochfahren.
//   Je Job      Jeder Messtakt gibt den Verbrauch von Runner und Daemon eines arbeitenden Platzes an dessen Messung
//               (`slot.meter`, siehe metrics.js); jeder dritte Takt wird ein Punkt im Verlauf.
//
// CPU steht in Kernen, Arbeitsspeicher in Bytes.

const os = require('node:os');
const { ESCAPES } = require('./run');
const { SECOND, MINUTE, MB, GB } = require('./units');
const { createVmMemory, COMMAND: VM_COMMAND } = require('./vmmemory');

const SAMPLE_EVERY = 3; // jeder dritte Messtakt wird ein Punkt im Verlauf
const STATS_MAX_AGE = 15 * SECOND; // ein beendeter Container meldet sich nicht ab: So lange gilt sein letzter Wert
const STATS_RESTART = 5 * SECOND; // Pause, bevor ein beendetes `docker stats` neu startet
const VM_FEED_MAX = 60 * MINUTE; // der Messprozess in der VM endet stündlich: Bliebe er stumm hängen, käme sonst nie wieder ein Wert
const UNITS = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: MB, GB: 1e9, GiB: GB };

const gbText = (bytes) => `${(bytes / GB).toFixed(1).replace('.', ',')} GB`; // für Meldungen

// Eine Zeile von `docker stats --format '{{json .}}'`: `{ name, cpu, memory }` oder `null` (Kopfzeile, unvollständig).
// Steuerzeichen, mit denen `docker stats` neu zeichnet, werden übergangen.
function parseStatsLine(raw) {
  const line = String(raw).replace(ESCAPES, '').trim();
  if (!line.startsWith('{')) return null;
  try {
    const entry = JSON.parse(line);
    const [value, unit] = entry.MemUsage.split('/')[0].trim().match(/^([\d.]+)\s*(\w+)$/).slice(1);
    return { name: entry.Name, cpu: (parseFloat(entry.CPUPerc) || 0) / 100, memory: Number(value) * (UNITS[unit] ?? 1) };
  } catch { return null; }
}

//   docker(args, options), inVm(script, options)   aus engine.js
//   metrics                 `sample(point)` (siehe metrics.js)
//   pools()                 die stehenden Pools; ihre arbeitenden Plätze tragen `meter` und `base`
//   log(text, repo, kind), stopping()
//   timer (wie `setTimeout`), now (Uhr in ms), cpus (wie `os.cpus`), memoryUsed() (belegter Arbeitsspeicher von Windows)
function createUsage({
  docker, inVm, metrics, pools, log, stopping,
  timer = setTimeout, now = Date.now, cpus = () => os.cpus(), memoryUsed = () => os.totalmem() - os.freemem(),
}) {
  const own = new Map(); // eigene Container: Name -> { cpu, memory, at }
  const others = new Map(); // fremde Container in derselben Docker-VM
  // `vmMemory` und `otherMemory` sind die Summen der eigenen und der fremden Container; `vmUsed` ist die Belegung der
  // Docker-VM im Ganzen: gemessen in der VM, solange der Messwert frisch ist, sonst die beiden Summen.
  const usage = { hostCpu: 0, vmCpu: 0, vmMemory: 0, vmUsed: 0, otherCpu: 0, otherMemory: 0 };
  let hostTicks = null;
  let round = 0;

  let statsFeed = false; // es läuft höchstens einer
  function startStatsFeed() {
    if (statsFeed) return;
    statsFeed = true;
    // `docker stats` schreibt fortlaufend, deshalb ohne Zeitgrenze.
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
      if (tight) log(`Die Docker-VM hat nur noch ${gbText(sample.available)} von ${gbText(sample.total)} Arbeitsspeicher frei.`, null, 'error');
      else log(sample ? `Die Docker-VM hat wieder ${gbText(sample.available)} Arbeitsspeicher frei.` : 'Die Belegung der Docker-VM lässt sich nicht mehr messen; die Warnung entfällt.');
    },
  });
  let vmFeed = false; // es läuft höchstens einer
  let vmFeedMissing = false; // der letzte Versuch brachte keinen Messwert
  function startVmFeed() {
    if (vmFeed || vmFeedMissing || stopping()) return;
    vmFeed = true;
    let seen = false;
    inVm(VM_COMMAND, { timeout: VM_FEED_MAX, onLine: (line) => { vmProbe.line(line); seen ||= Boolean(vmProbe.current()); } })
      .then(() => { vmFeed = false; vmFeedMissing = !seen; vmProbe.drop(); });
  }

  // Docker ist (wieder) vorbereitet: beide Messungen starten, auch die in der VM, wenn sie zuletzt ohne Wert blieb.
  function dockerReady() {
    startStatsFeed();
    vmFeedMissing = false;
    startVmFeed();
  }

  function measure() {
    // Windows: Anteil der Zeit, in der die Kerne nicht im Leerlauf waren.
    const cores = cpus();
    const ticks = cores.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle }), { idle: 0, total: 0 });
    if (hostTicks && ticks.total > hostTicks.total) usage.hostCpu = (1 - (ticks.idle - hostTicks.idle) / (ticks.total - hostTicks.total)) * cores.length;
    hostTicks = ticks;

    // Docker-VM: die eigenen Container und, was sonst darin läuft.
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

  // `{ free }`, wenn die Docker-VM kaum noch Arbeitsspeicher frei hat, sonst null.
  const vmTight = () => { const sample = vmProbe.tight() ? vmProbe.current() : null; return sample ? { free: sample.available } : null; };

  return {
    dockerReady, dockerAlive: startVmFeed, measure, vmTight,
    view: () => usage,
    statsOf: (name) => own.get(name), // Verbrauch eines eigenen Containers oder undefined
    forget: (name) => own.delete(name),
  };
}

module.exports = { createUsage, parseStatsLine, SAMPLE_EVERY, STATS_MAX_AGE, STATS_RESTART };
