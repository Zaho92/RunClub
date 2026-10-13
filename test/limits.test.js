const test = require('node:test');
const assert = require('node:assert/strict');
const { bytesOf, memoryText, bounds, view, normalize, suggest, plan, planApplied, rate, sameValues, effective, key } = require('../src/limits');
const { GB } = require('../src/units');

const range = bounds({ dockerMemory: 9.7 * GB, dockerCpus: 12 });
const current = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' };

test('liest und schreibt Speicher, wie Docker ihn versteht', () => {
  assert.equal(bytesOf('4g'), 4 * GB);
  assert.equal(bytesOf('1536m'), 1.5 * GB);
  assert.equal(bytesOf('4 GB'), 4 * GB);
  assert.equal(bytesOf('unsinn'), 0);
  assert.equal(bytesOf('1.5.2g'), 0);
  assert.equal(memoryText(4), '4g');
  assert.equal(memoryText(1.5), '1536m');
  assert.deepEqual(view({ runnerCpus: 6, runnerMemory: '1536m', dockerCpus: 4, dockerMemory: '2g' }), { runnerMemory: 1.5, dockerMemory: 2, runnerCpus: 6, dockerCpus: 4 });
});

test('die Grenzen folgen der Docker-VM', () => {
  assert.deepEqual(range, { memory: { min: 1, max: 9, step: 0.5, total: 8.5 }, cpus: { min: 1, max: 12, step: 1 } });
  assert.deepEqual(bounds({ dockerMemory: 0, dockerCpus: 0 }), { memory: { min: 1, max: 2, step: 0.5, total: 2 }, cpus: { min: 1, max: 1, step: 1 } });
});

test('übernimmt neue Werte, rundet auf die Schrittweite und lässt Fehlendes stehen', () => {
  assert.deepEqual(normalize({ runnerMemory: 2, dockerMemory: 1.5 }, current, range), { runnerCpus: 6, runnerMemory: '2g', dockerCpus: 6, dockerMemory: '1536m' });
  assert.deepEqual(normalize({ runnerMemory: '2.3', runnerCpus: '3.6' }, current, range), { runnerCpus: 4, runnerMemory: '2560m', dockerCpus: 6, dockerMemory: '4g' });
  assert.deepEqual(normalize({}, current, range), current);
});

test('setzt Werte außerhalb der Grenzen an die Grenze und lehnt Unsinn ab', () => {
  assert.deepEqual(normalize({ runnerMemory: 99, dockerMemory: 0, runnerCpus: 64, dockerCpus: -3 }, current, range), { runnerCpus: 12, runnerMemory: '7680m', dockerCpus: 1, dockerMemory: '1g' });
  assert.throws(() => normalize({ runnerMemory: 'viel' }, current, range), /Zahlen/);
});

test('schlägt die höchste Spitze mit 50 % Luft vor', () => {
  const jobs = [
    { runs: 4, peakMemory: 2 * GB, peakRunner: 1.2 * GB, peakDocker: 0.6 * GB, peakCpu: 3.2 },
    { runs: 3, peakMemory: 1 * GB, peakRunner: 0.4 * GB, peakDocker: 0.9 * GB, peakCpu: 1.1 },
  ];
  assert.deepEqual(suggest(jobs, range), { runnerMemory: 2, dockerMemory: 1.5, runnerCpus: 4, dockerCpus: 4 });
});

test('ohne genug Messwerte gibt es keinen Vorschlag', () => {
  assert.equal(suggest([], range), null);
  assert.equal(suggest([{ runs: 4, peakMemory: GB, peakRunner: GB, peakDocker: GB, peakCpu: 1 }], range), null);
  assert.equal(suggest([{ runs: 9, peakMemory: 0, peakRunner: 0, peakDocker: 0, peakCpu: 0 }], range), null);
});

test('eigene Limits eines Projekts gehen vor, sonst gelten die für alle', () => {
  assert.deepEqual(effective(current, undefined), current);
  assert.deepEqual(effective(current, { runnerCpus: 10, runnerMemory: '6g', dockerCpus: 2, dockerMemory: '1g' }), { runnerCpus: 10, runnerMemory: '6g', dockerCpus: 2, dockerMemory: '1g' });
});

test('die Kennung unterscheidet Limits, nicht ihre Schreibweise', () => {
  assert.equal(key(current), key({ runnerCpus: 6, runnerMemory: '4096m', dockerCpus: 6, dockerMemory: '4g' }));
  assert.notEqual(key(current), key({ ...current, dockerMemory: '1g' }));
});

// Ein Projekt mit einem Job, dessen Spitzen in GB angegeben sind.
const project = (repo, runner, docker, runs = 6) => ({ repo, jobs: [{ runs, peakMemory: (runner + docker) * GB, peakRunner: runner * GB, peakDocker: docker * GB, peakCpu: 2 }] });

test('der Standard deckt die Projekte mit ähnlichem Bedarf, der Ausreißer bekommt eigene Limits', () => {
  const found = plan([project('a/klein', 0.2, 0.1), project('a/mittel', 0.4, 0.1), project('a/auch', 0.3, 0.2), project('a/hungrig', 2.3, 0.5)], range);
  assert.deepEqual(found.shared, { runnerMemory: 1, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 });
  assert.deepEqual(found.own, { 'a/hungrig': { runnerMemory: 3.5, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 } });
});

