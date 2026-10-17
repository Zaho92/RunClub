// Where a repo's jobs go: the workflows read their target from the repo variable CI_RUNNER
// (`runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}`). RunClub sets it when a pool is created
// and removes it when the pool goes.

const { Fault, reason } = require('./messages');

const VARIABLE = 'CI_RUNNER';
const VALUE = '["self-hosted","Linux"]';

// Does the variable's value point to your own runners? Case and order do not matter.
function pointsHere(value) {
  try {
    const labels = JSON.parse(value);
    const list = (Array.isArray(labels) ? labels : [labels]).map((label) => String(label).toLowerCase());
    return list.includes('self-hosted');
  } catch { return false; }
}

// How a repo's workflow files decide their target:
//   'variable'  through vars.CI_RUNNER – the variable switches
//   'fixed'     fixed to self-hosted – runs on your own runners without the variable
//   'none'      neither – the jobs go to GitHub's runners, whatever the variable says
function usage(texts) {
  if (texts.some((text) => /\bvars\.CI_RUNNER\b/.test(text))) return 'variable';
  if (texts.some((text) => /^\s*runs-on\s*:.*self-hosted/im.test(text) || /^\s*-\s*self-hosted\s*$/im.test(text))) return 'fixed';
  return 'none';
}

function createRouting({ github }) {
  const known = new Map(); // repo -> { value, here, uses, error }

  async function check(repo) {
    const info = { value: null, here: false, uses: null, error: null };
    try { info.value = (await github.get(`repos/${repo}/actions/variables/${VARIABLE}`)).value; } catch (error) { if (error.status !== 404) info.error = reason(error); }
    info.here = info.value != null && pointsHere(info.value);
    try {
      const files = (await github.get(`repos/${repo}/contents/.github/workflows`)).filter((file) => /\.ya?ml$/.test(file.name));
      const texts = [];
      for (const file of files) texts.push(Buffer.from((await github.get(`repos/${repo}/contents/${file.path}`)).content, 'base64').toString('utf8'));
      info.uses = usage(texts);
    } catch { /* no workflow folder or no access: unknown */ }
    known.set(repo, info);
    return info;
  }

  // Switches the repo's jobs to your own runners (`on`) or back to GitHub's runners.
  async function set(repo, on) {
    // Always read fresh: the variable may have been set or removed by hand in the meantime.
    const current = await check(repo);
    // Without the variable's state (GitHub not reachable, rate limit) everything else would be guesswork.
    if (current.error) throw Fault.of(current.error);
    if (on) {
      const body = { name: VARIABLE, value: VALUE };
      if (current.value == null) await github.send('POST', `repos/${repo}/actions/variables`, body);
      else await github.send('PATCH', `repos/${repo}/actions/variables/${VARIABLE}`, body);
    } else if (current.value != null) {
      await github.send('DELETE', `repos/${repo}/actions/variables/${VARIABLE}`);
    }
    known.set(repo, { ...current, value: on ? VALUE : null, here: Boolean(on), error: null });
  }

  return { check, set, of: (repo) => known.get(repo) ?? null, forget: (repo) => known.delete(repo) };
}

module.exports = { createRouting, usage, pointsHere, VARIABLE, VALUE };
