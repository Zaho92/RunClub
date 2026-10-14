// Was zwischen den Jobs eines Repos bleibt und nicht Vorlage ist (siehe Kopf von backend.js): der Paket-Cache als
// Volume und der Build-Dienst mit seinem Volume, seinem Socket und seinem Netz. `prepareCaches` stellt beides bereit
// oder baut es ab, wenn das Repo keinen Cache will; `renewService` legt den Build-Dienst neu an, wenn er alte Limits
// trägt oder nicht zustande kam. `removeCaches` leert, `removeService` beendet den Build-Dienst. `measureSizes` misst,
// wie groß Paket-Cache, Vorlage und Build-Layer sind.
//
// Der Build-Dienst läuft ohne Rechte (`moby/buildkit:…-rootless`) und ist nur über einen Unix-Socket in einem
// eigenen Volume zu erreichen, das die Paare nur lesend einhängen (siehe `provision` in slots.js). Er hängt in keinem
// Netz der Paare: Über ihn erreicht kein Paar ein anderes. Sein eigenes Netz braucht er nur für den Weg ins Internet.
//
// Der Build-Dienst trägt die Limits des Docker-Daemons, als Etikett am Container und am Pool:
//   pool.serviceBuilt     Kennung der Limits (`limits.dockerKey`), mit denen er läuft
//   pool.serviceFailed    er kam zuletzt nicht zustande
//   pool.serviceFailures  Fehlschläge in Folge; pool.serviceRetryAt  frühester Zeitpunkt des nächsten Versuchs
//   pool.renewingService  er wird gerade erneuert;  pool.measuring  die Volumes werden gerade gemessen

const { lastLine } = require('./run');
const { MINUTE, MB } = require('./units');
const { createNetwork, alreadyExists } = require('./subnets');
const limitRules = require('./limits');
const { busy } = require('./states');

const VOLUME_PREFIX = 'rc-';
const SOCKET_DIR = '/run/rc-buildkit'; // Ordner des Sockets, im Build-Dienst wie in den Paaren (siehe linux/docker-shim.sh)
const SERVICE_USER = 1000; // unter diesem Benutzer läuft der Build-Dienst; die Paare kommen über seine Gruppe an den Socket
const LIMITS_LABEL = 'runclub.limits';
const PIDS_MAX = 8192; // Grenze für Prozesse je Container: Eine Fork-Bomb legte sonst die ganze Docker-VM lahm

