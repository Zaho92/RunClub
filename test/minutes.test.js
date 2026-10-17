const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinutes, summarize, STATE, TIGHT_AT, INCLUDED, FRESH, RETRY } = require('../src/minutes');
const { deepFreeze: frozen, GitHubError } = require('../src/github');
const { render } = require('../src/messages');

const NOW = new Date('2026-10-14T12:00:00Z').getTime();
const SUMMARY = 'users/someone/settings/billing/usage/summary?year=2026&month=10';

// The answers are frozen like the real ones from github.js (`frozen`): code that sorts or changes one in place
// shows up here instead of only in operation.

// A billing entry for Actions minutes: `gross` used, of which `net` paid.
const item = (sku, gross, net = 0, price = 0.006) => ({ product: 'Actions', sku, grossQuantity: gross, discountQuantity: gross - net, netQuantity: net, grossAmount: gross * price, discountAmount: (gross - net) * price, netAmount: net * price, pricePerUnit: price, unitType: 'minutes' });
const summaryOf = (items, period = { year: 2026, month: 10 }) => frozen({ timePeriod: period, user: 'someone', usageItems: items });

// This is how GitHub answered on 2026-10-14 for an account on the Free plan whose runs no longer started. The
// entries are taken word for word; account and month around them are made up.
const REAL = summaryOf([
  { product: 'Actions', sku: 'actions_linux', grossQuantity: 2047.0, discountQuantity: 2047.0, netQuantity: 0.0, grossAmount: 12.282, discountAmount: 12.282, netAmount: 0.0, pricePerUnit: 0.006, unitType: 'minutes' },
  { product: 'Actions', sku: 'actions_storage', grossQuantity: 0.774961026, discountQuantity: 0.774961026, netQuantity: 0.0, grossAmount: 0.000260304, discountAmount: 0.000260304, netAmount: 0.0, pricePerUnit: 0.00033602, unitType: 'gigabyte-hours' },
  { product: 'Actions', sku: 'actions_windows', grossQuantity: 50.4, discountQuantity: 50.4, netQuantity: 0.0, grossAmount: 0.504, discountAmount: 0.504, netAmount: 0.0, pricePerUnit: 0.01, unitType: 'minutes' },
  { product: 'Git LFS', sku: 'git_lfs_storage', grossQuantity: 153.26151534, discountQuantity: 153.26151534, netQuantity: 0.0, grossAmount: 0.014419721, discountAmount: 0.014419721, netAmount: 0.0, pricePerUnit: 9.4086e-05, unitType: 'gigabyte-hours' },
]);

test('the real answer: minutes per operating system and in total, storage and other things do not count', () => {
  assert.deepEqual(summarize(REAL, 'free', NOW), {
    plan: 'free', used: 2097, included: 2000, paid: 0, cost: 0,
    systems: { linux: 2047, windows: 50, macos: 0, other: 0 },
    resetAt: '2026-11-01T00:00:00.000Z', state: STATE.OUT, tightAt: TIGHT_AT, plans: INCLUDED,
  });
});

test('state: ok, tight from 85 %, out at what is included', () => {
  const stateAt = (used, net = 0) => summarize(summaryOf([item('actions_linux', used, net)]), 'free', NOW).state;
  assert.equal(stateAt(0), STATE.OK);
  assert.equal(stateAt(1699), STATE.OK);
  assert.equal(stateAt(1700), STATE.TIGHT);
  assert.equal(stateAt(1999), STATE.TIGHT);
  assert.equal(stateAt(2000), STATE.OUT);
  assert.equal(summarize(summaryOf([]), 'free', NOW).state, STATE.OK);
});

test('the judgement uses the rounded numbers that are shown as well', () => {
  const of = (...items) => summarize(summaryOf(items), 'free', NOW);
  assert.equal(of(item('actions_linux', 1699.4)).state, STATE.OK);
  assert.equal(of(item('actions_linux', 1699.5)).state, STATE.TIGHT);
  const full = of(item('actions_linux', 1999.6));
  assert.deepEqual([full.used, full.state], [2000, STATE.OUT]);
  // The sum is that of the parts shown.
  const halves = of(item('actions_linux', 10.5), item('actions_windows', 10.5));
  assert.deepEqual([halves.used, halves.systems.linux, halves.systems.windows], [22, 11, 11]);
  // A fraction of a paid minute is not paying yet.
  const fraction = of(item('actions_linux', 2100, 0.3));
  assert.deepEqual([fraction.paid, fraction.state], [0, STATE.OUT]);
});

test('paying beyond what is included means a budget: neither tight nor out, but paid', () => {
  const found = summarize(summaryOf([item('actions_linux', 2300, 300), item('actions_macos', 10, 10, 0.062)]), 'free', NOW);
  assert.equal(found.state, STATE.PAID);
  assert.equal(found.used, 2310);
  assert.equal(found.paid, 310);
  assert.equal(found.cost, 2.42);
  assert.deepEqual(found.systems, { linux: 2300, windows: 0, macos: 10, other: 0 });
  // If something is charged below what is included (a larger runner, say), it is not tight for that reason.
  assert.equal(summarize(summaryOf([item('actions_linux', 1800), item('actions_linux_4_core', 5, 5)]), 'free', NOW).state, STATE.OK);
});

