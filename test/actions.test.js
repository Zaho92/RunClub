const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActions } = require('../src/actions');
const { createSettings, PARALLEL_MAX } = require('../src/settings');
const limitRules = require('../src/limits');
const { GB } = require('../src/units');
const { errorLog } = require('../src/journal');
const { turn, until } = require('./support');

const REPO = 'wer/App';

// Alles um die Aufrufe herum nachgestellt; die Einstellungen sind echt (in einem leeren Ordner). `calls` hält in
// Kurzform, was die Aufrufe auslösen.
function world({ pools: repos = [REPO] } = {}) {
  const w = { calls: [], logs: [], timers: [], ready: true, info: {}, answers: {}, routingState: { uses: 'variable', here: false, error: null }, plan: null, stale: 1 };
  w.settings = createSettings({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-actions-')), log: () => {} });
  w.pools = new Map();
  for (const repo of repos) {
    w.settings.addPool(repo, 2);
    w.pools.set(repo, { repo, slots: [{ name: 'frei' }], reserve: [], removed: false });
  }
  const call = (name) => async (...args) => { w.calls.push([name, ...args.filter((arg) => typeof arg !== 'object' && typeof arg !== 'function')].join(' ')); };
  const runners = {
    pools: w.pools,
    slots: { abortIdle: (slot) => w.calls.push(`abortIdle ${slot.name}`) },
    discardReserve: async (pool) => w.calls.push(`discardReserve ${pool.repo}`),
    reconcile: (pool) => w.calls.push(`reconcile ${pool.repo}`),
    startPool: (repo) => w.calls.push(`startPool ${repo}`),
    withPoolAtRest: async (pool, work) => { w.calls.push(`atRest ${pool.repo}`); return work(); },
    renewReserve: (pool) => w.calls.push(`renewReserve ${pool.repo}`),
    staleCount: () => w.stale,
    rebuildIdle: async (pool) => w.calls.push(`rebuildIdle ${pool.repo}`),
    caches: { removeCaches: async (repo, parts) => { w.calls.push(`removeCaches ${repo} ${Object.keys(parts).filter((key) => parts[key]).join('+')}`); if (w.cachesFail) throw new Error(w.cachesFail); }, prepareCaches: call('prepareCaches'), measureSizes: async (pool) => w.calls.push(`measureSizes ${pool.repo}`) },
    seed: { forget: call('forgetSeed'), refreshSeed: call('refreshSeed') },
  };
  const { actions, guard } = createActions({
    gh: async (args) => { w.calls.push(`gh ${args.at(-1)}`); const answer = w.answers[args.at(-1)]; return answer === undefined ? w.info : typeof answer === 'function' ? answer() : answer; },
    settings: w.settings, runners,
    remote: { refreshAll: call('refreshAll'), markChecked: (repo) => w.calls.push(`markChecked ${repo}`), forget: (repo) => w.calls.push(`remote.forget ${repo}`), rerun: call('rerun') },
    routing: { check: async (repo) => { w.calls.push(`routing.check ${repo}`); return w.routingState; }, set: async (repo, on) => { w.calls.push(`routing.set ${repo} ${on}`); }, forget: (repo) => w.calls.push(`routing.forget ${repo}`) },
    waiting: { forget: (repo) => w.calls.push(`waiting.forget ${repo}`) },
    metrics: { forget: (repo) => w.calls.push(`metrics.forget ${repo}`) },
    account: { login: call('login'), grant: call('grant'), cancel: call('cancel'), logout: call('logout') },
    dockerWatch: { ready: () => w.ready, removeRegistrations: call('removeRegistrations') },
    limitRange: () => limitRules.bounds({ dockerMemory: 16 * GB, dockerCpus: 8 }),
    limitPlan: () => w.plan,
    log: (...entry) => w.logs.push(entry),
    logError: errorLog((...entry) => w.logs.push(entry)),
    shutdown: () => w.calls.push('shutdown'),
    timer: (work, ms) => w.timers.push({ work, ms }),
  });
  Object.assign(w, { actions, guard });
  return w;
}

test('pool/add prüft Namen, Verwaltungsrecht, Doppel, Namenskonflikt und Sichtbarkeit, bevor etwas angelegt wird', async () => {
  const w = world({ pools: ['wer/Tool'] });
  const add = (repo, info) => { w.info = info; return w.actions['pool/add']({ repo, parallel: 1 }); };
  const own = { full_name: 'wer/Neu', permissions: { admin: true }, private: true };
  await assert.rejects(add('--help', own), { message: 'Das Repo wird als besitzer/name angegeben.' });
  await assert.rejects(add('wer/Neu', { ...own, permissions: { admin: false } }), /Verwaltungsrechte/);
  await assert.rejects(add('WER/tool', { ...own, full_name: 'wer/Tool' }), { message: 'Für dieses Repo gibt es schon einen Pool.' });
  await assert.rejects(add('andere/tool', { ...own, full_name: 'andere/tool' }), { message: 'Ein Pool für wer/Tool belegt denselben Namen für Caches und Build-Dienst. Zwei Repos mit gleichem Namen lassen sich nicht zugleich bedienen.' });
  await assert.rejects(add('wer/Neu', { ...own, private: false }), /öffentlich/);
  w.pools.get('wer/Tool').removed = true;
  w.settings.removePool('wer/Tool');
  await assert.rejects(add('wer/tool', { ...own, full_name: 'wer/Tool' }), { message: 'Dieser Pool wird gerade entfernt. Bitte warten, bis das abgeschlossen ist.' });
  assert.deepEqual(w.settings.repos(), []);
  assert.equal(w.calls.some((name) => name.startsWith('startPool')), false);
});

test('pool/add legt an, wie GitHub das Repo schreibt, startet den Pool und leitet die Jobs um, wenn die Workflows die Variable lesen', async () => {
  const w = world({ pools: [] });
  w.info = { full_name: 'Wer/Neu', permissions: { admin: true }, private: true };
  await w.actions['pool/add']({ repo: 'wer/neu', parallel: 99 });
  await until(() => w.calls.includes('routing.set Wer/Neu true'));
  assert.deepEqual(w.settings.config.pools, [{ repo: 'Wer/Neu', parallel: PARALLEL_MAX, cache: true, paused: false, preload: [] }]);
  assert.deepEqual(w.calls.slice(0, 6), ['gh repos/wer/neu', 'waiting.forget Wer/Neu', 'markChecked Wer/Neu', 'startPool Wer/Neu', 'refreshAll', 'routing.check Wer/Neu']);
  assert.deepEqual(w.logs.map(([text]) => text), ['Pool angelegt', 'CI_RUNNER gesetzt – die Jobs laufen auf den eigenen Runnern']);
});

test('pool/set: Plätze begrenzt, Pausieren beendet freie Paare und die Reserve, ein anderer Cache wird bei Ruhe bereitgestellt', async () => {
  const w = world();
  await w.actions['pool/set']({ repo: REPO, parallel: '3', paused: true, cache: false });
  await turn();
  assert.deepEqual(w.settings.settingsOf(REPO), { repo: REPO, parallel: 3, cache: false, paused: true, preload: [] });
  assert.deepEqual(w.calls, ['abortIdle frei', `discardReserve ${REPO}`, `reconcile ${REPO}`, `atRest ${REPO}`, `prepareCaches ${REPO}`]);
  assert.deepEqual(w.logs, [['3 Plätze, pausiert, Cache aus', REPO]]);
  await assert.rejects(w.actions['pool/set']({ repo: 'wer/Fremd', parallel: 1 }), { message: 'Diesen Pool gibt es nicht.' });
});

test('ein öffentlich gewordenes Repo: weder fortsetzen noch Jobs umleiten, bis es wieder privat ist', async () => {
  const w = world();
  Object.assign(w.settings.settingsOf(REPO), { paused: true, pausedPublic: true });
  await assert.rejects(w.actions['pool/set']({ repo: REPO, paused: false, parallel: 4 }), /öffentlich/);
  assert.deepEqual([w.settings.settingsOf(REPO).paused, w.settings.settingsOf(REPO).parallel], [true, 2]);
  await assert.rejects(w.actions['pool/routing']({ repo: REPO, on: true }), /öffentlich/);
  await w.actions['pool/routing']({ repo: REPO, on: false }); // zurück an GitHub geht immer
  for (const paused of [0, '', null]) await assert.rejects(w.actions['pool/set']({ repo: REPO, paused }), /öffentlich/); // jeder falsche Wert setzte fort
  w.guard.unblock(REPO, 'public');
  assert.equal(w.settings.settingsOf(REPO).pausedPublic, undefined);
  assert.equal(w.logs.at(-1)[0], 'Das Repo ist wieder privat; der Pool lässt sich fortsetzen.');
  await w.actions['pool/set']({ repo: REPO, paused: false });
  assert.equal(w.settings.settingsOf(REPO).paused, false);
});

test('Fork-PRs in einem Org-Repo: Pool pausiert, laut im Protokoll; weder fortsetzen noch umleiten, bis sie abgeschaltet sind', async () => {
  const w = world();
  await w.guard.block(REPO, 'forks', 'Workflows aus Forks dürfen laufen');
  assert.deepEqual([w.settings.settingsOf(REPO).paused, w.settings.settingsOf(REPO).pausedForks], [true, true]);
  assert.deepEqual(w.calls, ['abortIdle frei', `discardReserve ${REPO}`, `routing.set ${REPO} false`]);
  assert.match(w.logs[0][0], /^Workflows aus Forks dürfen laufen. /);
  assert.equal(w.logs[0][2], 'error');
  await assert.rejects(w.actions['pool/set']({ repo: REPO, paused: false }), /Forks/);
  await assert.rejects(w.actions['pool/routing']({ repo: REPO, on: true }), /Forks/);
  w.guard.unblock(REPO, 'forks');
  assert.equal(w.settings.settingsOf(REPO).pausedForks, undefined);
  await w.actions['pool/set']({ repo: REPO, paused: false });
  assert.equal(w.settings.settingsOf(REPO).paused, false);
  w.calls.length = 0;
  w.pools.get(REPO).removed = true;
  await w.guard.block(REPO, 'forks', 'x');
  assert.deepEqual(w.calls, []);
});

test('fällt ein Grund weg, während der andere gilt, bleibt der Pool gesperrt, und das Protokoll sagt warum', async () => {
  const w = world();
  await w.guard.block(REPO, 'public');
  await w.guard.block(REPO, 'forks', 'Workflows aus Forks dürfen laufen');
  w.guard.unblock(REPO, 'public');
  assert.match(w.logs.at(-1)[0], /^Das Repo ist wieder privat; der Pool bleibt gesperrt: Pull Requests aus Forks/);
  await assert.rejects(w.actions['pool/set']({ repo: REPO, paused: false }), /Forks/);
  w.guard.unblock(REPO, 'forks');
  assert.equal(w.logs.at(-1)[0], 'Workflows aus Forks laufen in diesem Repo nicht mehr; der Pool lässt sich fortsetzen.');
});

test('ein Pool, dessen Repo sich nicht prüfen lässt, ruht: freie Paare und Reserve gehen; entfernte bleiben unberührt', async () => {
  const w = world();
  w.guard.restUnchecked(REPO);
  assert.deepEqual(w.calls, ['abortIdle frei', `discardReserve ${REPO}`]);
  w.calls.length = 0;
  w.pools.get(REPO).removed = true;
  w.guard.restUnchecked(REPO);
  w.guard.restUnchecked('wer/Fremd');
  assert.deepEqual(w.calls, []);
});

test('pool/add lehnt ein Org-Repo ab, in dem Fork-PRs laufen dürfen oder es sich nicht lesen lässt', async () => {
  const w = world({ pools: [] });
  const forks = 'repos/firma/App/actions/permissions/fork-pr-workflows-private-repos';
  w.info = { full_name: 'firma/App', private: true, permissions: { admin: true }, owner: { type: 'Organization' } };
  w.answers[forks] = { run_workflows_from_fork_pull_requests: true, require_approval_for_fork_pr_workflows: true };
  await assert.rejects(w.actions['pool/add']({ repo: 'firma/App', parallel: 1 }), /Forks/);
  w.answers[forks] = () => { throw new Error('HTTP 403'); };
  await assert.rejects(w.actions['pool/add']({ repo: 'firma/App', parallel: 1 }), /HTTP 403/);
  assert.deepEqual(w.settings.repos(), []);
  w.answers[forks] = { run_workflows_from_fork_pull_requests: false };
  await w.actions['pool/add']({ repo: 'firma/App', parallel: 1 });
  assert.deepEqual(w.settings.repos(), ['firma/App']);
});

test('pool/remove: sofort aus den Einstellungen; danach Caches, Vorlage, Variable, Anmeldungen, Gelerntes; dann ist der Name frei', async () => {
  const w = world();
  w.routingState = { here: true, error: null };
  const pool = w.pools.get(REPO);
  await w.actions['pool/remove']({ repo: REPO });
  assert.equal(pool.removed, true);
  assert.deepEqual(w.settings.repos(), []);
  await until(() => !w.pools.has(REPO));
  assert.deepEqual(w.calls, [`atRest ${REPO}`, `removeCaches ${REPO} packages+build`, `forgetSeed ${REPO}`, `routing.check ${REPO}`, `routing.set ${REPO} false`, `routing.forget ${REPO}`, `removeRegistrations ${REPO}`, `metrics.forget ${REPO}`, `remote.forget ${REPO}`]);
  assert.deepEqual(w.logs.map(([text]) => text), ['Pool wird entfernt', 'CI_RUNNER entfernt – die Jobs gehen wieder an GitHubs Runner', 'Pool und seine Caches sind entfernt']);
});

test('pool/remove: was sich nicht löschen ließ, steht im Protokoll; ohne Stand der Variable bleibt sie', async () => {
  const w = world();
  w.cachesFail = 'Caches ließen sich nicht löschen – volume is in use';
  w.routingState = { error: 'HTTP 502' };
  await w.actions['pool/remove']({ repo: REPO });
  await until(() => !w.pools.has(REPO));
  assert.deepEqual(w.logs.slice(1), [
    ['CI_RUNNER bleibt, wie es ist – HTTP 502', REPO, 'error'],
    ['Pool entfernt, aber nicht alles: Caches ließen sich nicht löschen – volume is in use', REPO, 'error'],
  ]);
  assert.equal(w.calls.includes(`routing.set ${REPO} false`), false);
});

test('pool/clear: nur bekannte Caches; geleert wird bei Ruhe, danach neu bereitgestellt und gemessen', async () => {
  const w = world();
  await assert.rejects(w.actions['pool/clear']({ repo: REPO, what: 'constructor' }), { message: 'Unbekannter Cache.' });
  await w.actions['pool/clear']({ repo: REPO, what: 'images' });
  await until(() => w.logs.length === 2);
  assert.deepEqual(w.calls, [`atRest ${REPO}`, `removeCaches ${REPO} `, `forgetSeed ${REPO}`, `prepareCaches ${REPO}`, `refreshSeed ${REPO}`, `measureSizes ${REPO}`]);
  assert.deepEqual(w.logs.map(([text]) => text), ['Leere die gelernten Abbilder …', 'Geleert; der nächste Lauf füllt wieder auf']);
  // Scheitert das Löschen, steht es im Protokoll, und Caches, Build-Dienst und Vorlage stehen trotzdem wieder bereit.
  w.calls.length = 0;
  w.logs.length = 0;
  w.cachesFail = 'Caches ließen sich nicht löschen – volume is in use';
  await w.actions['pool/clear']({ repo: REPO, what: 'build' });
  await until(() => w.logs.length === 2);
  assert.deepEqual(w.calls.slice(-3), [`prepareCaches ${REPO}`, `refreshSeed ${REPO}`, `measureSizes ${REPO}`]);
  assert.deepEqual(w.logs[1], [w.cachesFail, REPO, 'error']);
  w.cachesFail = null;
  w.calls.length = 0;
  await w.actions['pool/clear']({ repo: REPO, what: 'all' });
  await until(() => w.calls.includes(`measureSizes ${REPO}`));
  assert.equal(w.calls[1], `removeCaches ${REPO} packages+build`);
});

test('Limits lassen sich erst setzen, wenn Docker bereit ist; danach erneuert sich die Reserve aller Pools', async () => {
  const w = world();
  w.ready = false;
  await assert.rejects(w.actions['limits/set']({ runnerMemory: 2 }), /Docker ist noch nicht bereit/);
  await assert.rejects(w.actions['limits/plan'](), /Docker ist noch nicht bereit/);
  w.ready = true;
  await assert.rejects(w.actions['limits/plan'](), { message: 'Für einen Vorschlag fehlen noch Messwerte.' });
  await assert.rejects(w.actions['limits/set']({ repo: 'wer/Fremd', runnerMemory: 2 }), { message: 'Diesen Pool gibt es nicht.' });
  await w.actions['limits/set']({ repo: REPO, runnerMemory: 2 });
  assert.equal(w.settings.settingsOf(REPO).limits.runnerMemory, '2g');
  await w.actions['limits/set']({ repo: REPO, inherit: true });
  assert.equal(w.settings.settingsOf(REPO).limits, undefined);
  assert.deepEqual(w.calls, [`renewReserve ${REPO}`, `renewReserve ${REPO}`]);
});

test('pool/rebuild baut nur Pools mit veralteten Paaren neu auf, keine, die gerade entfernt werden', async () => {
  const w = world({ pools: [REPO, 'wer/Zwei'] });
  w.pools.get('wer/Zwei').removed = true;
  await w.actions['pool/rebuild']({});
  assert.deepEqual(w.calls, [`rebuildIdle ${REPO}`]);
  w.stale = 0;
  await w.actions['pool/rebuild']({ repo: REPO });
  assert.equal(w.calls.length, 1);
  await assert.rejects(w.actions['pool/rebuild']({ repo: 'wer/Fremd' }), { message: 'Diesen Pool gibt es nicht.' });
});

test('beenden antwortet erst und beendet dann', async () => {
  const w = world();
  await w.actions.shutdown();
  assert.deepEqual(w.calls, []);
  w.timers[0].work();
  assert.deepEqual(w.calls, ['shutdown']);
});

test('ein öffentlich gewordenes Repo: Pool pausiert, freie Paare und Reserve weg, Variable entfernt, laut im Protokoll', async () => {
  const w = world();
  await w.guard.block(REPO, 'public');
  assert.deepEqual([w.settings.settingsOf(REPO).paused, w.settings.settingsOf(REPO).pausedPublic], [true, true]);
  assert.deepEqual(w.calls, ['abortIdle frei', `discardReserve ${REPO}`, `routing.set ${REPO} false`]);
  assert.equal(w.logs[0][2], 'error');
  w.calls.length = 0;
  w.pools.get(REPO).removed = true;
  await w.guard.block(REPO, 'public');
  assert.deepEqual(w.calls, []);
});
