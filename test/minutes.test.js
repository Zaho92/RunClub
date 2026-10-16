const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinutes, summarize, STATE, TIGHT_AT, INCLUDED, FRESH, RETRY } = require('../src/minutes');
const { deepFreeze: frozen } = require('../src/github');
const { render } = require('../src/messages');

const NOW = new Date('2026-10-14T12:00:00Z').getTime();
const SUMMARY = 'users/wer/settings/billing/usage/summary?year=2026&month=10';

// Die Antworten sind eingefroren wie die echten aus github.js (`frozen`): Wer eine an Ort und Stelle sortiert oder
// ändert, fällt hier auf statt erst im Betrieb.

// Ein Eintrag der Abrechnung für Actions-Minuten: `gross` verbraucht, davon `net` bezahlt.
const item = (sku, gross, net = 0, price = 0.006) => ({ product: 'Actions', sku, grossQuantity: gross, discountQuantity: gross - net, netQuantity: net, grossAmount: gross * price, discountAmount: (gross - net) * price, netAmount: net * price, pricePerUnit: price, unitType: 'minutes' });
const summaryOf = (items, period = { year: 2026, month: 10 }) => frozen({ timePeriod: period, user: 'wer', usageItems: items });

// So antwortete GitHub am 14.10.2026 für ein Konto im Tarif Free, dessen Läufe nicht mehr starteten. Wörtlich
// übernommen sind die Einträge; Konto und Monat darum herum sind nachgestellt.
const REAL = summaryOf([
  { product: 'Actions', sku: 'actions_linux', grossQuantity: 2047.0, discountQuantity: 2047.0, netQuantity: 0.0, grossAmount: 12.282, discountAmount: 12.282, netAmount: 0.0, pricePerUnit: 0.006, unitType: 'minutes' },
  { product: 'Actions', sku: 'actions_storage', grossQuantity: 0.774961026, discountQuantity: 0.774961026, netQuantity: 0.0, grossAmount: 0.000260304, discountAmount: 0.000260304, netAmount: 0.0, pricePerUnit: 0.00033602, unitType: 'gigabyte-hours' },
  { product: 'Actions', sku: 'actions_windows', grossQuantity: 50.4, discountQuantity: 50.4, netQuantity: 0.0, grossAmount: 0.504, discountAmount: 0.504, netAmount: 0.0, pricePerUnit: 0.01, unitType: 'minutes' },
  { product: 'Git LFS', sku: 'git_lfs_storage', grossQuantity: 153.26151534, discountQuantity: 153.26151534, netQuantity: 0.0, grossAmount: 0.014419721, discountAmount: 0.014419721, netAmount: 0.0, pricePerUnit: 9.4086e-05, unitType: 'gigabyte-hours' },
]);

test('die echte Antwort: Minuten je Betriebssystem und zusammen, Speicher und anderes zählen nicht', () => {
  assert.deepEqual(summarize(REAL, 'free', NOW), {
    plan: 'free', used: 2097, included: 2000, paid: 0, cost: 0,
    systems: { linux: 2047, windows: 50, macos: 0, other: 0 },
    resetAt: '2026-11-01T00:00:00.000Z', state: STATE.OUT, tightAt: TIGHT_AT, plans: INCLUDED,
  });
});

test('Zustand: in Ordnung, knapp ab 85 %, aufgebraucht am Enthaltenen', () => {
  const stateAt = (used, net = 0) => summarize(summaryOf([item('actions_linux', used, net)]), 'free', NOW).state;
  assert.equal(stateAt(0), STATE.OK);
  assert.equal(stateAt(1699), STATE.OK);
  assert.equal(stateAt(1700), STATE.TIGHT);
  assert.equal(stateAt(1999), STATE.TIGHT);
  assert.equal(stateAt(2000), STATE.OUT);
  assert.equal(summarize(summaryOf([]), 'free', NOW).state, STATE.OK);
});

