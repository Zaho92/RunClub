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
function suggest(jobs, range) {
  const measured = jobs.filter((job) => job.peakMemory > 0);
  if (measured.reduce((sum, job) => sum + job.runs, 0) < SUGGEST_RUNS) return null;
  const peak = (field) => Math.max(0, ...measured.map((job) => job[field] ?? 0));
  const memory = (bytes) => Math.min(range.memory.max, Math.max(range.memory.min, Math.ceil(bytes * 1.5 / GB * 2) / 2));
  // Die Kerne sind nur zusammen gemessen: Runner und Docker bekommen dieselbe Zahl.
  const cpus = Math.min(range.cpus.max, Math.max(2, Math.ceil(peak('peakCpu'))));
  return { runnerMemory: memory(peak('peakRunner')), dockerMemory: memory(peak('peakDocker')), runnerCpus: cpus, dockerCpus: cpus };
}

module.exports = { bytesOf, memoryText, bounds, view, normalize, suggest, GB };
