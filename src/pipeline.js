// Läufe eines Repos als Pipeline: alle Jobs eines laufenden Laufs, ihre übliche Dauer und daraus die Restzeit.
//
// Übliche Dauer: Median der letzten erfolgreichen Durchläufe desselben Jobs (history.json im Datenordner).
// Restzeit: Die offenen Jobs aller laufenden Läufe werden der Reihe nach auf die Plätze des Pools verteilt.
// Abhängigkeiten zwischen Jobs (`needs`) verrät GitHub nicht – die Restzeit ist deshalb eine grobe Schätzung.

const fs = require('node:fs');
const path = require('node:path');

const KEEP = 10; // gemerkte Dauern je Job
const LEARN_PER_ROUND = 5; // abgeschlossene Läufe, die je Abfrage nachgelernt werden
const SEEN_MAX = 300;
const WAITS_KEEP = 50; // gemerkte Wartezeiten je Repo
const TURNAROUND_S = 8; // Wechsel eines Platzes zum nächsten Job

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const seconds = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000));
const waiting = (job) => job.status !== 'completed' && job.status !== 'in_progress';

function createPipelines({ gh, dataDir }) {
  const file = path.join(dataDir, 'history.json');
  let history = {};
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* noch nichts gelernt */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(history)); } catch { /* Gelerntes ist Beiwerk */ } };
  const memoryOf = (repo) => (history[repo] ??= { durations: {}, jobsOf: {}, seen: [] });
  const active = new Map(); // Repo -> laufende Läufe mit ihren Jobs

  const key = (workflow, job) => `${workflow} / ${job}`;
  const estimate = (repo, workflow, job) => median(memoryOf(repo).durations[key(workflow, job)] ?? []);
  const jobsOfRun = async (repo, id) => (await gh(['api', `repos/${repo}/actions/runs/${id}/jobs?per_page=100`])).jobs;

  async function learn(repo, run) {
    const memory = memoryOf(repo);
    const good = (await jobsOfRun(repo, run.id)).filter((job) => job.conclusion === 'success' && job.started_at && job.completed_at);
    for (const job of good) {
      const list = (memory.durations[key(run.name, job.name)] ??= []);
      list.push(seconds(job.started_at, job.completed_at));
      if (list.length > KEEP) list.shift();
    }
    // Wartezeit: vom Anlegen des Jobs bis ein eigener Runner ihn nimmt.
    const waits = (memory.waits ??= []);
    for (const job of good) if ((job.labels ?? []).includes('self-hosted') && job.created_at) waits.push(seconds(job.created_at, job.started_at));
    if (waits.length > WAITS_KEEP) waits.splice(0, waits.length - WAITS_KEEP);
    // Welche Jobs zu einem Workflow gehören: So lassen sich Jobs ankündigen, die GitHub erst später anlegt.
    if (run.conclusion === 'success') memory.jobsOf[run.name] = good.map((job) => job.name);
    memory.seen.push(run.id);
    if (memory.seen.length > SEEN_MAX) memory.seen.splice(0, memory.seen.length - SEEN_MAX);
  }

  // `runs`: die jüngsten Läufe des Repos, wie GitHub sie liefert (neueste zuerst).
  async function refresh(repo, runs) {
    const memory = memoryOf(repo);
    // Läufe von Dependabot heißen jedes Mal anders und wiederholen sich nicht.
    const unseen = runs.filter((run) => run.status === 'completed' && run.event !== 'dynamic' && !memory.seen.includes(run.id)).reverse().slice(0, LEARN_PER_ROUND);
    for (const run of unseen) await learn(repo, run);
    if (unseen.length) save();

    const list = [];
    for (const run of runs.filter((r) => r.status !== 'completed').reverse()) {
      const jobs = (await jobsOfRun(repo, run.id)).map((job) => {
        const steps = job.steps ?? [];
        const current = steps.find((step) => step.status === 'in_progress');
        return {
          name: job.name, status: job.status, conclusion: job.conclusion, runner: job.runner_name || null, own: (job.labels ?? []).includes('self-hosted'),
          startedAt: job.started_at, completedAt: job.completed_at, url: job.html_url, estimate: estimate(repo, run.name, job.name),
          step: current ? { name: current.name, number: current.number, total: steps.length } : null,
        };
      });
      const present = new Set(jobs.map((job) => job.name));
      for (const name of memory.jobsOf[run.name] ?? []) {
        if (!present.has(name)) jobs.push({ name, status: 'pending', conclusion: null, runner: null, own: true, startedAt: null, completedAt: null, url: run.html_url, estimate: estimate(repo, run.name, name), step: null });
      }
      list.push({ id: run.id, workflow: run.name, title: run.display_title, branch: run.head_branch, event: run.event, url: run.html_url, startedAt: run.run_started_at ?? run.created_at, jobs });
    }
    active.set(repo, list);
    return list;
  }

  // Die laufenden Läufe mit Restzeit; `slots`: Plätze des Pools, die Jobs annehmen.
  function view(repo, slots, now = Date.now()) {
    const fallback = median(Object.values(memoryOf(repo).durations).map(median).filter((value) => value != null)) ?? 60;
    const list = (active.get(repo) ?? []).map((pipeline) => ({ ...pipeline, rough: false, jobs: pipeline.jobs.map((job) => ({ ...job })) }));
    const usual = (pipeline, job) => { if (job.estimate == null) pipeline.rough = true; return job.estimate ?? fallback; };
    const free = []; // je Platz: Sekunden ab jetzt, bis er frei wird

    for (const pipeline of list) {
      for (const job of pipeline.jobs) {
        if (job.status === 'completed') { job.finishIn = 0; job.duration = job.startedAt && job.completedAt ? seconds(job.startedAt, job.completedAt) : null; continue; }
        if (job.status !== 'in_progress') continue;
        const length = usual(pipeline, job);
        job.elapsed = seconds(job.startedAt, now);
        job.finishIn = Math.max(length - job.elapsed, Math.round(length * 0.1));
        if (job.own && free.length < slots) free.push(job.finishIn + TURNAROUND_S);
      }
    }
    while (free.length < slots) free.push(0);
    for (const pipeline of list) {
      // Erst was schon auf einen Runner wartet, dann was GitHub noch nicht angelegt hat.
      for (const job of [...pipeline.jobs.filter((j) => waiting(j) && j.status !== 'pending'), ...pipeline.jobs.filter((j) => j.status === 'pending')]) {
        const length = usual(pipeline, job);
        if (!job.own) { job.finishIn = length; continue; }
        if (!free.length) { job.finishIn = null; continue; }
        const slot = free.indexOf(Math.min(...free));
        job.finishIn = free[slot] + length;
        free[slot] = job.finishIn + TURNAROUND_S;
      }
    }

    const at = (finishIn) => (finishIn == null ? null : new Date(now + finishIn * 1000).toISOString());
    return list.map((pipeline) => {
      const open = pipeline.jobs.filter((job) => job.status !== 'completed');
      const finishIn = open.some((job) => job.finishIn == null) ? null : Math.max(0, ...open.map((job) => job.finishIn));
      let total = 0;
      let done = 0;
      for (const job of pipeline.jobs) {
        const length = job.status === 'completed' ? (job.duration ?? 0) : (job.estimate ?? fallback);
        total += length;
        if (job.status === 'completed') done += length;
        else if (job.status === 'in_progress') done += Math.min(job.elapsed, length * 0.95);
      }
      return {
        ...pipeline, finishAt: at(finishIn), progress: total ? done / total : 0,
        jobs: pipeline.jobs.map(({ finishIn: jobFinish, own, elapsed, ...job }) => ({ ...job, finishAt: job.status === 'completed' ? null : at(jobFinish) })),
      };
    });
  }

  // Wie lange Jobs zuletzt auf einen eigenen Runner gewartet haben (Sekunden).
  function waitOf(repo) {
    const waits = memoryOf(repo).waits ?? [];
    return waits.length ? { usual: median(waits), longest: Math.max(...waits), jobs: waits.length } : null;
  }

  return { refresh, view, waitOf };
}

module.exports = { createPipelines };
