// Regeln für die gelernten Abbilder eines Repos (siehe „Abbilder“ in backend.js).

// Sagt die Registry, dass es das Abbild für uns nicht gibt? Nur dann lohnt kein weiterer Versuch.
// Alles andere (Netz weg, Anfragelimit, Daemon nicht bereit) geht vorüber und ändert nichts am Gelernten.
const GONE = /not found|manifest unknown|does not exist|access denied|denied:|unauthorized|authentication required|invalid reference format/i;
const TRANSIENT = /toomanyrequests|rate limit|timeout|timed out|temporary failure|connection (refused|reset)|no such host|i\/o timeout|\bEOF\b|unexpected status.* 5\d\d/i;
const permanentPullError = (stderr) => { const text = String(stderr ?? ''); return GONE.test(text) && !TRANSIENT.test(text); };

// Entfernt Einträge `{ name: ISO-Zeitpunkt }`, die älter als `days` Tage sind. Liefert, ob etwas entfernt wurde.
function pruneOlder(entries, days, now = Date.now()) {
  let removed = false;
  for (const [name, at] of Object.entries(entries ?? {})) {
    if (!((now - new Date(at).getTime()) / 86400000 <= days)) { delete entries[name]; removed = true; }
  }
  return removed;
}

// Zwei Repos dürfen sich Volumes und Build-Dienst nicht teilen: Deren Namen entstehen nur aus dem Repo-Namen.
const slug = (repo) => String(repo).split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const clashes = (repo, others) => others.find((other) => !sameRepo(other, repo) && slug(other) === slug(repo)) ?? null;

module.exports = { permanentPullError, pruneOlder, slug, sameRepo, clashes };
