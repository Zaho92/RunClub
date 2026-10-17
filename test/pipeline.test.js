const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPipelines } = require('../src/pipeline');

const REPO = 'owner/repo';
const iso = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
const job = (name, values) => ({ name, labels: ['self-hosted', 'Linux'], html_url: 'https://example.invalid', steps: [], ...values });
const done = (name, duration) => job(name, { status: 'completed', conclusion: 'success', created_at: iso(-600), started_at: iso(-598), completed_at: iso(-598 + duration) });

// An earlier run (no. 1) provides the usual durations, run no. 2 is under way.
function setup(activeJobs) {
  const jobsOf = { 1: [done('Short', 10), done('Long', 100), done('Later', 50)], 2: activeJobs };
  const github = { get: async (url) => ({ jobs: jobsOf[url.match(/runs\/(\d+)\/jobs/)[1]] }) };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
  const runs = [
    { id: 2, name: 'CI', status: 'in_progress', conclusion: null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', run_started_at: iso(-60) },
    { id: 1, name: 'CI', status: 'completed', conclusion: 'success', event: 'push' },
  ];
  return { pipelines: createPipelines({ github, dataDir }), runs, dataDir };
}
const left = (finishAt) => Math.round((new Date(finishAt) - Date.now()) / 1000);

test('learns the usual duration and the wait time from completed runs', async () => {
  const { pipelines, runs, dataDir } = setup([]);
  await pipelines.refresh(REPO, runs);
  const history = JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8'))[REPO];
  assert.deepEqual(history.durations['CI / Long'], [100]);
  assert.deepEqual(history.jobsOf.CI, ['Short', 'Long', 'Later']);
  assert.deepEqual(pipelines.waitOf(REPO), { usual: 2, longest: 2, jobs: 3 });
});

test('a run started earlier that ends after a later one stays around for a few queries to confirm', async () => {
  const jobsOf = { 3: [done('Late', 10)], 4: [done('Early', 10)] };
  const github = { get: async (url) => ({ jobs: jobsOf[url.match(/runs\/(\d+)\/jobs/)[1]] }) };
  const pipelines = createPipelines({ github, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  const run = (id, status) => ({ id, name: 'CI', status, conclusion: status === 'completed' ? 'success' : null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', updated_at: status });
  // Run 4 is the newer one and already finished, run 3 is still running and only ends afterwards.
  await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'in_progress')]);
  assert.deepEqual(pipelines.finishedOf(REPO), []);
  await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'completed')]);
  assert.equal(pipelines.lastOf(REPO).id, 4);
  assert.deepEqual(pipelines.finishedOf(REPO).map((p) => [p.id, p.jobs.map((j) => j.name)]), [[3, ['Late']]]);
  for (let round = 1; round < 6; round += 1) await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'completed')]);
  assert.equal(pipelines.finishedOf(REPO).length, 1); // for six queries, the first one included
  await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'completed')]);
  assert.deepEqual(pipelines.finishedOf(REPO), []);
});

test('a running job is done when its usual duration is up', async () => {
  const { pipelines, runs } = setup([job('Long', { status: 'in_progress', conclusion: null, started_at: iso(-40), completed_at: null })]);
  await pipelines.refresh(REPO, runs);
  const [pipeline] = pipelines.view(REPO, 4);
  assert.equal(left(pipeline.jobs.find((j) => j.name === 'Long').finishAt), 60);
});

test('waiting jobs line up behind the running ones when there is only one slot', async () => {
  const active = [
    job('Long', { status: 'in_progress', conclusion: null, started_at: iso(-40), completed_at: null }),
    job('Short', { status: 'queued', conclusion: null, started_at: iso(-5), completed_at: null }),
  ];
  const { pipelines, runs } = setup(active);
  await pipelines.refresh(REPO, runs);
  const finish = (slots, name) => left(pipelines.view(REPO, slots)[0].jobs.find((j) => j.name === name).finishAt);
  assert.equal(finish(4, 'Short'), 10); // free slot: right away
  assert.equal(finish(1, 'Short'), 60 + 8 + 10); // first "Long" runs out, then the slot switches
});

