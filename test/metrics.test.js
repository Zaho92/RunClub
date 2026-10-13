const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMetrics } = require('../src/metrics');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
const fresh = (options) => createMetrics({ dataDir: tempDir(), ...options });
const GB = 1073741824;

test('ein Job merkt sich Spitzen und Durchschnitt, Runner und Docker getrennt', () => {
  const metrics = fresh();
  const meter = metrics.meter();
  meter.add({ cpu: 0.5, memory: 0.5 * GB }, { cpu: 1.5, memory: 1 * GB });
  meter.add({ cpu: 0.5, memory: 1 * GB }, { cpu: 3.5, memory: 2 * GB });
  meter.add(undefined, undefined); // Container schon weg
  metrics.recordJob('wer/was', { job: 'Semgrep', result: 'Succeeded', duration: 90, ...meter.finish() });

  const [row] = metrics.jobsView('wer/was');
  assert.equal(row.job, 'Semgrep');
  assert.equal(row.peakMemory, 3 * GB);
  assert.equal(row.peakRunner, 1 * GB);
  assert.equal(row.peakDocker, 2 * GB);
  assert.equal(row.peakCpu, 4);
  assert.equal(row.cpu, 2);
  assert.equal(row.duration, 90);
});

test('die hungrigsten Jobs stehen oben, übliche Dauer ist der Median', () => {
  const metrics = fresh();
  for (const [job, duration, memory] of [['Klein', 10, 1], ['Groß', 100, 3], ['Groß', 300, 2], ['Groß', 200, 2]]) {
    const meter = metrics.meter();
    meter.add({ cpu: 1, memory: memory * GB }, undefined);
    metrics.recordJob('wer/was', { job, result: 'Succeeded', duration, ...meter.finish() });
  }
  const rows = metrics.jobsView('wer/was');
  assert.deepEqual(rows.map((row) => row.job), ['Groß', 'Klein']);
  assert.equal(rows[0].duration, 200);
  assert.equal(rows[0].runs, 3);
});

test('aus den Messpunkten einer Minute werden Mittel- und Höchstwert', () => {
  const start = Date.parse('2026-01-01T10:00:00Z');
  const metrics = fresh({ now: () => start + 60000 });
  const point = (vmCpu) => ({ hostCpu: 1, hostMemory: GB, vmCpu, vmMemory: GB });
  metrics.sample(point(2), start);
  metrics.sample(point(4), start + 30000);
  metrics.sample(point(0), start + 60000); // neue Minute schließt die alte ab
  assert.equal(metrics.minutes().length, 1);
  assert.equal(metrics.minutes()[0].vmCpu, 3);
  assert.equal(metrics.minutes()[0].vmCpuMax, 4);
  assert.deepEqual(metrics.series().vmCpu, [2, 4, 0]);
});

test('Jobs dürfen wie eingebaute Eigenschaften heißen', () => {
  const metrics = fresh();
  for (const job of ['constructor', '__proto__', 'toString']) metrics.recordJob('wer/was', { job, result: 'Succeeded', duration: 5, ...metrics.meter().finish() });
  assert.deepEqual(metrics.jobsView('wer/was').map((row) => row.job).sort(), ['__proto__', 'constructor', 'toString']);
  assert.deepEqual(metrics.jobsView('constructor'), []);
});

test('merkt sich je Repo nur eine begrenzte Zahl von Jobnamen', () => {
  const metrics = fresh();
  for (let n = 0; n < 130; n += 1) metrics.recordJob('wer/was', { job: 'Test ' + n, result: 'Succeeded', duration: 5, ...metrics.meter().finish() });
  const names = metrics.jobsView('wer/was').map((row) => row.job);
  assert.equal(names.length, 100);
  assert.ok(names.includes('Test 129'));
  assert.ok(!names.includes('Test 0'));
});

test('zählt, in wie vielen Läufen gemessen wurde', () => {
  const metrics = fresh();
  const meter = metrics.meter();
  meter.add({ cpu: 1, memory: GB }, { cpu: 1, memory: GB });
  metrics.recordJob('wer/was', { job: 'a', result: 'Succeeded', duration: 5, ...meter.finish() });
  metrics.recordJob('wer/was', { job: 'a', result: 'Succeeded', duration: 5, ...metrics.meter().finish() });
  const [row] = metrics.jobsView('wer/was');
  assert.equal(row.runs, 2);
  assert.equal(row.measuredRuns, 1);
});

