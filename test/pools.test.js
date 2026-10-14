const test = require('node:test');
const assert = require('node:assert/strict');
const { createPools } = require('../src/pools');
const { createRunners } = require('../src/runners');
const { createNames, DEFAULT_PORT } = require('../src/names');
const { runnerView } = require('../src/status');
const limitRules = require('../src/limits');
const { turn, until, settle } = require('./support');

const REPO = 'wer/App';
const MARK = 'runclub.runner=test';
const OLD = { runnerCpus: 6, runnerMemory: '4g', dockerCpus: 4, dockerMemory: '8g' };
const NEW = { ...OLD, dockerMemory: '6g' };
const NEWER = { ...OLD, dockerMemory: '5g' };

function basics() {
  return {
    calls: [], logs: [], slept: [], stopping: false, ready: true, limits: OLD, onSleep: () => {},
    settings: { repo: REPO, parallel: 2, cache: true, paused: false },
    pool: { repo: REPO, slots: [], reserve: [], leaving: 0, hold: false, prepared: true, removed: false, seeded: new Set(), sizes: null }, // wie `startPool`, schon vorbereitet
  };
}

// Die Plätze aus slots.js und der Rest nachgestellt. `calls` hält in ihrer Reihenfolge, was die Reserve
// von den Plätzen verlangt. Ein Aufbau (`builds`) bleibt offen, bis der Test ihn mit `finish` oder `fail` beendet.
// Zeit vergeht ohne Warten: `sleep` gibt nur einmal an alles andere ab und merkt sich die Dauer.
function world() {
  const w = { ...basics(), builds: [], loops: [], aborted: [], removing: () => {}, caches: () => {} };
  w.pools = createPools({
    log: (...entry) => w.logs.push(entry),
    sleep: async (ms) => { w.slept.push(ms); w.onSleep(ms); await turn(); },
    settingsOf: (repo) => (repo === REPO ? w.settings : undefined),
    limitsOf: () => w.limits,
    stopping: () => w.stopping, dockerReady: () => w.ready,
    provision: (pool, cancelled) => {
      const number = w.builds.length + 1;
      const build = { cancelled, pair: { id: String(number), base: `rc-app-${number}` } };
      build.promise = new Promise((resolve, reject) => { build.finish = (pair = build.pair) => resolve(pair); build.fail = reject; });
      w.builds.push(build);
      w.calls.push(`provision ${number}`);
      return build.promise;
    },
    removePair: async (repo, base, runnerId) => {
      assert.equal(repo, REPO);
      assert.equal(runnerId, null); // ein Paar der Reserve war nie angemeldet
      w.calls.push(`remove ${base}`);
      await w.removing(base);
      w.calls.push(`removed ${base}`);
    },
    abort: async (slot) => { slot.aborted = true; w.calls.push(`teardown ${slot.name}`); },
    slotLoop: (pool, slot) => { w.loops.push(slot); },
    abortIdle: async (slot) => { w.aborted.push(slot); w.calls.push(`abort ${slot.name ?? w.pool.slots.indexOf(slot) + 1}`); },
    prepareCaches: async (repo) => { w.calls.push(`caches ${repo}`); await w.caches(); },
    pools: new Map([[REPO, w.pool]]), refreshSeed: async () => {}, measureSizes: async () => {},
  });
  return w;
}

// Ein Tor: hält auf, bis der Test es öffnet.
function gate() {
  let open = null;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test('die Reserve füllt sich bis zur gewünschten Größe und nicht darüber', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2']);
  assert.deepEqual(w.pool.reserve.map(({ cancel, ready, built }) => ({ cancel, ready, built })),
    [{ cancel: false, ready: false, built: limitRules.key(OLD) }, { cancel: false, ready: false, built: limitRules.key(OLD) }]);

  w.builds[0].finish();
  assert.equal(await w.pool.reserve[0].promise, w.builds[0].pair);
  assert.deepEqual(w.pool.reserve.map((entry) => entry.ready), [true, false]);

  // Nimmt ein Platz ein Paar heraus, entsteht genau eines neu.
  w.pool.reserve.shift();
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2', 'provision 3']);
  assert.equal(w.pool.reserve.length, 2);
  assert.deepEqual(w.logs, []);
});

test('die Größe der Reserve: eingestellt, sonst so viele wie Plätze, höchstens zwei', () => {
  const w = world();
  const size = (settings) => { w.settings = settings; return w.pools.reserveSize(w.pool); };
  assert.equal(size({ parallel: 1 }), 1);
  assert.equal(size({ parallel: 2 }), 2);
  assert.equal(size({ parallel: 4 }), 2);
  assert.equal(size({ parallel: 4, reserve: 3 }), 3);
  assert.equal(size({ parallel: 4, reserve: 0 }), 0);
  assert.equal(size({}), 0);
  assert.equal(w.pools.reserveSize({ repo: 'wer/Anders' }), 0); // kein Pool in den Einstellungen
});