test('announces jobs GitHub has not created yet', async () => {
  const { pipelines, runs } = setup([done('Short', 10)]);
  await pipelines.refresh(REPO, runs);
  const [pipeline] = pipelines.view(REPO, 4);
  assert.deepEqual(pipeline.jobs.filter((j) => j.status === 'pending').map((j) => j.name), ['Long', 'Later']);
  assert.equal(left(pipeline.finishAt), 100);
});

test('without a free slot there is no time left', async () => {
  const { pipelines, runs } = setup([job('Short', { status: 'queued', conclusion: null, started_at: iso(-5), completed_at: null })]);
  await pipelines.refresh(REPO, runs);
  assert.equal(pipelines.view(REPO, 0)[0].finishAt, null);
});

const { parseWorkflow, stagesOf } = require('../src/pipeline');

const WORKFLOW = `name: CI
on: [push]
jobs:
  changes:
    name: Changed areas
    runs-on: x
    steps:
      - name: some step
        run: echo
  build:
    name: "Build and tests"   # comment
    needs: changes
    steps:
      - run: echo
  lint:
    needs: [changes]
  smoke:
    name: Smoke-Test
    needs:
      - build
      - lint
`;

test('reads names and dependencies from a workflow file', () => {
  assert.deepEqual(parseWorkflow(WORKFLOW), [
    { id: 'changes', name: 'Changed areas', needs: [] },
    { id: 'build', name: 'Build and tests', needs: ['changes'] },
    { id: 'lint', name: 'lint', needs: ['changes'] },
    { id: 'smoke', name: 'Smoke-Test', needs: ['build', 'lint'] },
  ]);
});

test('sorts jobs into stages by their dependencies', () => {
  const jobs = [{ name: 'c', needs: ['b'] }, { name: 'a', needs: [] }, { name: 'b', needs: ['a'] }, { name: 'd', needs: ['a', 'c'] }];
  stagesOf(jobs);
  assert.deepEqual(jobs.map((job) => [job.name, job.stage]), [['c', 2], ['a', 0], ['b', 1], ['d', 3]]);
});