test('geurteilt wird über die gerundeten Zahlen, die auch gezeigt werden', () => {
  const of = (...items) => summarize(summaryOf(items), 'free', NOW);
  assert.equal(of(item('actions_linux', 1699.4)).state, STATE.OK);
  assert.equal(of(item('actions_linux', 1699.5)).state, STATE.TIGHT);
  const full = of(item('actions_linux', 1999.6));
  assert.deepEqual([full.used, full.state], [2000, STATE.OUT]);
  // Die Summe ist die der gezeigten Teile.
  const halves = of(item('actions_linux', 10.5), item('actions_windows', 10.5));
  assert.deepEqual([halves.used, halves.systems.linux, halves.systems.windows], [22, 11, 11]);
  // Ein Bruchteil einer bezahlten Minute ist noch kein Bezahlen.
  const fraction = of(item('actions_linux', 2100, 0.3));
  assert.deepEqual([fraction.paid, fraction.state], [0, STATE.OUT]);
});

test('wer über das Enthaltene hinaus bezahlt, hat ein Budget: weder knapp noch aufgebraucht, sondern bezahlt', () => {
  const found = summarize(summaryOf([item('actions_linux', 2300, 300), item('actions_macos', 10, 10, 0.062)]), 'free', NOW);
  assert.equal(found.state, STATE.PAID);
  assert.equal(found.used, 2310);
  assert.equal(found.paid, 310);
  assert.equal(found.cost, 2.42);
  assert.deepEqual(found.systems, { linux: 2300, windows: 0, macos: 10, other: 0 });
  // Wird schon unter dem Enthaltenen etwas berechnet (etwa ein größerer Runner), ist es deshalb nicht knapp.
  assert.equal(summarize(summaryOf([item('actions_linux', 1800), item('actions_linux_4_core', 5, 5)]), 'free', NOW).state, STATE.OK);
});

test('die enthaltenen Minuten kommen aus dem Tarif; ein unbekannter hat keine und damit keinen Zustand', () => {
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

test('der Name des Tarifs geht nur in schlichter Form hinaus', () => {
  const planOf = (plan) => summarize(summaryOf([]), plan, NOW).plan;
  assert.equal(planOf('Team'), 'team');
  assert.equal(planOf('<img src=x onerror=alert(1)>'), null);
  assert.equal(planOf('x'.repeat(41)), null);
  assert.equal(planOf(undefined), null);
});

test('unsinnig große Zahlen in der Antwort ergeben keine unendliche Summe', () => {
  const found = summarize(summaryOf([item('actions_linux', 1e308), item('actions_linux', 1e308, 1e308)]), 'free', NOW);
  assert.ok(Number.isFinite(found.used) && Number.isFinite(found.paid) && Number.isFinite(found.cost));
  assert.equal(JSON.parse(JSON.stringify(found)).used, found.used);
});

test('mehrere Einträge eines Betriebssystems zählen zusammen, ein unbekanntes Kürzel als anderes', () => {
  const found = summarize(summaryOf([item('actions_linux', 100), item('actions_linux_4_core', 20), item('actions_macos_xl', 5), item('actions_neu', 3)]), 'free', NOW);
  assert.deepEqual(found.systems, { linux: 120, windows: 0, macos: 5, other: 3 });
  assert.equal(found.used, 128);
});

test('der Monat beginnt am Ersten des Folgemonats neu, auch über den Jahreswechsel und ohne Angabe', () => {
  assert.equal(summarize(summaryOf([], { year: 2026, month: 12 }), 'free', NOW).resetAt, '2027-01-01T00:00:00.000Z');
  assert.equal(summarize(frozen({ usageItems: [] }), 'free', NOW).resetAt, '2026-11-01T00:00:00.000Z');
  assert.equal(summarize(summaryOf([], { year: 2026, month: 13 }), 'free', NOW).resetAt, '2026-11-01T00:00:00.000Z');
});

test('eine Antwort ohne Einträge oder mit Unsinn ergibt null Minuten statt eines Fehlers', () => {
  for (const summary of [null, frozen({}), frozen({ usageItems: 'nichts' }), summaryOf([null, { product: 'Actions', unitType: 'minutes', grossQuantity: 'viel', netQuantity: -3 }])]) {
    const found = summarize(summary, 'free', NOW);
    assert.equal(found.used, 0);
    assert.equal(found.state, STATE.OK);
  }
});

// `gh` nachgestellt: Zusammenfassung und Konto; `fail` lässt jede Abfrage scheitern, `hold` hält jede auf.
function fakeGitHub(summary, plan = 'free') {
  const github = { calls: [], fail: null, hold: null, summary };
  github.gh = async ([, path]) => {
    github.calls.push(path);
    await github.hold;
    if (github.fail) throw new Error(github.fail);
    return path === 'user' ? frozen({ login: 'wer', plan: { name: plan } }) : github.summary;
  };
  github.reads = () => github.calls.filter((path) => path !== 'user');
  return github;
}

test('liest die Zusammenfassung des Kontos für den laufenden Monat und den Tarif und zeigt den Stand', async () => {
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ gh: github.gh, now: () => NOW });
  await minutes.refresh('wer');
  assert.deepEqual(github.calls, [SUMMARY, 'user']);
  assert.equal(minutes.view('wer').used, 2097);
  assert.equal(minutes.view('wer').state, STATE.OUT);
  assert.equal('login' in minutes.view('wer'), false);
});

