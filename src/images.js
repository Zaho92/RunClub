// Rules for a repo's learned images (see "Images" in backend.js); learning and loading happens in seed.js.

const { DAY } = require('./units');

// Does the registry say the image does not exist for us? Only then is another attempt not worth it.
// Everything else (network gone, rate limit, daemon not ready) passes and changes nothing about what was learned.
const GONE = /not found|manifest unknown|does not exist|access denied|denied:|unauthorized|authentication required|invalid reference format/i;
const TRANSIENT = /toomanyrequests|rate limit|timeout|timed out|temporary failure|connection (refused|reset)|no such host|i\/o timeout|\bEOF\b|unexpected status.* 5\d\d/i;
const permanentPullError = (stderr) => { const text = String(stderr ?? ''); return GONE.test(text) && !TRANSIENT.test(text); };

// How many days have passed since an ISO time (with fraction).
const daysSince = (iso, now = Date.now()) => (now - new Date(iso).getTime()) / DAY;

// Removes entries `{ name: ISO time }` older than `days` days. Returns whether something was removed.
function pruneOlder(entries, days, now = Date.now()) {
  let removed = false;
  for (const [name, at] of Object.entries(entries ?? {})) {
    if (!(daysSince(at, now) <= days)) { delete entries[name]; removed = true; }
  }
  return removed;
}

// Two repos must not share volumes and build service: their names are made from the repo name only.
const slug = (repo) => String(repo).split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const clashes = (repo, others) => others.find((other) => !sameRepo(other, repo) && slug(other) === slug(repo)) ?? null;

module.exports = { permanentPullError, daysSince, pruneOlder, slug, sameRepo, clashes };
