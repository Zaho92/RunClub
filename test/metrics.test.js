const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMetrics } = require('../src/metrics');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
const fresh = (options) => createMetrics({ dataDir: tempDir(), ...options });
const { GB } = require('../src/units');

test('a job keeps peaks and average, runner and Docker apart', () => {
  const metrics = fresh();
  const meter = metrics.meter();
  meter.add({ cpu: 0.5, memory: 0.5 * GB }, { cpu: 1.5, memory: 1 * GB });
  meter.add({ cpu: 0.5, memory: 1 * GB }, { cpu: 3.5, memory: 2 * GB });
  meter.add(undefined, undefined); // container already gone
  metrics.recordJob('owner/repo', { job: 'Semgrep', result: 'Succeeded', duration: 90, ...meter.finish() });

  const [row] = metrics.jobsView('owner/repo');
  assert.equal(row.job, 'Semgrep');
  assert.equal(row.peakMemory, 3 * GB);
  assert.equal(row.peakRunner, 1 * GB);
  assert.equal(row.peakDocker, 2 * GB);
  assert.equal(row.peakCpu, 4);
  assert.equal(row.cpu, 2);
  assert.equal(row.duration, 90);
});

test('the hungriest jobs are on top, the usual duration is the median', () => {
  const metrics = fresh();
  for (const [job, duration, memory] of [['Small', 10, 1], ['Large', 100, 3], ['Large', 300, 2], ['Large', 200, 2]]) {
    const meter = metrics.meter();
    meter.add({ cpu: 1, memory: memory * GB }, undefined);
    metrics.recordJob('owner/repo', { job, result: 'Succeeded', duration, ...meter.finish() });
  }
  const rows = metrics.jobsView('owner/repo');
  assert.deepEqual(rows.map((row) => row.job), ['Large', 'Small']);
  assert.equal(rows[0].duration, 200);
  assert.equal(rows[0].runs, 3);
});

test('the samples of a minute become a mean and a peak', () => {
  const start = Date.parse('2026-01-01T10:00:00Z');
  const metrics = fresh({ now: () => start + 60000 });
  const point = (vmCpu) => ({ hostCpu: 1, hostMemory: GB, vmCpu, vmMemory: GB });
  metrics.sample(point(2), start);
  metrics.sample(point(4), start + 30000);
  metrics.sample(point(0), start + 60000); // a new minute closes the old one
  assert.equal(metrics.dayMinutes().length, 1);
  assert.equal(metrics.dayMinutes()[0].vmCpu, 3);
  assert.equal(metrics.dayMinutes()[0].vmCpuMax, 4);
  assert.deepEqual(metrics.series().vmCpu, [2, 4, 0]);
});

test('jobs may be named like built-in properties', () => {
  const metrics = fresh();
  for (const job of ['constructor', '__proto__', 'toString']) metrics.recordJob('owner/repo', { job, result: 'Succeeded', duration: 5, ...metrics.meter().finish() });
  assert.deepEqual(metrics.jobsView('owner/repo').map((row) => row.job).sort(), ['__proto__', 'constructor', 'toString']);
  assert.deepEqual(metrics.jobsView('constructor'), []);
});

test('keeps only a limited number of job names per repo', () => {
  const metrics = fresh();
  for (let n = 0; n < 130; n += 1) metrics.recordJob('owner/repo', { job: 'Test ' + n, result: 'Succeeded', duration: 5, ...metrics.meter().finish() });
  const names = metrics.jobsView('owner/repo').map((row) => row.job);
  assert.equal(names.length, 100);
  assert.ok(names.includes('Test 129'));
  assert.ok(!names.includes('Test 0'));
});

test('counts in how many runs there were measurements', () => {
  const metrics = fresh();
  const meter = metrics.meter();
  meter.add({ cpu: 1, memory: GB }, { cpu: 1, memory: GB });
  metrics.recordJob('owner/repo', { job: 'a', result: 'Succeeded', duration: 5, ...meter.finish() });
  metrics.recordJob('owner/repo', { job: 'a', result: 'Succeeded', duration: 5, ...metrics.meter().finish() });
  const [row] = metrics.jobsView('owner/repo');
  assert.equal(row.runs, 2);
  assert.equal(row.measuredRuns, 1);
});

test('minutes older than 24 hours drop out', () => {
  const start = Date.parse('2026-01-01T10:00:00Z');
  const HOUR = 3600000;
  let time = start;
  const metrics = fresh({ now: () => time });
  const point = { hostCpu: 1, hostMemory: GB, vmCpu: 1, vmMemory: GB };
  metrics.sample(point);
  time = start + 60000;
  metrics.sample(point); // closes the first minute
  assert.deepEqual(metrics.dayMinutes().map((entry) => entry.at), [start]);

  // Exactly 24 hours old still belongs on the axis, a minute later no longer.
  time = start + 24 * HOUR;
  assert.equal(metrics.dayMinutes().length, 1);
  time = start + 24 * HOUR + 60000;
  assert.equal(metrics.dayMinutes().length, 0);

  // After a 30-hour pause: the minute before the pause is still closed but no longer counts.
  time = start + 30 * HOUR;
  metrics.sample(point);
  time += 60000;
  metrics.sample(point);
  assert.deepEqual(metrics.dayMinutes().map((entry) => entry.at), [start + 30 * HOUR]);
});

