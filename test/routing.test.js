const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouting, usage, pointsHere, VALUE } = require('../src/routing');
const { GitHubError } = require('../src/github');

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

test('setzt die Variable neu, wenn es sie nicht gibt, und entfernt sie wieder', async () => {
  const fake = fakeGitHub(null);
  const routing = createRouting({ github: fake.github });
  assert.deepEqual(await routing.check('wer/was'), { value: null, here: false, uses: 'variable', error: null });
  await routing.set('wer/was', true);
  assert.equal(fake.value(), VALUE);
  assert.equal(routing.of('wer/was').here, true);
  assert.ok(fake.calls.includes('send POST repos/wer/was/actions/variables'));
  await routing.set('wer/was', false);
  assert.equal(fake.value(), null);
  assert.equal(routing.of('wer/was').here, false);
});

test('überschreibt eine vorhandene Variable, statt sie doppelt anzulegen', async () => {
  const fake = fakeGitHub('"ubuntu-latest"');
  const routing = createRouting({ github: fake.github });
  assert.equal((await routing.check('wer/was')).here, false);
  await routing.set('wer/was', true);
  assert.equal(fake.value(), VALUE);
  assert.ok(fake.calls.includes('send PATCH repos/wer/was/actions/variables/CI_RUNNER'));
});

test('liest den Stand frisch, bevor es schreibt: von Hand gesetzt führt nicht zum doppelten Anlegen', async () => {
  const fake = fakeGitHub(null);
  const routing = createRouting({ github: fake.github });
  await routing.check('wer/was');
  fake.put('"ubuntu-latest"'); // inzwischen bei GitHub von Hand angelegt
  await routing.set('wer/was', true);
  assert.equal(fake.value(), VALUE);
  assert.ok(fake.calls.includes('send PATCH repos/wer/was/actions/variables/CI_RUNNER'));
  assert.ok(!fake.calls.includes('send POST repos/wer/was/actions/variables'));
});

test('ohne lesbaren Stand wird nichts geschrieben und nichts als erledigt gemeldet', async () => {
  const calls = [];
  const fail = () => { throw new Error('Das Anfragelimit von GitHub ist aufgebraucht; weiter um 17:05.'); };
  const github = { get: async (url) => { calls.push(`get ${url}`); fail(); }, send: async (method, url) => { calls.push(`send ${method} ${url}`); fail(); } };
  const routing = createRouting({ github });
  await assert.rejects(routing.set('wer/was', false), /Anfragelimit/);
  assert.ok(calls.every((call) => !call.startsWith('send')));
  assert.match(routing.of('wer/was').error, /Anfragelimit/);
});
