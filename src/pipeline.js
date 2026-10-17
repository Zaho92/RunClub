// Läufe eines Repos als Pipeline: alle Jobs eines Laufs, ihre Abhängigkeiten, ihre übliche Dauer und daraus die Restzeit.
//
// Abhängigkeiten  stehen als `needs:` in der Workflow-Datei des Laufs; sie wird einmal je Commit gelesen.
//                 Daraus ergeben sich auch die Jobs, die GitHub erst später anlegt.
// Übliche Dauer   Median der letzten erfolgreichen Durchläufe desselben Jobs (history.json im Datenordner).
// Restzeit        Die offenen Jobs aller laufenden Läufe werden in der Reihenfolge ihrer Abhängigkeiten auf die
//                 Plätze des Pools verteilt. Das bleibt eine Schätzung.

const path = require('node:path');
const { median } = require('./numbers');
const { readJson, writeJson } = require('./store');
const { SECOND } = require('./units');
const { PAGE_MAX } = require('./github');

const KEEP = 10; // gemerkte Dauern je Job
const LEARN_PER_ROUND = 5; // abgeschlossene Läufe, die je Abfrage nachgelernt werden
const SEEN_MAX = 300;
const WAITS_KEEP = 50; // gemerkte Wartezeiten je Repo
const WORKFLOWS_MAX = 40; // gemerkte Workflow-Dateien
const TURNAROUND_S = 8; // Wechsel eines Platzes zum nächsten Job
const FALLBACK_S = 60; // übliche Dauer eines Jobs, solange das Repo noch keinen gelernt hat
const FINISHED_ROUNDS = 6; // so viele Abfragen lang bleibt ein eben beendeter Lauf zum Bestätigen der Ergebnisse da

// Sekunden bleiben ganze Zahlen.
const roundedMedian = (values) => { const middle = median(values); return middle === null ? null : Math.round(middle); };
const seconds = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / SECOND));
const unquote = (text) => text.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');

