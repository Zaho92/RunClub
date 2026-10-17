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
  const github = { get: async (url) => ({ jobs: jobsOf[url.match(/runs\/(\d+)\/jobs/)[1]] }) };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-'));
  const runs = [
    { id: 2, name: 'CI', status: 'in_progress', conclusion: null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', run_started_at: iso(-60) },
    { id: 1, name: 'CI', status: 'completed', conclusion: 'success', event: 'push' },
  ];
  return { pipelines: createPipelines({ github, dataDir }), runs, dataDir };
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

test('ein früher gestarteter Lauf, der nach einem späteren endet, bleibt einige Abfragen lang zum Bestätigen da', async () => {
  const jobsOf = { 3: [done('Spät', 10)], 4: [done('Früh', 10)] };
  const github = { get: async (url) => ({ jobs: jobsOf[url.match(/runs\/(\d+)\/jobs/)[1]] }) };
  const pipelines = createPipelines({ github, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  const run = (id, status) => ({ id, name: 'CI', status, conclusion: status === 'completed' ? 'success' : null, event: 'push', head_branch: 'main', html_url: 'https://example.invalid', updated_at: status });
  // Lauf 4 ist der jüngere und schon fertig, Lauf 3 läuft noch und endet erst danach.
  await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'in_progress')]);
  assert.deepEqual(pipelines.finishedOf(REPO), []);
  await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'completed')]);
  assert.equal(pipelines.lastOf(REPO).id, 4);
  assert.deepEqual(pipelines.finishedOf(REPO).map((p) => [p.id, p.jobs.map((j) => j.name)]), [[3, ['Spät']]]);
  for (let round = 1; round < 6; round += 1) await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'completed')]);
  assert.equal(pipelines.finishedOf(REPO).length, 1); // sechs Abfragen lang, die erste eingerechnet
  await pipelines.refresh(REPO, [run(4, 'completed'), run(3, 'completed')]);
  assert.deepEqual(pipelines.finishedOf(REPO), []);
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
  const github = { get: async (url) => url.includes('/contents/') ? { content: Buffer.from(WORKFLOW).toString('base64') } : { jobs: jobsOf[url.match(/runs\/(\d+)\/jobs/)[1]] } };
  const pipelines = createPipelines({ github, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
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
const EXPR = 'Test …'; // so heißt `Test ${{ matrix.os }}`, solange GitHub den Job nicht angelegt hat

// `durations`: schon gelernte Dauern des Workflows „CI“, Jobname -> Sekunden.
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

test('ein Ausdruck im Namen steht nie für „ / “ und darf leer sein', () => {
  const { matcherOf } = require('../src/pipeline');
  const test = matcherOf({ name: 'Test ${{ matrix.os }}' });
  assert.equal(test.test('Test ubuntu-latest'), true);
  assert.equal(test.test('Test'), true); // der Ausdruck ergab nichts
  assert.equal(test.test('Test (18)'), true);
  assert.equal(test.test('Test / Docker'), false); // gehört zu einem fremden Aufruf
  assert.equal(test.test('Tests bauen'), false);
  const middle = matcherOf({ name: 'Bau ${{ inputs.ziel }} fertig' });
  assert.deepEqual(['Bau x fertig', 'Bau fertig', 'Bau  fertig', 'Baufertig', 'Bau xfertig'].map((name) => middle.test(name)), [true, true, true, false, false]);
  const call = matcherOf({ name: 'Ausliefern ${{ inputs.ziel }}', uses: true });
  assert.equal(call.test('Ausliefern / Bauen'), true);
  assert.equal(call.test('Ausliefern prod / Bauen'), true);
  assert.equal(call.test('Ausliefern prod'), false);
});

test('ein angekündigter Job hat die Dauer der passenden gelernten Jobs', async () => {
  const { pipeline } = await renamed([done('Vorbereiten', 10)], { 'Test ubuntu-latest': [100], 'Test windows-latest': [200, 300], 'lint (18)': [40], Vorbereiten: [10], 'Ausliefern / Bauen': [30] });
  const estimate = (name) => pipeline.jobs.find((j) => j.name === name).estimate;
  assert.equal(estimate(EXPR), 200);
  assert.equal(estimate('lint'), 40);
  assert.equal(estimate('Ausliefern'), null); // ein Aufruf läuft als mehrere Jobs: Einer davon sagt nichts über die Dauer
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

test('Lauf und Job tragen ihre Kennung von GitHub, damit sie sich erneut starten lassen; ein angekündigter Job hat keine', async () => {
  const { runs } = setup([]);
  const github = { get: async (url) => ({ jobs: url.includes('runs/1/') ? [{ ...done('Kurz', 10), id: 71 }, { ...done('Lang', 100), id: 72 }] : [{ ...done('Kurz', 10), id: 115542192486 }] }) };
  const withIds = createPipelines({ github, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-test-')) });
  await withIds.refresh(REPO, runs);
  const [active] = withIds.view(REPO, 4);
  assert.equal(active.id, 2);
  assert.deepEqual(active.jobs.map((j) => [j.name, j.id]), [['Kurz', 115542192486], ['Lang', null]]);
  const last = withIds.lastOf(REPO);
  assert.equal(last.id, 1);
  assert.deepEqual(last.jobs.map((j) => [j.name, j.id]), [['Kurz', 71], ['Lang', 72]]);
});