test('der Stand gilt nur für sein Konto und nur bis zum Ende seines Monats', async () => {
  let now = NOW;
  const minutes = createMinutes({ gh: fakeGitHub(REAL).gh, now: () => now });
  await minutes.refresh('wer');
  assert.deepEqual(minutes.view('anders'), { state: STATE.READING });
  assert.equal(minutes.view(null), null);
  now = new Date('2026-11-01T00:00:00Z').getTime();
  assert.deepEqual(minutes.view('wer'), { state: STATE.READING });
});

test('ohne Stand sagt die Ansicht, ob noch gelesen wird oder die Abfrage gescheitert ist', async () => {
  const github = fakeGitHub(REAL);
  github.fail = 'gh: Not Found (HTTP 404)';
  const minutes = createMinutes({ gh: github.gh, now: () => NOW });
  assert.equal(minutes.view(null), null);
  assert.deepEqual(minutes.view('wer'), { state: STATE.READING });
  await minutes.refresh('wer');
  assert.deepEqual(minutes.view('wer'), { state: STATE.FAILED });
  assert.deepEqual(minutes.view('anders'), { state: STATE.READING });
  github.fail = null;
  await minutes.refresh('wer');
  assert.equal(minutes.view('wer').state, STATE.OUT);
});

test('eine Antwort für einen anderen Monat gilt nicht und steht im Protokoll', async () => {
  const logged = [];
  const github = fakeGitHub(summaryOf([item('actions_linux', 10)], { year: 2026, month: 9 }));
  const minutes = createMinutes({ gh: github.gh, log: (text) => logged.push(render(text)), now: () => NOW });
  await minutes.refresh('wer');
  assert.deepEqual(minutes.view('wer'), { state: STATE.FAILED });
  assert.match(logged[0], /Abrechnung für 9\/2026 statt für 10\/2026/);
});

test('ein Fehler lässt den letzten Stand stehen und steht einmal im Protokoll, bis es wieder gelingt', async () => {
  const github = fakeGitHub(REAL);
  const logged = [];
  const minutes = createMinutes({ gh: github.gh, log: (text) => logged.push(render(text)), now: () => NOW });
  await minutes.refresh('wer');
  github.fail = 'gh: Not Found (HTTP 404)';
  await minutes.refresh('wer');
  await minutes.refresh('wer');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Minuten-Kontingent.*HTTP 404/);
  assert.equal(minutes.view('wer').used, 2097);
  github.fail = null;
  github.summary = summaryOf([item('actions_linux', 10)]);
  await minutes.refresh('wer');
  assert.equal(minutes.view('wer').used, 10);
  github.fail = 'kein Netz';
  await minutes.refresh('wer');
  assert.equal(logged.length, 2);
});

