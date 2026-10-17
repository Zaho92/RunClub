// GitHub through its REST API (https://api.github.com), with the sign-in's token (see auth.js) and
// sparing with the account's rate limit (5,000 per hour).
//
// Reading   Every query (`get`) remembers answer and tag (ETag) and asks conditionally next time. If nothing
//           changed, GitHub answers 304; that doesn't count against the limit.
// Limit     The state comes from the headers of every answer and from `rate_limit` (doesn't count either). The limit
//           applies to the whole account: other tools with the same sign-in (such as `gh` in the terminal) use it up too.
// Pause     If GitHub asks for quiet (403/429 with `retry-after`, the secondary limit), nothing is read until then.
// State     ok | tight (less than 15 % left: poll less often) | out (only the reserve left: stop reading,
//           the rest is kept for registering new runners) | unknown (no state, or the window has expired
//           and the new state isn't there yet).
// Token     Comes fresh from the sign-in on every request (`token()`). If GitHub rejects it (401), the request has
//           it renewed once (`renew`) and tries again.
// Errors    An answer with an error throws a GitHubError with `status`; callers tell them apart by it, not by
//           the text. The text is GitHub's, with the status after it.

const { SECOND, MINUTE, DAY } = require('./units');
const { Fault } = require('./messages');

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const STATE = { OK: 'ok', TIGHT: 'tight', OUT: 'out', UNKNOWN: 'unknown' };
const TIGHT = 0.15; // share that is still left
const RESERVE = 0.02;
const TIGHT_GAP = MINUTE; // with a tight limit, this long lies between two queries of the same thing
const PAUSE_MAX_S = 3600; // seconds; RunClub doesn't let one answer stop it for longer
const WINDOW_MAX = DAY; // a window end further in the future is not a state but nonsense
const PAGE_MAX = 100; // GitHub hands out at most this many entries per page (`per_page`)
const CACHE_MAX = 500; // remembered answers; each query of a run's jobs is one of its own
const PATH = /^[A-Za-z0-9]/; // a path under API, not an absolute one

// An answer from GitHub with an error. `message` is GitHub's text (a text from outside) with the status after it.
class GitHubError extends Error {
  constructor(status, text) {
    super(text ? `${text} (HTTP ${status})` : `HTTP ${status}`);
    this.status = status;
  }
}

// The headers of every request to API.
const apiHeaders = (token, version) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION, 'user-agent': `RunClub/${version}` });

// Freezes an answer with everything in it.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// The body of an answer as an object; empty means null. What isn't JSON is an error.
function parseBody(text) {
  return String(text ?? '').trim() ? JSON.parse(text) : null;
}