test('nachgefüllt wird nicht, wenn das Programm endet, der Pool entfernt wird, Docker fehlt oder der Pool ruht', () => {
  const cases = [
    (w) => { w.stopping = true; },
    (w) => { w.pool.removed = true; },
    (w) => { w.ready = false; },
    (w) => { w.pool.prepared = false; },
    (w) => { w.pool.hold = true; },
    (w) => { w.settings.paused = true; },
  ];
  for (const prepare of cases) {
    const w = world();
    prepare(w);
    w.pools.replenish(w.pool);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.pool.reserve, []);
  }
});

test('ein Pool ruht, solange er nicht vorbereitet, angehalten oder pausiert ist', () => {
  const w = world();
  assert.ok(!w.pools.poolResting(w.pool));
  assert.ok(w.pools.poolResting({ ...w.pool, prepared: false }));
  assert.ok(w.pools.poolResting({ ...w.pool, hold: true }));
  w.settings.paused = true;
  assert.ok(w.pools.poolResting(w.pool));
  assert.ok(!w.pools.poolResting({ repo: 'wer/Anders', prepared: true, hold: false }));
});

test('ein gescheiterter Aufbau verlässt die Reserve und steht im Protokoll; ein abgebrochener geht still', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  const [failed, cancelled] = w.pool.reserve;
  w.builds[0].fail(new Error('Docker-Daemon startet nicht: no space left on device'));
  assert.equal(await failed.promise, null); // wer das Paar schon übernommen hat, bekommt keinen Fehler
  assert.deepEqual(w.pool.reserve, [cancelled]);
  assert.deepEqual(w.logs, [['Vorbereitung eines Paars – Docker-Daemon startet nicht: no space left on device', REPO, 'error']]);
  assert.equal(failed.ready, false);

  w.builds[1].finish(null); // so endet `provision` nach einem Abbruch
  assert.equal(await cancelled.promise, null);
  assert.deepEqual(w.pool.reserve, []);
  assert.equal(w.logs.length, 1);

  w.pools.replenish(w.pool); // der nächste Takt füllt wieder auf
  assert.deepEqual(w.calls, ['provision 1', 'provision 2', 'provision 3', 'provision 4']);
});

test('ein Aufbau für die Reserve gilt als abgebrochen, wenn sein Eintrag verworfen wird oder das Programm endet', () => {
  const w = world();
  w.pools.replenish(w.pool);
  assert.equal(w.builds[0].cancelled(), false);
  w.pool.reserve[0].cancel = true;
  assert.equal(w.builds[0].cancelled(), true);
  assert.equal(w.builds[1].cancelled(), false);
  w.stopping = true;
  assert.equal(w.builds[1].cancelled(), true);
});

test('discardReserve ohne `keep`: Fertige Paare werden entfernt, laufende Aufbauten abgebrochen und abgewartet', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  const entries = [...w.pool.reserve];
  w.builds[0].finish();
  await entries[0].promise;

  let done = false;
  const discarding = w.pools.discardReserve(w.pool).then(() => { done = true; });
  assert.deepEqual(w.pool.reserve, []); // sofort leer: Ein Platz nimmt nichts mehr daraus
  assert.deepEqual(entries.map((entry) => entry.cancel), [true, true]);
  await settle();
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'removed rc-app-1']);
  assert.equal(done, false); // der zweite Aufbau läuft noch

  w.builds[1].finish(null);
  await discarding;
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'removed rc-app-1']);

  // Wird ein Aufbau trotz Abbruch noch fertig, geht auch dieses Paar.
  w.pools.replenish(w.pool);
  const late = w.pools.discardReserve(w.pool);
  w.builds[2].finish();
  w.builds[3].finish(null);
  await late;
  assert.deepEqual(w.calls.slice(6), ['remove rc-app-3', 'removed rc-app-3']);
  assert.deepEqual(w.logs, []);
});

test('discardReserve mit `keep`: Was behalten wird, bleibt unberührt in der Reserve', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  const [first, second] = w.pool.reserve;
  w.builds[0].finish();
  w.builds[1].finish();
  await w.pools.discardReserve(w.pool, (entry) => entry === second);
  assert.deepEqual(w.pool.reserve, [second]);
  assert.deepEqual([first.cancel, second.cancel], [true, false]);
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'removed rc-app-1']);
});

test('renewReserve ersetzt nur Einträge mit alten Limits', async () => {
  const w = world();
  w.settings.reserve = 1;
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  const old = w.pool.reserve[0];

  await w.pools.renewReserve(w.pool); // nichts geändert: Die Reserve bleibt stehen
  assert.deepEqual(w.pool.reserve, [old]);
  assert.deepEqual(w.calls, ['provision 1']);

  w.limits = NEW;
  await w.pools.renewReserve(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'remove rc-app-1', 'removed rc-app-1', 'provision 2']);
  assert.deepEqual(w.pool.reserve.map((entry) => entry.built), [limitRules.key(NEW)]);
  assert.equal(old.cancel, true);

  // Mit zwei Einträgen: Nur der alte geht.
  w.settings.reserve = 2;
  w.pools.replenish(w.pool);
  const [fresh, stale] = w.pool.reserve;
  stale.built = limitRules.key(OLD);
  w.builds[1].finish();
  w.builds[2].finish();
  await w.pools.renewReserve(w.pool);
  assert.equal(w.pool.reserve[0], fresh);
  assert.deepEqual(w.calls.slice(4), ['provision 3', 'remove rc-app-3', 'removed rc-app-3', 'provision 4']);
  assert.deepEqual(w.logs, []);
});

