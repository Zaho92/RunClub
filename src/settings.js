// Einstellungen (`runners.json`) und Gelerntes (`state.json`) im Datenordner.
//
//   Einstellungen  { limits, pools: [{ repo, parallel, cache, paused, preload, limits?, reserve? }] }
//                  `limits` gilt für alle Projekte; ein Pool kann eigene tragen (siehe limits.js).
//   Gelerntes      { learned, rejected } für die Vorlagen (siehe seed.js)
//
// `config.pools` wird beim Entfernen eines Pools neu gesetzt: Wer die Liste braucht, liest sie jedes Mal über `config`.

const path = require('node:path');
const { readJson, writeJson } = require('./store');
const limitRules = require('./limits');
const { msg } = require('./messages');

const LIMIT_DEFAULTS = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' };
// Je Pool neu, damit sich keine zwei Pools eine Liste teilen.
const poolDefaults = () => ({ parallel: 1, cache: true, paused: false, preload: [] });
const PARALLEL_MAX = 4;
// So schreibt GitHub einen Repo-Namen; nichts, was `gh` oder Docker als Option lesen könnte.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

// Zahl der Plätze eines Pools: eine ganze Zahl von 1 bis PARALLEL_MAX, was auch immer ankommt.
const clampParallel = (value) => Math.min(PARALLEL_MAX, Math.max(1, Math.trunc(Number(value)) || 1));

//   dataDir                 der Datenordner
//   log(text, repo, kind)   meldet eine Datei, die sich nicht lesen ließ
function createSettings({ dataDir, log }) {
  const configFile = path.join(dataDir, 'runners.json');
  const stateFile = path.join(dataDir, 'state.json');

  function load(file) {
    const { data, broken } = readJson(file, {});
    if (broken) log(msg('m_settingsBroken', path.basename(file), broken), null, 'error');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  const raw = load(configFile);
  const config = {
    limits: { ...LIMIT_DEFAULTS, ...raw.limits },
    pools: (raw.pools ?? raw.linux ?? []).map((pool) => ({ ...poolDefaults(), ...pool })),
  };
  const saveConfig = () => writeJson(configFile, config);

  const state = load(stateFile);
  state.learned ??= {};
  state.rejected ??= {};
  const saveState = () => writeJson(stateFile, state);

  const settingsOf = (repo) => config.pools.find((pool) => pool.repo === repo);
  // Eigene Limits des Projekts oder die für alle.
  const limitsOf = (repo) => limitRules.effective(config.limits, settingsOf(repo)?.limits);
  const repos = () => config.pools.map((pool) => pool.repo);

  function addPool(repo, parallel) {
    const settings = { ...poolDefaults(), repo, parallel: clampParallel(parallel) };
    config.pools.push(settings);
    saveConfig();
    return settings;
  }

  function removePool(repo) {
    config.pools = config.pools.filter((settings) => settings.repo !== repo);
    saveConfig();
  }

  return { config, saveConfig, state, saveState, settingsOf, limitsOf, repos, addPool, removePool };
}

module.exports = { createSettings, clampParallel, PARALLEL_MAX, REPO_NAME };
