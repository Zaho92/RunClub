const test = require('node:test');
const assert = require('node:assert/strict');
const { forkExposure, settingPath } = require('../src/forks');
const { render } = require('../src/messages');

const REPO = 'firma/App';
const SETTING = { run_workflows_from_fork_pull_requests: false, send_write_tokens_to_workflows: false, send_secrets_and_variables: false, require_approval_for_fork_pr_workflows: false };

// `answer` ist die Antwort auf die Einstellung (eine Funktion darf werfen); `calls` hält die Pfade.
function ghWith(answer) {
  const calls = [];
  const gh = async (args) => { calls.push(args.at(-1)); return typeof answer === 'function' ? answer() : answer; };
  return { gh, calls };
}

test('Repos auf einem Benutzerkonto gelten nie als gefährdet und kosten keine Anfrage', async () => {
  const { gh, calls } = ghWith({ ...SETTING, run_workflows_from_fork_pull_requests: true });
  assert.deepEqual(await forkExposure(gh, 'wer/App', { owner: { type: 'User' }, allow_forking: true }), { exposed: false });
  assert.deepEqual(calls, []);
});

test('ein Org-Repo ohne Workflows aus Forks ist sicher, auch wenn es sich forken lässt', async () => {
  const { gh, calls } = ghWith(SETTING);
  assert.deepEqual(await forkExposure(gh, REPO, { owner: { type: 'Organization' }, allow_forking: true }), { exposed: false });
  assert.deepEqual(calls, [settingPath(REPO)]);
});

test('ein Org-Repo, in dem Workflows aus Forks laufen dürfen, ist gefährdet – auch mit Freigabepflicht und ohne Forken', async () => {
  for (const extra of [{}, { require_approval_for_fork_pr_workflows: true }]) {
    for (const allowForking of [true, false]) {
      const { gh } = ghWith({ ...SETTING, run_workflows_from_fork_pull_requests: true, ...extra });
      const found = await forkExposure(gh, REPO, { owner: { type: 'Organization' }, allow_forking: allowForking });
      assert.equal(found.exposed, true);
      assert.match(render(found.reason), /Forks/);
    }
  }
});

test('lässt sich die Einstellung nicht lesen oder fehlt das Feld, gilt ein Org-Repo als gefährdet', async () => {
  const failing = ghWith(() => { throw new Error('HTTP 403'); });
  const found = await forkExposure(failing.gh, REPO, { owner: { type: 'Organization' } });
  assert.equal(found.exposed, true);
  assert.match(render(found.reason), /HTTP 403/);
  assert.equal((await forkExposure(ghWith({}).gh, REPO, { owner: { type: 'Organization' } })).exposed, true);
  assert.equal((await forkExposure(ghWith(null).gh, REPO, { owner: { type: 'Organization' } })).exposed, true);
});
