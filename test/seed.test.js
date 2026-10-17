const test = require('node:test');
const assert = require('node:assert/strict');
const { DAEMON_FLAGS, DAEMON_COMMAND, DATA_ROOT, READY_TRIES } = require('../src/dind');
const { createSeed, LEARNED_DAYS, LEARNED_MAX } = require('../src/seed');
const { DAY } = require('../src/units');
const { createEngine } = require('../src/engine');
const { turn, settle, rendered } = require('./support');

const REPO = 'owner/App';
const SEED = 'rc-seed-app';
const LOADER = `${SEED}-loader`;
const MARK = 'runclub.runner=test';
const GONE = 'Error response from daemon: manifest for gone:1 not found: manifest unknown: manifest unknown';
const BUSY = 'toomanyrequests: You have reached your unauthenticated pull rate limit.';

const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

// A Docker call in short form: in the loader daemon only what happens there.
function brief(args) {
  if (args[0] === 'run') return args.includes('--name') ? `run ${args[args.indexOf('--name') + 1]}` : 'run prepare';
  if (args[0] === 'exec') return `exec ${args.slice(args.indexOf('docker') + 1).filter((arg) => !['-q', '-f', '--format', 'ok', '{{.Repository}}:{{.Tag}}', '-H', 'unix:///sock/docker.sock'].includes(arg)).join(' ')}`;
  return args.join(' ');
}

// Docker and the rest faked. `calls` holds the calls to Docker in their order,
// `answer(name, args, options)` can give a call a result (otherwise it succeeds without output).
// Time passes without waiting: `sleep` only yields once to everything else and records the duration.
function world() {
  const w = {
    calls: [], details: [], logs: [], slept: [], saved: 0, stopping: false, answer: () => undefined,
    settings: { repo: REPO, preload: [] },
    state: { learned: {}, rejected: {} },
    pool: { repo: REPO, seeded: new Set() },
  };
  // Docker through engine.js, as in operation; only `run` is faked.
  const run = async (command, args, options = {}) => {
    const name = brief(args);
    w.calls.push(name);
    w.details.push({ name, args, options });
    return { code: 0, stdout: '', stderr: '', ...(await w.answer(name, args, options)) };
  };
  const { docker, dockerList } = createEngine({ run, timeout: 99 });
  w.seed = createSeed({
    docker, dockerList,
    log: (...entry) => w.logs.push(rendered(entry)),
    sleep: async (ms) => { w.slept.push(ms); await turn(); },
    mark: MARK, dind: 'dind:test', longTimeout: 1234,
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    seedVolume: () => SEED,
    poolOf: (repo) => (repo === REPO ? w.pool : undefined),
    state: w.state, saveState: () => { w.saved += 1; }, stopping: () => w.stopping,
  });
  return w;
}

test('wanted are the fixed images and the learned ones, the most recent first', () => {
  const w = world();
  w.settings.preload = ['fixed:1', 'both:1'];
  w.state.learned[REPO] = { 'old:1': daysAgo(3), 'new:1': daysAgo(1), 'both:1': daysAgo(2), 'forgotten:1': daysAgo(LEARNED_DAYS + 1) };
  assert.deepEqual(w.seed.wantedImages(REPO), ['fixed:1', 'both:1', 'new:1', 'old:1']);
  assert.deepEqual(w.seed.wantedImages('owner/Other'), []);
});

test('more than the maximum does not go into the template; the oldest stay out', () => {
  const w = world();
  w.state.learned[REPO] = Object.fromEntries(Array.from({ length: LEARNED_MAX + 3 }, (_, index) => [`image${index}:1`, daysAgo(index / 100)]));
  const wanted = w.seed.wantedImages(REPO);
  assert.equal(wanted.length, LEARNED_MAX);
  assert.equal(wanted[0], 'image0:1');
  assert.equal(wanted.includes(`image${LEARNED_MAX}:1`), false);
});

