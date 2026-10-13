const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMetrics } = require('../src/metrics');

const fresh = () => createMetrics({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
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
  const metrics = fresh();
  const start = Date.parse('2026-01-01T10:00:00Z');
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