test('Minuten, die älter als 24 Stunden sind, fallen heraus', () => {
  const start = Date.parse('2026-01-01T10:00:00Z');
  const HOUR = 3600000;
  let time = start;
  const metrics = fresh({ now: () => time });
  const point = { hostCpu: 1, hostMemory: GB, vmCpu: 1, vmMemory: GB };
  metrics.sample(point);
  time = start + 60000;
  metrics.sample(point); // schließt die erste Minute ab
  assert.deepEqual(metrics.minutes().map((entry) => entry.at), [start]);

  // Genau 24 Stunden alt gehört noch auf die Achse, eine Minute später nicht mehr.
  time = start + 24 * HOUR;
  assert.equal(metrics.minutes().length, 1);
  time = start + 24 * HOUR + 60000;
  assert.equal(metrics.minutes().length, 0);

  // Nach 30 Stunden Pause: Die Minute vor der Pause wird noch abgeschlossen, zählt aber nicht mehr.
  time = start + 30 * HOUR;
  metrics.sample(point);
  time += 60000;
  metrics.sample(point);
  assert.deepEqual(metrics.minutes().map((entry) => entry.at), [start + 30 * HOUR]);
});

test('alte Minuten aus der Datei werden weder geliefert noch wieder gespeichert', () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, 'metrics.json');
  const end = Date.parse('2026-01-03T10:00:00Z');
  const minute = (at) => ({ at, hostCpu: 1, hostCpuMax: 1, hostMemory: GB, hostMemoryMax: GB, vmCpu: 1, vmCpuMax: 1, vmMemory: GB, vmMemoryMax: GB });
  const old = end - 30 * 3600000;
  const young = end - 3600000;
  fs.writeFileSync(file, JSON.stringify({ minutes: [minute(old), minute(old + 60000), minute(young)], jobs: { 'wer/was': { a: [{ at: '2026-01-01T00:00:00.000Z', result: 'Succeeded', duration: 5, samples: 0 }] } } }));

  const metrics = createMetrics({ dataDir, now: () => end });
  assert.deepEqual(metrics.minutes().map((entry) => entry.at), [young]);
  metrics.save();
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stored.minutes.map((entry) => entry.at), [young]);
  assert.equal(stored.jobs['wer/was'].a.length, 1); // Jobs haben keine Frist
});

test('übliche Dauer zählt nur erfolgreiche Durchläufe', () => {
  const metrics = fresh();
  for (const [result, duration] of [['Succeeded', 100], ['Failed', 5], ['Canceled', 3], ['Succeeded', 300], ['Failed', 7]]) {
    metrics.recordJob('wer/was', { job: 'Bauen', result, duration, ...metrics.meter().finish() });
  }
  const [row] = metrics.jobsView('wer/was');
  assert.equal(row.duration, 200);
  assert.equal(row.runs, 5);
  assert.equal(row.lastDuration, 7);
  assert.equal(row.lastResult, 'Failed');
});

test('ohne erfolgreichen Durchlauf bleibt die übliche Dauer der Median aller', () => {
  const metrics = fresh();
  for (const [result, duration] of [['Failed', 10], ['Canceled', 30], ['Failed', 20]]) {
    metrics.recordJob('wer/was', { job: 'Bauen', result, duration, ...metrics.meter().finish() });
  }
  assert.equal(metrics.jobsView('wer/was')[0].duration, 20);
});

// Ein Durchlauf mit `memory` GB Spitze im Runner.
const record = (metrics, job, workflow, duration, memory) => {
  const meter = metrics.meter();
  meter.add({ cpu: 1, memory: memory * GB }, undefined);
  metrics.recordJob('wer/was', { job, workflow, result: 'Succeeded', duration, ...meter.finish() });
};
const rowsOf = (metrics) => Object.fromEntries(metrics.jobsView('wer/was').map((row) => [`${row.workflow}/${row.job}`, row]));

test('gleichnamige Jobs aus zwei Workflows bleiben getrennt', () => {
  const metrics = fresh();
  for (const [workflow, duration, memory] of [['CI', 60, 1], ['Release', 600, 4], ['CI', 80, 1], ['Release', 800, 5], ['CI', 70, 2]]) record(metrics, 'test', workflow, duration, memory);
  record(metrics, 'lint', 'CI', 10, 0.5);

  const rows = metrics.jobsView('wer/was');
  assert.deepEqual(rows.map((row) => [row.workflow, row.job]), [['Release', 'test'], ['CI', 'test'], ['CI', 'lint']]);
  const [release, ci] = rows;
  assert.deepEqual([release.runs, release.duration, release.lastDuration, release.peakRunner], [2, 700, 800, 5 * GB]);
  assert.deepEqual([ci.runs, ci.duration, ci.lastDuration, ci.peakRunner], [3, 70, 70, 2 * GB]);
});