test('mehrere renewReserve kurz nacheinander laufen nacheinander: erst entfernen, dann neu bauen', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  const first = gate();
  w.removing = (base) => (base === 'rc-app-1' ? first.promise : undefined);

  w.limits = NEW;
  w.pools.renewReserve(w.pool);
  w.limits = NEWER; // der nächste Regler, bevor die erste Erneuerung fertig ist
  const second = w.pools.renewReserve(w.pool);
  assert.equal(w.pool.renewing, second);
  await settle();
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'remove rc-app-2', 'removed rc-app-2']); // solange ein altes Paar steht, entsteht nichts Neues
  assert.deepEqual(w.pool.reserve, []);

  first.open();
  await until(() => w.builds.length === 4);
  // Die erste Erneuerung hat mit den jetzt geltenden Limits gebaut; für die zweite bleibt nichts zu tun.
  assert.deepEqual(w.calls.slice(2), ['remove rc-app-1', 'remove rc-app-2', 'removed rc-app-2', 'removed rc-app-1', 'provision 3', 'provision 4']);
  await second;
  assert.deepEqual(w.pool.reserve.map((entry) => entry.built), [limitRules.key(NEWER), limitRules.key(NEWER)]);
  assert.equal(w.builds.length, 4);
});

test('eine Erneuerung, die auf einen noch laufenden Aufbau trifft, wartet ihn ab; ein Fehler steht im Protokoll und hält die nächste nicht auf', async () => {
  const w = world();
  w.settings.reserve = 1;
  w.pools.replenish(w.pool);
  w.limits = NEW;
  let done = false;
  w.pools.renewReserve(w.pool).then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  assert.deepEqual(w.calls, ['provision 1']);
  w.builds[0].finish(null);
  await until(() => done);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2']);

  w.builds[1].finish();
  w.limits = NEWER;
  w.removing = () => { throw new Error('Docker antwortet nicht'); };
  await w.pools.renewReserve(w.pool);
  assert.deepEqual(w.logs, [['Abbau der Reserve – Docker antwortet nicht', REPO, 'error']]);
  assert.deepEqual(w.calls.slice(-2), ['remove rc-app-2', 'provision 3']); // nachgefüllt wird auch nach dem Fehler
  assert.deepEqual(w.pool.reserve.map((entry) => entry.built), [limitRules.key(NEWER)]);

  w.removing = () => {};
  await w.pools.renewReserve(w.pool); // die Reserve ist schon frisch
  assert.equal(w.builds.length, 3);
  assert.equal(w.logs.length, 1);
});

test('staleCount zählt freie Paare und Reserve mit alten Limits, nicht aber arbeitende und aufräumende Plätze', () => {
  const w = world();
  const old = limitRules.key(OLD);
  const current = limitRules.key(NEW);
  w.limits = NEW;
  assert.equal(w.pools.staleCount(w.pool), 0);
  w.pool.slots = [
    { state: 'bereit', base: 'rc-app-1', built: old }, // zählt
    { state: 'startet', base: 'rc-app-2', built: old }, // zählt
    { state: 'bereit', base: 'rc-app-3', built: current },
    { state: 'arbeitet', base: 'rc-app-4', built: old },
    { state: 'räumt auf', base: 'rc-app-5', built: old },
    { state: 'wartet', base: null, built: old }, // kein Paar mehr
    { state: 'startet', base: 'rc-app-6' }, // noch ohne Angabe
  ];
  assert.equal(w.pools.staleCount(w.pool), 2);
  w.pool.reserve = [{ built: old }, { built: current }, { built: old }];
  assert.equal(w.pools.staleCount(w.pool), 4);
  w.limits = OLD;
  assert.equal(w.pools.staleCount(w.pool), 2); // jetzt sind die anderen die alten: ein freier Platz und ein Eintrag der Reserve
});