//   token()                 the sign-in's token, or null if nobody is signed in
//   renew(rejected)         GitHub rejected `rejected`: a new token, or null if there is none
//   fetch                   like Node's; controllable in tests
//   version                 goes into the identification (User-Agent) GitHub requires
function createGitHub({ token, renew = async () => null, fetch = globalThis.fetch, timeout = MINUTE, now = Date.now, version = '0' }) {
  const cache = new Map(); // path -> { etag, data }, the most recently used at the end
  const polled = new Map(); // key -> when last polled (only matters with a tight limit)
  let quota = null; // { limit, remaining, resetAt (ms) }
  let pausedUntil = 0; // GitHub asked for quiet until then (`retry-after`)
  let reported = STATE.UNKNOWN; // the state refreshQuota reported last

  function note(limit, remaining, reset) {
    const values = [limit, remaining, reset].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[0] <= 0) return;
    const resetAt = values[2] * SECOND;
    if (resetAt > now() + WINDOW_MAX) return;
    quota = { limit: values[0], remaining: Math.max(0, values[1]), resetAt };
  }

  const paused = () => now() < pausedUntil;
  const windowOpen = () => Boolean(quota) && now() < quota.resetAt; // there is a state, and it still holds
  const spent = () => windowOpen() && quota.remaining <= quota.limit * RESERVE;

  // A requested pause holds even beyond the end of the window.
  function state() {
    if (paused() || spent()) return STATE.OUT;
    if (!windowOpen()) return STATE.UNKNOWN;
    return quota.remaining < quota.limit * TIGHT ? STATE.TIGHT : STATE.OK;
  }

  // When it continues: at the end of the window; if only a pause was requested, at its end. If both apply,
  // the later one counts.
  const endsAt = () => Math.max(paused() ? pausedUntil : 0, spent() ? quota.resetAt : 0) || quota.resetAt;

  // May what `key` names (a repo) be polled routinely now? With a tight limit only at intervals of `gap`,
  // when used up not at all.
  function mayPoll(key, gap = TIGHT_GAP) {
    const current = state();
    if (current === STATE.OUT) return false;
    if (current === STATE.TIGHT) {
      if (now() - (polled.get(key) ?? -Infinity) < gap) return false;
      polled.set(key, now());
    }
    return true;
  }

  // One request, once. Returns fetch's answer; throws only if GitHub doesn't answer.
  async function once(secret, method, path, { body, etag }) {
    const headers = apiHeaders(secret, version);
    if (etag) headers['if-none-match'] = etag;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(`${API}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Fault('m_githubSilent');
      throw new Fault('m_githubUnreachable', String(error?.cause?.code ?? error?.message ?? error));
    }
  }

  // A request with the sign-in's token; if GitHub rejects it, once more with a renewed one. Remembers limit and
  // pause from the answer. Returns `{ status, headers, text }`.
  async function request(method, path, options = {}) {
    // The token goes only to GitHub: an address of its own in the path would be the caller's mistake.
    if (!PATH.test(String(path)) || new URL(path, `${API}/`).origin !== API) throw new TypeError(`Not a path under ${API}: ${path}`);
    let secret = await token();
    if (!secret) throw new Fault('m_loginFirst');
    let response = await once(secret, method, path, options);
    if (response.status === 401) {
      const next = await renew(secret).catch(() => null);
      if (next && next !== secret) {
        await response.text().catch(() => {}); // read the rejected answer so its connection is freed
        secret = next;
        response = await once(secret, method, path, options);
      }
    }
    const headers = response.headers;
    if ((headers.get('x-ratelimit-resource') ?? 'core') === 'core') note(headers.get('x-ratelimit-limit'), headers.get('x-ratelimit-remaining'), headers.get('x-ratelimit-reset'));
    // GitHub's secondary limit (too much in a short time): the answer says how long to wait.
    const retry = Number(headers.get('retry-after'));
    if ((response.status === 403 || response.status === 429) && retry > 0) pausedUntil = now() + Math.min(retry, PAUSE_MAX_S) * SECOND;
    return { status: response.status, headers, text: await response.text() };
  }

  // Throws for an answer with an error; GitHub names the reason in `message`.
  function check({ status, text }) {
    if (status >= 200 && status < 300) return;
    let said = '';
    try { said = String(JSON.parse(text)?.message ?? ''); } catch { /* not JSON: then only the status */ }
    throw new GitHubError(status, said.slice(0, 300));
  }

  // Reading. The answer is frozen because the same one goes to the next caller on 304. With a used-up limit or
  // a requested pause it doesn't ask.
  async function get(path) {
    if (state() === STATE.OUT) throw new Fault(paused() ? 'm_githubPause' : 'm_quotaSpent', { time: new Date(endsAt()).toISOString() });
    const known = cache.get(path);
    const response = await request('GET', path, { etag: known?.etag });
    if (response.status === 304 && known) {
      cache.delete(path);
      cache.set(path, known);
      return known.data;
    }
    check(response);
    const data = deepFreeze(parseBody(response.text));
    cache.delete(path);
    const etag = response.headers.get('etag');
    if (etag) {
      cache.set(path, { etag, data });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return data;
  }

  // Writing (POST, PATCH, PUT, DELETE), optionally with an object as body. Always goes through, even with a
  // used-up limit: the reserve is there for registering new runners.
  async function send(method, path, body) {
    const response = await request(method, path, { body });
    check(response);
    return parseBody(response.text);
  }

  // `tightAt`: the used share from which it is tight; the interface puts its mark there.
  const view = () => (!windowOpen() ? null : { limit: quota.limit, remaining: quota.remaining, resetAt: new Date(endsAt()).toISOString(), state: state(), tightAt: 1 - TIGHT });

  // Fetch the state explicitly; needed as long as nothing else is polled. Returns the state if it has
  // flipped since the last call (with the previous one as `before`; `resetAt` is then the end of the pause if it lasts longer),
  // otherwise null.
  async function refreshQuota() {
    try {
      const response = await request('GET', 'rate_limit');
      if (response.status === 200) { const core = JSON.parse(response.text).resources.core; note(core.limit, core.remaining, core.reset); }
    } catch { /* not signed in or unreachable: then the last state stays */ }
    const current = state();
    if (!windowOpen() || current === reported) return null;
    const before = reported;
    reported = current;
    return { ...view(), before, paused: paused() };
  }

  return { get, send, refreshQuota, mayPoll, quota: view };
}

// Remove a runner from GitHub. 404 means: already gone (e.g. by itself after its job) and is not an error.
// `github` as from createGitHub.
async function unregisterRunner(github, repo, runnerId) {
  try { await github.send('DELETE', `repos/${repo}/actions/runners/${runnerId}`); } catch (error) {
    if (error.status !== 404) throw error;
  }
}

module.exports = { createGitHub, GitHubError, deepFreeze, unregisterRunner, apiHeaders, STATE, PAGE_MAX, API };
