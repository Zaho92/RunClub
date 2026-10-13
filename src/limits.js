// Limits je Job: wie viel Arbeitsspeicher und wie viele Kerne der Runner und sein Docker-Daemon bekommen.
// In `runners.json` stehen sie, wie Docker sie liest (`4g`, `1536m`); die Oberfläche rechnet in GB und Kernen.

const GB = 1073741824;

const bytesOf = (text) => {
  const match = String(text ?? '').trim().match(/^([\d.]+)\s*([gmk]?)b?$/i);
  if (!match) return 0;
  const unit = match[2].toLowerCase();
  return Math.round(Number(match[1]) * (unit === 'g' ? GB : unit === 'm' ? 1048576 : unit === 'k' ? 1024 : 1));
};
const memoryText = (gb) => (Number.isInteger(gb) ? `${gb}g` : `${Math.round(gb * 1024)}m`);

// Was sich einstellen lässt, hängt an der Docker-VM: mehr als sie hat, kann kein Job bekommen.
function bounds({ dockerMemory, dockerCpus }) {
  return {
    memory: { min: 1, max: Math.min(32, Math.max(2, Math.floor((dockerMemory || 0) / GB))), step: 0.5 },
    cpus: { min: 1, max: Math.max(1, Math.floor(dockerCpus || 1)), step: 1 },
  };
}

// Die Limits als Zahlen: Speicher in GB, Kerne als Anzahl.
const view = (limits) => ({
  runnerMemory: bytesOf(limits.runnerMemory) / GB, dockerMemory: bytesOf(limits.dockerMemory) / GB,
  runnerCpus: Number(limits.runnerCpus), dockerCpus: Number(limits.dockerCpus),
});

// Übernimmt neue Werte (Speicher in GB, Kerne als Anzahl) in die Schreibweise der Einstellungen.
// Was fehlt, bleibt; was außerhalb der Grenzen liegt, wird an die Grenze gesetzt.
function normalize(input, current, range) {
  const now = view(current);
  const pick = (key, { min, max, step }) => {
    if (input?.[key] === undefined || input[key] === null || input[key] === '') return now[key];
    const value = Number(input[key]);
    if (!Number.isFinite(value)) throw new Error('Limits werden als Zahlen angegeben.');
    return Math.min(max, Math.max(min, Math.round(value / step) * step));
  };
  return {
    runnerCpus: pick('runnerCpus', range.cpus), runnerMemory: memoryText(pick('runnerMemory', range.memory)),
    dockerCpus: pick('dockerCpus', range.cpus), dockerMemory: memoryText(pick('dockerMemory', range.memory)),
  };
}

// Vorschlag aus den Messwerten: die höchste gemessene Spitze mit 50 % Luft, auf halbe GB gerundet.
// `jobs`: Zeilen aus `metrics.jobsView` aller Repos. Ohne genug Durchläufe gibt es keinen Vorschlag.
const SUGGEST_RUNS = 5;
const runsOf = (jobs) => jobs.filter((job) => job.peakMemory > 0).reduce((sum, job) => sum + job.runs, 0);
function suggest(jobs, range) {
  const measured = jobs.filter((job) => job.peakMemory > 0);
  if (runsOf(jobs) < SUGGEST_RUNS) return null;
  const peak = (field) => Math.max(0, ...measured.map((job) => job[field] ?? 0));
  const memory = (bytes) => Math.min(range.memory.max, Math.max(range.memory.min, Math.ceil(bytes * 1.5 / GB * 2) / 2));
  // Die Kerne sind nur zusammen gemessen: Runner und Docker bekommen dieselbe Zahl.
  const cpus = Math.min(range.cpus.max, Math.max(2, Math.ceil(peak('peakCpu'))));
  return { runnerMemory: memory(peak('peakRunner')), dockerMemory: memory(peak('peakDocker')), runnerCpus: cpus, dockerCpus: cpus };
}

// Was für ein Projekt gilt: seine eigenen Limits, sonst die für alle.
const effective = (shared, own) => ({ ...shared, ...(own ?? {}) });
// Kennung eines Satzes von Limits: Daran ist zu erkennen, ob ein Paar noch mit anderen gebaut wurde.
const key = (limits) => [limits.runnerCpus, bytesOf(limits.runnerMemory), limits.dockerCpus, bytesOf(limits.dockerMemory)].join('/');

// Ein Vorschlag für alle Projekte zusammen: ein Standard, der die Projekte mit ähnlichem Bedarf deckt, und eigene
// Limits nur für Ausreißer. Ein Durchschnitt taugt dafür nicht – ein Limit unter dem Bedarf bricht den Job ab.
// Ausreißer ist, wer deutlich mehr Speicher braucht als das mittlere Projekt: über das Anderthalbfache und
// mindestens 1 GB mehr. `projects`: [{ repo, jobs }] mit Zeilen aus `metrics.jobsView`.
const OUTLIER_FACTOR = 1.5;
const OUTLIER_GB = 1;
function plan(projects, range) {
  const needs = projects.map((project) => ({ repo: project.repo, need: suggest(project.jobs, range) })).filter((entry) => entry.need);
  if (!needs.length) return null;
  const memory = (need) => need.runnerMemory + need.dockerMemory;
  const sorted = needs.map((entry) => memory(entry.need)).sort((a, b) => a - b);
  const middle = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const outlier = (entry) => memory(entry.need) > middle * OUTLIER_FACTOR && memory(entry.need) - middle >= OUTLIER_GB;
  const usual = needs.filter((entry) => !outlier(entry));
  const most = (field) => Math.max(...usual.map((entry) => entry.need[field]));
  return {
    shared: { runnerMemory: most('runnerMemory'), dockerMemory: most('dockerMemory'), runnerCpus: most('runnerCpus'), dockerCpus: most('dockerCpus') },
    own: Object.fromEntries(needs.filter(outlier).map((entry) => [entry.repo, entry.need])),
  };
}

// Wie gut die geltenden Limits (`values`, Speicher in GB) zu einem Projekt passen:
//   'full'       eine Spitze hat das Limit ausgeschöpft – der Job braucht mehr
//   'tight'      eine Spitze kam ihm nahe (über 85 %); das zählt schon nach einem einzigen Lauf
//   'generous'   das Limit ist mehr als doppelt so hoch wie der Bedarf (erst mit genug Läufen)
//   'measuring'  noch zu wenige Läufe für ein Urteil
//   'ok'
const TIGHT = 0.85;
const FULL = 0.97;
function rate(jobs, values, range) {
  const runs = runsOf(jobs);
  const share = Math.max(0, ...jobs.map((job) => Math.max((job.peakRunner ?? 0) / (values.runnerMemory * GB), (job.peakDocker ?? 0) / (values.dockerMemory * GB))));
  if (share >= FULL) return { state: 'full', runs };
  if (share > TIGHT) return { state: 'tight', runs };
  const need = suggest(jobs, range);
  if (!need) return { state: 'measuring', runs };
  return { state: values.runnerMemory + values.dockerMemory > 2 * (need.runnerMemory + need.dockerMemory) ? 'generous' : 'ok', runs };
}

const sameValues = (a, b) => ['runnerMemory', 'dockerMemory', 'runnerCpus', 'dockerCpus'].every((field) => a?.[field] === b?.[field]);

module.exports = { bytesOf, memoryText, bounds, view, normalize, suggest, plan, rate, sameValues, effective, key, SUGGEST_RUNS, GB };