test('reconcile legt fehlende Plätze an und lässt überzählige auslaufen', () => {
  const w = world();
  w.pools.reconcile(w.pool);
  assert.deepEqual(w.pool.slots, [{ repo: REPO, state: 'startet', jobs: 0 }, { repo: REPO, state: 'startet', jobs: 0 }]);
  assert.deepEqual(w.loops, w.pool.slots);
  const [first, second] = w.pool.slots;

  w.pools.reconcile(w.pool); // schon passend
  assert.equal(w.pool.slots.length, 2);
  assert.deepEqual(w.aborted, []);

  w.settings.parallel = 1;
  w.pools.reconcile(w.pool);
  assert.deepEqual([first.retired, second.retired], [undefined, true]);
  assert.deepEqual(w.aborted, [second]);
  assert.equal(w.pool.slots.length, 2); // der auslaufende Platz geht erst, wenn seine Schleife endet

  // Wird wieder erhöht, bleibt zuerst der auslaufende Platz; erst für den dritten entsteht ein neuer.
  w.settings.parallel = 3;
  w.pools.reconcile(w.pool);
  assert.equal(w.pool.slots.length, 3);
  assert.equal(w.loops.length, 3);
  assert.deepEqual(w.pool.slots.map((slot) => Boolean(slot.retired)), [false, false, false]);
  assert.deepEqual(w.pool.slots.slice(0, 2), [first, second]);
  assert.deepEqual(w.aborted, [second]);

  // Ohne Eintrag in den Einstellungen laufen alle aus.
  w.settings = undefined;
  w.pools.reconcile(w.pool);
  assert.deepEqual(w.pool.slots.map((slot) => slot.retired), [true, true, true]);
  assert.equal(w.aborted.length, 4);
  w.pools.reconcile(w.pool); // schon auslaufende werden nicht noch einmal abgebrochen
  assert.equal(w.aborted.length, 4);
});

test('reconcile übernimmt nur auslaufende Plätze, deren Schleife noch läuft, und nicht mehr als gewünscht', () => {
  const w = world();
  w.settings.parallel = 4;
  w.pools.reconcile(w.pool);
  const [first, second, third, fourth] = w.pool.slots;
  w.settings.parallel = 1;
  w.pools.reconcile(w.pool);
  second.state = 'aus'; // seine Schleife ist schon zu Ende
  third.state = 'arbeitet';

  w.settings.parallel = 2;
  w.pools.reconcile(w.pool);
  assert.deepEqual([first, second, third, fourth].map((slot) => Boolean(slot.retired)), [false, true, false, true]);
  assert.equal(w.loops.length, 4); // kein neuer Platz

  w.settings.parallel = 4;
  w.pools.reconcile(w.pool);
  assert.deepEqual([first, second, third, fourth].map((slot) => Boolean(slot.retired)), [false, true, false, false]);
  assert.equal(w.loops.length, 5); // der beendete Platz kommt nicht zurück: Für ihn entsteht ein neuer
});

test('quiesce baut Reserve und freie Paare ab und wartet, bis nichts mehr steht', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  const working = { name: 'arbeitend', state: 'arbeitet', base: 'rc-app-8' };
  const building = { name: 'bauend', state: 'startet', building: true };
  w.pool.slots = [working, building];
  w.onSleep = () => {
    if (w.slept.length === 2) building.building = false;
    if (w.slept.length === 4) working.base = null; // der Job ist zu Ende, das Paar abgeräumt
  };
  await w.pools.quiesce(w.pool);

  assert.deepEqual(w.calls.slice(2), ['abort arbeitend', 'abort bauend', 'remove rc-app-1', 'remove rc-app-2', 'removed rc-app-1', 'removed rc-app-2']);
  assert.deepEqual(w.slept, [500, 500, 500, 500]);
  assert.deepEqual(w.pool.reserve, []);

  // Steht nichts, wird nicht gewartet. Solange noch etwas in der Reserve liegt, schon.
  const empty = world();
  await empty.pools.quiesce(empty.pool);
  assert.deepEqual(empty.slept, []);
  const refilled = world();
  refilled.removing = () => { refilled.pool.reserve.push({}); };
  refilled.pools.replenish(refilled.pool);
  refilled.builds[0].finish();
  refilled.builds[1].finish(null);
  refilled.onSleep = () => { if (refilled.slept.length === 3) refilled.pool.reserve = []; };
  await refilled.pools.quiesce(refilled.pool);
  assert.deepEqual(refilled.slept, [500, 500, 500]);
});

test('withPoolAtRest hält den Pool an, bis die Arbeit getan ist, und gibt ihr Ergebnis zurück', async () => {
  const w = world();
  const slot = { name: 'frei', state: 'bereit', base: 'rc-app-9' };
  w.pool.slots = [slot];
  w.onSleep = () => { assert.equal(w.pool.hold, true); if (w.slept.length === 2) slot.base = null; };
  const seen = {};
  const result = await w.pools.withPoolAtRest(w.pool, async () => {
    Object.assign(seen, { hold: w.pool.hold, base: slot.base, slept: w.slept.length });
    w.pools.replenish(w.pool); // ein angehaltener Pool füllt nicht nach
    return 'fertig';
  });
  assert.equal(result, 'fertig');
  assert.deepEqual(seen, { hold: true, base: null, slept: 2 }); // die Arbeit beginnt erst, wenn nichts mehr steht
  assert.equal(w.pool.hold, false);
  assert.deepEqual(w.calls, ['abort frei']);
});