test('the included minutes come from the plan; an unknown one has none and so no state', () => {
  const summary = summaryOf([item('actions_linux', 2600)]);
  assert.equal(summarize(summary, 'pro', NOW).included, INCLUDED.pro);
  assert.equal(summarize(summary, 'Pro', NOW).state, STATE.TIGHT);
  for (const plan of ['team', undefined, null, '', 'constructor']) {
    const found = summarize(summary, plan, NOW);
    assert.equal(found.included, null);
    assert.equal(found.state, STATE.UNKNOWN);
    assert.equal(found.used, 2600);
  }
});

test('the plan name only goes out in a plain form', () => {
  const planOf = (plan) => summarize(summaryOf([]), plan, NOW).plan;
  assert.equal(planOf('Team'), 'team');
  assert.equal(planOf('<img src=x onerror=alert(1)>'), null);
  assert.equal(planOf('x'.repeat(41)), null);
  assert.equal(planOf(undefined), null);
});

test('absurdly large numbers in the answer do not give an infinite sum', () => {
  const found = summarize(summaryOf([item('actions_linux', 1e308), item('actions_linux', 1e308, 1e308)]), 'free', NOW);
  assert.ok(Number.isFinite(found.used) && Number.isFinite(found.paid) && Number.isFinite(found.cost));
  assert.equal(JSON.parse(JSON.stringify(found)).used, found.used);
});

test('several entries of one operating system add up, an unknown code counts as other', () => {
  const found = summarize(summaryOf([item('actions_linux', 100), item('actions_linux_4_core', 20), item('actions_macos_xl', 5), item('actions_new', 3)]), 'free', NOW);
  assert.deepEqual(found.systems, { linux: 120, windows: 0, macos: 5, other: 3 });
  assert.equal(found.used, 128);
});

test('the month starts over on the first of the following month, also across the new year and without a period given', () => {
  assert.equal(summarize(summaryOf([], { year: 2026, month: 12 }), 'free', NOW).resetAt, '2027-01-01T00:00:00.000Z');
  assert.equal(summarize(frozen({ usageItems: [] }), 'free', NOW).resetAt, '2026-11-01T00:00:00.000Z');
  assert.equal(summarize(summaryOf([], { year: 2026, month: 13 }), 'free', NOW).resetAt, '2026-11-01T00:00:00.000Z');
});

test('an answer without entries or with nonsense gives zero minutes instead of an error', () => {
  for (const summary of [null, frozen({}), frozen({ usageItems: 'nothing' }), summaryOf([null, { product: 'Actions', unitType: 'minutes', grossQuantity: 'lots', netQuantity: -3 }])]) {
    const found = summarize(summary, 'free', NOW);
    assert.equal(found.used, 0);
    assert.equal(found.state, STATE.OK);
  }
});

// GitHub faked: summary and account; `fail` (an error) makes every request fail, `hold` holds each one up.
function fakeGitHub(summary, plan = 'free') {
  const github = { calls: [], fail: null, hold: null, summary };
  github.get = async (path) => {
    github.calls.push(path);
    await github.hold;
    if (github.fail) throw github.fail;
    return path === 'user' ? frozen({ login: 'someone', plan: { name: plan } }) : github.summary;
  };
  github.reads = () => github.calls.filter((path) => path !== 'user');
  return github;
}

test('reads the account summary for the current month and the plan and shows the figures', async () => {
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ github, now: () => NOW });
  await minutes.refresh('someone');
  assert.deepEqual(github.calls, [SUMMARY, 'user']);
  assert.equal(minutes.view('someone').used, 2097);
  assert.equal(minutes.view('someone').state, STATE.OUT);
  assert.equal('login' in minutes.view('someone'), false);
});

test('the figures apply only to their account and only until the end of their month', async () => {
  let now = NOW;
  const minutes = createMinutes({ github: fakeGitHub(REAL), now: () => now });
  await minutes.refresh('someone');
  assert.deepEqual(minutes.view('other'), { state: STATE.READING });
  assert.equal(minutes.view(null), null);
  now = new Date('2026-11-01T00:00:00Z').getTime();
  assert.deepEqual(minutes.view('someone'), { state: STATE.READING });
});

test('without figures the view says whether it is still reading or the request failed', async () => {
  const github = fakeGitHub(REAL);
  github.fail = new GitHubError(404, 'Not Found');
  const minutes = createMinutes({ github, now: () => NOW });
  assert.equal(minutes.view(null), null);
  assert.deepEqual(minutes.view('someone'), { state: STATE.READING });
  await minutes.refresh('someone');
  assert.deepEqual(minutes.view('someone'), { state: STATE.FAILED });
  assert.deepEqual(minutes.view('other'), { state: STATE.READING });
  github.fail = null;
  await minutes.refresh('someone');
  assert.equal(minutes.view('someone').state, STATE.OUT);
});