test('ein anderes Konto beginnt von vorn: Sein erster Fehler steht im Protokoll, und es wird bald wieder gefragt', async () => {
  let now = NOW;
  const github = fakeGitHub(REAL);
  const logged = [];
  github.fail = 'gh: Not Found (HTTP 404)';
  const minutes = createMinutes({ gh: github.gh, log: (text) => logged.push(render(text)), now: () => now });
  for (let round = 0; round < 4; round += 1) { await minutes.refresh('wer'); }
  assert.equal(logged.length, 1);
  await minutes.poll('anders');
  assert.equal(logged.length, 2);
  const before = github.reads().length;
  now += RETRY;
  await minutes.poll('anders');
  assert.equal(github.reads().length, before + 1);
});

test('wirft das Protokoll, scheitert die Abfrage trotzdem nicht', async () => {
  const github = fakeGitHub(REAL);
  github.fail = 'kein Netz';
  const minutes = createMinutes({ gh: github.gh, log: () => { throw new Error('Platte voll'); }, now: () => NOW });
  await minutes.refresh('wer');
  assert.deepEqual(minutes.view('wer'), { state: STATE.FAILED });
});

test('es läuft höchstens eine Abfrage zugleich', async () => {
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ gh: github.gh, now: () => NOW });
  await Promise.all([minutes.refresh('wer'), minutes.refresh('wer')]);
  assert.equal(github.calls.length, 2);
});

test('wird während einer Abfrage nach einem anderen Konto gefragt, folgt dessen Abfrage danach', async () => {
  const github = fakeGitHub(REAL);
  let open;
  github.hold = new Promise((resolve) => { open = resolve; });
  const minutes = createMinutes({ gh: github.gh, now: () => NOW });
  const both = Promise.all([minutes.refresh('wer'), minutes.refresh('anders')]);
  open();
  await both;
  assert.deepEqual(github.reads(), [SUMMARY, SUMMARY.replace('wer', 'anders')]);
  assert.equal(minutes.view('anders').used, 2097);
});

test('im Takt wird nur gelesen, wenn der Stand fehlt oder alt ist', async () => {
  let now = NOW;
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ gh: github.gh, now: () => now });
  await minutes.poll('wer');
  await minutes.poll('wer');
  assert.equal(github.reads().length, 1);
  now += FRESH - 1;
  await minutes.poll('wer');
  assert.equal(github.reads().length, 1);
  now += 1;
  await minutes.poll('wer');
  assert.equal(github.reads().length, 2);
  // Ein anderes Konto wird sofort gelesen.
  await minutes.poll('anders');
  assert.equal(github.reads().length, 3);
});

test('nach einem Fehlschlag wird im Takt in wachsendem Abstand wieder gefragt', async () => {
  let now = NOW;
  const github = fakeGitHub(REAL);
  github.fail = 'kein Netz';
  const minutes = createMinutes({ gh: github.gh, now: () => now });
  await minutes.poll('wer');
  const waits = [];
  for (let round = 0; round < 6; round += 1) {
    const before = github.reads().length;
    let waited = 0;
    while (github.reads().length === before) { now += RETRY; waited += 1; await minutes.poll('wer'); }
    waits.push(waited);
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 15, 15]);
});

test('nach dem Monatswechsel wird beim nächsten Takt gleich neu gelesen', async () => {
  let now = new Date('2026-10-31T23:59:00Z').getTime();
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ gh: github.gh, now: () => now });
  await minutes.poll('wer');
  now += 2 * RETRY;
  github.summary = summaryOf([item('actions_linux', 3)], { year: 2026, month: 11 });
  assert.deepEqual(minutes.view('wer'), { state: STATE.READING });
  await minutes.poll('wer');
  assert.equal(github.reads().at(-1), 'users/wer/settings/billing/usage/summary?year=2026&month=11');
  assert.equal(minutes.view('wer').used, 3);
});

test('was die Oberfläche bekommt, lässt sich ändern, ohne den Stand zu treffen', async () => {
  const minutes = createMinutes({ gh: fakeGitHub(REAL).gh, now: () => NOW });
  await minutes.refresh('wer');
  minutes.view('wer').systems.linux = 0;
  minutes.view('wer').plans.free = 1;
  assert.equal(minutes.view('wer').systems.linux, 2047);
  assert.equal(minutes.view('wer').plans.free, INCLUDED.free);
});
