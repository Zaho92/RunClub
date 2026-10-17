const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouting, usage, pointsHere, VALUE } = require('../src/routing');
const { GitHubError } = require('../src/github');

test('recognizes how workflows decide their target', () => {
  assert.equal(usage([`runs-on: \${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}`]), 'variable');
  assert.equal(usage(['jobs:\n  a:\n    runs-on: [self-hosted, Linux]\n']), 'fixed');
  assert.equal(usage(['jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - Linux\n']), 'fixed');
  assert.equal(usage(['jobs:\n  a:\n    runs-on: ubuntu-latest\n']), 'none');
  assert.equal(usage([]), 'none');
});

test('recognizes whether the variable points to your own runners', () => {
  assert.equal(pointsHere(VALUE), true);
  assert.equal(pointsHere('["Linux", "Self-Hosted"]'), true);
  assert.equal(pointsHere('"ubuntu-latest"'), false);
  assert.equal(pointsHere('not json'), false);
});

// GitHub simulated: one variable and one workflow folder per repo.
function fakeGitHub(variable) {
  const calls = [];
  const get = async (url) => {
    calls.push(`get ${url}`);
    if (url.endsWith('/actions/variables/CI_RUNNER')) {
      if (variable == null) throw new GitHubError(404, 'Not Found');
      return { name: 'CI_RUNNER', value: variable };
    }
    if (url.endsWith('/contents/.github/workflows')) return [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }, { name: 'README.md', path: '.github/workflows/README.md' }];
    return { content: Buffer.from('runs-on: ${{ fromJSON(vars.CI_RUNNER) }}').toString('base64') };
  };
  const send = async (method, url, body) => {
    calls.push(`send ${method} ${url}`);
    if (method === 'DELETE') variable = null;
    else variable = body.value;
    return null;
  };
  return { github: { get, send }, calls, value: () => variable, put: (value) => { variable = value; } };
}

test('creates the variable if it does not exist, and removes it again', async () => {
  const fake = fakeGitHub(null);
  const routing = createRouting({ github: fake.github });
  assert.deepEqual(await routing.check('who/what'), { value: null, here: false, uses: 'variable', error: null });
  await routing.set('who/what', true);
  assert.equal(fake.value(), VALUE);
  assert.equal(routing.of('who/what').here, true);
  assert.ok(fake.calls.includes('send POST repos/who/what/actions/variables'));
  await routing.set('who/what', false);
  assert.equal(fake.value(), null);
  assert.equal(routing.of('who/what').here, false);
});

test('overwrites an existing variable instead of creating it twice', async () => {
  const fake = fakeGitHub('"ubuntu-latest"');
  const routing = createRouting({ github: fake.github });
  assert.equal((await routing.check('who/what')).here, false);
  await routing.set('who/what', true);
  assert.equal(fake.value(), VALUE);
  assert.ok(fake.calls.includes('send PATCH repos/who/what/actions/variables/CI_RUNNER'));
});

test('reads the state fresh before writing: set by hand does not lead to creating it twice', async () => {
  const fake = fakeGitHub(null);
  const routing = createRouting({ github: fake.github });
  await routing.check('who/what');
  fake.put('"ubuntu-latest"'); // created by hand at GitHub in the meantime
  await routing.set('who/what', true);
  assert.equal(fake.value(), VALUE);
  assert.ok(fake.calls.includes('send PATCH repos/who/what/actions/variables/CI_RUNNER'));
  assert.ok(!fake.calls.includes('send POST repos/who/what/actions/variables'));
});

test('without a readable state nothing is written and nothing reported as done', async () => {
  const calls = [];
  const fail = () => { throw new Error('The GitHub rate limit is used up; continuing at 17:05.'); };
  const github = { get: async (url) => { calls.push(`get ${url}`); fail(); }, send: async (method, url) => { calls.push(`send ${method} ${url}`); fail(); } };
  const routing = createRouting({ github });
  await assert.rejects(routing.set('who/what', false), /rate limit/);
  assert.ok(calls.every((call) => !call.startsWith('send')));
  assert.match(routing.of('who/what').error, /rate limit/);
});