test('copying runs at the same time, refreshing only alone', async () => {
  const w = world();
  const order = [];
  const gates = [];
  const work = (name) => () => new Promise((resolve) => { order.push(`${name} begins`); gates.push(() => { order.push(`${name} ends`); resolve(name); }); });
  const first = w.seed.withSeed(REPO, false, work('Copy 1'));
  const second = w.seed.withSeed(REPO, false, work('Copy 2'));
  const refresh = w.seed.withSeed(REPO, true, work('Refresh'));
  const other = w.seed.withSeed('owner/Other', true, work('other repo'));
  await settle();
  assert.deepEqual(order, ['Copy 1 begins', 'Copy 2 begins', 'other repo begins']);

  gates[0]();
  await settle();
  assert.equal(order.includes('Refresh begins'), false); // the second copy is still running
  gates[1]();
  await settle();
  assert.equal(order.at(-1), 'Refresh begins');

  // While refreshing, a new copy waits as well.
  const third = w.seed.withSeed(REPO, false, work('Copy 3'));
  await settle();
  assert.equal(order.includes('Copy 3 begins'), false);
  gates[3]();
  await settle();
  assert.equal(order.at(-1), 'Copy 3 begins');
  gates[4]();
  gates[2]();
  assert.deepEqual(await Promise.all([first, second, refresh, third, other]), ['Copy 1', 'Copy 2', 'Refresh', 'Copy 3', 'other repo']);
  assert.ok(w.slept.every((ms) => ms === 500));
});

test('if work on the template fails, it is free again afterwards', async () => {
  const w = world();
  await assert.rejects(w.seed.withSeed(REPO, true, async () => { throw new Error('broken'); }), /broken/);
  await assert.rejects(w.seed.withSeed(REPO, false, async () => { throw new Error('also broken'); }), /also broken/);
  assert.equal(await w.seed.withSeed(REPO, true, async () => 'free'), 'free');
  assert.deepEqual(w.slept, []);
});

test('without wanted images the template goes away', async () => {
  const w = world();
  w.pool.seeded = new Set(['old:1']);
  await w.seed.refreshSeed(REPO);
  assert.deepEqual(w.calls, [`rm -f -v ${LOADER}`, `volume rm -f ${SEED}`]);
  assert.deepEqual([...w.pool.seeded], []);
  assert.deepEqual(w.logs, []);
  assert.equal(w.saved, 0);
});

test('refreshing pulls what is wanted, removes what is outdated and records what is in the template', async () => {
  const w = world();
  w.settings.preload = ['fixed:1'];
  w.state.learned[REPO] = { 'new:1': daysAgo(1), 'forgotten:1': daysAgo(LEARNED_DAYS + 1) };
  w.state.rejected[REPO] = { 'long-ago:1': daysAgo(LEARNED_DAYS + 1), 'recent:1': daysAgo(1) };
  w.answer = (name) => (name === 'exec image ls' ? { stdout: 'fixed:1\nnew:1\nforgotten:1\n<none>:<none>\n' } : undefined);
  await w.seed.refreshSeed(REPO);
  assert.deepEqual(w.calls, [
    `rm -f -v ${LOADER}`, `volume create ${SEED}`, 'run prepare', `run ${LOADER}`, 'exec info',
    'exec pull fixed:1', 'exec pull new:1', 'exec image ls', 'exec rmi forgotten:1', 'exec image prune',
    `stop ${LOADER}`, `rm -v ${LOADER}`,
  ]);
  const loader = w.details.find((call) => call.name === `run ${LOADER}`).args;
  // Without privileges like the daemon of a pair; a template from the time with privileges is cleared once first.
  assert.deepEqual(loader, ['run', '-d', '--label', MARK, '--name', LOADER, ...DAEMON_FLAGS, '-v', `${SEED}:${DATA_ROOT}`, 'dind:test', ...DAEMON_COMMAND]);
  assert.deepEqual(w.details.find((call) => call.name === 'run prepare').args, ['run', '--rm', '-v', `${SEED}:/d`, '--user', '0', '--entrypoint', 'sh', 'dind:test', '-c',
    '[ "$(stat -c %u /d)" = 1001 ] || { find /d -mindepth 1 -delete; chown 1001:1001 /d; }']);
  assert.equal(loader.includes('--privileged'), false);
  assert.equal(w.details.find((call) => call.name === 'exec pull fixed:1').options.timeout, 1234);
  assert.deepEqual([...w.pool.seeded], ['fixed:1', 'new:1']);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['new:1']);
  assert.deepEqual(Object.keys(w.state.rejected[REPO]), ['recent:1']);
  assert.equal(w.saved, 1);
  assert.deepEqual(w.logs, [['Refreshing the template (2 images) …', REPO]]);
});