test('with a workflow file: dependencies, later jobs and time left in the right order', async () => {
  const jobsOf = {
    1: [done('Changed areas', 10), done('Build and tests', 100), done('lint', 20), done('Smoke-Test', 50)],
    2: [done('Changed areas', 10), job('Build and tests', { status: 'in_progress', conclusion: null, started_at: iso(-40), completed_at: null }), job('lint', { status: 'queued', conclusion: null, started_at: iso(-5), completed_at: null })],
  };
  const github = { get: async (url) => url.includes('/contents/') ? { content: Buffer.from(WORKFLOW).toString('base64') } : { jobs: jobsOf[url.match(/runs\/(\d+)\/jobs/)[1]] } };
  const pipelines = createPipelines({ github, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  const run = { name: 'CI', event: 'push', head_branch: 'main', html_url: 'https://example.invalid', path: '.github/workflows/ci.yml', head_sha: 'abc' };
  await pipelines.refresh(REPO, [{ ...run, id: 2, status: 'in_progress', conclusion: null, run_started_at: iso(-60) }, { ...run, id: 1, status: 'completed', conclusion: 'success', updated_at: 'x' }]);
  const [pipeline] = pipelines.view(REPO, 4);
  const smoke = pipeline.jobs.find((j) => j.name === 'Smoke-Test');
  assert.equal(smoke.status, 'pending');
  assert.deepEqual(smoke.needs, ['Build and tests', 'lint']);
  assert.deepEqual(pipeline.jobs.map((j) => j.stage), [0, 1, 1, 2]);
  assert.equal(left(smoke.finishAt), 60 + 50); // only once "Build and tests" is done
  assert.equal(pipelines.lastOf(REPO).jobs.length, 4);
});

// Jobs named differently at GitHub than in the file: expression in the name, matrix without a name, called workflow.
const RENAMED = `name: CI
on: [push]
jobs:
  prepare:
    name: Prepare
    runs-on: x
  test:
    name: Test \${{ matrix.os }}
    needs: prepare
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
  lint:
    needs: prepare
    strategy:
      matrix:
        node: [18, 20]
  deploy:
    name: Ship
    needs: [test, lint]
    uses: ./.github/workflows/deploy.yml
  check:
    name: Test
    needs: prepare
    steps:
      - uses: actions/checkout@v4
`;
const EXPR = 'Test …'; // what `Test ${{ matrix.os }}` is called while GitHub has not created the job

// `durations`: already learned durations of the workflow "CI", job name -> seconds.
async function renamed(activeJobs, durations = {}) {
  const github = { get: async (url) => url.includes('/contents/') ? { content: Buffer.from(RENAMED).toString('base64') } : { jobs: activeJobs } };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
  const learned = Object.fromEntries(Object.entries(durations).map(([name, values]) => [`CI / ${name}`, values]));
  fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify({ [REPO]: { durations: learned, jobsOf: {}, seen: [] } }));
  const pipelines = createPipelines({ github, dataDir });
  await pipelines.refresh(REPO, [{ id: 2, name: 'CI', status: 'in_progress', conclusion: null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', path: '.github/workflows/ci.yml', head_sha: 'abc', run_started_at: iso(-60) }]);
  const [pipeline] = pipelines.view(REPO, 4);
  return { pipeline, pending: pipeline.jobs.filter((j) => j.status === 'pending').map((j) => j.name), needs: (name) => pipeline.jobs.find((j) => j.name === name).needs };
}

test('only the job itself shows that it calls a workflow', () => {
  assert.deepEqual(parseWorkflow(RENAMED).map((j) => [j.id, j.uses ?? false]), [['prepare', false], ['test', false], ['lint', false], ['deploy', true], ['check', false]]);
});

test('as long as GitHub delivers nothing matching, the announced jobs stay', async () => {
  const { pending, needs } = await renamed([done('Prepare', 10)]);
  assert.deepEqual(pending, [EXPR, 'lint', 'Ship', 'Test']);
  assert.deepEqual(needs('Ship'), [EXPR, 'lint']);
});

test('expression in the name: the evaluated jobs replace the announced one', async () => {
  const { pending, needs } = await renamed([done('Prepare', 10), done('Test ubuntu-latest', 10), done('Test windows-latest', 10)]);
  assert.deepEqual(pending, ['lint', 'Ship', 'Test']);
  assert.deepEqual(needs('Test windows-latest'), ['Prepare']);
  assert.deepEqual(needs('Ship'), ['Test ubuntu-latest', 'Test windows-latest', 'lint']);
});

test('matrix without a name: "job (value)" replaces the announced job', async () => {
  const { pending, needs } = await renamed([done('Prepare', 10), done('lint (18)', 10), done('lint (20)', 10)]);
  assert.deepEqual(pending, [EXPR, 'Ship', 'Test']);
  assert.deepEqual(needs('lint (20)'), ['Prepare']);
  assert.deepEqual(needs('Ship'), [EXPR, 'lint (18)', 'lint (20)']);
});

test('called workflow: its jobs replace the call and inherit its dependencies', async () => {
  const all = [done('Prepare', 10), done('Test ubuntu-latest', 10), done('Test windows-latest', 10), done('lint (18)', 10), done('lint (20)', 10), done('Test', 10), done('Ship / Build', 10), done('Ship / Upload', 10)];
  const { pipeline, pending, needs } = await renamed(all);
  assert.deepEqual(pending, []);
  assert.deepEqual(needs('Ship / Upload'), ['Test ubuntu-latest', 'Test windows-latest', 'lint (18)', 'lint (20)']);
  assert.equal(pipeline.jobs.length, all.length);
  assert.equal(left(pipeline.finishAt) || 0, 0); // no phantom job any more that stretches the time left (rounding just below zero gives -0)
});

test('a job does not swallow a foreign one with a similar name', async () => {
  const strangers = ['Tests nightly', 'lint / Docker', 'Ship (old)', 'lint-fix (18)'];
  const { pending, needs } = await renamed([done('Prepare', 10), ...strangers.map((name) => done(name, 10))]);
  assert.deepEqual(pending, [EXPR, 'lint', 'Ship', 'Test']);
  for (const name of strangers) assert.deepEqual(needs(name), []);
  // "Test" belongs to the job with exactly that name – not to the job with the expression in its name.
  assert.deepEqual((await renamed([done('Prepare', 10), done('Test', 10)])).pending, [EXPR, 'lint', 'Ship']);
});

test('an expression in the name never stands for " / " and may be empty', () => {
  const { matcherOf } = require('../src/pipeline');
  const test = matcherOf({ name: 'Test ${{ matrix.os }}' });
  assert.equal(test.test('Test ubuntu-latest'), true);
  assert.equal(test.test('Test'), true); // the expression yielded nothing
  assert.equal(test.test('Test (18)'), true);
  assert.equal(test.test('Test / Docker'), false); // belongs to a foreign call
  assert.equal(test.test('Tests nightly'), false);
  const middle = matcherOf({ name: 'Build ${{ inputs.target }} done' });
  assert.deepEqual(['Build x done', 'Build done', 'Build  done', 'Builddone', 'Build xdone'].map((name) => middle.test(name)), [true, true, true, false, false]);
  const call = matcherOf({ name: 'Ship ${{ inputs.target }}', uses: true });
  assert.equal(call.test('Ship / Build'), true);
  assert.equal(call.test('Ship prod / Build'), true);
  assert.equal(call.test('Ship prod'), false);
});

test('an announced job has the duration of the matching learned jobs', async () => {
  const { pipeline } = await renamed([done('Prepare', 10)], { 'Test ubuntu-latest': [100], 'Test windows-latest': [200, 300], 'lint (18)': [40], Prepare: [10], 'Ship / Build': [30] });
  const estimate = (name) => pipeline.jobs.find((j) => j.name === name).estimate;
  assert.equal(estimate(EXPR), 200);
  assert.equal(estimate('lint'), 40);
  assert.equal(estimate('Ship'), null); // a call runs as several jobs: one of them says nothing about the duration
});

test('many expressions in the name do not become an expensive pattern', async () => {
  const { matcherOf } = require('../src/pipeline');
  const long = 'a'.repeat(400) + '!';
  const started = Date.now();
  assert.equal(matcherOf({ name: '${{ a }}${{ b }}${{ c }}${{ d }}${{ e }}${{ f }}x' }).test(long), false);
  assert.equal(matcherOf({ name: 'T ${{ a }} ${{ b }} ${{ c }} ${{ d }} ${{ e }} z' }).test(`T ${long}`), false);
  assert.ok(Date.now() - started < 500);
  // Expressions right after each other count as one and still match.
  assert.equal(matcherOf({ name: 'Test ${{ a }}${{ b }}' }).test('Test ubuntu 20'), true);
});

test('run and job carry their GitHub id so they can be re-run; an announced job has none', async () => {
  const { runs } = setup([]);
  const github = { get: async (url) => ({ jobs: url.includes('runs/1/') ? [{ ...done('Short', 10), id: 71 }, { ...done('Long', 100), id: 72 }] : [{ ...done('Short', 10), id: 115542192486 }] }) };
  const withIds = createPipelines({ github, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  await withIds.refresh(REPO, runs);
  const [active] = withIds.view(REPO, 4);
  assert.equal(active.id, 2);
  assert.deepEqual(active.jobs.map((j) => [j.name, j.id]), [['Short', 115542192486], ['Long', null]]);
  const last = withIds.lastOf(REPO);
  assert.equal(last.id, 1);
  assert.deepEqual(last.jobs.map((j) => [j.name, j.id]), [['Short', 71], ['Long', 72]]);
});
