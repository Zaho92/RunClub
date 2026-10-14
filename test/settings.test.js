const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings, clampParallel, PARALLEL_MAX } = require('../src/settings');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-settings-'));
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

test('ohne Dateien gelten die Vorgaben; nichts steht im Protokoll', () => {
  const logs = [];
  const s = createSettings({ dataDir: folder(), log: (...entry) => logs.push(entry) });
  assert.deepEqual(s.config, { limits: { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' }, pools: [] });
  assert.deepEqual(s.state, { learned: {}, rejected: {} });
  assert.deepEqual(logs, []);
});

test('ein Pool bekommt die Vorgaben, die er nicht selbst trägt; der alte Schlüssel `linux` zählt noch', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify({ limits: { runnerCpus: 2 }, linux: [{ repo: 'wer/a', parallel: 3 }, { repo: 'wer/b' }] }));
  const s = createSettings({ dataDir: dir, log: () => {} });
  assert.equal(s.config.limits.runnerCpus, 2);
  assert.equal(s.config.limits.dockerMemory, '4g');
  assert.deepEqual(s.config.pools, [
    { repo: 'wer/a', parallel: 3, cache: true, paused: false, preload: [] },
    { repo: 'wer/b', parallel: 1, cache: true, paused: false, preload: [] },
  ]);
  assert.notEqual(s.config.pools[0].preload, s.config.pools[1].preload); // keine geteilte Liste
  assert.deepEqual(s.repos(), ['wer/a', 'wer/b']);
});

test('eine kaputte Datei steht im Protokoll und wird durch die Vorgaben ersetzt', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ kaputt');
  const logs = [];
  const s = createSettings({ dataDir: dir, log: (...entry) => logs.push(entry) });
  assert.deepEqual(s.state, { learned: {}, rejected: {} });
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /^state\.json ließ sich nicht lesen/);
});

test('Limits eines Projekts gehen den Limits für alle vor', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify({ pools: [{ repo: 'wer/a', limits: { dockerMemory: '8g' } }] }));
  const s = createSettings({ dataDir: dir, log: () => {} });
  assert.equal(s.limitsOf('wer/a').dockerMemory, '8g');
  assert.equal(s.limitsOf('wer/a').runnerMemory, '4g');
  assert.equal(s.limitsOf('wer/fremd').dockerMemory, '4g');
  assert.equal(s.settingsOf('wer/fremd'), undefined);
});

test('anlegen und entfernen schreibt die Datei', () => {
  const dir = folder();
  const s = createSettings({ dataDir: dir, log: () => {} });
  assert.deepEqual(s.addPool('wer/a', '9'), { repo: 'wer/a', parallel: PARALLEL_MAX, cache: true, paused: false, preload: [] });
  assert.deepEqual(read(dir, 'runners.json').pools.map((pool) => pool.repo), ['wer/a']);
  s.removePool('wer/a');
  assert.deepEqual(s.config.pools, []);
  assert.deepEqual(read(dir, 'runners.json').pools, []);
  s.state.learned['wer/a'] = { 'node:22': 'heute' };
  s.saveState();
  assert.deepEqual(read(dir, 'state.json').learned, { 'wer/a': { 'node:22': 'heute' } });
});

test('die Zahl der Plätze ist eine ganze Zahl von 1 bis zur Höchstzahl', () => {
  assert.deepEqual([clampParallel(2), clampParallel('3'), clampParallel(2.7), clampParallel(0), clampParallel(-1), clampParallel('x'), clampParallel(99)], [2, 3, 2, 1, 1, 1, PARALLEL_MAX]);
});
