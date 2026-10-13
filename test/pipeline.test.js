const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPipelines } = require('../src/pipeline');

const REPO = 'wer/was';
const iso = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
const job = (name, values) => ({ name, labels: ['self-hosted', 'Linux'], html_url: 'https://example.invalid', steps: [], ...values });
const done = (name, duration) => job(name, { status: 'completed', conclusion: 'success', created_at: iso(-600), started_at: iso(-598), completed_at: iso(-598 + duration) });

// Ein früherer Lauf (Nr. 1) liefert die üblichen Dauern, Lauf Nr. 2 ist unterwegs.
function setup(activeJobs) {
  const jobsOf = { 1: [done('Kurz', 10), done('Lang', 100), done('Später', 50)], 2: activeJobs };
  const gh = async (args) => ({ jobs: jobsOf[args[1].match(/runs\/(\d+)\/jobs/)[1]] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
  const runs = [
    { id: 2, name: 'CI', status: 'in_progress', conclusion: null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', run_started_at: iso(-60) },
    { id: 1, name: 'CI', status: 'completed', conclusion: 'success', event: 'push' },
  ];
  return { pipelines: createPipelines({ gh, dataDir }), runs, dataDir };
}
const left = (finishAt) => Math.round((new Date(finishAt) - Date.now()) / 1000);

test('lernt die übliche Dauer und die Wartezeit aus abgeschlossenen Läufen', async () => {
  const { pipelines, runs, dataDir } = setup([]);
  await pipelines.refresh(REPO, runs);
  const history = JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8'))[REPO];
  assert.deepEqual(history.durations['CI / Lang'], [100]);
  assert.deepEqual(history.jobsOf.CI, ['Kurz', 'Lang', 'Später']);
  assert.deepEqual(pipelines.waitOf(REPO), { usual: 2, longest: 2, jobs: 3 });
});

test('ein laufender Job ist fertig, wenn seine übliche Dauer um ist', async () => {
  const { pipelines, runs } = setup([job('Lang', { status: 'in_progress', conclusion: null, started_at: iso(-40), completed_at: null })]);
  await pipelines.refresh(REPO, runs);
  const [pipeline] = pipelines.view(REPO, 4);
  assert.equal(left(pipeline.jobs.find((j) => j.name === 'Lang').finishAt), 60);
});

test('wartende Jobs stellen sich hinter die laufenden, wenn es nur einen Platz gibt', async () => {
  const active = [
    job('Lang', { status: 'in_progress', conclusion: null, started_at: iso(-40), completed_at: null }),
    job('Kurz', { status: 'queued', conclusion: null, started_at: iso(-5), completed_at: null }),
  ];
  const { pipelines, runs } = setup(active);
  await pipelines.refresh(REPO, runs);
  const finish = (slots, name) => left(pipelines.view(REPO, slots)[0].jobs.find((j) => j.name === name).finishAt);
  assert.equal(finish(4, 'Kurz'), 10); // freier Platz: sofort
  assert.equal(finish(1, 'Kurz'), 60 + 8 + 10); // erst läuft „Lang“ aus, dann der Wechsel des Platzes
});

test('kündigt Jobs an, die GitHub noch nicht angelegt hat', async () => {
  const { pipelines, runs } = setup([done('Kurz', 10)]);
  await pipelines.refresh(REPO, runs);
  const [pipeline] = pipelines.view(REPO, 4);
  assert.deepEqual(pipeline.jobs.filter((j) => j.status === 'pending').map((j) => j.name), ['Lang', 'Später']);
  assert.equal(left(pipeline.finishAt), 100);
});

test('ohne freien Platz gibt es keine Restzeit', async () => {
  const { pipelines, runs } = setup([job('Kurz', { status: 'queued', conclusion: null, started_at: iso(-5), completed_at: null })]);
  await pipelines.refresh(REPO, runs);
  assert.equal(pipelines.view(REPO, 0)[0].finishAt, null);
});

const { parseWorkflow, stagesOf } = require('../src/pipeline');

const WORKFLOW = `name: CI
on: [push]
jobs:
  changes:
    name: Berührte Bereiche
    runs-on: x
    steps:
      - name: irgendein Schritt
        run: echo
  build:
    name: "Build und Tests"   # Kommentar
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

test('liest Namen und Abhängigkeiten aus einer Workflow-Datei', () => {
  assert.deepEqual(parseWorkflow(WORKFLOW), [
    { id: 'changes', name: 'Berührte Bereiche', needs: [] },
    { id: 'build', name: 'Build und Tests', needs: ['changes'] },
    { id: 'lint', name: 'lint', needs: ['changes'] },
    { id: 'smoke', name: 'Smoke-Test', needs: ['build', 'lint'] },
  ]);
});

test('ordnet Jobs nach ihren Abhängigkeiten in Stufen', () => {
  const jobs = [{ name: 'c', needs: ['b'] }, { name: 'a', needs: [] }, { name: 'b', needs: ['a'] }, { name: 'd', needs: ['a', 'c'] }];
  stagesOf(jobs);
  assert.deepEqual(jobs.map((job) => [job.name, job.stage]), [['c', 2], ['a', 0], ['b', 1], ['d', 3]]);
});

test('mit Workflow-Datei: Abhängigkeiten, spätere Jobs und Restzeit in der richtigen Reihenfolge', async () => {
  const jobsOf = {
    1: [done('Berührte Bereiche', 10), done('Build und Tests', 100), done('lint', 20), done('Smoke-Test', 50)],
    2: [done('Berührte Bereiche', 10), job('Build und Tests', { status: 'in_progress', conclusion: null, started_at: iso(-40), completed_at: null }), job('lint', { status: 'queued', conclusion: null, started_at: iso(-5), completed_at: null })],
  };
  const gh = async (args) => args[1].includes('/contents/') ? { content: Buffer.from(WORKFLOW).toString('base64') } : { jobs: jobsOf[args[1].match(/runs\/(\d+)\/jobs/)[1]] };
  const pipelines = createPipelines({ gh, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  const run = { name: 'CI', event: 'push', head_branch: 'main', html_url: 'https://example.invalid', path: '.github/workflows/ci.yml', head_sha: 'abc' };
  await pipelines.refresh(REPO, [{ ...run, id: 2, status: 'in_progress', conclusion: null, run_started_at: iso(-60) }, { ...run, id: 1, status: 'completed', conclusion: 'success', updated_at: 'x' }]);
  const [pipeline] = pipelines.view(REPO, 4);
  const smoke = pipeline.jobs.find((j) => j.name === 'Smoke-Test');
  assert.equal(smoke.status, 'pending');
  assert.deepEqual(smoke.needs, ['Build und Tests', 'lint']);
  assert.deepEqual(pipeline.jobs.map((j) => j.stage), [0, 1, 1, 2]);
  assert.equal(left(smoke.finishAt), 60 + 50); // erst wenn „Build und Tests“ fertig ist
  assert.equal(pipelines.lastOf(REPO).jobs.length, 4);
});

// Jobs, die bei GitHub anders heißen als in der Datei: Ausdruck im Namen, Matrix ohne Namen, aufgerufener Workflow.
const RENAMED = `name: CI
on: [push]
jobs:
  prepare:
    name: Vorbereiten
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
    name: Ausliefern
    needs: [test, lint]
    uses: ./.github/workflows/deploy.yml
  check:
    name: Test
    needs: prepare
    steps:
      - uses: actions/checkout@v4
`;
const EXPR = 'Test ${{ matrix.os }}';

async function renamed(activeJobs) {
  const gh = async (args) => args[1].includes('/contents/') ? { content: Buffer.from(RENAMED).toString('base64') } : { jobs: activeJobs };
  const pipelines = createPipelines({ gh, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  await pipelines.refresh(REPO, [{ id: 2, name: 'CI', status: 'in_progress', conclusion: null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', path: '.github/workflows/ci.yml', head_sha: 'abc', run_started_at: iso(-60) }]);
  const [pipeline] = pipelines.view(REPO, 4);
  return { pipeline, pending: pipeline.jobs.filter((j) => j.status === 'pending').map((j) => j.name), needs: (name) => pipeline.jobs.find((j) => j.name === name).needs };
}

test('erkennt nur am Job selbst, dass er einen Workflow aufruft', () => {
  assert.deepEqual(parseWorkflow(RENAMED).map((j) => [j.id, j.uses ?? false]), [['prepare', false], ['test', false], ['lint', false], ['deploy', true], ['check', false]]);
});

test('solange GitHub nichts Passendes liefert, bleiben die angekündigten Jobs stehen', async () => {
  const { pending, needs } = await renamed([done('Vorbereiten', 10)]);
  assert.deepEqual(pending, [EXPR, 'lint', 'Ausliefern', 'Test']);
  assert.deepEqual(needs('Ausliefern'), [EXPR, 'lint']);
});

test('Ausdruck im Namen: die ausgewerteten Jobs lösen den angekündigten ab', async () => {
  const { pending, needs } = await renamed([done('Vorbereiten', 10), done('Test ubuntu-latest', 10), done('Test windows-latest', 10)]);
  assert.deepEqual(pending, ['lint', 'Ausliefern', 'Test']);
  assert.deepEqual(needs('Test windows-latest'), ['Vorbereiten']);
  assert.deepEqual(needs('Ausliefern'), ['Test ubuntu-latest', 'Test windows-latest', 'lint']);
});

test('Matrix ohne Namen: „Job (Wert)“ löst den angekündigten Job ab', async () => {
  const { pending, needs } = await renamed([done('Vorbereiten', 10), done('lint (18)', 10), done('lint (20)', 10)]);
  assert.deepEqual(pending, [EXPR, 'Ausliefern', 'Test']);
  assert.deepEqual(needs('lint (20)'), ['Vorbereiten']);
  assert.deepEqual(needs('Ausliefern'), [EXPR, 'lint (18)', 'lint (20)']);
});

test('aufgerufener Workflow: seine Jobs lösen den Aufruf ab und erben dessen Abhängigkeiten', async () => {
  const all = [done('Vorbereiten', 10), done('Test ubuntu-latest', 10), done('Test windows-latest', 10), done('lint (18)', 10), done('lint (20)', 10), done('Test', 10), done('Ausliefern / Bauen', 10), done('Ausliefern / Hochladen', 10)];
  const { pipeline, pending, needs } = await renamed(all);
  assert.deepEqual(pending, []);
  assert.deepEqual(needs('Ausliefern / Hochladen'), ['Test ubuntu-latest', 'Test windows-latest', 'lint (18)', 'lint (20)']);
  assert.equal(pipeline.jobs.length, all.length);
  assert.equal(left(pipeline.finishAt) || 0, 0); // kein Phantom-Job mehr, der die Restzeit verlängert (eine Rundung knapp unter null ergibt -0)
});

test('ein Job schluckt keinen fremden mit ähnlichem Namen', async () => {
  const strangers = ['Tests bauen', 'lint / Docker', 'Ausliefern (alt)', 'lint-fix (18)'];
  const { pending, needs } = await renamed([done('Vorbereiten', 10), ...strangers.map((name) => done(name, 10))]);
  assert.deepEqual(pending, [EXPR, 'lint', 'Ausliefern', 'Test']);
  for (const name of strangers) assert.deepEqual(needs(name), []);
  // „Test“ gehört zum Job, der genau so heißt – nicht zum Job mit dem Ausdruck im Namen.
  assert.deepEqual((await renamed([done('Vorbereiten', 10), done('Test', 10)])).pending, [EXPR, 'lint', 'Ausliefern']);
});

test('viele Ausdrücke im Namen werden nicht zum teuren Muster', async () => {
  const { matcherOf } = require('../src/pipeline');
  const long = 'a'.repeat(400) + '!';
  const started = Date.now();
  assert.equal(matcherOf({ name: '${{ a }}${{ b }}${{ c }}${{ d }}${{ e }}${{ f }}x' }).test(long), false);
  assert.equal(matcherOf({ name: 'T ${{ a }} ${{ b }} ${{ c }} ${{ d }} ${{ e }} z' }).test(`T ${long}`), false);
  assert.ok(Date.now() - started < 500);
  // Ausdrücke direkt hintereinander zählen als einer und passen weiter.
  assert.equal(matcherOf({ name: 'Test ${{ a }}${{ b }}' }).test('Test ubuntu 20'), true);
});
