// Ob Pull Requests aus Forks auf den eigenen Runnern Code ausführen könnten. In einem privaten Repo auf einem
// Benutzerkonto kann nur forken, wer ohnehin Schreibrecht hat. In einer Organisation dürfen auch Mitglieder mit
// Leserecht forken; laufen dort Workflows aus Fork-PRs, käme ihr Code auf diesen Rechner. Auch die Freigabepflicht
// („require approval“) genügt nicht: Ein Klick auf „Approve“ ohne Blick in den Code reicht dann.
//
// `allow_forking` des Repos zählt bewusst nicht: Ob vorhandene Forks verschwinden, wenn das Forken abgeschaltet wird,
// ist nicht belegt; maßgeblich ist, ob GitHub ihre Workflows starten würde. Lässt sich das bei einem Org-Repo nicht
// lesen, gilt das Repo als gefährdet.

const { msg, reason } = require('./messages');

const settingPath = (repo) => `repos/${repo}/actions/permissions/fork-pr-workflows-private-repos`;

// `info` ist die Antwort auf `repos/{repo}`. Liefert { exposed, unknown, reason }; `reason` (eine Meldung) steht nur bei `exposed`,
// `unknown`, wenn sich die Einstellung nicht lesen ließ.
async function forkExposure(gh, repo, info) {
  if (info?.owner?.type !== 'Organization') return { exposed: false };
  let setting;
  try {
    setting = await gh(['api', settingPath(repo)]);
  } catch (error) {
    return { exposed: true, unknown: true, reason: msg('m_forksUnreadable', reason(error)) };
  }
  if (setting?.run_workflows_from_fork_pull_requests === false) return { exposed: false };
  return { exposed: true, reason: msg('m_forksAllowed') };
}

module.exports = { forkExposure, settingPath };
