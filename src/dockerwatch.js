// Die Docker-Überwachung: Docker kann später starten als RunClub, zwischendurch ausfallen oder neu starten.
// `watchLoop` bereitet Docker vor, sobald es antwortet (`prepareDocker`: Grenzen der VM lesen, die eigenen Abbilder
// von Runner und Docker-Daemon bauen, das Abbild des Build-Dienstes laden, Reste abräumen), prüft es danach regelmäßig
// und gibt es erst nach mehreren ausbleibenden Antworten verloren. Dazu das tägliche Neubauen der eigenen Abbilder
// (`refreshImage`, wegen des Runners) und das
// Abräumen von Resten (`removeLeftovers` beim Start und Beenden, `removeOrphans` nach einer Unterbrechung,
// `removeRegistrations` bei GitHub).
//
// Wo Docker läuft, steht in engine.js; von dort kommen `docker`, `dockerList` und die Meldung `unreachableText`.

const { lastLine } = require('./run');
const { SECOND } = require('./units');
const { orphaned } = require('./pairs');
const { unregisterRunner, PAGE_MAX } = require('./github');
const { PROBE_TIMEOUT } = require('./dind');
const { runnerPrefix } = require('./names');

const MISSES = 3; // so oft hintereinander muss Docker schweigen, bevor es als weg gilt
const READY_PAUSE = 30 * SECOND; // Abstand der Prüfungen, solange Docker antwortet
const WAIT_PAUSE = 15 * SECOND; // … und solange es noch nicht vorbereitet ist
const MISS_PAUSE = 5 * SECOND; // nach einer ausbleibenden Antwort

