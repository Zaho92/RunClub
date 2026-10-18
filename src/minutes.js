// The minutes quota of GitHub Actions (in the interface “GitHub minutes”): how many minutes the account has used this
// month on GitHub's own runners. Once it is used up, runs no longer start there (see waiting.js); here one sees it
// coming.
//
// Source    `users/<account>/settings/billing/usage/summary` (needs the “Plan” permission of the GitHub app) for the current month (UTC),
//           asked for explicitly with year and month. Only entries of the product Actions with the unit minutes are
//           counted, per operating system and in total. `grossQuantity` is what was used, `netQuantity`/`netAmount`
//           what is paid beyond what is included.
// Weight    Every minute counts once, whatever the operating system: that is how GitHub gives the numbers and how it
//           describes the quota today. The billing no longer names the earlier factors (Windows 2, macOS 10).
// Included  How many minutes the plan includes, the API does not say. The number is an ASSUMPTION from the
//           plan name (`user` → `plan.name`; if it is missing, the plan is unknown); an unknown plan has none. It is not exact to the
//           minute: the one real answer (test/minutes.test.js) shows 2,097 used against an assumed 2,000.
// Budget    Whether a budget is set at GitHub and how high, the answer does not say. All one sees is whether anything
//           has been paid yet. The states follow from that; what they say about runs starting is a conclusion.
// State     ok | tight (from 85 % of what is included, as long as nothing is charged) | out (what is included is reached and nothing was paid: without
//           a budget GitHub starts no more jobs in private repos) | paid (what is included is reached and is being
//           paid for: there is a budget; whether it is already used up cannot be seen) | unknown (the plan is
//           unknown). As long as there is no figure for the account: reading (being read) | failed (the last
//           request failed).

const { MINUTE } = require('./units');
const { msg, Fault, reason } = require('./messages');

const STATE = { OK: 'ok', TIGHT: 'tight', OUT: 'out', PAID: 'paid', UNKNOWN: 'unknown', READING: 'reading', FAILED: 'failed' };
const TIGHT_AT = 0.85; // share used from which it is tight
// ASSUMPTION: included minutes per month and plan of a personal account, as GitHub states them publicly
// (as of October 2026). If GitHub changes its plans, adjust this table; the interface gets it with the figures.
const INCLUDED = { free: 2000, pro: 3000 };
const SYSTEMS = ['linux', 'windows', 'macos']; // part of the entry's code (`actions_linux`, `actions_macos`, …)
const FRESH = 15 * MINUTE; // how long a figure that was read stays valid; the number changes slowly
const RETRY = MINUTE; // after a failed request; the gap doubles up to `FRESH`
const AMOUNT_MAX = 1e9; // no month has more minutes or dollars: keeps nonsense in the answer out of the sum
const PLAN_NAME = /^[a-z0-9 _-]{1,40}$/;

const amount = (value) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(number, AMOUNT_MAX) : 0; };
const monthOf = (now) => { const today = new Date(now); return { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 }; };

// Year and month (1 to 12) that the answer names, or null if it names no usable one.
function periodOf(summary) {
  const year = Number(summary?.timePeriod?.year);
  const month = Number(summary?.timePeriod?.month);
  return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12 ? { year, month } : null;
}

// When the billing month ends: on the first of the following month (UTC). If the answer names none, the current one applies.
function monthEnd(summary, now) {
  const { year, month } = periodOf(summary) ?? monthOf(now);
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

// The judgement uses the rounded numbers that the interface shows as well.
// If something is already being charged, there is a budget: then nothing is tight, and the caveat “without a budget” would not apply.
function stateOf(used, included, paid) {
  if (!included) return STATE.UNKNOWN;
  if (paid > 0) return used >= included ? STATE.PAID : STATE.OK;
  if (used >= included) return STATE.OUT;
  return used >= included * TIGHT_AT ? STATE.TIGHT : STATE.OK;
}

// Works out the figures from the billing summary and the plan name. Does not change the answer.
// { plan (or null), used, included (or null), paid (minutes), cost (US dollars), systems: { linux, windows, macos,
//   other }, resetAt (ISO), state, tightAt, plans (the table of included minutes) }; minutes are rounded to whole
// ones, `used` is the sum of the rounded parts.
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

// `github` as in github.js. `log(message)` writes an error (see messages.js) to the log.
function createMinutes({ github, log = () => {}, now = Date.now }) {
  let current = null; // { login, …figures }
  let failures = 0; // failed requests in a row for the account in `asked`: only the first is reported
  let asked = null; // { login, nextAt }: whom we last asked for and when the next request is due
  let reading = null; // { login, promise }: the running request; at most one runs

  const valid = (login) => Boolean(current) && current.login === login && now() < new Date(current.resetAt).getTime();

  async function read(login) {
    if (asked?.login !== login) failures = 0; // another account starts over: its first error goes into the log
    try {
      const wanted = monthOf(now());
      const summary = await github.get(`users/${encodeURIComponent(login)}/settings/billing/usage/summary?year=${wanted.year}&month=${wanted.month}`);
      const got = periodOf(summary);
      if (got && (got.year !== wanted.year || got.month !== wanted.month)) throw new Fault('m_billingMonth', String(got.month), String(got.year), String(wanted.month), String(wanted.year));
      const plan = (await github.get('user'))?.plan?.name;
      current = { login, ...summarize(summary, plan, now()) };
      failures = 0;
    } catch (error) {
      // The last figures stay; those of another account do not apply anyway (see `view`).
      failures += 1;
      if (failures === 1) { try { log(msg('m_withReason', msg('m_minutesUnreadable'), reason(error))); } catch { /* the log is secondary */ } }
    }
    asked = { login, nextAt: now() + (failures ? Math.min(RETRY * 2 ** (failures - 1), FRESH) : FRESH) };
  }

  // Fetch the figures for the account. Never throws. If a request for another account is running, this one follows it.
  function refresh(login) {
    if (reading && reading.login !== login) return reading.promise.then(() => refresh(login));
    reading ??= { login, promise: read(login).finally(() => { reading = null; }) };
    return reading.promise;
  }

  // For the timer in operation: fetches the figures only if there are no valid ones for the account (another account, new
  // month) or the last attempt is long enough ago. After a failure it asks again at growing intervals.
  function poll(login) {
    const due = !asked || asked.login !== login || now() >= asked.nextAt || (!failures && !valid(login));
    return due ? refresh(login) : Promise.resolve();
  }

  // The account's figures; without an account null. Figures from a past month no longer apply. As long as there are
  // none, only `{ state }`: reading or, after a failed request, failed.
  function view(login) {
    if (!login) return null;
    if (!valid(login)) return { state: failures && asked?.login === login ? STATE.FAILED : STATE.READING };
    const { login: _, ...rest } = current;
    return { ...rest, systems: { ...rest.systems }, plans: { ...rest.plans } };
  }

  return { refresh, poll, view };
}

module.exports = { createMinutes, summarize, STATE, TIGHT_AT, INCLUDED, FRESH, RETRY };