test('ein zweites withPoolAtRest wartet auf das erste', async () => {
  const w = world();
  const first = gate();
  const order = [];
  const one = w.pools.withPoolAtRest(w.pool, async () => { order.push('eins beginnt'); await first.promise; order.push('eins endet'); });
  const two = w.pools.withPoolAtRest(w.pool, async () => { order.push('zwei beginnt'); assert.equal(w.pool.hold, true); });
  await settle();
  assert.deepEqual(order, ['eins beginnt']);
  assert.ok(w.slept.length > 0 && w.slept.every((ms) => ms === 500));
  first.open();
  await Promise.all([one, two]);
  assert.deepEqual(order, ['eins beginnt', 'eins endet', 'zwei beginnt']);
  assert.equal(w.pool.hold, false);
});

test('`hold` wird auch nach einem Fehler gelöst; ein Fehler beim Abbau steht im Protokoll und hält die Arbeit nicht auf', async () => {
  const w = world();
  await assert.rejects(w.pools.withPoolAtRest(w.pool, async () => { throw new Error('Cache lässt sich nicht leeren'); }), { message: 'Cache lässt sich nicht leeren' });
  assert.equal(w.pool.hold, false);

  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  w.removing = () => { throw new Error('Docker antwortet nicht'); };
  let worked = false;
  await w.pools.withPoolAtRest(w.pool, async () => { worked = true; });
  assert.equal(worked, true);
  assert.equal(w.pool.hold, false);
  assert.deepEqual(w.logs, [['Abbau der Reserve – Docker antwortet nicht', REPO, 'error'], ['Abbau der Reserve – Docker antwortet nicht', REPO, 'error']]);
  assert.equal(w.pool.leaving, 0);

  w.removing = () => {};
  assert.equal(await w.pools.withPoolAtRest(w.pool, async () => 'danach'), 'danach');
});

test('rebuildIdle ohne laufenden Job: Der Pool kommt zur Ruhe und der Build-Dienst entsteht neu', async () => {
  const w = world();
  const slot = { name: 'frei', state: 'bereit', base: 'rc-app-9' };
  w.pool.slots = [slot];
  w.onSleep = () => { slot.base = null; };
  w.caches = () => { assert.equal(w.pool.hold, true); assert.equal(slot.base, null); };
  await w.pools.rebuildIdle(w.pool);
  assert.deepEqual(w.calls, ['abort frei', `caches ${REPO}`]);
  assert.equal(w.pool.hold, false);
  assert.equal(w.pool.renewing, undefined);
});

test('rebuildIdle mit laufendem Job: Die Reserve wird erneuert, freie Paare mit alten Limits abgebrochen, der Pool nicht angehalten', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  w.builds[1].finish();
  w.limits = NEW;
  const old = limitRules.key(OLD);
  w.pool.slots = [
    { name: 'arbeitend', state: 'arbeitet', base: 'rc-app-8', built: old },
    { name: 'frei', state: 'bereit', base: 'rc-app-9', built: old },
    { name: 'frisch', state: 'bereit', base: 'rc-app-7', built: limitRules.key(NEW) }, // trägt schon die neuen Limits: bleibt
    { name: 'bauend', state: 'startet', building: true }, // baut selbst, mit den neuen Limits: bleibt
    { name: 'übernimmt', state: 'startet', building: true, built: old }, // übernimmt gerade ein Paar mit alten Limits: geht
  ];
  await w.pools.rebuildIdle(w.pool);
  assert.deepEqual(w.calls.slice(2), ['abort frei', 'abort übernimmt', 'remove rc-app-1', 'remove rc-app-2', 'removed rc-app-1', 'removed rc-app-2', 'provision 3', 'provision 4']);
  assert.equal(w.pool.hold, false);
  assert.deepEqual(w.slept, []);
});

test('rebuildIdle wartet auf `hold` und entscheidet erst danach, ob ein Job läuft', async () => {
  // Beim Aufruf läuft kein Job; während der Pool angehalten ist (ein Cache wird geleert), beginnt einer.
  const started = world();
  const slot = { name: 'eins', state: 'bereit', base: 'rc-app-9' };
  started.pool.slots = [slot];
  started.pool.hold = true;
  started.onSleep = () => { if (started.slept.length === 3) { slot.state = 'arbeitet'; started.pool.hold = false; } };
  await started.pools.rebuildIdle(started.pool);
  assert.deepEqual(started.slept, [500, 500, 500]);
  assert.deepEqual(started.calls, ['provision 1', 'provision 2']); // nicht angehalten, kein neuer Build-Dienst; die Reserve füllt sich
  assert.equal(started.pool.hold, false);
  assert.ok(started.pool.renewing);

  // Umgekehrt: Beim Aufruf läuft ein Job, am Ende des Wartens nicht mehr.
  const ended = world();
  const busy = { name: 'eins', state: 'arbeitet', base: 'rc-app-9' };
  ended.pool.slots = [busy];
  ended.pool.hold = true;
  ended.onSleep = () => { if (ended.slept.length === 2) { Object.assign(busy, { state: 'bereit', base: null }); ended.pool.hold = false; } };
  await ended.pools.rebuildIdle(ended.pool);
  assert.deepEqual(ended.slept, [500, 500]);
  assert.deepEqual(ended.calls, ['abort eins', `caches ${REPO}`]);
  assert.equal(ended.pool.renewing, undefined);
});

