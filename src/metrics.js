// Messung: Auslastung von Windows und Docker-VM als Verlauf, dazu der Verbrauch jedes Jobs.
//
// Verlauf   alle paar Sekunden ein Messpunkt für die letzte halbe Stunde (nur im Speicher),
//           daraus je Minute ein Mittel- und Höchstwert für die letzten 24 Stunden (metrics.json).
// Je Job    Dauer, Spitzen- und Durchschnittsverbrauch der letzten Durchläufe (metrics.json), abgelegt unter dem
//           Jobnamen. Jeder Durchlauf trägt den Namen seines Workflows, soweit er bekannt war: Zwei Workflows
//           können einen Job gleich nennen, und beim Lesen wird danach getrennt.
// CPU steht überall in Kernen, Arbeitsspeicher in Bytes.

const path = require('node:path');

const { MINUTE, DAY } = require('./units');
const { median } = require('./numbers');
const { readJson, writeJson } = require('./store');

const RECENT_MAX = 300; // Messpunkte der letzten halben Stunde
const MINUTES_MAX = 1440;
const JOB_KEEP = 20; // gemerkte Durchläufe je Job und Workflow
const NAME_KEEP = 100; // … und je Jobname über alle Workflows
const JOBS_MAX = 100; // gemerkte Jobnamen je Repo; mit wechselnden Namen (etwa einem Commit im Namen) wüchse die Datei ohne Ende
const FIELDS = ['hostCpu', 'hostMemory', 'vmCpu', 'vmMemory'];

// `now`: die Uhr in Millisekunden; in Tests steuerbar.
function createMetrics({ dataDir, now: clock = Date.now }) {
  const file = path.join(dataDir, 'metrics.json');
  const stored = readJson(file, {}).data; // eine beschädigte Datei bleibt als Kopie liegen
  // Die Datei kann von Hand verändert oder beschädigt sein: nur nehmen, was die erwartete Form hat.
  const minutes = (Array.isArray(stored?.minutes) ? stored.minutes : []).filter((entry) => entry && Number.isFinite(entry.at));
  const jobs = stored?.jobs && typeof stored.jobs === 'object' && !Array.isArray(stored.jobs) ? stored.jobs : {};
  // Job- und Repo-Namen kommen von außen und können wie eingebaute Eigenschaften heißen (constructor, __proto__):
  // nur eigene Einträge zählen, und angelegt wird, ohne den Prototyp zu berühren.
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  const ensure = (object, key, make) => {
    if (!Object.hasOwn(object, key)) Object.defineProperty(object, key, { value: make(), enumerable: true, writable: true, configurable: true });
    return object[key];
  };
  const save = () => { try { writeJson(file, { minutes, jobs }, { compact: true }); } catch { /* Messwerte sind Beiwerk */ } };

  // Was älter als 24 Stunden ist, fällt heraus: Nach einer langen Pause lägen sonst alte Minuten auf der Achse eines Tages.
  // Ebenso, was in der Zukunft liegt (die Uhr wurde zurückgestellt): Die Kurve liefe sonst rückwärts.
  const prune = (time) => {
    const kept = minutes.filter((entry) => entry.at >= time - DAY && entry.at <= time);
    if (kept.length !== minutes.length) minutes.splice(0, minutes.length, ...kept);
  };
  prune(clock());

  const recent = [];
  let bucket = null; // die laufende Minute

  // `point`: { hostCpu, hostMemory, vmCpu, vmMemory }
  function sample(point, now = clock()) {
    recent.push({ at: now, ...point });
    if (recent.length > RECENT_MAX) recent.shift();
    const minute = Math.floor(now / MINUTE);
    if (bucket && bucket.minute !== minute) {
      const entry = { at: bucket.minute * MINUTE };
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

  // `record`: { job, workflow, result, duration, ...meter().finish() }; `workflow` ist leer, wenn er nicht bekannt war.
  function recordJob(repo, record) {
    const list = ensure(ensure(jobs, repo, () => ({})), String(record.job), () => []);
    const workflow = String(record.workflow ?? '');
    const same = (run) => (run.workflow ?? '') === workflow;
    list.push({ at: new Date(clock()).toISOString(), ...record, job: undefined, workflow });
    // Je Workflow gezählt: Sonst verdrängte der häufige Workflow die Durchläufe des seltenen gleichnamigen Jobs.
    if (list.filter(same).length > JOB_KEEP) list.splice(list.findIndex(same), 1);
    if (list.length > NAME_KEEP) list.shift();
    // Zu viele Namen: Die am längsten nicht gelaufenen fallen heraus.
    const names = Object.keys(jobs[repo]);
    if (names.length > JOBS_MAX) {
      const last = (name) => jobs[repo][name].at(-1)?.at ?? '';
      for (const name of names.sort((a, b) => last(a).localeCompare(last(b))).slice(0, names.length - JOBS_MAX)) delete jobs[repo][name];
    }
    save();
  }

  const forget = (repo) => { delete jobs[repo]; save(); };

  // Die Durchläufe eines Jobnamens je Workflow. Wo der Workflow fehlt (ältere Daten, oder GitHub hatte noch nicht
  // geantwortet), zählt der Durchlauf zum Workflow mit den meisten bekannten Durchläufen; ist keiner bekannt, bleibt
  // es eine Gruppe ohne Workflow.
  function byWorkflow(list) {
    const counts = new Map();
    for (const run of list) if (run.workflow) counts.set(run.workflow, (counts.get(run.workflow) ?? 0) + 1);
    const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const groups = new Map();
    for (const run of list) {
      const workflow = run.workflow || most;
      if (!groups.has(workflow)) groups.set(workflow, []);
      groups.get(workflow).push(run);
    }
    return [...groups];
  }

  // Je Workflow und Job eine Zeile; die hungrigsten zuerst.
  function jobsView(repo) {
    return Object.entries(own(jobs, repo) ?? {}).flatMap(([job, all]) => byWorkflow(all).map(([workflow, list]) => {
      const measured = list.filter((r) => r.samples > 0);
      // Üblich ist, was ein erfolgreicher Durchlauf braucht (wie in pipeline.js): Ein Abbruch nach Sekunden verfälscht sonst die Dauer.
      // Ohne einen erfolgreichen zählen alle, damit die Spalte nicht leer bleibt.
      const good = list.filter((r) => r.result === 'Succeeded');
      return {
        job, workflow, runs: list.length, measuredRuns: measured.length, lastAt: list.at(-1).at, lastResult: list.at(-1).result,
        duration: median((good.length ? good : list).map((r) => r.duration)), lastDuration: list.at(-1).duration,
        peakMemory: Math.max(0, ...measured.map((r) => r.peakMemory)), peakRunner: Math.max(0, ...measured.map((r) => r.peakRunner)), peakDocker: Math.max(0, ...measured.map((r) => r.peakDocker)),
        cpu: median(measured.map((r) => r.cpu)) ?? 0, peakCpu: Math.max(0, ...measured.map((r) => r.peakCpu)),
      };
    })).sort((a, b) => b.peakMemory - a.peakMemory);
  }

  // Die letzte halbe Stunde, je Messgröße eine Reihe.
  const series = () => ({ at: recent.map((p) => p.at), ...Object.fromEntries(FIELDS.map((field) => [field, recent.map((p) => Math.round(p[field] * 100) / 100)])) });

  return { sample, meter, recordJob, forget, jobsView, series, dayMinutes: () => { prune(clock()); return minutes; }, save };
}

module.exports = { createMetrics };
