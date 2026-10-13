// Messung: Auslastung von Windows und Docker-VM als Verlauf, dazu der Verbrauch jedes Jobs.
//
// Verlauf   alle paar Sekunden ein Messpunkt für die letzte halbe Stunde (nur im Speicher),
//           daraus je Minute ein Mittel- und Höchstwert für die letzten 24 Stunden (metrics.json).
// Je Job    Dauer, Spitzen- und Durchschnittsverbrauch der letzten Durchläufe (metrics.json).
// CPU steht überall in Kernen, Arbeitsspeicher in Bytes.

const fs = require('node:fs');
const path = require('node:path');

const RECENT_MAX = 300; // Messpunkte der letzten halben Stunde
const MINUTES_MAX = 1440;
const DAY = 24 * 3600000;
const JOB_KEEP = 20; // gemerkte Durchläufe je Job
const JOBS_MAX = 100; // gemerkte Jobnamen je Repo; mit wechselnden Namen (etwa einem Commit im Namen) wüchse die Datei ohne Ende
const FIELDS = ['hostCpu', 'hostMemory', 'vmCpu', 'vmMemory'];

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// `now`: die Uhr; in Tests steuerbar.
function createMetrics({ dataDir, now: clock = Date.now }) {
  const file = path.join(dataDir, 'metrics.json');
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* noch nichts gemessen */ }
  const minutes = stored.minutes ?? [];
  const jobs = stored.jobs ?? {};
  // Job- und Repo-Namen kommen von außen und können wie eingebaute Eigenschaften heißen (constructor, __proto__):
  // nur eigene Einträge zählen, und angelegt wird, ohne den Prototyp zu berühren.
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  const ensure = (object, key, make) => {
    if (!Object.hasOwn(object, key)) Object.defineProperty(object, key, { value: make(), enumerable: true, writable: true, configurable: true });
    return object[key];
  };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify({ minutes, jobs })); } catch { /* Messwerte sind Beiwerk */ } };

  // Was älter als 24 Stunden ist, fällt heraus: Nach einer langen Pause lägen sonst alte Minuten auf der Achse eines Tages.
  const prune = (time) => {
    const kept = minutes.filter((entry) => entry.at >= time - DAY);
    if (kept.length !== minutes.length) minutes.splice(0, minutes.length, ...kept);
  };
  prune(clock());

  const recent = [];
  let bucket = null; // die laufende Minute

  // `point`: { hostCpu, hostMemory, vmCpu, vmMemory }
  function sample(point, now = clock()) {
    recent.push({ at: now, ...point });
    if (recent.length > RECENT_MAX) recent.shift();
    const minute = Math.floor(now / 60000);
    if (bucket && bucket.minute !== minute) {
      const entry = { at: bucket.minute * 60000 };
      for (const field of FIELDS) { entry[field] = bucket.sum[field] / bucket.count; entry[`${field}Max`] = bucket.max[field]; }
      minutes.push(entry);
      prune(now);
      if (minutes.length > MINUTES_MAX) minutes.splice(0, minutes.length - MINUTES_MAX);
      if (minute % 5 === 0) save();
      bucket = null;
    }
    bucket ??= { minute, count: 0, sum: Object.fromEntries(FIELDS.map((f) => [f, 0])), max: Object.fromEntries(FIELDS.map((f) => [f, 0])) };
    bucket.count += 1;
    for (const field of FIELDS) { bucket.sum[field] += point[field]; bucket.max[field] = Math.max(bucket.max[field], point[field]); }
  }

  // Zählt während eines Jobs mit; `finish` liefert, was davon gemerkt wird.
  function meter() {
    const usage = { peakMemory: 0, peakRunner: 0, peakDocker: 0, peakCpu: 0, cpuSum: 0, samples: 0 };
    return {
      add(runner, docker) {
        const memory = (runner?.memory ?? 0) + (docker?.memory ?? 0);
        const cpu = (runner?.cpu ?? 0) + (docker?.cpu ?? 0);
        usage.peakMemory = Math.max(usage.peakMemory, memory);
        usage.peakRunner = Math.max(usage.peakRunner, runner?.memory ?? 0);
        usage.peakDocker = Math.max(usage.peakDocker, docker?.memory ?? 0);
        usage.peakCpu = Math.max(usage.peakCpu, cpu);
        usage.cpuSum += cpu;
        usage.samples += 1;
      },
      finish: () => ({ peakMemory: usage.peakMemory, peakRunner: usage.peakRunner, peakDocker: usage.peakDocker, peakCpu: usage.peakCpu, cpu: usage.samples ? usage.cpuSum / usage.samples : 0, samples: usage.samples }),
    };
  }

  // `record`: { job, result, duration, ...meter().finish() }
  function recordJob(repo, record) {
    const list = ensure(ensure(jobs, repo, () => ({})), String(record.job), () => []);
    list.push({ at: new Date().toISOString(), ...record, job: undefined });
    if (list.length > JOB_KEEP) list.shift();
    // Zu viele Namen: Die am längsten nicht gelaufenen fallen heraus.
    const names = Object.keys(jobs[repo]);
    if (names.length > JOBS_MAX) {
      const last = (name) => jobs[repo][name].at(-1)?.at ?? '';
      for (const name of names.sort((a, b) => last(a).localeCompare(last(b))).slice(0, names.length - JOBS_MAX)) delete jobs[repo][name];
    }
    save();
  }

  const forget = (repo) => { delete jobs[repo]; save(); };

  // Je Job eine Zeile; die hungrigsten zuerst.
  function jobsView(repo) {
    return Object.entries(own(jobs, repo) ?? {}).map(([job, list]) => {
      const measured = list.filter((r) => r.samples > 0);
      // Üblich ist, was ein erfolgreicher Durchlauf braucht (wie in pipeline.js): Ein Abbruch nach Sekunden verfälscht sonst die Dauer.
      // Ohne einen erfolgreichen zählen alle, damit die Spalte nicht leer bleibt.
      const good = list.filter((r) => r.result === 'Succeeded');
      return {
        job, runs: list.length, measuredRuns: measured.length, lastAt: list.at(-1).at, lastResult: list.at(-1).result,
        duration: median((good.length ? good : list).map((r) => r.duration)), lastDuration: list.at(-1).duration,
        peakMemory: Math.max(0, ...measured.map((r) => r.peakMemory)), peakRunner: Math.max(0, ...measured.map((r) => r.peakRunner)), peakDocker: Math.max(0, ...measured.map((r) => r.peakDocker)),
        cpu: median(measured.map((r) => r.cpu)) ?? 0, peakCpu: Math.max(0, ...measured.map((r) => r.peakCpu)),
      };
    }).sort((a, b) => b.peakMemory - a.peakMemory);
  }

  // Die letzte halbe Stunde, je Messgröße eine Reihe.
  const series = () => ({ at: recent.map((p) => p.at), ...Object.fromEntries(FIELDS.map((field) => [field, recent.map((p) => Math.round(p[field] * 100) / 100)])) });

  return { sample, meter, recordJob, forget, jobsView, series, minutes: () => { prune(clock()); return minutes; }, save };
}

module.exports = { createMetrics };