// --- Mit den echten Plätzen, verdrahtet von runners.js wie im Betrieb; nachgestellt sind nur Docker und GitHub ---

function wired() {
  const w = { ...basics(), ends: new Map(), emit: new Map(), ids: 0 };
  const docker = async (args, options = {}) => {
    const name = args[0] === 'run' ? `run ${args[args.indexOf('--name') + 1]}` : args[0] === 'rm' ? `rm ${args.at(-1)}` : args.slice(0, 2).join(' ');
    w.calls.push(name);
    const runner = name.match(/^run (.+)-runner$/);
    if (runner) {
      w.emit.set(runner[1], options.onLine);
      options.onLine('Listening for Jobs');
      return new Promise((resolve) => { w.ends.set(runner[1], () => resolve({ code: 0, stdout: '', stderr: '' })); }); // der Runner wartet auf einen Job
    }
    const removed = name.match(/^rm (.+)-runner$/);
    if (removed && args.length === 3) w.ends.get(removed[1])?.();
    return { code: 0, stdout: '', stderr: '' };
  };
  const gh = async (args) => {
    w.calls.push(`gh ${args[2]}`);
    return args.at(-1).endsWith('/generate-jitconfig') ? { runner: { id: 70 + w.ids }, encoded_jit_config: 'geheim' } : null;
  };
  const sleep = async (ms) => { w.slept.push(ms); w.onSleep(ms); await turn(); };
  const log = (...entry) => w.logs.push(entry);
  w.runners = createRunners({
    docker, dockerList: async () => [], gh, log, sleep, timer: () => {}, newId: () => String(w.ids += 1),
    host: 'PC', names: createNames({ dataDir: 'C:/Daten', port: DEFAULT_PORT }), image: 'runner:test', dind: 'dind:test', buildkit: 'buildkit:test', longTimeout: 1234,
    settings: { settingsOf: (repo) => (repo === REPO ? w.settings : undefined), limitsOf: () => w.limits, state: { learned: {}, rejected: {} }, saveState: () => {} },
    metrics: { meter: () => ({ finish: () => ({}) }), recordJob: () => {} },
    stopping: () => w.stopping, dockerReady: () => w.ready, refreshRepo: () => {}, forgetStats: () => {},
  });
  w.abortIdle = w.runners.slots.abortIdle;
  // Am Ende eines Tests: alle Schleifen beenden, damit nichts weiterläuft.
  w.finish = async () => {
    w.stopping = true;
    for (const end of w.ends.values()) end();
    await until(() => !w.pool.slots.length);
  };
  return w;
}

// Die Plätze, wie die Oberfläche sie sieht (siehe status.js): Name, Zustand und ob er ausläuft.
const names = (w) => w.pool.slots.map((slot, index) => {
  const runner = runnerView({ slot, index, repo: REPO, jobs: [], statsOf: () => undefined, cpus: 1 });
  return `${slot.name} ${runner.state}${runner.retiring ? ', läuft aus' : ''}`;
});
const count = (w, call) => w.calls.filter((name) => name === call).length;

test('echte Plätze: Ein Platz nimmt sein Paar aus der Reserve, und sie füllt sich nach', async () => {
  const w = wired();
  w.settings.parallel = 1;
  w.runners.replenish(w.pool);
  await until(() => w.pool.reserve[0]?.ready);
  assert.equal(w.ids, 1);

  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots[0].state === 'bereit' && w.pool.reserve[0]?.ready);
  assert.deepEqual(names(w), ['PC-linux-1 bereit']); // das vorbereitete Paar, nicht ein neues
  assert.equal(w.ids, 2);
  assert.equal(w.pool.reserve.length, 1);
  assert.deepEqual(w.slept, []);

  // Pausieren, wie `pool/set` es tut: Runner und Reserve gehen, der Platz bleibt und wartet.
  w.settings.paused = true;
  w.pool.slots.forEach((slot) => w.abortIdle(slot));
  w.runners.discardReserve(w.pool);
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots[0].state === 'pausiert');
  assert.deepEqual(w.pool.reserve, []);
  assert.equal(count(w, 'network rm'), 2);
  assert.deepEqual(w.logs, []);
  await w.finish();
});

