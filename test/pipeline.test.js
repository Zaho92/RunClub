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
