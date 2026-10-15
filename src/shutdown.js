// Der Stand beim Beenden von RunClub, wie die Oberfläche ihn zeigt (`shutdown` in /api/status): je Projekt, wie viele
// Runner schon abgebaut sind und ob dort gerade ein Job abgebrochen wird, danach die Stufen Aufräumen (Build-Dienste,
// Netze, Volumes) und Abmelden (bei GitHub). Am Ende wird die Dauer jeder Stufe im Datenordner abgelegt; das nächste
// Beenden schätzt damit, wann es fertig ist.
//
// Gefüttert wird der Stand aus lifecycle.js (`begin`, `finish`) und dockerwatch.js (`step` beim Abräumen der Reste).
// Was je Projekt noch steht, fragt `view` bei jedem Aufruf neu ab; abgebaut ist ein Projekt, sobald dort nichts mehr steht.

const path = require('node:path');
const { readJson, writeJson } = require('./store');
const { SECOND } = require('./units');

const FILE = 'shutdown.json';
const STAGES = ['dismantle', 'cleanup', 'signoff'];

// Die gespeicherte Dauer taugt nur, wenn jede Stufe eine Zahl hat.
const durationsFrom = (data) => (data && STAGES.every((stage) => Number.isFinite(data[stage]) && data[stage] >= 0) ? data : null);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

//   dataDir
//   repos()                 die Repos mit Pool
//   remaining(repo)         was dort noch steht: `{ pairs, job }` (siehe `remaining` in pools.js), ohne Pool null
//   wait                    so lange wartet der Abbau höchstens auf Paare, die gerade entstehen (ms)
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

  // Ein Projekt ist abgebaut, sobald dort nichts mehr steht; spätestens mit dem Ende der Stufe, denn was dann noch
  // steht, räumt das Aufräumen ab.
  function settle(at) {
    for (const project of state.projects) {
      if (project.endedAt) continue;
      const left = remaining(project.repo);
      project.total = Math.max(project.total, left?.pairs ?? 0); // ein Paar, das eben erst entstand
      if (!left?.pairs || state.stages.dismantle.endedAt) project.endedAt = at;
    }
  }

  function enter(stage, at) {
    const index = STAGES.indexOf(stage);
    for (const before of STAGES.slice(0, index)) { state.stages[before].startedAt ??= at; state.stages[before].endedAt ??= at; }
    state.stages[stage].startedAt ??= at;
  }

  // Aus dockerwatch.js: `cleanup` vor den Build-Diensten, `signoff` mit der Zahl der Repos vor dem Abmelden bei GitHub,
  // `signedOff` nach jedem Repo.
  function step(name, count) {
    if (!state) return;
    const at = now();
    if (name === 'signedOff') { state.stages.signoff.done += 1; return; }
    enter(name, at);
    settle(at);
    if (name === 'signoff') state.stages.signoff.total = count ?? 0;
  }

  // Die Dauer der Stufen ablegen. Scheitert das, schätzt das nächste Beenden eben nicht: Beenden geht vor.
  function finish() {
    if (!state) return;
    const at = now();
    enter('signoff', at);
    state.stages.signoff.endedAt ??= at;
    settle(at);
    const durations = Object.fromEntries(STAGES.map((stage) => [stage, state.stages[stage].endedAt - state.stages[stage].startedAt]));
    try { writeJson(file, durations); } catch { /* siehe oben */ }
  }

  // Wie lange es nach der Dauer des letzten Beendens noch dauern dürfte: Was eine laufende Stufe schon gebraucht hat,
  // geht von ihrer Schätzung ab, aber nicht unter null; die wartenden zählen ganz.
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

  // null, solange RunClub nicht endet. `finishAt`: das geschätzte Ende; null ohne gespeicherte Dauer und wenn die
  // Schätzung schon überschritten ist (dann `over`). `last`: wie lange das letzte Beenden dauerte, `wait` wie oben
  // (beides Sekunden).
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
