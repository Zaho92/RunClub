// Settings (`runners.json`) and learned data (`state.json`) in the data folder.
//
//   Settings       { limits, pools: [{ repo, parallel, cache, paused, preload, limits?, reserve? }] }
//                  `limits` applies to all projects; a pool can carry its own (see limits.js).
//   Learned        { learned, rejected } for the templates (see seed.js)
//
// `config.pools` is set anew when a pool is removed: whoever needs the list reads it through `config` every time.

const path = require('node:path');
const { readJson, writeJson } = require('./store');
const limitRules = require('./limits');
const { msg } = require('./messages');

const LIMIT_DEFAULTS = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 6, dockerMemory: '4g' };
// New per pool, so that no two pools share a list.
const poolDefaults = () => ({ parallel: 1, cache: true, paused: false, preload: [] });
const PARALLEL_MAX = 4;
// This is how GitHub writes a repo name; nothing Docker could read as an option.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

// Number of slots of a pool: a whole number from 1 to PARALLEL_MAX, whatever arrives.
const clampParallel = (value) => Math.min(PARALLEL_MAX, Math.max(1, Math.trunc(Number(value)) || 1));

//   dataDir                 the data folder
//   log(text, repo, kind)   reports a file that could not be read
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
  // The project's own limits or the ones for all.
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
