// Runs of a repo as a pipeline: all jobs of a run, their dependencies, their usual duration and from that the time left.
//
// Dependencies    are the `needs:` in the run's workflow file; it is read once per commit.
//                 They also yield the jobs GitHub only creates later.
// Usual duration  median of the last successful runs of the same job (history.json in the data folder).
// Time left       The open jobs of all running runs are spread over the pool's slots in the order of their
//                 dependencies. It remains an estimate.

const path = require('node:path');
const { median } = require('./numbers');
const { readJson, writeJson } = require('./store');
const { SECOND } = require('./units');
const { PAGE_MAX } = require('./github');

const KEEP = 10; // durations remembered per job
const LEARN_PER_ROUND = 5; // completed runs learned per query
const SEEN_MAX = 300;
const WAITS_KEEP = 50; // wait times remembered per repo
const WORKFLOWS_MAX = 40; // workflow files remembered
const TURNAROUND_S = 8; // a slot switching to the next job
const FALLBACK_S = 60; // usual duration of a job while the repo has not learned any yet
const FINISHED_ROUNDS = 6; // for this many queries a run that just finished stays around to confirm the results

// Seconds stay whole numbers.
const roundedMedian = (values) => { const middle = median(values); return middle === null ? null : Math.round(middle); };
const seconds = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / SECOND));
const unquote = (text) => text.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');

// Reads from a workflow file, per job, its displayed name and its dependencies.
// Not full YAML: the `jobs:` block with `name:` and `needs:` in the usual notations is enough.
// A job that calls another workflow gets `uses: true`.
function parseWorkflow(text) {
  const jobs = [];
  let inJobs = false;
  let indent = null; // indentation of the job keys
  let job = null;
  let needsIndent = null; // set while a list under `needs:` is running
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const depth = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (depth === 0) { inJobs = /^jobs\s*:/.test(line); job = null; continue; }
    if (!inJobs) continue;
    indent ??= depth;
    if (depth === indent) {
      const key = line.match(/^([A-Za-z0-9_-]+)\s*:/);
      job = key ? { id: key[1], name: key[1], needs: [] } : null;
      if (job) jobs.push(job);
      needsIndent = null;
      continue;
    }
    if (!job) continue;
    if (needsIndent !== null) {
      const item = depth > needsIndent && line.match(/^-\s*(.+)$/);
      if (item) { job.needs.push(unquote(item[1])); continue; }
      needsIndent = null;
    }
    job.depth ??= depth;
    if (depth !== job.depth) continue; // deeper than the job's properties (steps, matrix …)
    const name = line.match(/^name\s*:\s*(.+)$/);
    if (name) { job.name = unquote(name[1]); continue; }
    if (/^uses\s*:/.test(line)) { job.uses = true; continue; }
    const needs = line.match(/^needs\s*:\s*(.*)$/);
    if (!needs) continue;
    const value = needs[1].replace(/\s+#.*$/, '').trim();
    if (!value) needsIndent = depth;
    else if (value.startsWith('[')) job.needs.push(...value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean));
    else job.needs.push(unquote(value));
  }
  return jobs.map(({ id, name, needs, uses }) => ({ id, name, needs, ...(uses && { uses }) }));
}