test('an answer for another month does not apply and is in the log', async () => {
  const logged = [];
  const github = fakeGitHub(summaryOf([item('actions_linux', 10)], { year: 2026, month: 9 }));
  const minutes = createMinutes({ github, log: (text) => logged.push(render(text)), now: () => NOW });
  await minutes.refresh('someone');
  assert.deepEqual(minutes.view('someone'), { state: STATE.FAILED });
  assert.match(logged[0], /billing for 9\/2026 instead of 10\/2026/);
});

test('an error keeps the last figures and is in the log once, until it works again', async () => {
  const github = fakeGitHub(REAL);
  const logged = [];
  const minutes = createMinutes({ github, log: (text) => logged.push(render(text)), now: () => NOW });
  await minutes.refresh('someone');
  github.fail = new GitHubError(404, 'Not Found');
  await minutes.refresh('someone');
  await minutes.refresh('someone');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /minutes quota.*HTTP 404/);
  assert.equal(minutes.view('someone').used, 2097);
  github.fail = null;
  github.summary = summaryOf([item('actions_linux', 10)]);
  await minutes.refresh('someone');
  assert.equal(minutes.view('someone').used, 10);
  github.fail = new Error('no network');
  await minutes.refresh('someone');
  assert.equal(logged.length, 2);
});

test('another account starts over: its first error is in the log, and it is asked again soon', async () => {
  let now = NOW;
  const github = fakeGitHub(REAL);
  const logged = [];
  github.fail = new GitHubError(404, 'Not Found');
  const minutes = createMinutes({ github, log: (text) => logged.push(render(text)), now: () => now });
  for (let round = 0; round < 4; round += 1) { await minutes.refresh('someone'); }
  assert.equal(logged.length, 1);
  await minutes.poll('other');
  assert.equal(logged.length, 2);
  const before = github.reads().length;
  now += RETRY;
  await minutes.poll('other');
  assert.equal(github.reads().length, before + 1);
});

test('if the log throws, the request still does not fail', async () => {
  const github = fakeGitHub(REAL);
  github.fail = new Error('no network');
  const minutes = createMinutes({ github, log: () => { throw new Error('disk full'); }, now: () => NOW });
  await minutes.refresh('someone');
  assert.deepEqual(minutes.view('someone'), { state: STATE.FAILED });
});

test('at most one request runs at a time', async () => {
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ github, now: () => NOW });
  await Promise.all([minutes.refresh('someone'), minutes.refresh('someone')]);
  assert.equal(github.calls.length, 2);
});

test('if another account is asked for during a request, its request follows afterwards', async () => {
  const github = fakeGitHub(REAL);
  let open;
  github.hold = new Promise((resolve) => { open = resolve; });
  const minutes = createMinutes({ github, now: () => NOW });
  const both = Promise.all([minutes.refresh('someone'), minutes.refresh('other')]);
  open();
  await both;
  assert.deepEqual(github.reads(), [SUMMARY, SUMMARY.replace('someone', 'other')]);
  assert.equal(minutes.view('other').used, 2097);
});

test('the timer only reads when the figures are missing or old', async () => {
  let now = NOW;
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ github, now: () => now });
  await minutes.poll('someone');
  await minutes.poll('someone');
  assert.equal(github.reads().length, 1);
  now += FRESH - 1;
  await minutes.poll('someone');
  assert.equal(github.reads().length, 1);
  now += 1;
  await minutes.poll('someone');
  assert.equal(github.reads().length, 2);
  // Another account is read at once.
  await minutes.poll('other');
  assert.equal(github.reads().length, 3);
});

test('after a failure the timer asks again at growing intervals', async () => {
  let now = NOW;
  const github = fakeGitHub(REAL);
  github.fail = new Error('no network');
  const minutes = createMinutes({ github, now: () => now });
  await minutes.poll('someone');
  const waits = [];
  for (let round = 0; round < 6; round += 1) {
    const before = github.reads().length;
    let waited = 0;
    while (github.reads().length === before) { now += RETRY; waited += 1; await minutes.poll('someone'); }
    waits.push(waited);
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 15, 15]);
});

test('after the month changes the next timer run reads again right away', async () => {
  let now = new Date('2026-10-31T23:59:00Z').getTime();
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ github, now: () => now });
  await minutes.poll('someone');
  now += 2 * RETRY;
  github.summary = summaryOf([item('actions_linux', 3)], { year: 2026, month: 11 });
  assert.deepEqual(minutes.view('someone'), { state: STATE.READING });
  await minutes.poll('someone');
  assert.equal(github.reads().at(-1), 'users/someone/settings/billing/usage/summary?year=2026&month=11');
  assert.equal(minutes.view('someone').used, 3);
});

test('what the interface gets can be changed without touching the figures', async () => {
  const minutes = createMinutes({ github: fakeGitHub(REAL), now: () => NOW });
  await minutes.refresh('someone');
  minutes.view('someone').systems.linux = 0;
  minutes.view('someone').plans.free = 1;
  assert.equal(minutes.view('someone').systems.linux, 2047);
  assert.equal(minutes.view('someone').plans.free, INCLUDED.free);
});
