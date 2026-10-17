// Measuring: load of Windows and the Docker VM over time, plus the consumption of each job.
//
// History   every few seconds a sample for the last half hour (in memory only),
//           from that per minute a mean and a peak for the last 24 hours (metrics.json).
// Per job   duration, peak and average consumption of the last runs (metrics.json), stored under the job
//           name. Each run carries the name of its workflow as far as it was known: two workflows can give a job
//           the same name, and reading separates by it.
// CPU is in cores everywhere, memory in bytes.

const path = require('node:path');

const { MINUTE, DAY } = require('./units');
const { median } = require('./numbers');
const { readJson, writeJson } = require('./store');

const RECENT_MAX = 300; // samples of the last half hour
const MINUTES_MAX = 1440;
const JOB_KEEP = 20; // runs kept per job and workflow
const NAME_KEEP = 100; // … and per job name across all workflows
const JOBS_MAX = 100; // job names kept per repo; with changing names (a commit in the name, say) the file would grow without end
const FIELDS = ['hostCpu', 'hostMemory', 'vmCpu', 'vmMemory'];
// Result of a job as GitHub names it (`conclusion`), in the runner's words.
const CONCLUSIONS = Object.freeze({ success: 'Succeeded', failure: 'Failed', timed_out: 'Failed', cancelled: 'Canceled', skipped: 'Skipped' });

// `now`: the clock in milliseconds; controllable in tests.
function createMetrics({ dataDir, now: clock = Date.now }) {
  const file = path.join(dataDir, 'metrics.json');
  const stored = readJson(file, {}).data; // a damaged file is kept as a copy
  // The file may have been changed by hand or damaged: only take what has the expected shape.
  const minutes = (Array.isArray(stored?.minutes) ? stored.minutes : []).filter((entry) => entry && Number.isFinite(entry.at));
  const jobs = stored?.jobs && typeof stored.jobs === 'object' && !Array.isArray(stored.jobs) ? stored.jobs : {};
  // Job and repo names come from outside and can be named like built-in properties (constructor, __proto__):
  // only own entries count, and entries are created without touching the prototype.
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  const ensure = (object, key, make) => {
    if (!Object.hasOwn(object, key)) Object.defineProperty(object, key, { value: make(), enumerable: true, writable: true, configurable: true });
    return object[key];
  };
  const save = () => { try { writeJson(file, { minutes, jobs }, { compact: true }); } catch { /* measurements are secondary */ } };

  // What is older than 24 hours drops out: after a long pause old minutes would otherwise lie on the axis of a day.
  // Likewise what lies in the future (the clock was set back): the curve would otherwise run backwards.
  const prune = (time) => {
    const kept = minutes.filter((entry) => entry.at >= time - DAY && entry.at <= time);
    if (kept.length !== minutes.length) minutes.splice(0, minutes.length, ...kept);
  };
  prune(clock());

  const recent = [];
  let bucket = null; // the current minute

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

  // Counts along during a job; `finish` returns what of it is kept.
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

  // `record`: { job, workflow, runner, result, duration, ...meter().finish() }; `workflow` is empty if it was not
  // known; `result` is provisional until `confirmResults` replaces it with GitHub's.
  function recordJob(repo, record) {
    const list = ensure(ensure(jobs, repo, () => ({})), String(record.job), () => []);
    const workflow = String(record.workflow ?? '');
    const same = (run) => (run.workflow ?? '') === workflow;
    list.push({ at: new Date(clock()).toISOString(), ...record, job: undefined, workflow });
    // Counted per workflow: otherwise the frequent workflow would push out the runs of the rare job of the same name.
    if (list.filter(same).length > JOB_KEEP) list.splice(list.findIndex(same), 1);
    if (list.length > NAME_KEEP) list.shift();
    // Too many names: those that have not run for the longest drop out.
    const names = Object.keys(jobs[repo]);
    if (names.length > JOBS_MAX) {
      const last = (name) => jobs[repo][name].at(-1)?.at ?? '';
      for (const name of names.sort((a, b) => last(a).localeCompare(last(b))).slice(0, names.length - JOBS_MAX)) delete jobs[repo][name];
    }
    save();
  }

  // The result of a run comes from the runner's output, which the job can write to as well (see `serveOneJob` in
  // slots.js), and is therefore provisional. Once GitHub reports a runner's job as completed, its result applies.
  // `done`: [{ runner, conclusion }]; a runner name belongs to exactly one job.
  function confirmResults(repo, done) {
    const results = new Map(done.filter((job) => job.runner && Object.hasOwn(CONCLUSIONS, job.conclusion)).map((job) => [job.runner, CONCLUSIONS[job.conclusion]]));
    let changed = false;
    for (const list of Object.values(own(jobs, repo) ?? {})) {
      for (const record of list) {
        if (!record.runner || record.confirmed || !results.has(record.runner)) continue;
        Object.assign(record, { result: results.get(record.runner), confirmed: true });
        changed = true;
      }
    }
    if (changed) save();
  }

  const forget = (repo) => { delete jobs[repo]; save(); };

  // The runs of a job name per workflow. Where the workflow is missing (older data, or GitHub had not answered yet),
  // the run counts towards the workflow with the most known runs; if none is known, it stays a group without a
  // workflow.
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

  // One row per workflow and job; the hungriest first.
  function jobsView(repo) {
    return Object.entries(own(jobs, repo) ?? {}).flatMap(([job, all]) => byWorkflow(all).map(([workflow, list]) => {
      const measured = list.filter((r) => r.samples > 0);
      // Usual is what a successful run takes (as in pipeline.js): otherwise an abort after seconds skews the duration.
      // Without a successful one all count, so that the column does not stay empty.
      const good = list.filter((r) => r.result === 'Succeeded');
      return {
        job, workflow, runs: list.length, measuredRuns: measured.length, lastAt: list.at(-1).at, lastResult: list.at(-1).result,
        duration: median((good.length ? good : list).map((r) => r.duration)), lastDuration: list.at(-1).duration,
        peakMemory: Math.max(0, ...measured.map((r) => r.peakMemory)), peakRunner: Math.max(0, ...measured.map((r) => r.peakRunner)), peakDocker: Math.max(0, ...measured.map((r) => r.peakDocker)),
        cpu: median(measured.map((r) => r.cpu)) ?? 0, peakCpu: Math.max(0, ...measured.map((r) => r.peakCpu)),
      };
    })).sort((a, b) => b.peakMemory - a.peakMemory);
  }

  // The last half hour, one series per measure.
  const series = () => ({ at: recent.map((p) => p.at), ...Object.fromEntries(FIELDS.map((field) => [field, recent.map((p) => Math.round(p[field] * 100) / 100)])) });

  return { sample, meter, recordJob, confirmResults, forget, jobsView, series, dayMinutes: () => { prune(clock()); return minutes; }, save };
}

module.exports = { createMetrics };
