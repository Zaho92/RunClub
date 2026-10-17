// Limits per job: how much memory and how many cores the runner and its Docker daemon get.
// `runners.json` holds them the way Docker reads them (`4g`, `1536m`); the interface works in GB and cores.

const { MB, GB } = require('./units');
const { median } = require('./numbers');
const { Fault } = require('./messages');

const bytesOf = (text) => {
  const match = String(text ?? '').trim().match(/^([\d.]+)\s*([gmk]?)b?$/i);
  if (!match) return 0;
  const unit = match[2].toLowerCase();
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value * (unit === 'g' ? GB : unit === 'm' ? MB : unit === 'k' ? 1024 : 1)) : 0;
};
const memoryText = (gb) => (Number.isInteger(gb) ? `${gb}g` : `${Math.round(gb * 1024)}m`);

// What can be set depends on the Docker VM: no job can get more than it has.
// `total` caps runner and Docker of a job together: the VM itself needs about 1 GB, and a limit above its memory
// limits nothing any more – then full memory would hit some job, even one of another project.
function bounds({ dockerMemory, dockerCpus }) {
  const vm = (dockerMemory || 0) / GB;
  return {
    memory: { min: 1, max: Math.min(32, Math.max(2, Math.floor(vm))), step: 0.5, total: Math.min(64, Math.max(2, Math.floor((vm - 1) * 2) / 2)) },
    cpus: { min: 1, max: Math.max(1, Math.floor(dockerCpus || 1)), step: 1 },
  };
}

// Keeps runner and Docker together below the cap: the larger value gives way first.
function capped(runner, docker, { min, step, total }) {
  let [a, b] = [runner, docker];
  while (total !== undefined && a + b > total && (a > min || b > min)) { if (a >= b && a > min) a -= step; else b -= step; }
  return [a, b];
}

// The limits as numbers: memory in GB, cores as a count.
const view = (limits) => ({
  runnerMemory: bytesOf(limits.runnerMemory) / GB, dockerMemory: bytesOf(limits.dockerMemory) / GB,
  runnerCpus: Number(limits.runnerCpus), dockerCpus: Number(limits.dockerCpus),
});

// Takes new values (memory in GB, cores as a count) into the notation of the settings.
// What is missing stays; what lies outside the bounds is set to the bound.
function normalize(input, current, range) {
  const now = view(current);
  const pick = (key, { min, max, step }) => {
    if (input?.[key] === undefined || input[key] === null || input[key] === '') return now[key];
    const value = Number(input[key]);
    if (!Number.isFinite(value)) throw new Fault('m_limitsNumbers');
    return Math.min(max, Math.max(min, Math.round(value / step) * step));
  };
  const [runner, docker] = capped(pick('runnerMemory', range.memory), pick('dockerMemory', range.memory), range.memory);
  return { runnerCpus: pick('runnerCpus', range.cpus), runnerMemory: memoryText(runner), dockerCpus: pick('dockerCpus', range.cpus), dockerMemory: memoryText(docker) };
}

// Suggestion from the measurements: the highest measured peak with 50 % headroom, rounded to half GB.
// `jobs`: rows from `metrics.jobsView` of all repos. Without enough runs there is no suggestion.
const SUGGEST_RUNS = 5;
// Only runs that were actually measured count (`measuredRuns` from `metrics.jobsView`).
const runsOf = (jobs) => jobs.filter((job) => job.peakMemory > 0).reduce((sum, job) => sum + (job.measuredRuns ?? job.runs), 0);
function suggest(jobs, range) {
  const measured = jobs.filter((job) => job.peakMemory > 0);
  if (runsOf(jobs) < SUGGEST_RUNS) return null;
  const peak = (field) => Math.max(0, ...measured.map((job) => job[field] ?? 0));
  const memory = (bytes) => Math.min(range.memory.max, Math.max(range.memory.min, Math.ceil(bytes * 1.5 / GB * 2) / 2));
  // The cores are only measured together: runner and Docker get the same number.
  const cpus = Math.min(range.cpus.max, Math.max(2, Math.ceil(peak('peakCpu'))));
  const [runner, docker] = capped(memory(peak('peakRunner')), memory(peak('peakDocker')), range.memory);
  return { runnerMemory: runner, dockerMemory: docker, runnerCpus: cpus, dockerCpus: cpus };
}