//   docker(args, options)   wie `run('docker', …)`: liefert `{ code, stdout, stderr }` und wirft nie
//   dockerList(args)        dasselbe, liefert die Zeilen der Ausgabe
//   log(text, repo, kind)
//   dind, buildkit          Abbild des Docker-Daemons (hier nur als Werkzeug für die Volumes) und des Build-Diensts
//   serviceMark             Kennzeichen der Build-Dienste und ihrer Netze; was es trägt, räumt der nächste Start ab
//   settingsOf(repo), limitsOf(repo), poolOf(repo) (der Pool oder undefined)
//   cacheVolume(repo), seedVolume(repo), buildVolume(repo), buildSocket(repo), buildService(repo), buildNetwork(repo)
//                           die Namen je Repo
//   stopping(), dockerReady()
function createCaches({
  docker, dockerList, log,
  dind, buildkit, serviceMark,
  settingsOf, limitsOf, poolOf,
  cacheVolume, seedVolume, buildVolume, buildSocket, buildService, buildNetwork,
  stopping, dockerReady,
}) {
  const serviceKey = (repo) => limitRules.dockerKey(limitsOf(repo));

  // Legt den Build-Dienst mit den geltenden Limits neu an, sobald im Pool nichts gebaut wird. Die Paare erreichen den
  // neuen Dienst über denselben Socket und bleiben, wie sie sind.
  async function renewService(pool) {
    const retry = Boolean(pool.serviceFailed);
    if (!settingsOf(pool.repo)?.cache || (!retry && (!pool.serviceBuilt || pool.serviceBuilt === serviceKey(pool.repo)))) return;
    if (retry && Date.now() < pool.serviceRetryAt) return;
    if (stopping() || pool.removed || pool.hold || pool.renewingService || pool.preparing || !pool.prepared || !dockerReady()) return;
    if (pool.slots.some(busy)) return;
    pool.renewingService = true;
    try {
      log(retry ? 'Versuche erneut, den Build-Dienst anzulegen' : 'Lege den Build-Dienst mit den neuen Limits an', pool.repo);
      await prepareCaches(pool.repo);
    } finally { pool.renewingService = false; }
  }

  // Läuft der Build-Dienst schon, mit den geltenden Limits? Dann bleibt er: Ein laufender Build bräche sonst ab.
  async function serviceCurrent(repo) {
    const found = await docker(['inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${LIMITS_LABEL}"}}`, buildService(repo)]);
    return found.code === 0 && found.stdout.trim() === `true ${serviceKey(repo)}`;
  }

  // Den Build-Dienst neu anlegen. Liefert, woran es scheiterte, sonst null.
  async function startService(repo) {
    await docker(['rm', '-f', buildService(repo)]);
    // Seine Volumes müssen dem Benutzer des Dienstes gehören. Build-Layer eines früheren Dienstes mit Rechten gehören
    // root und taugen ihm nicht: Sie werden einmal geleert.
    await docker(['run', '--rm', '-v', `${buildVolume(repo)}:/b`, '-v', `${buildSocket(repo)}:/s`, '--entrypoint', 'sh', dind, '-c',
      `[ "$(stat -c %u /b)" = ${SERVICE_USER} ] || find /b -mindepth 1 -delete; chown ${SERVICE_USER}:${SERVICE_USER} /b /s`]);
    const service = await docker(['run', '-d', '--name', buildService(repo), '--label', serviceMark, '--label', `${LIMITS_LABEL}=${serviceKey(repo)}`,
      '--restart', 'no', '--network', buildNetwork(repo),
      '--cpus', String(limitsOf(repo).dockerCpus), '--memory', limitsOf(repo).dockerMemory, '--pids-limit', String(PIDS_MAX),
      // Ohne Rechte braucht buildkit eigene Namensräume, die Dockers Vorgaben verbieten (siehe docs/rootless.md von buildkit).
      '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
      '-v', `${buildVolume(repo)}:/home/user/.local/share/buildkit`, '-v', `${buildSocket(repo)}:${SOCKET_DIR}`,
      buildkit, '--addr', `unix://${SOCKET_DIR}/buildkitd.sock`, '--oci-worker-no-process-sandbox']);
    return service.code === 0 ? null : `Build-Dienst startet nicht – ${lastLine(service.stderr)}`;
  }

  // Paket-Cache und Build-Dienst eines Repos bereitstellen.
  async function prepareCaches(repo) {
    if (!settingsOf(repo)?.cache) { await removeService(repo); return; }
    await docker(['volume', 'create', cacheVolume(repo)]);
    await docker(['run', '--rm', '-v', `${cacheVolume(repo)}:/c`, '--entrypoint', 'sh', dind, '-c',
      'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
    await docker(['volume', 'create', buildVolume(repo)]);
    await docker(['volume', 'create', buildSocket(repo)]);
    // Eigenes Netz je Repo: Im gemeinsamen Standard-Netz könnte ein Build den Dienst eines anderen Repos ansprechen.
    // Es bleibt stehen, solange das Repo einen Cache hat; dass es schon da ist, ist deshalb kein Fehler.
    const network = await createNetwork(docker, ['--label', serviceMark, buildNetwork(repo)]);
    let failure = network.code !== 0 && !alreadyExists(network.stderr) ? `Netz für den Build-Dienst lässt sich nicht anlegen – ${lastLine(network.stderr)}` : null;
    if (!failure && !(await serviceCurrent(repo))) failure = await startService(repo);
    const pool = poolOf(repo);
    if (failure) log(failure, repo, 'error');
    if (!pool) return;
    // Nach einem Fehlschlag versucht `renewService` es wieder, in wachsendem Abstand (höchstens eine halbe Stunde).
    pool.serviceFailures = failure ? (pool.serviceFailures ?? 0) + 1 : 0;
    pool.serviceRetryAt = Date.now() + Math.min(2 ** pool.serviceFailures, 30) * MINUTE;
    pool.serviceFailed = Boolean(failure);
    pool.serviceBuilt = failure ? null : serviceKey(repo);
  }

  // Den Build-Dienst samt Netz beenden; seine Build-Layer bleiben.
  async function removeService(repo) {
    await docker(['rm', '-f', buildService(repo)]);
    await docker(['network', 'rm', buildNetwork(repo)]);
  }

  // Paket-Cache und Build-Layer löschen, soweit verlangt. Der Pool muss dafür ruhen (`withPoolAtRest` in pools.js):
  // Ein Volume, das noch eingehängt ist, lässt sich nicht löschen, und das ist dann ein Fehler.
  async function removeCaches(repo, { packages = false, build = false }) {
    const volumes = [...(packages ? [cacheVolume(repo)] : []), ...(build ? [buildVolume(repo), buildSocket(repo)] : [])];
    if (build) await removeService(repo);
    if (!volumes.length) return;
    const removed = await docker(['volume', 'rm', '-f', ...volumes]);
    if (removed.code !== 0) throw new Error(`Caches ließen sich nicht löschen – ${lastLine(removed.stderr)}`);
  }

  // Die Größe der Volumes eines Pools in Bytes (`pool.sizes`: { packages, images, build }); was fehlt, zählt 0.
  // Ein Pool, der entfernt wird, wird nicht mehr gemessen: Der Messcontainer hielte seine Volumes fest.
  async function measureSizes(pool) {
    if (pool.removed || pool.measuring) return;
    pool.measuring = true;
    try { pool.sizes = await sizesOf(pool.repo); } finally { pool.measuring = false; }
  }

  // Alle Volumes von Caches und Vorlage beginnen mit `rc-` (siehe names.js).
  async function sizesOf(repo) {
    const existing = new Set(await dockerList(['volume', 'ls', '-q', '--filter', `name=${VOLUME_PREFIX}`]));
    const parts = [['packages', cacheVolume(repo)], ['images', seedVolume(repo)], ['build', buildVolume(repo)]].filter(([, volume]) => existing.has(volume));
    const sizes = { packages: 0, images: 0, build: 0 };
    if (!parts.length) return sizes;
    const mounts = parts.flatMap(([key, volume]) => ['-v', `${volume}:/m/${key}:ro`]);
    const result = await docker(['run', '--rm', ...mounts, '--entrypoint', 'sh', dind, '-c', 'du -sm /m/* 2>/dev/null']);
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\d+)\s+\/m\/(\w+)/);
      if (match) sizes[match[2]] = Number(match[1]) * MB;
    }
    return sizes;
  }

  return { prepareCaches, renewService, removeService, removeCaches, measureSizes };
}

module.exports = { createCaches, SOCKET_DIR, SERVICE_USER, PIDS_MAX };
