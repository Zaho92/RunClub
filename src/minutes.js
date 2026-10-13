// Das Minuten-Kontingent von GitHub Actions (in der Oberfläche „GitHub-Minuten“): wie viele Minuten das Konto in
// diesem Monat auf GitHubs eigenen Runnern verbraucht hat. Ist es aufgebraucht, starten Läufe dort nicht mehr (siehe
// waiting.js); hier sieht man es vorher.
//
// Quelle    `users/<konto>/settings/billing/usage/summary` (braucht das Recht `user`) für den laufenden Monat (UTC),
//           ausdrücklich mit Jahr und Monat erfragt. Gezählt werden nur Einträge des Produkts Actions mit der Einheit
//           Minuten, je Betriebssystem und zusammen. `grossQuantity` ist das Verbrauchte, `netQuantity`/`netAmount`,
//           was über das Enthaltene hinaus bezahlt wird.
// Gewicht   Jede Minute zählt einfach, gleich auf welchem Betriebssystem: So nennt GitHub die Zahlen, und so beschreibt
//           es heute das Kontingent. Die früheren Faktoren (Windows 2, macOS 10) nennt die Abrechnung nicht mehr.
// Enthalten Wie viele Minuten der Tarif enthält, sagt die Schnittstelle nicht. Die Zahl ist eine ANNAHME aus dem
//           Tarifnamen (`user` → `plan.name`); für einen unbekannten Tarif gibt es keine. Sie trifft nicht auf die
//           Minute: Die eine echte Antwort (test/minutes.test.js) zeigt 2.097 verbrauchte bei angenommenen 2.000.
// Budget    Ob bei GitHub ein Budget gesetzt ist und wie hoch, sagt die Antwort nicht. Zu sehen ist nur, ob schon
//           etwas bezahlt wurde. Daraus folgen die Zustände; was sie über das Starten von Läufen sagen, ist ein Schluss.
// Zustand   ok | tight (ab 85 % des Enthaltenen, solange nichts berechnet wird) | out (das Enthaltene ist erreicht und nichts wurde bezahlt: Ohne
//           Budget startet GitHub in privaten Repos keine Jobs mehr) | paid (das Enthaltene ist erreicht und es wird
//           bezahlt: Es gibt ein Budget; ob es schon erschöpft ist, ist nicht zu sehen) | unknown (der Tarif ist
//           unbekannt). Solange es für das Konto keinen Stand gibt: reading (wird gelesen) | failed (die letzte
//           Abfrage ist gescheitert).

const { MINUTE } = require('./units');

const SCOPE = 'user'; // das Recht, ohne das GitHub die Abrechnung nicht herausgibt
const STATE = { OK: 'ok', TIGHT: 'tight', OUT: 'out', PAID: 'paid', UNKNOWN: 'unknown', READING: 'reading', FAILED: 'failed' };
const TIGHT_AT = 0.85; // verbrauchter Anteil, ab dem es knapp ist
// ANNAHME: enthaltene Minuten je Monat und Tarif eines persönlichen Kontos, wie GitHub sie öffentlich nennt
// (Stand Oktober 2026). Ändert GitHub seine Tarife, ist diese Tabelle anzupassen; die Oberfläche bekommt sie im Stand.
const INCLUDED = { free: 2000, pro: 3000 };
const SYSTEMS = ['linux', 'windows', 'macos']; // steckt im Kürzel des Eintrags (`actions_linux`, `actions_macos`, …)
const FRESH = 15 * MINUTE; // so lange gilt ein gelesener Stand; die Zahl ändert sich langsam
const RETRY = MINUTE; // nach einer gescheiterten Abfrage; der Abstand verdoppelt sich bis `FRESH`
const AMOUNT_MAX = 1e9; // mehr Minuten oder Dollar hat kein Monat: hält Unsinn in der Antwort von der Summe fern
const PLAN_NAME = /^[a-z0-9 _-]{1,40}$/;

const amount = (value) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(number, AMOUNT_MAX) : 0; };
const monthOf = (now) => { const today = new Date(now); return { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 }; };

// Jahr und Monat (1 bis 12), die die Antwort nennt, oder null, wenn sie keinen brauchbaren nennt.
function periodOf(summary) {
  const year = Number(summary?.timePeriod?.year);
  const month = Number(summary?.timePeriod?.month);
  return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12 ? { year, month } : null;
}