// What applies to a project: its own limits, otherwise those for all.
const effective = (shared, own) => ({ ...shared, ...(own ?? {}) });
// Key of the Docker daemon's limits: the build service carries it too (see caches.js).
const dockerKey = (limits) => [limits.dockerCpus, bytesOf(limits.dockerMemory)].join('/');
// Key of a set of limits: it shows whether a pair was built with different limits.
const key = (limits) => [limits.runnerCpus, bytesOf(limits.runnerMemory), dockerKey(limits)].join('/');

function sameValues(a, b) { return ['runnerMemory', 'dockerMemory', 'runnerCpus', 'dockerCpus'].every((field) => a?.[field] === b?.[field]); }

// A suggestion for all projects together: a default that covers the projects with similar needs, and own limits
// only for outliers. An average is no good for this – a limit below the need kills the job.
// An outlier is a project that needs clearly more memory than the median project: over one and a half times and
// at least 1 GB more. `projects`: [{ repo, jobs }] with rows from `metrics.jobsView`.
const OUTLIER_FACTOR = 1.5;
const OUTLIER_GB = 1;
function plan(projects, range) {
  const needs = projects.map((project) => ({ repo: project.repo, need: suggest(project.jobs, range) })).filter((entry) => entry.need);
  if (!needs.length) return null;
  const memory = (need) => need.runnerMemory + need.dockerMemory;
  const middle = median(needs.map((entry) => memory(entry.need)));
  const outlier = (entry) => memory(entry.need) > middle * OUTLIER_FACTOR && memory(entry.need) - middle >= OUTLIER_GB;
  const usual = needs.filter((entry) => !outlier(entry));
  const most = (field) => Math.max(...usual.map((entry) => entry.need[field]));
  return {
    shared: { runnerMemory: most('runnerMemory'), dockerMemory: most('dockerMemory'), runnerCpus: most('runnerCpus'), dockerCpus: most('dockerCpus') },
    own: Object.fromEntries(needs.filter(outlier).map((entry) => [entry.repo, entry.need])),
    // The suggestion only says something about these projects. A project with too few runs yet keeps what it has.
    measured: needs.map((entry) => entry.repo),
  };
}

// Does the suggestion already apply? `shared`: the limits for all as numbers; `projects`: [{ repo, own }] with a
// project's own limits as numbers or `null`. Projects without enough runs do not count.
function planApplied(found, shared, projects) {
  return sameValues(found.shared, shared) && projects.filter((project) => found.measured.includes(project.repo))
    .every((project) => (found.own[project.repo] ? sameValues(found.own[project.repo], project.own) : !project.own));
}

// How well the current limits (`values`, memory in GB) fit a project:
//   'full'       a peak used up the limit – the job needs more
//   'tight'      a peak came close to it (over 85 %); that counts after a single run already
//   'generous'   the limit is more than twice the need (only with enough runs)
//   'measuring'  too few runs for a verdict yet
//   'ok'
const TIGHT = 0.85; // also goes to the interface: there the mark sits on the rail
const FULL = 0.97;
function rate(jobs, values, range) {
  const runs = runsOf(jobs);
  if (!(values.runnerMemory > 0) || !(values.dockerMemory > 0)) return { state: 'measuring', runs }; // unreadable limits: no verdict
  const share = Math.max(0, ...jobs.map((job) => Math.max((job.peakRunner ?? 0) / (values.runnerMemory * GB), (job.peakDocker ?? 0) / (values.dockerMemory * GB))));
  if (share >= FULL) return { state: 'full', runs };
  if (share > TIGHT) return { state: 'tight', runs };
  const need = suggest(jobs, range);
  if (!need) return { state: 'measuring', runs };
  return { state: values.runnerMemory + values.dockerMemory > 2 * (need.runnerMemory + need.dockerMemory) ? 'generous' : 'ok', runs };
}

module.exports = { bytesOf, memoryText, bounds, view, normalize, suggest, plan, planApplied, rate, sameValues, effective, key, dockerKey, SUGGEST_RUNS, TIGHT };
