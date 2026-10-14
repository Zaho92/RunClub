// Was zwischen den Jobs eines Repos bleibt und nicht Vorlage ist (siehe Kopf von backend.js): der Paket-Cache als
// Volume und der Build-Dienst mit seinem Volume und seinem Netz. `prepareCaches` stellt beides bereit oder baut es ab,
// wenn das Repo keinen Cache will; `renewService` legt den Build-Dienst neu an, wenn er alte Limits trägt oder nicht
// zustande kam. `measureSizes` misst, wie groß Paket-Cache, Vorlage und Build-Layer sind.
//
// Der Build-Dienst trägt die Limits des Docker-Daemons. Am Pool steht, womit er gebaut ist:
//   pool.serviceBuilt     Kennung der Limits (`serviceKey`) oder `SERVICE_FAILED`
//   pool.serviceFailures  Fehlschläge in Folge; pool.serviceRetryAt  frühester Zeitpunkt des nächsten Versuchs
//   pool.renewingService  es wird gerade erneuert

const { lastLine } = require('./run');
const { MINUTE, MB } = require('./units');
const { createNetwork, alreadyExists } = require('./subnets');
const limitRules = require('./limits');

const VOLUME_PREFIX = 'rc-';
const SERVICE_FAILED = 'gescheitert'; // steht in `serviceBuilt`, wenn der Build-Dienst nicht zustande kam

//   docker(args, options)   wie `run('docker', …)`: liefert `{ code, stdout, stderr }` und wirft nie
//   dockerList(args)        dasselbe, liefert die Zeilen der Ausgabe
//   log(text, repo, kind)
//   dind, buildkit          Abbild des Docker-Daemons (hier nur als Werkzeug für das Volume) und des Build-Diensts
//   settingsOf(repo), limitsOf(repo), poolOf(repo) (der Pool oder undefined)
//   cacheVolume(repo), seedVolume(repo), buildVolume(repo), buildService(repo), buildNetwork(repo)   die Namen je Repo
//   livePairs               Name des Paars -> Repo (aus slots.js)
//   stopping(), linuxReady()
function createCaches({
  docker, dockerList, log,
  dind, buildkit,
  settingsOf, limitsOf, poolOf,
  cacheVolume, seedVolume, buildVolume, buildService, buildNetwork,
  livePairs, stopping, linuxReady,
}) {
  // Der Build-Dienst trägt die Limits des Docker-Daemons; mit dieser Kennung ist zu erkennen, ob er noch alte trägt.
  const serviceKey = (repo) => `${limitsOf(repo).dockerCpus}/${limitRules.bytesOf(limitsOf(repo).dockerMemory)}`;

  // Legt den Build-Dienst mit den geltenden Limits neu an, sobald im Pool nichts gebaut wird, und hängt ihn wieder in
  // die Netze der stehenden Paare. Die Paare selbst bleiben, wie sie sind.
  async function renewService(pool) {
    const settings = settingsOf(pool.repo);
    if (!settings?.cache || !pool.serviceBuilt || pool.serviceBuilt === serviceKey(pool.repo)) return;
    const retry = pool.serviceBuilt === SERVICE_FAILED;
    if (retry && Date.now() < pool.serviceRetryAt) return;
    if (stopping() || pool.removed || pool.hold || pool.renewingService || !pool.prepared || !linuxReady()) return;
    if (pool.slots.some((slot) => slot.state === 'arbeitet' || slot.state === 'räumt auf')) return;
    pool.renewingService = true;
    try {
      log(retry ? 'Versuche erneut, den Build-Dienst anzulegen' : 'Lege den Build-Dienst mit den neuen Limits an', pool.repo);
      await prepareCaches(pool.repo);
      for (const [base, repo] of livePairs) if (repo === pool.repo) await docker(['network', 'connect', '--alias', 'buildkit', base, buildService(pool.repo)]);
    } finally { pool.renewingService = false; }
  }

  // Paket-Cache und Build-Dienst eines Repos bereitstellen.
  async function prepareCaches(repo) {
    const settings = settingsOf(repo);
    await docker(['rm', '-f', buildService(repo)]);
    if (!settings?.cache) { await docker(['network', 'rm', buildNetwork(repo)]); return; }
    await docker(['volume', 'create', cacheVolume(repo)]);
    await docker(['run', '--rm', '-v', `${cacheVolume(repo)}:/c`, '--entrypoint', 'sh', dind, '-c',
      'mkdir -p /c/nuget /c/npm && chown 1001:1001 /c /c/nuget /c/npm']);
    await docker(['volume', 'create', buildVolume(repo)]);
    // Eigenes Netz je Repo: Im gemeinsamen Standard-Netz könnte ein Build den Dienst eines anderen Repos ansprechen.
    // Es bleibt stehen, solange das Repo einen Cache hat; dass es schon da ist, ist deshalb kein Fehler.
    const network = await createNetwork(docker, [buildNetwork(repo)]);
    let failure = network.code !== 0 && !alreadyExists(network.stderr) ? `Netz für den Build-Dienst lässt sich nicht anlegen – ${lastLine(network.stderr)}` : null;
    if (!failure) {
      const service = await docker(['run', '-d', '--name', buildService(repo), '--privileged', '--restart', 'no', '--network', buildNetwork(repo),
        '--cpus', String(limitsOf(repo).dockerCpus), '--memory', limitsOf(repo).dockerMemory,
        '-v', `${buildVolume(repo)}:/var/lib/buildkit`, buildkit, '--addr', 'tcp://0.0.0.0:1234']);
      if (service.code !== 0) failure = `Build-Dienst startet nicht – ${lastLine(service.stderr)}`;
    }
    const pool = poolOf(repo);
    if (failure) log(failure, repo, 'error');
    if (!pool) return;
    // Nach einem Fehlschlag versucht `renewService` es wieder, in wachsendem Abstand (höchstens eine halbe Stunde).
    pool.serviceFailures = failure ? (pool.serviceFailures ?? 0) + 1 : 0;
    pool.serviceRetryAt = Date.now() + Math.min(2 ** pool.serviceFailures, 30) * MINUTE;
    pool.serviceBuilt = failure ? SERVICE_FAILED : serviceKey(repo);
  }

  // Die Größe der Volumes eines Pools in Bytes (`pool.sizes`: { packages, images, build }); was fehlt, zählt 0.
  // Alle Volumes von Caches und Vorlage beginnen mit `rc-` (siehe die Namen je Repo in backend.js).
  async function measureSizes(pool) {
    const existing = new Set(await dockerList(['volume', 'ls', '-q', '--filter', `name=${VOLUME_PREFIX}`]));
    const parts = [['packages', cacheVolume(pool.repo)], ['images', seedVolume(pool.repo)], ['build', buildVolume(pool.repo)]].filter(([, volume]) => existing.has(volume));
    const sizes = { packages: 0, images: 0, build: 0 };
    if (parts.length) {
      const mounts = parts.flatMap(([key, volume]) => ['-v', `${volume}:/m/${key}:ro`]);
      const result = await docker(['run', '--rm', ...mounts, '--entrypoint', 'sh', dind, '-c', 'du -sm /m/* 2>/dev/null']);
      for (const line of result.stdout.split('\n')) {
        const match = line.match(/^(\d+)\s+\/m\/(\w+)/);
        if (match) sizes[match[2]] = Number(match[1]) * MB;
      }
    }
    pool.sizes = sizes;
  }

  return { prepareCaches, renewService, measureSizes };
}

module.exports = { createCaches, SERVICE_FAILED };
