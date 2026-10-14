// Die Docker-Überwachung: Docker kann später starten als RunClub, zwischendurch ausfallen oder neu starten.
// `linuxLoop` bereitet Docker vor, sobald es antwortet (`prepareLinux`: Grenzen der VM lesen, Runner-Abbild bauen,
// Abbilder von Daemon und Build-Dienst laden, Reste abräumen), prüft es danach regelmäßig und gibt es erst nach
// mehreren ausbleibenden Antworten verloren. Dazu das tägliche Neubauen des Runner-Abbilds (`refreshImage`) und das
// Abräumen von Resten (`removeLeftovers` beim Start und Beenden, `removeOrphans` nach einer Unterbrechung,
// `removeRegistrations` bei GitHub).
//
// Wo Docker läuft, steht in engine.js; von dort kommen `docker`, `dockerList` und die Meldung `unreachableText`.

const { lastLine } = require('./run');
const { SECOND } = require('./units');
const { orphaned } = require('./pairs');

const MISSES = 3; // so oft hintereinander muss Docker schweigen, bevor es als weg gilt
const PROBE_TIMEOUT = 20 * SECOND;
const READY_PAUSE = 30 * SECOND; // Abstand der Prüfungen, solange Docker antwortet
const WAIT_PAUSE = 15 * SECOND; // … und solange es noch nicht vorbereitet ist
const MISS_PAUSE = 5 * SECOND; // nach einer ausbleibenden Antwort

//   docker(args, options), dockerList(args)   aus engine.js
//   gh(args)                Aufruf der GitHub-API, liefert die Antwort als Objekt oder wirft
//   log(text, repo, kind), sleep(ms)
//   host, mark              Name des Rechners (Anfang der Runner-Namen) und Kennzeichen der eigenen Container
//   image, imageDir         Name und Ordner (Dockerfile) des Runner-Abbilds
//   requiredImages          Abbilder, die geladen sein müssen (Docker-Daemon, Build-Dienst)
//   longTimeout             Zeitgrenze für Bauen und Laden
//   unreachableText         die Meldung, wenn Docker nicht antwortet (aus engine.js)
//   livePairs               Name des Paars -> Repo (aus slots.js)
//   repos(), pools()        die Repos mit Pool laut Einstellung, die stehenden Pools
//   preparePool(pool)       Caches und Vorlage eines Pools bereitstellen
//   stopping()
//   onReady()               Docker ist (wieder) vorbereitet: die Messungen starten
//   onAlive()               eine regelmäßige Prüfung hat Antwort bekommen, während Docker bereit ist
function createLinux({
  docker, dockerList, gh, log, sleep,
  host, mark, image, imageDir, requiredImages, longTimeout, unreachableText,
  livePairs, repos, pools, preparePool, stopping,
  onReady = () => {}, onAlive = () => {},
}) {
  let dockerCpus = 1;
  let dockerMemory = 0;
  let linuxReady = false;
  let linuxError = null;
  let leftoversRemoved = false;

  // Das Runner-Abbild bauen. Scheitert das (kein Netz) und liegt ein früheres vor, arbeiten die Runner damit weiter;
  // nur ganz ohne Abbild geht es nicht.
  async function buildImage() {
    const build = await docker(['build', '--pull', '-q', '-t', image, imageDir], { timeout: longTimeout });
    if (build.code === 0) return;
    const reason = lastLine(build.stderr);
    if ((await docker(['image', 'inspect', '--format', 'ok', image])).code !== 0) throw new Error(`Das Runner-Abbild ließ sich nicht bauen: ${reason}`);
    log(`Das Runner-Abbild ließ sich nicht neu bauen (${reason}); die Runner nutzen das vorhandene.`, null, 'error');
  }

  // Bei langer Laufzeit veraltet der Runner im Abbild, und GitHub weist zu alte Runner ab: täglich neu bauen. Neue
  // Paare starten von selbst mit dem neuen Abbild; laufende Jobs berührt das nicht.
  async function refreshImage() {
    if (stopping() || !linuxReady) return;
    log('Baue das Runner-Abbild neu (tägliche Auffrischung) …');
    await buildImage();
  }

  async function prepareLinux() {
    const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeout: PROBE_TIMEOUT });
    if (info.code !== 0) throw new Error(unreachableText);
    dockerCpus = Number(info.stdout.trim().split(' ')[0]) || 1;
    dockerMemory = Number(info.stdout.trim().split(' ')[1]) || 0;
    log('Baue das Runner-Abbild (mit dem neuesten Runner von GitHub) …');
    await buildImage();
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

  // Reste eines früheren Laufs: Paare, ihre Volumes und Netze, bei GitHub angemeldete Runner.
  async function removeLeftovers() {
    const containers = await dockerList(['ps', '-aq', '--filter', `label=${mark}`]);
    if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
    const volumes = await dockerList(['volume', 'ls', '-q', '--filter', `label=${mark}`]);
    if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
    for (const network of await dockerList(['network', 'ls', '-q', '--filter', `label=${mark}`])) await removeNetwork(network);
    for (const repo of repos()) await removeRegistrations(repo);
  }

  async function removeRegistrations(repo) {
    try {
      const runners = (await gh(['api', `repos/${repo}/actions/runners?per_page=100`])).runners;
      for (const runner of runners) {
        if (runner.name.startsWith(`${host}-linux-`) && !runner.busy) await gh(['api', '-X', 'DELETE', `repos/${repo}/actions/runners/${runner.id}`]);
      }
    } catch (error) { log(`Abmelden alter Runner – ${error.message}`, repo, 'error'); }
  }

  // Docker kann später starten als dieses Programm, oder zwischendurch neu starten.
  async function linuxLoop() {
    let misses = 0;
    while (!stopping()) {
      if (!linuxReady) {
        try {
          await prepareLinux();
          for (const pool of pools()) pool.prepared = false;
          linuxReady = true;
          linuxError = null;
          misses = 0;
          onReady();
          for (const pool of pools()) await preparePool(pool);
        } catch (error) {
          if (linuxError !== error.message) log(error.message, null, 'error');
          linuxError = error.message;
        }
      } else if ((await docker(['info', '--format', 'ok'], { timeout: PROBE_TIMEOUT })).code !== 0) {
        // Eine einzelne ausbleibende Antwort (volle VM, kurzer Hänger) heißt nicht, dass Docker weg ist:
        // Erst nach mehreren in Folge warten die Plätze und alles wird neu vorbereitet.
        misses += 1;
        if (misses >= MISSES) {
          linuxReady = false;
          log('Docker antwortet nicht mehr – die Linux-Runner warten.', null, 'error');
        }
        await sleep(MISS_PAUSE);
        continue;
      } else { misses = 0; onAlive(); }
      await sleep(linuxReady ? READY_PAUSE : WAIT_PAUSE);
    }
  }

  // `watch` ist die Schleife (`linuxLoop`); sie endet erst, wenn RunClub endet.
  return {
    watch: linuxLoop, prepareLinux, refreshImage, removeOrphans, removeLeftovers, removeRegistrations,
    ready: () => linuxReady, error: () => linuxError, cpus: () => dockerCpus, memory: () => dockerMemory,
  };
}

module.exports = { createLinux, MISSES, PROBE_TIMEOUT, READY_PAUSE, WAIT_PAUSE, MISS_PAUSE };