test('a disruption while pulling leaves in the template what is already there, and all of what was learned', async () => {
  const w = world();
  w.state.learned[REPO] = { 'here:1': daysAgo(1), 'missing:1': daysAgo(2) };
  w.answer = (name) => {
    if (name.startsWith('exec pull')) return { code: 1, stderr: BUSY };
    if (name === 'exec image ls') return { stdout: 'here:1\n' };
    return undefined;
  };
  await w.seed.refreshSeed(REPO);
  assert.deepEqual([...w.pool.seeded], ['here:1']);
  assert.equal(w.calls.some((name) => name.startsWith('exec rmi')), false);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['here:1', 'missing:1']);
  assert.deepEqual(w.state.rejected, {});
  assert.deepEqual(w.logs.slice(1), [[`here:1 does not go into the template – ${BUSY}`, REPO, 'error'], [`missing:1 does not go into the template – ${BUSY}`, REPO, 'error']]);
});

test('what the registry does not have is rejected, forgotten and removed from the template', async () => {
  const w = world();
  w.state.learned[REPO] = { 'gone:1': daysAgo(1), 'good:1': daysAgo(2) };
  w.answer = (name) => {
    if (name === 'exec pull gone:1') return { code: 1, stderr: GONE };
    if (name === 'exec image ls') return { stdout: 'gone:1\ngood:1\n' };
    return undefined;
  };
  await w.seed.refreshSeed(REPO);
  assert.deepEqual([...w.pool.seeded], ['good:1']);
  assert.ok(w.calls.includes('exec rmi gone:1'));
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['good:1']);
  assert.deepEqual(Object.keys(w.state.rejected[REPO]), ['gone:1']);
  assert.equal(w.saved, 1);
});

test('if RunClub ends while the loader daemon starts, the refresh stops quietly', async () => {
  const w = world();
  w.pool.seeded = new Set(['old:1']);
  w.state.learned[REPO] = { 'new:1': daysAgo(1) };
  w.answer = (name) => { if (name === 'exec info') { w.stopping = true; return { code: 1 }; } return undefined; };
  await w.seed.refreshSeed(REPO);
  assert.equal(w.calls.filter((name) => name === 'exec info').length, 1);
  assert.equal(w.calls.at(-1), `rm -f -v ${LOADER}`);
  assert.deepEqual(w.logs.filter((entry) => entry[2] === 'error'), []);
  assert.deepEqual([...w.pool.seeded], ['old:1']);
  assert.equal(w.saved, 0);
});

test('if the loader daemon does not become ready, everything stays as it is', async () => {
  const w = world();
  w.pool.seeded = new Set(['old:1']);
  w.state.learned[REPO] = { 'new:1': daysAgo(1) };
  w.answer = (name) => (name === 'exec info' ? { code: 1 } : undefined);
  await assert.rejects(w.seed.refreshSeed(REPO), /The loader daemon did not become ready/);
  assert.equal(w.calls.filter((name) => name === 'exec info').length, READY_TRIES);
  assert.equal(w.calls.at(-1), `rm -f -v ${LOADER}`);
  assert.equal(w.calls.some((name) => name.startsWith('exec pull')), false);
  assert.deepEqual([...w.pool.seeded], ['old:1']);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['new:1']);
  assert.equal(w.saved, 0);
  // Afterwards the template is free again.
  assert.equal(await w.seed.withSeed(REPO, true, async () => 'free'), 'free');
});

test('refreshing for a repo whose pool is already gone does not fail', async () => {
  const w = world();
  w.settings = { repo: 'owner/Gone', preload: ['fixed:1'] };
  const seed = createSeed({
    docker: async (args) => { w.calls.push(brief(args)); return { code: 0, stdout: '', stderr: '' }; },
    dockerList: async () => [], log: () => {}, sleep: turn, mark: MARK, dind: 'dind:test', longTimeout: 1,
    settingsOf: () => w.settings, seedVolume: () => SEED, poolOf: () => undefined, state: w.state, saveState: () => { w.saved += 1; },
  });
  await seed.refreshSeed('owner/Gone');
  assert.equal(w.saved, 1);
});