// Under which names a job of the file runs at GitHub. The name from the file always stands in full at the start,
// after it only what GitHub appends itself is allowed – so 'Test' does not match 'Tests nightly':
//   expression in name  `Test ${{ matrix.os }}` -> 'Test ubuntu-latest': the expression stands for any text, also
//                       for none ('Test'). The space next to it stays mandatory as soon as it yields something.
//   matrix              'Name (value, value)'
//   call (`uses:`)      'Name / inner job', with matrix 'Name (value) / inner job'. Only for such jobs, because
//                       otherwise 'Build' would match a foreign job called 'Build / Docker'. For the same reason
//                       `Test ${{ matrix.os }}` does not match a foreign 'Test / Docker'.
const EXPRESSION = /\$\{\{.*?\}\}/g;
const EXPRESSIONS_MAX = 3; // with more expressions a job name is no longer read as a pattern
const CALL = ' / '; // how GitHub separates the calling from the called job
function matcherOf(defined) {
  // Every expression stands for any text. Several of them make checking a long job name arbitrarily expensive;
  // expressions right after each other therefore count as one, and with more than EXPRESSIONS_MAX only the exact name counts.
  const parts = defined.name.split(EXPRESSION).filter((part, index, all) => part || index === 0 || index === all.length - 1);
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An expression together with the spaces separating it from the fixed text: if it yields nothing, they go with it.
  const expression = (before, after) => {
    const left = /\s$/.test(before);
    const right = /^\s/.test(after);
    if (left && right) return '\\s(?:.*\\s)?';
    if (left) return '(?:\\s.*)?';
    if (right) return '(?:.*\\s)?';
    return '.*';
  };
  const name = parts.length - 1 > EXPRESSIONS_MAX ? literal(defined.name) : parts.map((part, index) => {
    const fixed = literal(part.replace(index > 0 ? /^\s+/ : /^/, '').replace(index < parts.length - 1 ? /\s+$/ : /$/, ''));
    return index < parts.length - 1 ? fixed + expression(part, parts[index + 1]) : fixed;
  }).join('');
  const pattern = new RegExp(defined.uses ? `^${name}( \\(.*\\))?${CALL}` : `^${name}( \\(.*)?$`);
  const called = !defined.uses && !defined.name.includes(CALL); // a ' / ' in the name then belongs to a foreign call
  return { test: (job) => pattern.test(job) && !(called && job.includes(CALL)) };
}

// What an announced job is called while GitHub has not evaluated its name yet: 'Test …'.
const announced = (defined) => defined.name.replace(EXPRESSION, '…');

// Sorts jobs into stages by their dependencies: 0 has none, otherwise one more than the deepest dependency.
function stagesOf(jobs) {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const depth = (job, seen = new Set()) => {
    if (job.stage !== undefined) return job.stage;
    if (seen.has(job.name)) return 0; // cycle: does not exist in valid workflows
    seen.add(job.name);
    const parents = job.needs.map((name) => byName.get(name)).filter(Boolean);
    job.stage = parents.length ? 1 + Math.max(...parents.map((parent) => depth(parent, seen))) : 0;
    return job.stage;
  };
  jobs.forEach((job) => depth(job));
}

