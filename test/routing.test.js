const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouting, usage, pointsHere, VALUE } = require('../src/routing');

test('erkennt, wie Workflows ihr Ziel bestimmen', () => {
  assert.equal(usage([`runs-on: \${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}`]), 'variable');
  assert.equal(usage(['jobs:\n  a:\n    runs-on: [self-hosted, Linux]\n']), 'fixed');
  assert.equal(usage(['jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - Linux\n']), 'fixed');
  assert.equal(usage(['jobs:\n  a:\n    runs-on: ubuntu-latest\n']), 'none');
  assert.equal(usage([]), 'none');
});

test('erkennt, ob die Variable auf die eigenen Runner zeigt', () => {
  assert.equal(pointsHere(VALUE), true);
  assert.equal(pointsHere('["Linux", "Self-Hosted"]'), true);
  assert.equal(pointsHere('"ubuntu-latest"'), false);
  assert.equal(pointsHere('kein json'), false);
});

// GitHub nachgestellt: eine Variable und ein Workflow-Ordner je Repo.
function fakeGitHub(variable) {
  const calls = [];
  const gh = async (args, body) => {
    calls.push(args.filter((a) => a !== 'api').join(' '));
    const url = args.at(-1);
    if (url.endsWith('/actions/variables/CI_RUNNER')) {
      if (args.includes('DELETE')) { variable = null; return null; }
      if (args.includes('PATCH')) { variable = JSON.parse(body).value; return null; }
      if (variable == null) throw new Error('gh: Not Found (HTTP 404)');
      return { name: 'CI_RUNNER', value: variable };
    }
    if (url.endsWith('/actions/variables')) { variable = JSON.parse(body).value; return null; }
    if (url.endsWith('/contents/.github/workflows')) return [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }, { name: 'README.md', path: '.github/workflows/README.md' }];
    return { content: Buffer.from('runs-on: ${{ fromJSON(vars.CI_RUNNER) }}').toString('base64') };
  };
  return { gh, calls, value: () => variable };
}

test('setzt die Variable neu, wenn es sie nicht gibt, und entfernt sie wieder', async () => {
  const github = fakeGitHub(null);
  const routing = createRouting({ gh: github.gh });
  assert.deepEqual(await routing.check('wer/was'), { value: null, here: false, uses: 'variable', error: null });
  await routing.set('wer/was', true);
  assert.equal(github.value(), VALUE);
  assert.equal(routing.of('wer/was').here, true);
  assert.ok(github.calls.includes('-X POST repos/wer/was/actions/variables'));
  await routing.set('wer/was', false);
  assert.equal(github.value(), null);
  assert.equal(routing.of('wer/was').here, false);
});

test('überschreibt eine vorhandene Variable, statt sie doppelt anzulegen', async () => {
  const github = fakeGitHub('"ubuntu-latest"');
  const routing = createRouting({ gh: github.gh });
  assert.equal((await routing.check('wer/was')).here, false);
  await routing.set('wer/was', true);
  assert.equal(github.value(), VALUE);
  assert.ok(github.calls.includes('-X PATCH repos/wer/was/actions/variables/CI_RUNNER'));
});