test('after a job, what it pulled itself is learned', async () => {
  const w = world();
  w.pool.seeded = new Set(['copied:1', 'known:1']);
  w.state.learned[REPO] = { 'copied:1': daysAgo(5), 'known:1': daysAgo(5) };
  w.state.rejected[REPO] = { 'rejected:1': daysAgo(1), 'long-rejected:1': daysAgo(LEARNED_DAYS + 1) };
  w.answer = (name) => (name === 'exec image ls' ? { stdout: 'copied:1\nknown:1\nrejected:1\nlong-rejected:1\n<none>:<none>\nLarge:1\nknown:1\n\n' } : undefined);
  const before = w.state.learned[REPO]['copied:1'];
  await w.seed.learnImages(w.pool, { base: 'rc-app-1', copied: new Set(['copied:1']) });
  assert.deepEqual(w.details[0].args, ['exec', 'rc-app-1-dind', 'docker', '-H', 'unix:///sock/docker.sock', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  // What came from the template keeps its date; what the job pulled itself gets a new one.
  assert.equal(w.state.learned[REPO]['copied:1'], before);
  assert.ok(w.state.learned[REPO]['known:1'] > before);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['copied:1', 'known:1', 'long-rejected:1']);
  assert.equal(w.saved, 1);
  // `long-rejected:1` is not in the template: it is refreshed.
  await settle();
  assert.ok(w.calls.includes('exec pull long-rejected:1'));
});

test('if everything pulled is already in the template, it is not refreshed', async () => {
  const w = world();
  w.pool.seeded = new Set(['known:1']);
  w.answer = (name) => (name === 'exec image ls' ? { stdout: 'known:1\n' } : undefined);
  await w.seed.learnImages(w.pool, { base: 'rc-app-1', copied: new Set() });
  await settle();
  assert.deepEqual(w.calls, ['exec image ls']);
  assert.deepEqual(Object.keys(w.state.learned[REPO]), ['known:1']);
});

test('if the job’s Docker daemon does not answer, nothing is learned', async () => {
  const w = world();
  w.answer = () => ({ code: 1, stdout: 'new:1\n' });
  await w.seed.learnImages(w.pool, { base: 'rc-app-1' });
  assert.deepEqual(w.state.learned, {});
  assert.equal(w.saved, 0);
});

test('two jobs with something new in quick succession refresh the template only once; an error doing so is in the log', async () => {
  const w = world();
  w.answer = (name) => {
    if (name === 'exec image ls') return { stdout: 'new:1\n' };
    if (name === 'exec info') return { code: 1 };
    return undefined;
  };
  await w.seed.learnImages(w.pool, { base: 'rc-app-1' });
  await w.seed.learnImages(w.pool, { base: 'rc-app-2' });
  await settle();
  for (let turns = 0; turns < 200; turns += 1) await turn();
  assert.equal(w.calls.filter((name) => name === `run ${LOADER}`).length, 1);
  assert.deepEqual(w.logs.at(-1), ['Template – The loader daemon did not become ready; the template stays as it is.', REPO, 'error']);
  // Afterwards the way is clear again for the next refresh.
  await w.seed.learnImages(w.pool, { base: 'rc-app-3' });
  await settle();
  assert.equal(w.calls.filter((name) => name === `run ${LOADER}`).length, 2);
});

test('forgetting deletes what was learned and the template once no copy runs; what cannot be deleted throws', async () => {
  const w = world();
  w.state.learned[REPO] = { 'node:22': daysAgo(1) };
  w.state.rejected[REPO] = { 'own:1': daysAgo(1) };
  w.pool.seeded = new Set(['node:22']);
  let copying = null;
  const copy = w.seed.withSeed(REPO, false, () => new Promise((resolve) => { copying = resolve; }));
  const forgotten = w.seed.forget(REPO);
  await turn();
  assert.deepEqual(w.calls, []); // the copy is still running
  copying();
  await copy;
  await forgotten;
  assert.deepEqual(w.calls, [`volume rm -f ${SEED}`]);
  assert.deepEqual([w.state.learned[REPO], w.state.rejected[REPO], [...w.pool.seeded]], [undefined, undefined, []]);
  assert.equal(w.saved, 1);

  w.answer = () => ({ code: 1, stderr: 'Error response from daemon: volume is in use\n' });
  await assert.rejects(w.seed.forget(REPO), { message: 'Could not delete the template – Error response from daemon: volume is in use' });
});

test('the template of a pool that is being removed is no longer refreshed', async () => {
  const w = world();
  w.state.learned[REPO] = { 'node:22': daysAgo(1) };
  w.pool.removed = true;
  await w.seed.refreshSeed(REPO);
  assert.deepEqual(w.calls, []);
});
