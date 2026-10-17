const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings, clampParallel, PARALLEL_MAX } = require('../src/settings');
const { rendered } = require('./support');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-settings-'));
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

test('without files the defaults apply; nothing is logged', () => {
  const logs = [];
  const s = createSettings({ dataDir: folder(), log: (...entry) => logs.push(rendered(entry)) });
  assert.deepEqual(s.config, { limits: { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' }, pools: [] });
  assert.deepEqual(s.state, { learned: {}, rejected: {} });
  assert.deepEqual(logs, []);
});

test('a pool gets the defaults it does not carry itself; the old key `linux` still counts', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify({ limits: { runnerCpus: 2 }, linux: [{ repo: 'who/a', parallel: 3 }, { repo: 'who/b' }] }));
  const s = createSettings({ dataDir: dir, log: () => {} });
  assert.equal(s.config.limits.runnerCpus, 2);
  assert.equal(s.config.limits.dockerMemory, '4g');
  assert.deepEqual(s.config.pools, [
    { repo: 'who/a', parallel: 3, cache: true, paused: false, preload: [] },
    { repo: 'who/b', parallel: 1, cache: true, paused: false, preload: [] },
  ]);
  assert.notEqual(s.config.pools[0].preload, s.config.pools[1].preload); // no shared list
  assert.deepEqual(s.repos(), ['who/a', 'who/b']);
});

test('a broken file is logged and replaced by the defaults', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ broken');
  const logs = [];
  const s = createSettings({ dataDir: dir, log: (...entry) => logs.push(rendered(entry)) });
  assert.deepEqual(s.state, { learned: {}, rejected: {} });
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /^Could not read state\.json/);
});

test('a project\'s limits take precedence over the limits for all', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify({ pools: [{ repo: 'who/a', limits: { dockerMemory: '8g' } }] }));
  const s = createSettings({ dataDir: dir, log: () => {} });
  assert.equal(s.limitsOf('who/a').dockerMemory, '8g');
  assert.equal(s.limitsOf('who/a').runnerMemory, '4g');
  assert.equal(s.limitsOf('who/other').dockerMemory, '4g');
  assert.equal(s.settingsOf('who/other'), undefined);
});

test('adding and removing writes the file', () => {
  const dir = folder();
  const s = createSettings({ dataDir: dir, log: () => {} });
  assert.deepEqual(s.addPool('who/a', '9'), { repo: 'who/a', parallel: PARALLEL_MAX, cache: true, paused: false, preload: [] });
  assert.deepEqual(read(dir, 'runners.json').pools.map((pool) => pool.repo), ['who/a']);
  s.removePool('who/a');
  assert.deepEqual(s.config.pools, []);
  assert.deepEqual(read(dir, 'runners.json').pools, []);
  s.state.learned['who/a'] = { 'node:22': 'today' };
  s.saveState();
  assert.deepEqual(read(dir, 'state.json').learned, { 'who/a': { 'node:22': 'today' } });
});

test('the number of slots is a whole number from 1 to the maximum', () => {
  assert.deepEqual([clampParallel(2), clampParallel('3'), clampParallel(2.7), clampParallel(0), clampParallel(-1), clampParallel('x'), clampParallel(99)], [2, 3, 2, 1, 1, 1, PARALLEL_MAX]);
});
