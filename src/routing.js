// Wohin die Jobs eines Repos gehen: Die Workflows lesen ihr Ziel aus der Repo-Variablen CI_RUNNER
// (`runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}`). RunClub setzt sie, wenn ein Pool entsteht,
// und entfernt sie, wenn er geht.

const { Fault, reason } = require('./messages');

const VARIABLE = 'CI_RUNNER';
const VALUE = '["self-hosted","Linux"]';

// Zeigt der Wert der Variablen auf die eigenen Runner? Schreibweise und Reihenfolge sind egal.
function pointsHere(value) {
  try {
    const labels = JSON.parse(value);
    const list = (Array.isArray(labels) ? labels : [labels]).map((label) => String(label).toLowerCase());
    return list.includes('self-hosted');
  } catch { return false; }
}

// Wie die Workflow-Dateien eines Repos ihr Ziel bestimmen:
//   'variable'  über vars.CI_RUNNER – die Variable schaltet um
//   'fixed'     fest auf self-hosted – läuft ohne Variable auf den eigenen Runnern
//   'none'      weder noch – die Jobs gehen an GitHubs Runner, egal was die Variable sagt
function usage(texts) {
  if (texts.some((text) => /\bvars\.CI_RUNNER\b/.test(text))) return 'variable';
  if (texts.some((text) => /^\s*runs-on\s*:.*self-hosted/im.test(text) || /^\s*-\s*self-hosted\s*$/im.test(text))) return 'fixed';
  return 'none';
}

function createRouting({ github }) {
  const known = new Map(); // Repo -> { value, here, uses, error }

  async function check(repo) {
    const info = { value: null, here: false, uses: null, error: null };
    try { info.value = (await github.get(`repos/${repo}/actions/variables/${VARIABLE}`)).value; } catch (error) { if (error.status !== 404) info.error = reason(error); }
    info.here = info.value != null && pointsHere(info.value);
    try {
      const files = (await github.get(`repos/${repo}/contents/.github/workflows`)).filter((file) => /\.ya?ml$/.test(file.name));
      const texts = [];
      for (const file of files) texts.push(Buffer.from((await github.get(`repos/${repo}/contents/${file.path}`)).content, 'base64').toString('utf8'));
      info.uses = usage(texts);
    } catch { /* kein Workflow-Ordner oder kein Zugriff: unbekannt */ }
    known.set(repo, info);
    return info;
  }

  // Schaltet die Jobs des Repos auf die eigenen Runner (`on`) oder zurück zu GitHubs Runnern.
  async function set(repo, on) {
    // Immer frisch lesen: Die Variable kann inzwischen von Hand gesetzt oder entfernt worden sein.
    const current = await check(repo);
    // Ohne den Stand der Variable (GitHub nicht erreichbar, Anfragelimit) wäre alles Weitere geraten.
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