test('wer nur etwas mehr braucht, bleibt beim Standard und hebt ihn an', () => {
  const found = plan([project('a/eins', 1.0, 0.3), project('a/zwei', 1.3, 0.3), project('a/drei', 1.5, 0.6)], range);
  assert.deepEqual(found.own, {});
  assert.deepEqual(found.shared, { runnerMemory: 2.5, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 });
});

test('Projekte ohne genug Läufe zählen nicht mit, und ohne Messwerte gibt es keinen Vorschlag', () => {
  assert.equal(plan([project('a/neu', 3, 1, 2)], range), null);
  const found = plan([project('a/neu', 6, 2, 2), project('a/alt', 0.5, 0.2)], range);
  assert.deepEqual(found, { shared: { runnerMemory: 1, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 }, own: {}, measured: ['a/alt'] });
});

test('schätzt ein, wie gut die Limits zu einem Projekt passen', () => {
  const limits = { runnerMemory: 4, dockerMemory: 4, runnerCpus: 6, dockerCpus: 6 };
  assert.deepEqual(rate(project('a/b', 3.95, 0.2, 1).jobs, limits, range), { state: 'full', runs: 1 });
  assert.deepEqual(rate(project('a/b', 3.5, 0.2, 1).jobs, limits, range), { state: 'tight', runs: 1 });
  assert.deepEqual(rate(project('a/b', 0.2, 3.6, 1).jobs, limits, range), { state: 'tight', runs: 1 });
  assert.deepEqual(rate(project('a/b', 1, 0.2, 3).jobs, limits, range), { state: 'measuring', runs: 3 });
  assert.deepEqual(rate(project('a/b', 0.5, 0.2, 8).jobs, limits, range), { state: 'generous', runs: 8 });
  assert.deepEqual(rate(project('a/b', 2, 1.5, 8).jobs, limits, range), { state: 'ok', runs: 8 });
  assert.deepEqual(rate([], limits, range), { state: 'measuring', runs: 0 });
});

test('vergleicht Limits Wert für Wert', () => {
  assert.equal(sameValues({ runnerMemory: 1, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 }, { dockerCpus: 2, runnerCpus: 2, dockerMemory: 1, runnerMemory: 1 }), true);
  assert.equal(sameValues({ runnerMemory: 1, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 }, undefined), false);
});

test('Runner und Docker eines Jobs bleiben zusammen unter dem Speicher der Docker-VM', () => {
  assert.deepEqual(normalize({ runnerMemory: 6, dockerMemory: 6 }, current, range), { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4608m' });
  assert.deepEqual(normalize({ runnerMemory: 7, dockerMemory: 1.5 }, current, range), { runnerCpus: 6, runnerMemory: '7g', dockerCpus: 6, dockerMemory: '1536m' });
  const greedy = [{ runs: 9, peakMemory: 12 * GB, peakRunner: 6 * GB, peakDocker: 6 * GB, peakCpu: 2 }];
  const found = suggest(greedy, range);
  assert.ok(found.runnerMemory + found.dockerMemory <= range.memory.total);
});

test('für einen Vorschlag zählen nur gemessene Läufe', () => {
  const once = [{ runs: 5, measuredRuns: 1, peakMemory: GB, peakRunner: GB, peakDocker: GB, peakCpu: 1 }];
  assert.equal(suggest(once, range), null);
  assert.deepEqual(rate(once, { runnerMemory: 4, dockerMemory: 4 }, range), { state: 'measuring', runs: 1 });
});

test('der Vorschlag lässt Projekte ohne genug Läufe, wie sie sind', () => {
  const found = plan([project('a/neu', 6, 2, 2), project('a/alt', 0.5, 0.2), project('a/auch', 0.4, 0.2)], range);
  assert.deepEqual(found.measured, ['a/alt', 'a/auch']);
  const shared = { runnerMemory: 1, dockerMemory: 1, runnerCpus: 2, dockerCpus: 2 };
  const eight = { runnerMemory: 6, dockerMemory: 2, runnerCpus: 6, dockerCpus: 6 };
  assert.equal(planApplied(found, shared, [{ repo: 'a/neu', own: eight }, { repo: 'a/alt', own: null }, { repo: 'a/auch', own: null }]), true);
  assert.equal(planApplied(found, shared, [{ repo: 'a/neu', own: null }, { repo: 'a/alt', own: eight }]), false);
  assert.equal(planApplied(found, { ...shared, runnerMemory: 4 }, []), false);
});

test('zwei Projekte: Ausreißer ist das größere erst weit über dem kleineren', () => {
  assert.deepEqual(Object.keys(plan([project('a/klein', 0.5, 0.2), project('a/gross', 4.5, 0.5)], range).own), ['a/gross']);
  assert.deepEqual(Object.keys(plan([project('a/klein', 1.2, 0.2), project('a/gross', 2, 0.5)], range).own), []);
});

test('unlesbare Limits ergeben kein Urteil statt eines falschen', () => {
  assert.deepEqual(rate(project('a/b', 1, 1).jobs, { runnerMemory: 0, dockerMemory: 4 }, range), { state: 'measuring', runs: 6 });
});
