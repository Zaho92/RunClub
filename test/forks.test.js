const test = require('node:test');
const assert = require('node:assert/strict');
const { forkExposure, settingPath } = require('../src/forks');
const { render } = require('../src/messages');
const { GitHubError } = require('../src/github');

const REPO = 'company/App';
const SETTING = { run_workflows_from_fork_pull_requests: false, send_write_tokens_to_workflows: false, send_secrets_and_variables: false, require_approval_for_fork_pr_workflows: false };

// `answer` is the answer for the setting (a function may throw); `calls` keeps the paths.
function githubWith(answer) {
  const calls = [];
  const github = { get: async (path) => { calls.push(path); return typeof answer === 'function' ? answer() : answer; } };
  return { github, calls };
}

test('repos on a user account never count as exposed and cost no request', async () => {
  const { github, calls } = githubWith({ ...SETTING, run_workflows_from_fork_pull_requests: true });
  assert.deepEqual(await forkExposure(github, 'who/App', { owner: { type: 'User' }, allow_forking: true }), { exposed: false });
  assert.deepEqual(calls, []);
});

test('an org repo without workflows from forks is safe, even if it can be forked', async () => {
  const { github, calls } = githubWith(SETTING);
  assert.deepEqual(await forkExposure(github, REPO, { owner: { type: 'Organization' }, allow_forking: true }), { exposed: false });
  assert.deepEqual(calls, [settingPath(REPO)]);
});

test('an org repo in which workflows from forks may run is exposed – even with required approval and without forking', async () => {
  for (const extra of [{}, { require_approval_for_fork_pr_workflows: true }]) {
    for (const allowForking of [true, false]) {
      const { github } = githubWith({ ...SETTING, run_workflows_from_fork_pull_requests: true, ...extra });
      const found = await forkExposure(github, REPO, { owner: { type: 'Organization' }, allow_forking: allowForking });
      assert.equal(found.exposed, true);
      assert.match(render(found.reason), /fork pull requests/);
    }
  }
});

test('if the setting cannot be read or the field is missing, an org repo counts as exposed', async () => {
  const failing = githubWith(() => { throw new GitHubError(403, 'Forbidden'); });
  const found = await forkExposure(failing.github, REPO, { owner: { type: 'Organization' } });
  assert.equal(found.exposed, true);
  assert.match(render(found.reason), /HTTP 403/);
  assert.equal((await forkExposure(githubWith({}).github, REPO, { owner: { type: 'Organization' } })).exposed, true);
  assert.equal((await forkExposure(githubWith(null).github, REPO, { owner: { type: 'Organization' } })).exposed, true);
});
