// Die Vorlage eines Repos und das Gelernte dahinter (siehe „Abbilder“ im Kopf von backend.js): Nach jedem Job hält
// `learnImages` die Namen der Abbilder fest, die er selbst geladen hat. `refreshSeed` holt sie von der Registry in ein
// Volume, die Vorlage; jedes neue Paar bekommt eine Kopie davon (`provision` in slots.js) und muss sie nicht mehr laden.
// Kein Job schreibt in die Vorlage: Gemerkt werden nur Namen, geladen wird von hier aus.
//
//   Gelernt   `state.learned[repo]`  { Abbild: ISO-Zeitpunkt des letzten Gebrauchs }; fällt nach `LEARNED_DAYS` heraus
//   Abgelehnt `state.rejected[repo]` { Abbild: ISO-Zeitpunkt }; was es bei der Registry nicht gibt, wird so lange
//             nicht wieder gelernt
//   Vorlage   `pool.seeded`: die Abbilder, die gerade im Volume liegen
//
// Die Regeln für einzelne Abbilder liegen in images.js.

const { lastLine } = require('./run');
const { SECOND, DAY } = require('./units');
const { permanentPullError, pruneOlder } = require('./images');

const LEARNED_DAYS = 14;
const LEARNED_MAX = 25;
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:-]*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

