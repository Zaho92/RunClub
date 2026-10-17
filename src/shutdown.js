// The state while RunClub shuts down, as the interface shows it (`shutdown` in /api/status): per project, how many
// runners are already dismantled and whether a job is being cancelled there right now, then the stages cleanup (build services,
// networks, volumes) and sign-off (at GitHub). At the end the duration of each stage is stored in the data folder; the next
// shutdown uses it to estimate when it will be done.
//
// The state is fed from lifecycle.js (`begin`, `finish`) and dockerwatch.js (`step` while clearing the leftovers).
// What is still standing per project, `view` asks anew on every call; a project is dismantled once nothing stands there anymore.

const path = require('node:path');
const { readJson, writeJson } = require('./store');
const { SECOND } = require('./units');

const FILE = 'shutdown.json';
const STAGES = ['dismantle', 'cleanup', 'signoff'];

// The stored duration is only usable if every stage has a number.
const durationsFrom = (data) => (data && STAGES.every((stage) => Number.isFinite(data[stage]) && data[stage] >= 0) ? data : null);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

//   dataDir
//   repos()                 the repos with a pool
//   remaining(repo)         what is still standing there: `{ pairs, job }` (see `remaining` in pools.js), null without a pool
//   wait                    at most this long the dismantling waits for pairs that are just being created (ms)
//   now()
function createShutdown({ dataDir, repos, remaining, wait, now = Date.now }) {
  const file = path.join(dataDir, FILE);
  let state = null;

  function begin() {
    if (state) return;
    const at = now();
    const projects = repos().map((repo) => ({ repo, total: remaining(repo)?.pairs ?? 0, endedAt: null }));
    state = {
      startedAt: at, last: durationsFrom(readJson(file, null).data), projects,
      stages: { dismantle: { startedAt: at, endedAt: null }, cleanup: { startedAt: null, endedAt: null }, signoff: { startedAt: null, endedAt: null, total: 0, done: 0 } },
    };
  }

  // A project is dismantled once nothing stands there anymore; at the latest when the stage ends, since what is still
  // standing then is cleared by the cleanup.
  function settle(at) {
    for (const project of state.projects) {
      if (project.endedAt) continue;
      const left = remaining(project.repo);
      project.total = Math.max(project.total, left?.pairs ?? 0); // a pair that was only just created
      if (!left?.pairs || state.stages.dismantle.endedAt) project.endedAt = at;
    }
  }

  function enter(stage, at) {
    const index = STAGES.indexOf(stage);
    for (const before of STAGES.slice(0, index)) { state.stages[before].startedAt ??= at; state.stages[before].endedAt ??= at; }
    state.stages[stage].startedAt ??= at;
  }

  // From dockerwatch.js: `cleanup` before the build services, `signoff` with the number of repos before signing off at GitHub,
  // `signedOff` after each repo.
  function step(name, count) {
    if (!state) return;
    const at = now();
    if (name === 'signedOff') { state.stages.signoff.done += 1; return; }
    enter(name, at);
    settle(at);
    if (name === 'signoff') state.stages.signoff.total = count ?? 0;
  }

  // Store the duration of the stages. If that fails, the next shutdown simply does not estimate: shutting down comes first.
  function finish() {
    if (!state) return;
    const at = now();
    enter('signoff', at);
    state.stages.signoff.endedAt ??= at;
    settle(at);
    const durations = Object.fromEntries(STAGES.map((stage) => [stage, state.stages[stage].endedAt - state.stages[stage].startedAt]));
    try { writeJson(file, durations); } catch { /* see above */ }
  }

  // How long it should still take going by the duration of the last shutdown: what a running stage has already taken
  // comes off its estimate, but not below zero; the waiting ones count fully.
  function left(at) {
    const { last, stages } = state;
    return STAGES.reduce((sum, stage) => {
      const { startedAt, endedAt } = stages[stage];
      if (endedAt) return sum;
      return sum + (startedAt ? Math.max(0, last[stage] - (at - startedAt)) : last[stage]);
    }, 0);
  }

  function stageView(stage) {
    const { startedAt, endedAt } = state.stages[stage];
    return {
      state: endedAt ? 'done' : startedAt ? 'run' : 'wait', startedAt: iso(startedAt), endedAt: iso(endedAt),
      estimate: state.last ? Math.max(1, Math.round(state.last[stage] / SECOND)) : null,
      ...(stage === 'signoff' ? { total: state.stages.signoff.total || state.projects.length, done: state.stages.signoff.done } : {}),
    };
  }

  // null as long as RunClub is not shutting down. `finishAt`: the estimated end; null without a stored duration and when the
  // estimate is already exceeded (then `over`). `last`: how long the last shutdown took, `wait` as above
  // (both in seconds).
  function view() {
    if (!state) return null;
    const at = now();
    if (!state.stages.dismantle.endedAt) settle(at);
    return {
      startedAt: iso(state.startedAt),
      finishAt: state.last && left(at) >= SECOND ? iso(at + left(at)) : null,
      over: Boolean(state.last) && left(at) < SECOND,
      last: state.last ? Math.round(STAGES.reduce((sum, stage) => sum + state.last[stage], 0) / SECOND) : null,
      wait: Math.round(wait / SECOND),
      projects: state.projects.map(({ repo, total, endedAt }) => {
        const standing = endedAt ? null : remaining(repo);
        return { repo, total, removed: endedAt ? total : Math.max(0, total - (standing?.pairs ?? 0)), job: standing?.job ?? null, endedAt: iso(endedAt) };
      }),
      cleanup: stageView('cleanup'),
      signoff: stageView('signoff'),
    };
  }

  return { begin, step, finish, view };
}

module.exports = { createShutdown, FILE };