//   docker(args, options), dockerList(args)   aus engine.js
//   gh(args)                Aufruf der GitHub-API, liefert die Antwort als Objekt oder wirft
//   log(text, repo, kind), sleep(ms)
//   host, mark              Name des Rechners (Anfang der Runner-Namen) und Kennzeichen der eigenen Container
//   serviceMark             Kennzeichen der Build-Dienste und ihrer Netze (siehe caches.js)
//   builds                  die selbst gebauten Abbilder: [{ image, dir, args, what }] (Name, Ordner mit Dockerfile,
//                           weitere Argumente für `docker build`, Bezeichnung für Meldungen); das erste ist das Runner-Abbild
//   requiredImages          Abbilder, die geladen sein müssen (heute nur der Build-Dienst)
//   longTimeout             Zeitgrenze für Bauen und Laden
//   unreachableText         die Meldung, wenn Docker nicht antwortet (aus engine.js)
//   exposure()              Warnung, wenn der Daemon ohne Schutz erreichbar ist, sonst null (Promise, aus engine.js)
//   buildService(repo), buildNetwork(repo)   Namen des Build-Dienstes und seines Netzes (siehe names.js)
//   livePairs               Name des Paars -> Repo (aus slots.js)
//   repos(), pools()        die Repos mit Pool laut Einstellung, die stehenden Pools
//   preparePool(pool)       Caches und Vorlage eines Pools bereitstellen
//   stopping()
//   onReady()               Docker ist (wieder) vorbereitet: die Messungen starten
//   onAlive()               eine regelmäßige Prüfung hat Antwort bekommen, während Docker bereit ist
function createDockerWatch({
  docker, dockerList, gh, log, sleep,
  host, mark, serviceMark, builds, requiredImages, longTimeout, unreachableText, exposure = async () => null,
  buildService, buildNetwork,
  livePairs, repos, pools, preparePool, stopping,
  onReady = () => {}, onAlive = () => {},
}) {
  let dockerCpus = 1;
  let dockerMemory = 0;
  let dockerReady = false;
  let dockerError = null;
  let leftoversRemoved = false;

  // Die eigenen Abbilder bauen. Scheitert das (kein Netz) und liegt ein früheres vor, arbeiten die Runner damit weiter;
  // nur ganz ohne Abbild geht es nicht.
  async function buildImages() {
    for (const { image, dir, args = [], what } of builds) {
      const build = await docker(['build', '--pull', '-q', ...args, '-t', image, dir], { timeout: longTimeout });
      if (build.code === 0) continue;
      const reason = lastLine(build.stderr);
      if ((await docker(['image', 'inspect', '--format', 'ok', image])).code !== 0) throw new Error(`${what} ließ sich nicht bauen: ${reason}`);
      log(`${what} ließ sich nicht neu bauen (${reason}); die Runner nutzen das vorhandene.`, null, 'error');
    }
  }

  // Bei langer Laufzeit veraltet der Runner im Abbild, und GitHub weist zu alte Runner ab: täglich neu bauen. Neue
  // Paare starten von selbst mit dem neuen Abbild; laufende Jobs berührt das nicht.
  async function refreshImage() {
    if (stopping() || !dockerReady) return;
    log('Baue die Abbilder von Runner und Docker-Daemon neu (tägliche Auffrischung) …');
    await buildImages();
  }

  async function prepareDocker() {
    const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeout: PROBE_TIMEOUT });
    if (info.code !== 0) throw new Error(unreachableText);
    dockerCpus = Number(info.stdout.trim().split(' ')[0]) || 1;
    dockerMemory = Number(info.stdout.trim().split(' ')[1]) || 0;
    log('Baue die Abbilder von Runner (mit dem neuesten Runner von GitHub) und Docker-Daemon …');
    await buildImages();
    for (const name of requiredImages) await docker(['pull', '-q', name], { timeout: longTimeout });
    // Reste gibt es nur vom vorigen Programmlauf. Meldet sich Docker später zurück, räumen die Plätze ihre Paare
    // selbst ab; alles Gekennzeichnete zu entfernen, träfe dann auch Paare, auf denen gerade ein Job läuft.
    if (!leftoversRemoved) { await removeLeftovers(); leftoversRemoved = true; } else await removeOrphans();
  }

  // Ein Netz samt allem, was noch darin hängt (etwa der Build-Dienst).
  async function removeNetwork(network) {
    for (const member of await dockerList(['network', 'inspect', network, '--format', '{{range .Containers}}{{println .Name}}{{end}}'])) await docker(['network', 'disconnect', '-f', network, member]);
    await docker(['network', 'rm', network]);
  }

  // Nach einer Unterbrechung von Docker: War Docker beim Abräumen eines Paars nicht erreichbar, sind dessen Container,
  // Volumes und Netz liegen geblieben. Entfernt wird nur, was zu keinem stehenden Paar mehr gehört.
  async function removeOrphans() {
    const live = new Set(livePairs.keys());
    const containers = orphaned(await dockerList(['ps', '-a', '--filter', `label=${mark}`, '--format', '{{.Names}}']), live);
    if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
    const volumes = orphaned(await dockerList(['volume', 'ls', '-q', '--filter', `label=${mark}`]), live);
    if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
    for (const network of orphaned(await dockerList(['network', 'ls', '--filter', `label=${mark}`, '--format', '{{.Name}}']), live)) await removeNetwork(network);
    if (containers.length || volumes.length) log(`Reste nach der Unterbrechung entfernt: ${containers.length} Container, ${volumes.length} Volumes`);
  }

  // Reste eines früheren Laufs: Paare, ihre Volumes und Netze, Build-Dienste (sie enden mit dem Programm; was noch
  // steht, gehört zu einem Absturz oder einem Pool, den es nicht mehr gibt), bei GitHub angemeldete Runner. Build-Dienst
  // und Netz eines Repos werden dazu beim Namen entfernt: Ältere Versionen haben sie ohne Kennzeichen angelegt.
  async function removeLeftovers() {
    for (const repo of repos()) {
      await docker(['rm', '-f', buildService(repo)]);
      await removeNetwork(buildNetwork(repo));
    }
    const containers = [
      ...await dockerList(['ps', '-aq', '--filter', `label=${mark}`]),
      ...await dockerList(['ps', '-aq', '--filter', `label=${serviceMark}`]),
    ];
    if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
    const volumes = await dockerList(['volume', 'ls', '-q', '--filter', `label=${mark}`]);
    if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
    for (const label of [mark, serviceMark]) for (const network of await dockerList(['network', 'ls', '-q', '--filter', `label=${label}`])) await removeNetwork(network);
    for (const repo of repos()) await removeRegistrations(repo);
  }

  // Runner dieses Rechners bei GitHub abmelden, die keinen Job mehr haben. `keep()`: Namen, die zu stehenden Paaren
  // gehören und bleiben; erst nach der Antwort von GitHub gefragt, damit ein Platz, der sich währenddessen anmeldet,
  // dazugehört. Mit `offline` nur solche, die keine Verbindung mehr haben: Im Betrieb trifft das die Runner, deren
  // Paar mitten im Job endete (beim Beenden, nach einem Absturz) und die GitHub erst später freigibt.
  async function removeRegistrations(repo, { keep = () => new Set(), offline = false } = {}) {
    try {
      const runners = (await gh(['api', `repos/${repo}/actions/runners?per_page=${PAGE_MAX}`])).runners; // mehr hat ein Repo mit Pool nicht
      const kept = keep();
      const stale = runners.filter((runner) => runner.name.startsWith(runnerPrefix(host)) && !runner.busy && !kept.has(runner.name) && (!offline || runner.status === 'offline'));
      for (const runner of stale) await unregisterRunner(gh, repo, runner.id);
      if (offline && stale.length) log(`${stale.length} verwaiste Runner bei GitHub abgemeldet`, repo);
    } catch (error) { log(`Abmelden alter Runner – ${error.message}`, repo, 'error'); }
  }

  // Geprüft wird, sobald Docker (wieder) vorbereitet ist: Der Schalter in Docker Desktop kann inzwischen umgelegt sein.
  async function warnIfExposed() {
    const warning = await exposure();
    if (warning) log(warning, null, 'error');
  }

  // Docker kann später starten als dieses Programm, oder zwischendurch neu starten.
  async function watchLoop() {
    let misses = 0;
    while (!stopping()) {
      if (!dockerReady) {
        try {
          await prepareDocker();
          for (const pool of pools()) pool.prepared = false;
          dockerReady = true;
          dockerError = null;
          misses = 0;
          onReady();
          warnIfExposed();
          for (const pool of pools()) await preparePool(pool);
        } catch (error) {
          if (dockerError !== error.message) log(error.message, null, 'error');
          dockerError = error.message;
        }
      } else if ((await docker(['info', '--format', 'ok'], { timeout: PROBE_TIMEOUT })).code !== 0) {
        // Eine einzelne ausbleibende Antwort (volle VM, kurzer Hänger) heißt nicht, dass Docker weg ist:
        // Erst nach mehreren in Folge warten die Plätze und alles wird neu vorbereitet.
        misses += 1;
        if (misses >= MISSES) {
          dockerReady = false;
          log('Docker antwortet nicht mehr – die Linux-Runner warten.', null, 'error');
        }
        await sleep(MISS_PAUSE);
        continue;
      } else { misses = 0; onAlive(); }
      await sleep(dockerReady ? READY_PAUSE : WAIT_PAUSE);
    }
  }

  // `watch` ist die Schleife (`watchLoop`); sie endet erst, wenn RunClub endet.
  return {
    watch: watchLoop, prepareDocker, refreshImage, removeOrphans, removeLeftovers, removeRegistrations,
    ready: () => dockerReady, error: () => dockerError, cpus: () => dockerCpus, memory: () => dockerMemory,
  };
}

module.exports = { createDockerWatch, MISSES, READY_PAUSE, WAIT_PAUSE, MISS_PAUSE };