// Wann der Monat der Abrechnung endet: am Ersten des Folgemonats (UTC). Nennt die Antwort keinen, gilt der laufende.
function monthEnd(summary, now) {
  const { year, month } = periodOf(summary) ?? monthOf(now);
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

// Geurteilt wird über die gerundeten Zahlen, die auch die Oberfläche zeigt.
// Wird schon etwas berechnet, gibt es ein Budget: Dann ist nichts knapp, und der Vorbehalt „ohne Budget“ gälte nicht.
function stateOf(used, included, paid) {
  if (!included) return STATE.UNKNOWN;
  if (paid > 0) return used >= included ? STATE.PAID : STATE.OK;
  if (used >= included) return STATE.OUT;
  return used >= included * TIGHT_AT ? STATE.TIGHT : STATE.OK;
}

// Rechnet aus der Zusammenfassung der Abrechnung und dem Tarifnamen den Stand. Ändert die Antwort nicht.
// { plan (oder null), used, included (oder null), paid (Minuten), cost (US-Dollar), systems: { linux, windows, macos,
//   other }, resetAt (ISO), state, tightAt, plans (die Tabelle der enthaltenen Minuten) }; Minuten sind auf ganze
// gerundet, `used` ist die Summe der gerundeten Teile.
function summarize(summary, plan, now = Date.now()) {
  const systems = { linux: 0, windows: 0, macos: 0, other: 0 };
  let paid = 0;
  let cost = 0;
  for (const item of Array.isArray(summary?.usageItems) ? summary.usageItems : []) {
    if (String(item?.product).toLowerCase() !== 'actions' || String(item?.unitType).toLowerCase() !== 'minutes') continue;
    const sku = String(item.sku ?? '').toLowerCase();
    systems[SYSTEMS.find((system) => sku.includes(system)) ?? 'other'] += amount(item.grossQuantity);
    paid += amount(item.netQuantity);
    cost += amount(item.netAmount);
  }
  for (const system of Object.keys(systems)) systems[system] = Math.round(systems[system]);
  const used = Object.values(systems).reduce((sum, value) => sum + value, 0);
  paid = Math.round(paid);
  const name = String(plan ?? '').toLowerCase();
  const included = Object.hasOwn(INCLUDED, name) ? INCLUDED[name] : null;
  return {
    plan: PLAN_NAME.test(name) ? name : null, used, included, paid, cost: Math.round(cost * 100) / 100, systems,
    resetAt: monthEnd(summary, now), state: stateOf(used, included, paid), tightAt: TIGHT_AT, plans: { ...INCLUDED },
  };
}

// `gh` wie `call` in github.js. `log(text)` schreibt einen Fehler ins Protokoll.
function createMinutes({ gh, log = () => {}, now = Date.now }) {
  let current = null; // { login, …Stand }
  let failures = 0; // gescheiterte Abfragen in Folge für das Konto in `asked`: Gemeldet wird nur die erste
  let asked = null; // { login, nextAt }: für wen zuletzt gefragt wurde und wann die nächste Abfrage fällig ist
  let reading = null; // { login, promise }: die laufende Abfrage; es läuft höchstens eine

  const valid = (login) => Boolean(current) && current.login === login && now() < new Date(current.resetAt).getTime();

  async function read(login) {
    if (asked?.login !== login) failures = 0; // ein anderes Konto beginnt von vorn: Sein erster Fehler steht im Protokoll
    try {
      const wanted = monthOf(now());
      const summary = await gh(['api', `users/${encodeURIComponent(login)}/settings/billing/usage/summary?year=${wanted.year}&month=${wanted.month}`]);
      const got = periodOf(summary);
      if (got && (got.year !== wanted.year || got.month !== wanted.month)) throw new Error(`GitHub lieferte die Abrechnung für ${got.month}/${got.year} statt für ${wanted.month}/${wanted.year}.`);
      const plan = (await gh(['api', 'user']))?.plan?.name;
      current = { login, ...summarize(summary, plan, now()) };
      failures = 0;
    } catch (error) {
      // Es bleibt der letzte Stand; der eines anderen Kontos gilt ohnehin nicht (siehe `view`).
      failures += 1;
      if (failures === 1) { try { log(`Das Minuten-Kontingent von GitHub ließ sich nicht lesen – ${error.message}`); } catch { /* das Protokoll ist Beiwerk */ } }
    }
    asked = { login, nextAt: now() + (failures ? Math.min(RETRY * 2 ** (failures - 1), FRESH) : FRESH) };
  }

  // Den Stand für das Konto holen. Wirft nie. Läuft gerade eine Abfrage für ein anderes Konto, folgt diese danach.
  function refresh(login) {
    if (reading && reading.login !== login) return reading.promise.then(() => refresh(login));
    reading ??= { login, promise: read(login).finally(() => { reading = null; }) };
    return reading.promise;
  }

  // Für den Takt im Betrieb: holt den Stand nur, wenn es für das Konto keinen gültigen gibt (anderes Konto, neuer
  // Monat) oder der letzte Versuch lange genug her ist. Nach einem Fehlschlag wird in wachsendem Abstand wieder gefragt.
  function poll(login) {
    const due = !asked || asked.login !== login || now() >= asked.nextAt || (!failures && !valid(login));
    return due ? refresh(login) : Promise.resolve();
  }

  // Der Stand des Kontos; ohne Konto null. Ein Stand aus einem vergangenen Monat gilt nicht mehr. Solange es keinen
  // gibt, nur `{ state }`: reading oder, nach einer gescheiterten Abfrage, failed.
  function view(login) {
    if (!login) return null;
    if (!valid(login)) return { state: failures && asked?.login === login ? STATE.FAILED : STATE.READING };
    const { login: _, ...rest } = current;
    return { ...rest, systems: { ...rest.systems }, plans: { ...rest.plans } };
  }

  return { refresh, poll, view };
}

module.exports = { createMinutes, summarize, STATE, SCOPE, TIGHT_AT, INCLUDED, FRESH, RETRY };
