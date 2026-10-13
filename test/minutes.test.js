const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinutes, summarize, STATE, TIGHT, INCLUDED } = require('../src/minutes');

const NOW = new Date('2026-10-14T12:00:00Z').getTime();

// Die Antworten sind eingefroren wie die echten aus github.js: Wer eine an Ort und Stelle sortiert oder ändert, fällt
// hier auf statt erst im Betrieb.
const frozen = (value) => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(frozen); } return value; };

const item = (sku, gross, net = 0, price = 0.006, unitType = 'minutes', product = 'Actions') => ({ product, sku, grossQuantity: gross, discountQuantity: gross - net, netQuantity: net, grossAmount: gross * price, discountAmount: (gross - net) * price, netAmount: net * price, pricePerUnit: price, unitType });
const summaryOf = (items, period = { year: 2026, month: 10 }) => frozen({ timePeriod: period, user: 'wer', usageItems: items });

// So antwortete GitHub am 14.10.2026 für ein Konto im Tarif Free, dessen Läufe nicht mehr starteten.
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
    resetAt: '2026-11-01T00:00:00.000Z', state: STATE.OUT, tightAt: TIGHT,
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

test('wer über das Enthaltene hinaus bezahlt, ist nicht aufgebraucht: Dort starten die Läufe weiter', () => {
  const found = summarize(summaryOf([item('actions_linux', 2300, 300), item('actions_macos', 10, 10, 0.062)]), 'free', NOW);
  assert.equal(found.state, STATE.TIGHT);
  assert.equal(found.used, 2310);
  assert.equal(found.paid, 310);
  assert.equal(found.cost, 2.42);
  assert.deepEqual(found.systems, { linux: 2300, windows: 0, macos: 10, other: 0 });
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

// `gh` nachgestellt: Zusammenfassung und Konto; `fail` lässt jede Abfrage scheitern.
function fakeGitHub(summary, plan = 'free') {
  const github = { calls: [], fail: null, summary };
  github.gh = async ([, path]) => {
    github.calls.push(path);
    if (github.fail) throw new Error(github.fail);
    return path === 'user' ? frozen({ login: 'wer', plan: { name: plan } }) : github.summary;
  };
  return github;
}

test('liest die Zusammenfassung des Kontos und den Tarif und zeigt den Stand', async () => {
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ gh: github.gh, now: () => NOW });
  assert.equal(minutes.view('wer'), null);
  await minutes.refresh('wer');
  assert.deepEqual(github.calls, ['users/wer/settings/billing/usage/summary', 'user']);
  assert.equal(minutes.view('wer').used, 2097);
  assert.equal(minutes.view('wer').state, STATE.OUT);
  assert.equal('login' in minutes.view('wer'), false);
});

test('der Stand gilt nur für sein Konto und nur bis zum Ende seines Monats', async () => {
  let now = NOW;
  const minutes = createMinutes({ gh: fakeGitHub(REAL).gh, now: () => now });
  await minutes.refresh('wer');
  assert.equal(minutes.view('anders'), null);
  assert.equal(minutes.view(null), null);
  now = new Date('2026-11-01T00:00:00Z').getTime();
  assert.equal(minutes.view('wer'), null);
});

test('ein Fehler lässt den letzten Stand stehen und steht einmal im Protokoll, bis es wieder gelingt', async () => {
  const github = fakeGitHub(REAL);
  const logged = [];
  const minutes = createMinutes({ gh: github.gh, log: (text) => logged.push(text), now: () => NOW });
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

test('es läuft höchstens eine Abfrage zugleich', async () => {
  const github = fakeGitHub(REAL);
  const minutes = createMinutes({ gh: github.gh, now: () => NOW });
  await Promise.all([minutes.refresh('wer'), minutes.refresh('wer')]);
  assert.equal(github.calls.length, 2);
});

test('was die Oberfläche bekommt, lässt sich ändern, ohne den Stand zu treffen', async () => {
  const minutes = createMinutes({ gh: fakeGitHub(REAL).gh, now: () => NOW });
  await minutes.refresh('wer');
  minutes.view('wer').systems.linux = 0;
  assert.equal(minutes.view('wer').systems.linux, 2047);
});