// Liest aus einer Workflow-Datei je Job seinen angezeigten Namen und seine Abhängigkeiten.
// Kein vollständiges YAML: Es genügt der Block `jobs:` mit `name:` und `needs:` in den üblichen Schreibweisen.
// `uses: true` bekommt ein Job, der einen anderen Workflow aufruft.
function parseWorkflow(text) {
  const jobs = [];
  let inJobs = false;
  let indent = null; // Einrückung der Job-Schlüssel
  let job = null;
  let needsIndent = null; // gesetzt, solange eine Liste unter `needs:` läuft
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
    if (depth !== job.depth) continue; // tiefer als die Eigenschaften des Jobs (Schritte, Matrix …)
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

// Unter welchen Namen ein Job der Datei bei GitHub läuft. Der Name aus der Datei steht immer vollständig am Anfang,
// danach ist nur erlaubt, was GitHub selbst anhängt – „Test“ trifft deshalb nicht „Tests bauen“:
//   Ausdruck im Namen   `Test ${{ matrix.os }}` → „Test ubuntu-latest“: Der Ausdruck steht für beliebigen Text, auch
//                       für keinen („Test“). Das Leerzeichen daneben bleibt Pflicht, sobald er etwas ergibt.
//   Matrix              „Name (Wert, Wert)“
//   Aufruf (`uses:`)    „Name / innerer Job“, mit Matrix „Name (Wert) / innerer Job“. Nur für solche Jobs, denn
//                       sonst träfe „Build“ einen fremden Job, der „Build / Docker“ heißt. Aus demselben Grund trifft
//                       `Test ${{ matrix.os }}` keinen fremden „Test / Docker“.
const EXPRESSION = /\$\{\{.*?\}\}/g;
const EXPRESSIONS_MAX = 3; // mehr Ausdrücke in einem Jobnamen werden nicht mehr als Muster gelesen
const CALL = ' / '; // so trennt GitHub den aufrufenden vom aufgerufenen Job
function matcherOf(defined) {
  // Jeder Ausdruck steht für beliebigen Text. Mehrere davon machen das Prüfen eines langen Jobnamens beliebig teuer;
  // Ausdrücke direkt hintereinander zählen deshalb als einer, und mit mehr als EXPRESSIONS_MAX gilt nur der genaue Name.
  const parts = defined.name.split(EXPRESSION).filter((part, index, all) => part || index === 0 || index === all.length - 1);
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Ein Ausdruck samt den Leerzeichen, die ihn vom festen Text trennen: Ergibt er nichts, fallen sie mit ihm weg.
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
  const called = !defined.uses && !defined.name.includes(CALL); // ein „ / “ im Namen gehört dann zu einem fremden Aufruf
  return { test: (job) => pattern.test(job) && !(called && job.includes(CALL)) };
}

// Wie ein angekündigter Job heißt, solange GitHub seinen Namen noch nicht ausgewertet hat: „Test …“.
const announced = (defined) => defined.name.replace(EXPRESSION, '…');

// Ordnet Jobs nach ihren Abhängigkeiten in Stufen: 0 hat keine, sonst eine mehr als die tiefste Abhängigkeit.
function stagesOf(jobs) {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const depth = (job, seen = new Set()) => {
    if (job.stage !== undefined) return job.stage;
    if (seen.has(job.name)) return 0; // Kreis: gibt es in gültigen Workflows nicht
    seen.add(job.name);
    const parents = job.needs.map((name) => byName.get(name)).filter(Boolean);
    job.stage = parents.length ? 1 + Math.max(...parents.map((parent) => depth(parent, seen))) : 0;
    return job.stage;
  };
  jobs.forEach((job) => depth(job));
}

function createPipelines({ github, dataDir }) {
  const file = path.join(dataDir, 'history.json');
  const read = readJson(file, {}).data; // eine beschädigte Datei bleibt als Kopie liegen
  const history = read && typeof read === 'object' && !Array.isArray(read) ? read : {};
  const save = () => { try { writeJson(file, history, { compact: true }); } catch { /* Gelerntes ist Beiwerk */ } };
  const memoryOf = (repo) => (history[repo] ??= { durations: {}, jobsOf: {}, seen: [] });
  const active = new Map(); // Repo -> laufende Läufe mit ihren Jobs
  const latest = new Map(); // Repo -> { id, updatedAt, pipeline } des jüngsten abgeschlossenen Laufs
  const finished = new Map(); // Repo -> [{ rounds, pipeline }] der Läufe, die seit kurzem abgeschlossen sind
  const workflows = new Map(); // "Repo@Commit:Pfad" -> Jobs der Workflow-Datei oder null

  const key = (workflow, job) => `${workflow} / ${job}`;
  const estimate = (repo, workflow, job) => roundedMedian(memoryOf(repo).durations[key(workflow, job)] ?? []);
  // Ein angekündigter Job läuft bei GitHub oft unter anderem Namen (Ausdruck, Matrix): dann zählen alle gelernten Jobs
  // desselben Workflows, die zu ihm passen.
  function estimateOf(repo, workflow, defined, matcher) {
    // Ein Aufruf (`uses:`) läuft als mehrere Jobs, oft nacheinander: Die Dauer eines davon wäre zu kurz geschätzt.
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
        // Dynamischer Lauf ohne Datei oder kein Zugriff (GitHub antwortet mit 4xx): dann ohne Abhängigkeiten. 403 und
        // 429 können auch nur „zu viele Anfragen“ heißen und zählen deshalb nicht dazu.
        // Alles andere (kein Netz, Anfragelimit) ist vorübergehend und wird beim nächsten Mal neu versucht.
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
    // Wartezeit: vom Anlegen des Jobs bis ein eigener Runner ihn nimmt.
    const waits = (memory.waits ??= []);
    for (const job of good) if ((job.labels ?? []).includes('self-hosted') && job.created_at) waits.push(seconds(job.created_at, job.started_at));
    if (waits.length > WAITS_KEEP) waits.splice(0, waits.length - WAITS_KEEP);
    // Welche Jobs zu einem Workflow gehören – Ersatz, wenn sich die Workflow-Datei nicht lesen lässt.
    // Der Name des Workflows kommt von außen: als eigene Eigenschaft ablegen, auch wenn er __proto__ heißt.
    if (run.conclusion === 'success') Object.defineProperty(memory.jobsOf, String(run.name), { value: good.map((job) => job.name), enumerable: true, writable: true, configurable: true });
    memory.seen.push(run.id);
    if (memory.seen.length > SEEN_MAX) memory.seen.splice(0, memory.seen.length - SEEN_MAX);
  }

  // Ein Lauf mit seinen Jobs, wie GitHub sie kennt, ergänzt um Abhängigkeiten und noch nicht angelegte Jobs.
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
      // Ein Job der Datei kann als mehrere Jobs laufen (Matrix, Aufruf) und dort anders heißen: siehe matcherOf.
      // Jeder echte Job gehört zu höchstens einem Job der Datei: zu dem, der genau so heißt, sonst zu dem mit dem
      // längsten festen Text – ein Name nur aus einem Ausdruck passt auf alles und bekommt, was übrig bleibt.
      const matchers = new Map(definition.map((defined) => [defined, matcherOf(defined)]));
      const fixed = (defined) => defined.name.replace(EXPRESSION, '').length;
      const vague = (defined) => Number(defined.name !== defined.name.replace(EXPRESSION, ''));
      const found = new Map(definition.map((defined) => [defined, []]));
      for (const job of jobs) {
        // Der genaue Name geht vor; sonst ein Job ohne Ausdruck vor einem mit, dann der mit dem längsten festen Text.
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

  // `runs`: die jüngsten Läufe des Repos, wie GitHub sie liefert (neueste zuerst).
  async function refresh(repo, runs) {
    const memory = memoryOf(repo);
    // Läufe von Dependabot heißen jedes Mal anders und wiederholen sich nicht.
    const unseen = runs.filter((run) => run.status === 'completed' && run.event !== 'dynamic' && !memory.seen.includes(run.id)).reverse().slice(0, LEARN_PER_ROUND);
    for (const run of unseen) await learn(repo, run);
    if (unseen.length) save();

    const before = new Set((active.get(repo) ?? []).map((pipeline) => pipeline.id));
    const list = [];
    for (const run of runs.filter((r) => r.status !== 'completed').reverse()) list.push(await build(repo, run));
    active.set(repo, list);

    // Ein Lauf, der seit der letzten Abfrage fertig wurde, wird einmal abschließend gelesen. Er muss nicht der jüngste
    // abgeschlossene sein (ein früher gestarteter endet nach einem späteren); sein letzter Job wäre sonst nie bestätigt.
    // Er bleibt einige Abfragen lang da: Der Platz verbucht einen Job erst, wenn der Runner-Container geendet hat.
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

  // Die laufenden Läufe mit Restzeit; `slots`: Plätze des Pools, die Jobs annehmen.
  function view(repo, slots, now = Date.now()) {
    const fallback = roundedMedian(Object.values(memoryOf(repo).durations).map(roundedMedian).filter((value) => value != null)) ?? FALLBACK_S;
    const list = (active.get(repo) ?? []).map((pipeline) => ({ ...pipeline, rough: false, jobs: pipeline.jobs.map((job) => ({ ...job })) }));
    const usual = (pipeline, job) => { if (job.estimate == null) pipeline.rough = true; return job.estimate ?? fallback; };
    const free = []; // je Platz: Sekunden ab jetzt, bis er frei wird

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
      // Stufe für Stufe; innerhalb einer Stufe erst, was schon auf einen Runner wartet.
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

  // Was die Oberfläche von einem Job braucht.
  const present = ({ finishIn, elapsed, ...job }, finishAt) => ({ ...job, finishAt, duration: job.status === 'completed' && job.startedAt && job.completedAt ? seconds(job.startedAt, job.completedAt) : null });

  // Der jüngste abgeschlossene Lauf – für die Ansicht, wenn gerade nichts läuft.
  function lastOf(repo) {
    const pipeline = latest.get(repo)?.pipeline;
    return pipeline ? { ...pipeline, finishAt: null, jobs: pipeline.jobs.map((job) => present(job, null)) } : null;
  }

  // Die Läufe, die seit kurzem abgeschlossen sind, mit ihren Jobs wie GitHub sie zuletzt meldete.
  const finishedOf = (repo) => (finished.get(repo) ?? []).map((entry) => entry.pipeline);

  // Wie lange Jobs zuletzt auf einen eigenen Runner gewartet haben (Sekunden).
  function waitOf(repo) {
    const waits = memoryOf(repo).waits ?? [];
    return waits.length ? { usual: roundedMedian(waits), longest: Math.max(...waits), jobs: waits.length } : null;
  }

  return { refresh, view, lastOf, finishedOf, waitOf };
}

module.exports = { createPipelines, parseWorkflow, stagesOf, matcherOf };