//   docker(args, options)   wie `run('docker', …)`: liefert `{ code, stdout, stderr }` und wirft nie
//   dockerList(args)        dasselbe, liefert die Zeilen der Ausgabe
//   log(text, repo, kind), sleep(ms)
//   mark, dind              Kennzeichen der eigenen Container und Abbild des Docker-Daemons
//   longTimeout             Zeitgrenze für das Laden eines Abbilds
//   settingsOf(repo), seedVolume(repo), poolOf(repo) (der Pool oder undefined)
//   state, saveState()      das Gelernte (`learned`, `rejected`) und sein Speichern
function createSeed({
  docker, dockerList, log, sleep,
  mark, dind, longTimeout,
  settingsOf, seedVolume, poolOf,
  state, saveState,
}) {
  // Für `.catch(…)`: schreibt den Fehler zum Projekt ins Protokoll, mit dem, was gerade versucht wurde.
  const logError = (repo, what) => (error) => log(`${what} – ${error.message}`, repo, 'error');
  const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / DAY;

  function wantedImages(repo) {
    const fixed = settingsOf(repo)?.preload ?? [];
    const learned = Object.entries(state.learned[repo] ?? {})
      .filter(([, usedAt]) => daysSince(usedAt) <= LEARNED_DAYS)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([image]) => image);
    return [...new Set([...fixed, ...learned])].slice(0, LEARNED_MAX);
  }

  // Kopieren darf gleichzeitig laufen, auffrischen nur allein.
  const seedLocks = new Map();
  async function withSeed(repo, exclusive, work) {
    if (!seedLocks.has(repo)) seedLocks.set(repo, { readers: 0, writing: false });
    const lock = seedLocks.get(repo);
    while (lock.writing || (exclusive && lock.readers > 0)) await sleep(500);
    if (exclusive) lock.writing = true; else lock.readers += 1;
    try { return await work(); } finally { if (exclusive) lock.writing = false; else lock.readers -= 1; }
  }

  function refreshSeed(repo) {
    return withSeed(repo, true, async () => {
      const pool = poolOf(repo);
      if (pool?.removed) return; // der Lade-Container hielte das Volume fest, das gerade gelöscht werden soll
      const seed = seedVolume(repo);
      const loader = `${seed}-loader`;
      const wanted = wantedImages(repo);
      await docker(['rm', '-f', loader]);
      if (!wanted.length) { await docker(['volume', 'rm', '-f', seed]); if (pool) pool.seeded = new Set(); return; }
      log(`Frische die Vorlage auf (${wanted.length} Abbilder) …`, repo);
      await docker(['volume', 'create', seed]);
      await docker(['run', '-d', '--label', mark, '--name', loader, '--privileged', '-v', `${seed}:/var/lib/docker`, dind]);
      let ready = false;
      for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
        ready = (await docker(['exec', loader, 'docker', 'info', '--format', 'ok'], { timeout: 20 * SECOND })).code === 0;
        if (!ready) await sleep(1000);
      }
      // Ohne laufenden Lade-Daemon ließe sich nichts laden; das Gelernte bleibt, wie es ist.
      if (!ready) { await docker(['rm', '-f', loader]); throw new Error('Der Lade-Daemon wurde nicht bereit; die Vorlage bleibt unverändert.'); }
      const present = new Set();
      const retry = new Set();
      for (const image of wanted) {
        const pull = await docker(['exec', loader, 'docker', 'pull', '-q', image], { timeout: longTimeout });
        if (pull.code === 0) { present.add(image); continue; }
        log(`${image} kommt nicht in die Vorlage – ${lastLine(pull.stderr)}`, repo, 'error');
        // Eine Störung (Netz, Anfragelimit) geht vorüber: Was schon in der Vorlage liegt, bleibt dort.
        if (!permanentPullError(pull.stderr)) { retry.add(image); continue; }
        // Was es bei der Registry nicht gibt, hat der Job selbst gebaut oder es ist nicht öffentlich: nicht wieder versuchen.
        (state.rejected[repo] ??= {})[image] = new Date().toISOString();
        delete state.learned[repo]?.[image];
      }
      const existing = await dockerList(['exec', loader, 'docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
      for (const image of existing) if (retry.has(image)) present.add(image);
      const obsolete = existing.filter((image) => !present.has(image) && IMAGE_NAME.test(image));
      if (obsolete.length) await docker(['exec', loader, 'docker', 'rmi', '-f', ...obsolete]);
      await docker(['exec', loader, 'docker', 'image', 'prune', '-f']);
      await docker(['stop', loader]);
      await docker(['rm', loader]);
      if (pool) pool.seeded = present;
      pruneOlder(state.rejected[repo], LEARNED_DAYS);
      pruneOlder(state.learned[repo], LEARNED_DAYS);
      saveState();
    });
  }

  // Nach einem Job: die Namen der Abbilder festhalten, die er selbst geladen hat.
  const refreshQueued = new Set();
  async function learnImages(pool, slot) {
    const listing = await docker(['exec', `${slot.base}-dind`, 'docker', '-H', 'unix:///sock/docker.sock', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
    if (listing.code !== 0) return;
    const now = new Date().toISOString();
    const rejected = state.rejected[pool.repo] ?? {};
    let unknown = false;
    for (const image of new Set(listing.stdout.split('\n').map((s) => s.trim()))) {
      if (!IMAGE_NAME.test(image)) continue;
      if (rejected[image] && daysSince(rejected[image]) <= LEARNED_DAYS) continue;
      // Was schon aus der Vorlage kam, kann unbenutzt sein: Sein Datum bleibt, damit es nach einer Frist herausfällt
      // und nur zurückkommt, wenn ein Job es wieder selbst lädt.
      if (slot.copied?.has(image)) continue;
      (state.learned[pool.repo] ??= {})[image] = now;
      if (!pool.seeded.has(image)) unknown = true;
    }
    saveState();
    if (unknown && !refreshQueued.has(pool.repo)) {
      refreshQueued.add(pool.repo);
      refreshSeed(pool.repo).catch(logError(pool.repo, 'Vorlage')).finally(() => refreshQueued.delete(pool.repo));
    }
  }

  // Vorlage und Gelerntes eines Repos verwerfen, sobald keine Kopie und kein Auffrischen mehr läuft. Wirft, wenn
  // sich das Volume nicht löschen lässt.
  function forget(repo) {
    return withSeed(repo, true, async () => {
      delete state.learned[repo];
      delete state.rejected[repo];
      saveState();
      const pool = poolOf(repo);
      if (pool) pool.seeded = new Set();
      const removed = await docker(['volume', 'rm', '-f', seedVolume(repo)]);
      if (removed.code !== 0) throw new Error(`Die Vorlage ließ sich nicht löschen – ${lastLine(removed.stderr)}`);
    });
  }

  return { wantedImages, withSeed, refreshSeed, learnImages, forget };
}

module.exports = { createSeed, LEARNED_DAYS, LEARNED_MAX };
