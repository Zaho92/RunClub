const test = require('node:test');
const assert = require('node:assert/strict');
const { bytesOf, memoryText, bounds, view, normalize, suggest, GB } = require('../src/limits');

const range = bounds({ dockerMemory: 9.7 * GB, dockerCpus: 12 });
const current = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' };

test('liest und schreibt Speicher, wie Docker ihn versteht', () => {
  assert.equal(bytesOf('4g'), 4 * GB);
  assert.equal(bytesOf('1536m'), 1.5 * GB);
  assert.equal(bytesOf('4 GB'), 4 * GB);
  assert.equal(bytesOf('unsinn'), 0);
  assert.equal(memoryText(4), '4g');
  assert.equal(memoryText(1.5), '1536m');
  assert.deepEqual(view({ runnerCpus: 6, runnerMemory: '1536m', dockerCpus: 4, dockerMemory: '2g' }), { runnerMemory: 1.5, dockerMemory: 2, runnerCpus: 6, dockerCpus: 4 });
});

test('die Grenzen folgen der Docker-VM', () => {
  assert.deepEqual(range, { memory: { min: 1, max: 9, step: 0.5 }, cpus: { min: 1, max: 12, step: 1 } });
  assert.deepEqual(bounds({ dockerMemory: 0, dockerCpus: 0 }), { memory: { min: 1, max: 2, step: 0.5 }, cpus: { min: 1, max: 1, step: 1 } });
});

test('übernimmt neue Werte, rundet auf die Schrittweite und lässt Fehlendes stehen', () => {
  assert.deepEqual(normalize({ runnerMemory: 2, dockerMemory: 1.5 }, current, range), { runnerCpus: 6, runnerMemory: '2g', dockerCpus: 6, dockerMemory: '1536m' });
  assert.deepEqual(normalize({ runnerMemory: '2.3', runnerCpus: '3.6' }, current, range), { runnerCpus: 4, runnerMemory: '2560m', dockerCpus: 6, dockerMemory: '4g' });
  assert.deepEqual(normalize({}, current, range), current);
});

test('setzt Werte außerhalb der Grenzen an die Grenze und lehnt Unsinn ab', () => {
  assert.deepEqual(normalize({ runnerMemory: 99, dockerMemory: 0, runnerCpus: 64, dockerCpus: -3 }, current, range), { runnerCpus: 12, runnerMemory: '9g', dockerCpus: 1, dockerMemory: '1g' });
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