function createPipelines({ github, dataDir }) {
  const file = path.join(dataDir, 'history.json');
  const read = readJson(file, {}).data; // a damaged file is kept as a copy
  const history = read && typeof read === 'object' && !Array.isArray(read) ? read : {};
  const save = () => { try { writeJson(file, history, { compact: true }); } catch { /* what was learned is an extra */ } };
  const memoryOf = (repo) => (history[repo] ??= { durations: {}, jobsOf: {}, seen: [] });
  const active = new Map(); // repo -> running runs with their jobs
  const latest = new Map(); // repo -> { id, updatedAt, pipeline } of the latest completed run
  const finished = new Map(); // repo -> [{ rounds, pipeline }] of the runs completed recently
  const workflows = new Map(); // "repo@commit:path" -> jobs of the workflow file or null

  const key = (workflow, job) => `${workflow} / ${job}`;
  const estimate = (repo, workflow, job) => roundedMedian(memoryOf(repo).durations[key(workflow, job)] ?? []);
  // An announced job often runs at GitHub under a different name (expression, matrix): then all learned jobs of
  // the same workflow that match it count.
  function estimateOf(repo, workflow, defined, matcher) {
    // A call (`uses:`) runs as several jobs, often one after another: the duration of one of them would be too short.
    if (defined.uses) return estimate(repo, workflow, defined.name);
    const prefix = key(workflow, '');
    const durations = Object.entries(memoryOf(repo).durations)
      .filter(([name]) => name.startsWith(prefix) && matcher.test(name.slice(prefix.length)))
      .flatMap(([, values]) => values);
    return estimate(repo, workflow, defined.name) ?? roundedMedian(durations);
  }
  const jobsOfRun = async (repo, id) => (await github.get(`repos/${repo}/actions/runs/${id}/jobs?per_page=${PAGE_MAX}`)).jobs;

  async function workflowOf(repo, run) {
    if (!run.path || !run.head_sha) return null;
    const id = `${repo}@${run.head_sha}:${run.path}`;
    if (!workflows.has(id)) {
      let jobs = null;
      try {
        const content = await github.get(`repos/${repo}/contents/${run.path}?ref=${run.head_sha}`);
        jobs = parseWorkflow(Buffer.from(content.content, 'base64').toString('utf8'));
      } catch (error) {
        // Dynamic run without a file or no access (GitHub replies with 4xx): then without dependencies. 403 and
        // 429 can also just mean "too many requests" and therefore don't count.
        // Everything else (no network, rate limit) is temporary and is tried again next time.
        if (!(error.status >= 400 && error.status < 500) || error.status === 403 || error.status === 429) return null;
      }
      workflows.set(id, jobs);
      if (workflows.size > WORKFLOWS_MAX) workflows.delete(workflows.keys().next().value);
    }
    return workflows.get(id);
  }

  async function learn(repo, run) {
    const memory = memoryOf(repo);
    const good = (await jobsOfRun(repo, run.id)).filter((job) => job.conclusion === 'success' && job.started_at && job.completed_at);
    for (const job of good) {
      const list = (memory.durations[key(run.name, job.name)] ??= []);
      list.push(seconds(job.started_at, job.completed_at));
      if (list.length > KEEP) list.shift();
    }
    // Wait time: from creation of the job until one of our own runners takes it.
    const waits = (memory.waits ??= []);
    for (const job of good) if ((job.labels ?? []).includes('self-hosted') && job.created_at) waits.push(seconds(job.created_at, job.started_at));
    if (waits.length > WAITS_KEEP) waits.splice(0, waits.length - WAITS_KEEP);
    // Which jobs belong to a workflow – a substitute when the workflow file cannot be read.
    // The workflow's name comes from outside: store it as an own property, even if it is called __proto__.
    if (run.conclusion === 'success') Object.defineProperty(memory.jobsOf, String(run.name), { value: good.map((job) => job.name), enumerable: true, writable: true, configurable: true });
    memory.seen.push(run.id);
    if (memory.seen.length > SEEN_MAX) memory.seen.splice(0, memory.seen.length - SEEN_MAX);
  }

  // A run with its jobs as GitHub knows them, plus dependencies and jobs not created yet.
  async function build(repo, run) {
    const memory = memoryOf(repo);
    const definition = await workflowOf(repo, run);
    const jobs = (await jobsOfRun(repo, run.id)).map((job) => {
      const steps = job.steps ?? [];
      const current = steps.find((step) => step.status === 'in_progress');
      const failed = steps.find((step) => step.conclusion === 'failure');
      return {
        id: job.id ?? null, name: job.name, status: job.status, conclusion: job.conclusion, runner: job.runner_name || null, own: (job.labels ?? []).some((label) => String(label).toLowerCase() === 'self-hosted'),
        startedAt: job.started_at, completedAt: job.completed_at, url: job.html_url, estimate: estimate(repo, run.name, job.name), needs: [],
        step: current ? { name: current.name, number: current.number, total: steps.length } : failed ? { name: failed.name, number: failed.number, total: steps.length, failed: true } : null,
      };
    });
    const present = new Map(jobs.map((job) => [job.name, job]));
    const pending = (name, guess = estimate(repo, run.name, name)) => ({ id: null, name, status: 'pending', conclusion: null, runner: null, own: true, startedAt: null, completedAt: null, url: run.html_url, estimate: guess, needs: [], step: null });
    if (definition) {
      // A job of the file can run as several jobs (matrix, call) and be named differently there: see matcherOf.
      // Every real job belongs to at most one job of the file: to the one with exactly that name, otherwise to the one
      // with the longest fixed text – a name made only of an expression matches everything and gets what is left.
      const matchers = new Map(definition.map((defined) => [defined, matcherOf(defined)]));
      const fixed = (defined) => defined.name.replace(EXPRESSION, '').length;
      const vague = (defined) => Number(defined.name !== defined.name.replace(EXPRESSION, ''));
      const found = new Map(definition.map((defined) => [defined, []]));
      for (const job of jobs) {
        // The exact name comes first; otherwise a job without an expression before one with, then the longest fixed text.
        const owner = definition.find((defined) => defined.name === job.name) ?? definition.filter((defined) => matchers.get(defined).test(job.name)).sort((a, b) => vague(a) - vague(b) || fixed(b) - fixed(a))[0];
        if (owner) found.get(owner).push(job);
      }
      const actual = (defined) => found.get(defined);
      const nameOf = new Map(definition.map((defined) => [defined.id, defined]));
      for (const defined of definition) {
        if (actual(defined).length || run.status === 'completed') continue;
        const job = pending(announced(defined), estimateOf(repo, run.name, defined, matchers.get(defined)));
        jobs.push(job);
        present.set(job.name, job);
      }
      for (const defined of definition) {
        const parents = defined.needs.map((id) => nameOf.get(id)).filter(Boolean).flatMap((parent) => { const found = actual(parent); return found.length ? found : [present.get(announced(parent))].filter(Boolean); });
        for (const job of [...actual(defined), present.get(announced(defined))].filter(Boolean)) job.needs = [...new Set(parents.map((parent) => parent.name))].filter((name) => name !== job.name);
      }
    } else if (run.status !== 'completed') {
      for (const name of (Object.hasOwn(memory.jobsOf, run.name) ? memory.jobsOf[run.name] : [])) if (!present.has(name)) jobs.push(pending(name));
    }
    stagesOf(jobs);
    return {
      id: run.id, workflow: run.name, title: run.display_title, branch: run.head_branch, event: run.event, url: run.html_url,
      status: run.status, conclusion: run.conclusion, startedAt: run.run_started_at ?? run.created_at, updatedAt: run.updated_at, graph: Boolean(definition), jobs,
    };
  }

  // `runs`: the repo's latest runs as GitHub returns them (newest first).
  async function refresh(repo, runs) {
    const memory = memoryOf(repo);
    // Dependabot runs have a different name every time and do not repeat.
    const unseen = runs.filter((run) => run.status === 'completed' && run.event !== 'dynamic' && !memory.seen.includes(run.id)).reverse().slice(0, LEARN_PER_ROUND);
    for (const run of unseen) await learn(repo, run);
    if (unseen.length) save();

    const before = new Set((active.get(repo) ?? []).map((pipeline) => pipeline.id));
    const list = [];
    for (const run of runs.filter((r) => r.status !== 'completed').reverse()) list.push(await build(repo, run));
    active.set(repo, list);

    // A run that finished since the last query is read one final time. It need not be the latest completed one
    // (one started earlier ends after a later one); its last job would otherwise never be confirmed.
    // It stays around for a few queries: the slot books a job only once the runner container has ended.
    const recent = (finished.get(repo) ?? []).map((entry) => ({ ...entry, rounds: entry.rounds - 1 })).filter((entry) => entry.rounds > 0);
    for (const run of runs.filter((r) => r.status === 'completed' && before.has(r.id))) recent.push({ rounds: FINISHED_ROUNDS, pipeline: await build(repo, run) });
    finished.set(repo, recent);

    const last = runs.find((run) => run.status === 'completed' && run.event !== 'dynamic');
    const known = latest.get(repo);
    if (last && (known?.id !== last.id || known.updatedAt !== last.updated_at)) {
      const pipeline = recent.find((entry) => entry.pipeline.id === last.id && entry.pipeline.updatedAt === last.updated_at)?.pipeline ?? await build(repo, last);
      latest.set(repo, { id: last.id, updatedAt: last.updated_at, pipeline });
    }
    return list;
  }

  // The running runs with time left; `slots`: slots of the pool that accept jobs.
  function view(repo, slots, now = Date.now()) {
    const fallback = roundedMedian(Object.values(memoryOf(repo).durations).map(roundedMedian).filter((value) => value != null)) ?? FALLBACK_S;
    const list = (active.get(repo) ?? []).map((pipeline) => ({ ...pipeline, rough: false, jobs: pipeline.jobs.map((job) => ({ ...job })) }));
    const usual = (pipeline, job) => { if (job.estimate == null) pipeline.rough = true; return job.estimate ?? fallback; };
    const free = []; // per slot: seconds from now until it is free

    for (const pipeline of list) {
      for (const job of pipeline.jobs) {
        if (job.status === 'completed') { job.finishIn = 0; continue; }
        if (job.status !== 'in_progress') continue;
        const length = usual(pipeline, job);
        job.elapsed = seconds(job.startedAt, now);
        job.finishIn = Math.max(length - job.elapsed, Math.round(length * 0.1));
        if (job.own && free.length < slots) free.push(job.finishIn + TURNAROUND_S);
      }
    }
    while (free.length < slots) free.push(0);
    for (const pipeline of list) {
      const byName = new Map(pipeline.jobs.map((job) => [job.name, job]));
      // Stage by stage; within a stage first what is already waiting for a runner.
      const waiting = pipeline.jobs.filter((job) => job.finishIn === undefined).sort((a, b) => a.stage - b.stage || (a.status === 'pending') - (b.status === 'pending'));
      for (const job of waiting) {
        const length = usual(pipeline, job);
        const parents = job.needs.map((name) => byName.get(name)?.finishIn);
        if (parents.includes(null)) { job.finishIn = null; continue; }
        const ready = Math.max(0, ...parents.filter((value) => value !== undefined));
        if (!job.own) { job.finishIn = ready + length; continue; }
        if (!free.length) { job.finishIn = null; continue; }
        const slot = free.indexOf(Math.min(...free));
        job.finishIn = Math.max(free[slot], ready) + length;
        free[slot] = job.finishIn + TURNAROUND_S;
      }
    }

    const at = (finishIn) => (finishIn == null ? null : new Date(now + finishIn * SECOND).toISOString());
    return list.map((pipeline) => {
      const open = pipeline.jobs.filter((job) => job.status !== 'completed');
      const finishIn = open.some((job) => job.finishIn == null) ? null : Math.max(0, ...open.map((job) => job.finishIn));
      return { ...pipeline, finishAt: at(finishIn), jobs: pipeline.jobs.map((job) => present(job, job.status === 'completed' ? null : at(job.finishIn))) };
    });
  }

  // What the interface needs from a job.
  const present = ({ finishIn, elapsed, ...job }, finishAt) => ({ ...job, finishAt, duration: job.status === 'completed' && job.startedAt && job.completedAt ? seconds(job.startedAt, job.completedAt) : null });

  // The latest completed run – for the view when nothing is running.
  function lastOf(repo) {
    const pipeline = latest.get(repo)?.pipeline;
    return pipeline ? { ...pipeline, finishAt: null, jobs: pipeline.jobs.map((job) => present(job, null)) } : null;
  }

  // The runs completed recently, with their jobs as GitHub last reported them.
  const finishedOf = (repo) => (finished.get(repo) ?? []).map((entry) => entry.pipeline);

  // How long jobs recently waited for one of our own runners (seconds).
  function waitOf(repo) {
    const waits = memoryOf(repo).waits ?? [];
    return waits.length ? { usual: roundedMedian(waits), longest: Math.max(...waits), jobs: waits.length } : null;
  }

  return { refresh, view, lastOf, finishedOf, waitOf };
}

module.exports = { createPipelines, parseWorkflow, stagesOf, matcherOf };
