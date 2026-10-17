// Whether pull requests from forks could run code on your own runners. In a private repo on a user account
// only someone who has write access anyway can fork. In an organization members with read access may fork too;
// if workflows from fork PRs run there, their code would reach this machine. Requiring approval
// (“require approval”) is not enough either: a click on “Approve” without a look at the code is then enough.
//
// The repo's `allow_forking` deliberately does not count: whether existing forks disappear when forking is turned off
// is not established; what matters is whether GitHub would start their workflows. If that cannot be read for an org
// repo, the repo counts as exposed.

const { msg, reason } = require('./messages');

const settingPath = (repo) => `repos/${repo}/actions/permissions/fork-pr-workflows-private-repos`;

// `info` is the answer to `repos/{repo}`. Returns { exposed, unknown, reason }; `reason` (a message) is only set with
// `exposed`, `unknown` if the setting could not be read.
async function forkExposure(github, repo, info) {
  if (info?.owner?.type !== 'Organization') return { exposed: false };
  let setting;
  try {
    setting = await github.get(settingPath(repo));
  } catch (error) {
    return { exposed: true, unknown: true, reason: msg('m_forksUnreadable', reason(error)) };
  }
  if (setting?.run_workflows_from_fork_pull_requests === false) return { exposed: false };
  return { exposed: true, reason: msg('m_forksAllowed') };
}

module.exports = { forkExposure, settingPath };