test('old minutes from the file are neither returned nor saved again', () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, 'metrics.json');
  const end = Date.parse('2026-01-03T10:00:00Z');
  const minute = (at) => ({ at, hostCpu: 1, hostCpuMax: 1, hostMemory: GB, hostMemoryMax: GB, vmCpu: 1, vmCpuMax: 1, vmMemory: GB, vmMemoryMax: GB });
  const old = end - 30 * 3600000;
  const young = end - 3600000;
  fs.writeFileSync(file, JSON.stringify({ minutes: [minute(old), minute(old + 60000), minute(young)], jobs: { 'owner/repo': { a: [{ at: '2026-01-01T00:00:00.000Z', result: 'Succeeded', duration: 5, samples: 0 }] } } }));

  const metrics = createMetrics({ dataDir, now: () => end });
  assert.deepEqual(metrics.dayMinutes().map((entry) => entry.at), [young]);
  metrics.save();
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stored.minutes.map((entry) => entry.at), [young]);
  assert.equal(stored.jobs['owner/repo'].a.length, 1); // jobs have no expiry
});

test('the usual duration counts only successful runs', () => {
  const metrics = fresh();
  for (const [result, duration] of [['Succeeded', 100], ['Failed', 5], ['Canceled', 3], ['Succeeded', 300], ['Failed', 7]]) {
    metrics.recordJob('owner/repo', { job: 'Build', result, duration, ...metrics.meter().finish() });
  }
  const [row] = metrics.jobsView('owner/repo');
  assert.equal(row.duration, 200);
  assert.equal(row.runs, 5);
  assert.equal(row.lastDuration, 7);
  assert.equal(row.lastResult, 'Failed');
});

test('without a successful run the usual duration stays the median of all', () => {
  const metrics = fresh();
  for (const [result, duration] of [['Failed', 10], ['Canceled', 30], ['Failed', 20]]) {
    metrics.recordJob('owner/repo', { job: 'Build', result, duration, ...metrics.meter().finish() });
  }
  assert.equal(metrics.jobsView('owner/repo')[0].duration, 20);
});

// A run with a peak of `memory` GB in the runner.
const record = (metrics, job, workflow, duration, memory) => {
  const meter = metrics.meter();
  meter.add({ cpu: 1, memory: memory * GB }, undefined);
  metrics.recordJob('owner/repo', { job, workflow, result: 'Succeeded', duration, ...meter.finish() });
};
const rowsOf = (metrics) => Object.fromEntries(metrics.jobsView('owner/repo').map((row) => [`${row.workflow}/${row.job}`, row]));

test('jobs of the same name from two workflows stay apart', () => {
  const metrics = fresh();
  for (const [workflow, duration, memory] of [['CI', 60, 1], ['Release', 600, 4], ['CI', 80, 1], ['Release', 800, 5], ['CI', 70, 2]]) record(metrics, 'test', workflow, duration, memory);
  record(metrics, 'lint', 'CI', 10, 0.5);

  const rows = metrics.jobsView('owner/repo');
  assert.deepEqual(rows.map((row) => [row.workflow, row.job]), [['Release', 'test'], ['CI', 'test'], ['CI', 'lint']]);
  const [release, ci] = rows;
  assert.deepEqual([release.runs, release.duration, release.lastDuration, release.peakRunner], [2, 700, 800, 5 * GB]);
  assert.deepEqual([ci.runs, ci.duration, ci.lastDuration, ci.peakRunner], [3, 70, 70, 2 * GB]);
});

test('runs without a workflow count towards the workflow with the most known runs', () => {
  const metrics = fresh();
  record(metrics, 'test', undefined, 500, 6); // GitHub had not answered yet
  for (const [workflow, duration] of [['Release', 600], ['CI', 60], ['CI', 80]]) record(metrics, 'test', workflow, duration, 1);
  record(metrics, 'test', '', 70, 1);

  const rows = rowsOf(metrics);
  assert.deepEqual(Object.keys(rows).sort(), ['CI/test', 'Release/test']);
  assert.deepEqual([rows['CI/test'].runs, rows['CI/test'].peakRunner, rows['CI/test'].lastDuration], [4, 6 * GB, 70]);
  assert.deepEqual([rows['Release/test'].runs, rows['Release/test'].peakRunner], [1, 1 * GB]);
});

