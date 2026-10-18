// Version numbers of RunClub (“1.2.3”, “1.2.3-beta.4”, also with a leading “v”) and the channel they belong to.
// No side effects on load.

// Splits “1.2.3-beta.4” (also with a leading “v”); null if it isn't a version.
function parseVersion(text) {
  const match = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}

// Like semver: a pre-release comes before the version without suffix, numbers are compared as numbers.
// Returns < 0, 0 or > 0; a value that isn't a version comes before any other.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/;
    if (numeric.test(p) && numeric.test(q)) { if (Number(p) !== Number(q)) return Number(p) - Number(q); continue; }
    if (numeric.test(p) !== numeric.test(q)) return numeric.test(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isPrerelease = (version) => Boolean(parseVersion(version)?.pre.length);
const channelOf = (version) => (isPrerelease(version) ? 'beta' : 'stable');

module.exports = { parseVersion, compareVersions, isPrerelease, channelOf };