test('echte Plätze: Überzählige laufen aus; der freie wird abgebrochen, der arbeitende bleibt bis zum Ende seines Jobs', async () => {
  const w = wired();
  w.settings.reserve = 0;
  w.settings.parallel = 3;
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots.every((slot) => slot.state === 'bereit'));
  const [first, second, third] = w.pool.slots;
  w.emit.get(second.base)('Running job: Bauen');
  assert.deepEqual(names(w), ['PC-linux-1 bereit', 'PC-linux-2 arbeitet', 'PC-linux-3 bereit']);

  w.settings.parallel = 1;
  w.runners.reconcile(w.pool);
  assert.deepEqual([first.retired, second.retired, third.retired], [undefined, true, true]);
  await until(() => w.pool.slots.length === 2);
  assert.deepEqual(names(w), ['PC-linux-1 bereit', 'PC-linux-2 arbeitet, läuft aus']);
  assert.equal(third.state, 'aus');
  assert.equal(count(w, 'rm rc-app-3-runner'), 1);
  assert.equal(count(w, 'rm rc-app-2-runner'), 0);
  assert.equal(count(w, 'gh DELETE'), 1); // nur der freie Runner wird bei GitHub abgemeldet

  await settle();
  assert.equal(second.state, 'arbeitet'); // der Job läuft weiter
  w.emit.get(second.base)('Job Bauen completed with result: Succeeded');
  w.ends.get('rc-app-2')();
  await until(() => w.pool.slots.length === 1);
  assert.equal(second.state, 'aus');
  assert.equal(second.jobs, 1);
  assert.equal(w.ids, 3); // für den ausgelaufenen Platz entsteht kein neues Paar
  assert.equal(first.state, 'bereit');
  await w.finish();
});

test('echte Plätze: Wird erhöht, während Plätze auslaufen, stehen nie mehr als eingestellt', async () => {
  const w = wired();
  w.settings.reserve = 0;
  w.settings.parallel = 3;
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots.every((slot) => slot.state === 'bereit'));
  const [first, second, third] = w.pool.slots;
  w.emit.get(second.base)('Running job: Bauen');

  w.settings.parallel = 1;
  w.runners.reconcile(w.pool);
  w.settings.parallel = 3; // gleich wieder erhöht: der arbeitende und der gerade abgebrochene Platz laufen noch aus
  w.runners.reconcile(w.pool);
  assert.deepEqual(w.pool.slots, [first, second, third]);
  assert.deepEqual(w.pool.slots.map((slot) => Boolean(slot.retired)), [false, false, false]);

  await until(() => third.state === 'bereit' && third.name === 'PC-linux-4'); // der abgebrochene Platz baut neu auf
  assert.deepEqual(names(w), ['PC-linux-1 bereit', 'PC-linux-2 arbeitet', 'PC-linux-4 bereit']);
  assert.equal(w.ids, 4);

  // Der Platz, der auslaufen sollte, bedient nach seinem Job den nächsten.
  w.emit.get(second.base)('Job Bauen completed with result: Succeeded');
  w.ends.get('rc-app-2')();
  await until(() => second.state === 'bereit' && second.name === 'PC-linux-5');
  assert.equal(w.pool.slots.length, 3);
  await w.finish();
});

test('echte Plätze: withPoolAtRest wartet das Ende eines laufenden Jobs ab und hält die Plätze so lange an', async () => {
  const w = wired();
  w.settings.reserve = 0;
  w.runners.reconcile(w.pool);
  await until(() => w.pool.slots.every((slot) => slot.state === 'bereit'));
  const [busy, idle] = w.pool.slots;
  w.emit.get(busy.base)('Running job: Bauen');

  let state = null;
  const rest = w.runners.withPoolAtRest(w.pool, async () => { state = names(w); return w.ids; });
  await until(() => idle.state === 'wartet');
  await settle();
  assert.equal(state, null); // solange der Job läuft, beginnt die Arbeit nicht
  assert.equal(busy.state, 'arbeitet');
  assert.equal(w.pool.hold, true);

  w.emit.get(busy.base)('Job Bauen completed with result: Succeeded');
  w.ends.get(busy.base)();
  assert.equal(await rest, 2);
  assert.deepEqual(state, ['PC-linux-1 wartet', 'PC-linux-2 wartet']);
  assert.equal(w.pool.hold, false);

  await until(() => w.pool.slots.every((slot) => slot.state === 'bereit')); // danach bauen die Plätze wieder auf
  assert.equal(w.ids, 4);
  await w.finish();
});

// --- einen Pool anlegen und vorbereiten ---

// Nur was `startPool` und `preparePool` brauchen; der Rest der Reserve bleibt außen vor.
function starter({ ready = true, failCaches = null } = {}) {
  const s = { calls: [], logs: [], pools: new Map(), ready };
  s.api = createPools({
    log: (...entry) => s.logs.push(entry), sleep: turn, pools: s.pools,
    settingsOf: (repo) => ({ repo, parallel: 2, cache: true, paused: false }), limitsOf: () => OLD,
    stopping: () => false, dockerReady: () => s.ready,
    provision: async () => null, removePair: async () => {}, slotLoop: (pool, slot) => s.calls.push(`loop ${pool.repo} ${pool.slots.indexOf(slot) + 1}`), abortIdle: async () => {},
    prepareCaches: async (repo) => { s.calls.push(`caches ${repo}`); if (failCaches) throw new Error(failCaches); },
    refreshSeed: async (repo) => { s.calls.push(`seed ${repo}`); },
    measureSizes: async (pool) => { s.calls.push(`sizes ${pool.repo} ${pool.prepared}`); },
  });
  return s;
}