test('without a known workflow there is one row without a workflow', () => {
  const metrics = fresh();
  record(metrics, 'test', undefined, 60, 1);
  record(metrics, 'test', '', 80, 2);
  const rows = metrics.jobsView('owner/repo');
  assert.deepEqual(rows.map((row) => [row.workflow, row.job, row.runs]), [['', 'test', 2]]);
});

test('stored runs without the workflow field are not lost', () => {
  const dataDir = tempDir();
  const run = (duration, workflow) => ({ at: '2026-01-01T00:00:00.000Z', result: 'Succeeded', duration, samples: 1, peakMemory: GB, peakRunner: GB, peakDocker: 0, peakCpu: 1, cpu: 1, ...(workflow === undefined ? {} : { workflow }) });
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ minutes: [], jobs: { 'only/old': { test: [run(10), run(30)] }, 'owner/repo': { test: [run(10), run(30)] } } }));
  const metrics = createMetrics({ dataDir });
  assert.deepEqual(metrics.jobsView('only/old').map((row) => [row.workflow, row.job, row.runs, row.duration]), [['', 'test', 2, 20]]);

  // Once the workflow is known, the old runs count towards its row; the file stays as it was.
  record(metrics, 'test', 'CI', 50, 1);
  assert.deepEqual(metrics.jobsView('owner/repo').map((row) => [row.workflow, row.job, row.runs, row.duration]), [['CI', 'test', 3, 30]]);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'metrics.json'), 'utf8')).jobs['owner/repo'].test;
  assert.deepEqual(stored.map((entry) => entry.workflow), [undefined, undefined, 'CI']);
});

test('the frequent workflow does not push out the runs of the rare one', () => {
  const metrics = fresh();
  record(metrics, 'test', 'Release', 600, 4);
  for (let n = 0; n < 30; n += 1) record(metrics, 'test', 'CI', 60, 1);
  const rows = rowsOf(metrics);
  assert.equal(rows['CI/test'].runs, 20);
  assert.equal(rows['Release/test'].runs, 1);
});

test('stored runs without a result do not disturb the usual duration', () => {
  const dataDir = tempDir();
  const run = (duration, result) => ({ at: '2026-01-01T00:00:00.000Z', result, duration, samples: 0 });
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ minutes: [], jobs: { 'only/old': { a: [run(10), run(30)] }, 'owner/repo': { a: [run(10), run(30), run(50, 'Succeeded')] } } }));
  const metrics = createMetrics({ dataDir });
  assert.equal(metrics.jobsView('only/old')[0].duration, 20);
  assert.equal(metrics.jobsView('owner/repo')[0].duration, 50);
});

test('a file in the wrong shape does not prevent the start', () => {
  for (const content of ['{"minutes":[null]}', '{"minutes":{}}', '{"jobs":[]}', 'null', '[1]']) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
    fs.writeFileSync(path.join(dataDir, 'metrics.json'), content);
    const metrics = createMetrics({ dataDir });
    assert.deepEqual(metrics.dayMinutes(), []);
    assert.deepEqual(metrics.jobsView('owner/repo'), []);
  }
});

test('minutes from the future drop out (the clock was set back)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  fs.writeFileSync(path.join(dataDir, 'metrics.json'), JSON.stringify({ minutes: [{ at: now - 60000 }, { at: now + 3600000 }], jobs: {} }));
  assert.deepEqual(createMetrics({ dataDir, now: () => now }).dayMinutes().map((entry) => entry.at), [now - 60000]);
});

test('the result from the runner output only applies until GitHub reports that of the job', () => {
  const dataDir = tempDir();
  const metrics = createMetrics({ dataDir });
  // A job wrote “Succeeded” to the output but failed at GitHub.
  metrics.recordJob('owner/repo', { job: 'Build', workflow: 'CI', runner: 'PC-linux-1', result: 'Succeeded', duration: 10, samples: 0 });
  metrics.recordJob('owner/repo', { job: 'Build', workflow: 'CI', runner: 'PC-linux-2', result: 'Succeeded', duration: 600, samples: 0 });
  metrics.confirmResults('owner/repo', [{ runner: 'PC-linux-1', conclusion: 'failure' }, { runner: 'PC-linux-2', conclusion: 'success' }, { runner: 'PC-linux-9', conclusion: 'success' }]);
  const [row] = metrics.jobsView('owner/repo');
  assert.equal(row.duration, 600); // only the real success is usual
  assert.equal(row.lastResult, 'Succeeded');
  // A confirmed result stays even if something else came later; unknown results change nothing.
  metrics.confirmResults('owner/repo', [{ runner: 'PC-linux-2', conclusion: 'failure' }, { runner: 'PC-linux-1', conclusion: 'neutral' }]);
  assert.equal(metrics.jobsView('owner/repo')[0].duration, 600);
  // It is saved as well.
  const again = createMetrics({ dataDir });
  assert.equal(again.jobsView('owner/repo')[0].duration, 600);
});