test('Durchläufe ohne Workflow zählen zum Workflow mit den meisten bekannten Durchläufen', () => {
  const metrics = fresh();
  record(metrics, 'test', undefined, 500, 6); // GitHub hatte noch nicht geantwortet
  for (const [workflow, duration] of [['Release', 600], ['CI', 60], ['CI', 80]]) record(metrics, 'test', workflow, duration, 1);
  record(metrics, 'test', '', 70, 1);

  const rows = rowsOf(metrics);
  assert.deepEqual(Object.keys(rows).sort(), ['CI/test', 'Release/test']);
  assert.deepEqual([rows['CI/test'].runs, rows['CI/test'].peakRunner, rows['CI/test'].lastDuration], [4, 6 * GB, 70]);
  assert.deepEqual([rows['Release/test'].runs, rows['Release/test'].peakRunner], [1, 1 * GB]);
});

test('ohne einen bekannten Workflow bleibt eine Zeile ohne Workflow', () => {
  const metrics = fresh();
  record(metrics, 'test', undefined, 60, 1);
  record(metrics, 'test', '', 80, 2);
  const rows = metrics.jobsView('wer/was');
  assert.deepEqual(rows.map((row) => [row.workflow, row.job, row.runs]), [['', 'test', 2]]);
});

test('gespeicherte Durchläufe ohne das Feld Workflow gehen nicht verloren', () => {
  const dataDir = tempDir();
  const run = (duration, workflow) => ({ at: '2026-01-01T00:00:00.000Z', result: 'Succeeded', duration, samples: 1, peakMemory: GB, peakRunner: GB, peakDocker: 0, peakCpu: 1, cpu: 1, ...(workflow === undefined ? {} : { workflow }) });
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ minutes: [], jobs: { 'nur/alt': { test: [run(10), run(30)] }, 'wer/was': { test: [run(10), run(30)] } } }));
  const metrics = createMetrics({ dataDir });
  assert.deepEqual(metrics.jobsView('nur/alt').map((row) => [row.workflow, row.job, row.runs, row.duration]), [['', 'test', 2, 20]]);

  // Sobald der Workflow bekannt ist, tragen die alten Durchläufe seine Zeile mit; die Datei bleibt, wie sie war.
  record(metrics, 'test', 'CI', 50, 1);
  assert.deepEqual(metrics.jobsView('wer/was').map((row) => [row.workflow, row.job, row.runs, row.duration]), [['CI', 'test', 3, 30]]);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'metrics.json'), 'utf8')).jobs['wer/was'].test;
  assert.deepEqual(stored.map((entry) => entry.workflow), [undefined, undefined, 'CI']);
});

test('der häufige Workflow verdrängt die Durchläufe des seltenen nicht', () => {
  const metrics = fresh();
  record(metrics, 'test', 'Release', 600, 4);
  for (let n = 0; n < 30; n += 1) record(metrics, 'test', 'CI', 60, 1);
  const rows = rowsOf(metrics);
  assert.equal(rows['CI/test'].runs, 20);
  assert.equal(rows['Release/test'].runs, 1);
});

test('gespeicherte Durchläufe ohne Ergebnis stören die übliche Dauer nicht', () => {
  const dataDir = tempDir();
  const run = (duration, result) => ({ at: '2026-01-01T00:00:00.000Z', result, duration, samples: 0 });
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ minutes: [], jobs: { 'nur/alt': { a: [run(10), run(30)] }, 'wer/was': { a: [run(10), run(30), run(50, 'Succeeded')] } } }));
  const metrics = createMetrics({ dataDir });
  assert.equal(metrics.jobsView('nur/alt')[0].duration, 20);
  assert.equal(metrics.jobsView('wer/was')[0].duration, 50);
});

test('eine Datei in falscher Form verhindert den Start nicht', () => {
  for (const content of ['{"minutes":[null]}', '{"minutes":{}}', '{"jobs":[]}', 'null', '[1]']) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
    fs.writeFileSync(path.join(dataDir, 'metrics.json'), content);
    const metrics = createMetrics({ dataDir });
    assert.deepEqual(metrics.minutes(), []);
    assert.deepEqual(metrics.jobsView('wer/was'), []);
  }
});

test('Minuten aus der Zukunft fallen heraus (die Uhr wurde zurückgestellt)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ minutes: [{ at: now - 60000 }, { at: now + 3600000 }], jobs: {} }));
  assert.deepEqual(createMetrics({ dataDir, now: () => now }).minutes().map((entry) => entry.at), [now - 60000]);
});