test('ein neuer Pool steht sofort mit seinen Plätzen da und wird vorbereitet, wenn Docker bereit ist', async () => {
  const s = starter();
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  assert.deepEqual({ ...pool, slots: pool.slots.length, seeded: [...pool.seeded] }, { repo: REPO, slots: 2, reserve: [], leaving: 0, hold: false, prepared: true, preparing: false, removed: false, seeded: [], sizes: null });
  assert.deepEqual(s.calls, [`loop ${REPO} 1`, `loop ${REPO} 2`, `caches ${REPO}`, `seed ${REPO}`, `sizes ${REPO} true`]);
});

test('ist Docker noch nicht bereit, wartet die Vorbereitung auf die Docker-Überwachung', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  assert.equal(s.pools.get(REPO).prepared, false);
  assert.deepEqual(s.calls, [`loop ${REPO} 1`, `loop ${REPO} 2`]);
});

test('scheitert die Vorbereitung, steht das im Protokoll, und der Pool gilt trotzdem als vorbereitet', async () => {
  const s = starter({ failCaches: 'kein Platz' });
  await s.api.startPool(REPO);
  assert.equal(s.pools.get(REPO).prepared, true);
  assert.deepEqual(s.logs, [['Vorbereitung – kein Platz', REPO, 'error']]);
  assert.deepEqual(s.calls.slice(2), [`caches ${REPO}`, `sizes ${REPO} true`]);
});

test('ein Pool, der gerade entfernt wird, wird nicht mehr vorbereitet', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  pool.removed = true;
  await s.api.preparePool(pool);
  assert.equal(s.calls.some((call) => call.startsWith('caches')), false);
});

test('zwei Vorbereitungen zugleich (Anlegen und Docker-Überwachung) laufen nur einmal', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  await Promise.all([s.api.preparePool(pool), s.api.preparePool(pool)]);
  assert.deepEqual(s.calls.filter((call) => call.startsWith('caches')), [`caches ${REPO}`]);
});

test('was gerade abgebaut wird, zählt beim Nachfüllen mit: Es stehen nie mehr Paare als gewollt', async () => {
  const w = world();
  w.pool.leaving = 1;
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1']); // zwei gewollt, eines geht noch
  w.pool.leaving = 0;
  w.pools.replenish(w.pool);
  assert.deepEqual(w.calls, ['provision 1', 'provision 2']);
});

test('withPoolAtRest wartet, bis Vorbereitung, Erneuern des Build-Dienstes und Messen fertig sind', async () => {
  for (const busy of ['preparing', 'renewingService', 'measuring']) {
    const w = world();
    w.pool[busy] = true;
    let worked = false;
    const done = w.pools.withPoolAtRest(w.pool, async () => { worked = true; });
    await settle();
    assert.equal(worked, false, busy);
    assert.equal(w.pool.hold, false, busy); // angehalten wird erst danach
    w.pool[busy] = false;
    await done;
    assert.equal(worked, true, busy);
  }
});

test('ruht der Pool für eine Arbeit an seinen Caches, lässt die Vorbereitung Caches und Messen dieser Arbeit', async () => {
  const s = starter({ ready: false });
  await s.api.startPool(REPO);
  const pool = s.pools.get(REPO);
  pool.hold = true;
  await s.api.preparePool(pool);
  assert.deepEqual(s.calls.slice(2), [`seed ${REPO}`]); // gemessen wird nach der Arbeit, nicht dazwischen
});

test('beim Beenden: Reserve und Paare werden abgebaut, auch eines im Aufbau wird abgewartet', async () => {
  const w = world();
  w.pools.replenish(w.pool);
  w.builds[0].finish();
  const working = { name: 'arbeitend', state: 'arbeitet', base: 'rc-app-9' };
  const building = { name: 'bauend', state: 'startet', building: true };
  w.pool.slots = [working, building];
  w.onSleep = () => { building.building = false; working.base = null; };
  const done = w.pools.dismantle(30000);
  await settle();
  assert.equal(w.builds[1].cancelled(), true); // der Aufbau für die Reserve gilt als abgebrochen …
  w.builds[1].finish(null); // … und endet ohne Paar
  await done;
  assert.ok(w.calls.includes('remove rc-app-1'));
  assert.ok(w.calls.includes('teardown arbeitend') && w.calls.includes('teardown bauend'));
  assert.equal(working.aborted && building.aborted, true);
  assert.ok(w.slept.length >= 1);

  // Ohne Ende wartet es nicht länger als erlaubt.
  const stuck = world();
  stuck.pool.slots = [{ name: 'hängt', state: 'startet', building: true }];
  await stuck.pools.dismantle(0);
  assert.deepEqual(stuck.slept, []);
});

test('beim Beenden hält ein Aufbau für die Reserve, der nicht endet, nichts auf', async () => {
  const w = world();
  w.pools.replenish(w.pool); // beide Aufbauten bleiben offen, etwa hinter dem Auffrischen der Vorlage
  await w.pools.dismantle(0);
  assert.equal(w.pool.leaving, 2); // sie zählen noch, bis sie enden
  assert.equal(w.builds.every((build) => build.cancelled()), true);
  w.builds.forEach((build) => build.finish(null));
  await settle();
  assert.equal(w.pool.leaving, 0);
});
