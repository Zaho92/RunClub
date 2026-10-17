// What stays between the jobs of a repo and is not the template (see the head of backend.js): the package cache as a
// volume and the build service with its volume, its socket and its network. `prepareCaches` sets both up or removes
// them if the repo wants no cache; `renewService` creates the build service anew if it carries old limits or failed
// to start. `removeCaches` clears, `removeService` stops the build service. `measureSizes` measures how large the
// package cache, template and build layers are.
//
// The build service runs without privileges (`moby/buildkit:…-rootless`) and can only be reached through a Unix socket
// in its own volume, which the pairs mount read-only (see `provision` in slots.js). It is in no network of the pairs:
// no pair reaches another through it. It needs its own network only for the way to the internet.
//
// The build service carries the limits of the Docker daemon, as a label on the container and on the pool:
//   pool.serviceBuilt     key of the limits (`limits.dockerKey`) it runs with
//   pool.serviceFailed    it failed to start last time
//   pool.serviceFailures  failures in a row; pool.serviceRetryAt  earliest time of the next attempt
//   pool.renewingService  it is being renewed right now;  pool.measuring  the volumes are being measured right now

const { lastLine } = require('./run');
const { msg, Fault } = require('./messages');
const { MINUTE, SECOND, MB } = require('./units');
const { createNetwork, alreadyExists } = require('./subnets');
const limitRules = require('./limits');
const { busy } = require('./states');
const { RUNNER_USER, SECURITY_FLAGS, asRoot, whyNotReady } = require('./dind');

const VOLUME_PREFIX = 'rc-';
const SOCKET_DIR = '/run/rc-buildkit'; // folder of the socket, in the build service as in the pairs
const SOCKET = `${SOCKET_DIR}/buildkitd.sock`; // the same path is in linux/docker-shim.sh
const SERVICE_USER = 1000; // the build service runs as this user; the pairs reach the socket through its group
const RETRY_MAX = 30 * MINUTE; // longest gap between two attempts to create the build service
const LIMITS_LABEL = 'runclub.limits';
const PIDS_MAX = 8192; // limit on processes per container: otherwise a fork bomb would cripple the whole Docker VM
const SERVICE_SETTLE = 3 * SECOND; // how long after the start to wait whether the build service ends right away

//   docker(args, options)   like `run('docker', …)`: returns `{ code, stdout, stderr }` and never throws
//   dockerList(args)        the same, returns the lines of the output
//   log(text, repo, kind), sleep(ms)
//   dind, buildkit          image of the Docker daemon (here only as a tool for the volumes, see dind.js) and of the
//                           build service
//   serviceMark             mark of the build services and their networks; whatever carries it, the next start removes
//   settingsOf(repo), limitsOf(repo), poolOf(repo) (the pool or undefined)
//   cacheVolume(repo), seedVolume(repo), buildVolume(repo), buildSocket(repo), buildService(repo), buildNetwork(repo)
//                           the names per repo
//   stopping(), dockerReady()
function createCaches({
  docker, dockerList, log, sleep,
  dind, buildkit, serviceMark,
  settingsOf, limitsOf, poolOf,
  cacheVolume, seedVolume, buildVolume, buildSocket, buildService, buildNetwork,
  stopping, dockerReady,
}) {
  const serviceKey = (repo) => limitRules.dockerKey(limitsOf(repo));

  // Creates the build service anew with the current limits as soon as nothing is being built in the pool. The pairs
  // reach the new service through the same socket and stay as they are.
  async function renewService(pool) {
    const retry = Boolean(pool.serviceFailed);
    if (!settingsOf(pool.repo)?.cache || (!retry && (!pool.serviceBuilt || pool.serviceBuilt === serviceKey(pool.repo)))) return;
    if (retry && Date.now() < pool.serviceRetryAt) return;
    if (stopping() || pool.removed || pool.hold || pool.renewingService || pool.preparing || !pool.prepared || !dockerReady()) return;
    if (pool.slots.some(busy)) return;
    pool.renewingService = true;
    try {
      log(msg(retry ? 'm_serviceRetry' : 'm_serviceRenew'), pool.repo);
      await prepareCaches(pool.repo);
    } finally { pool.renewingService = false; }
  }

  // Is the build service already running, with the current limits? Then it stays: a running build would break off.
  async function serviceCurrent(repo) {
    const found = await docker(['inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${LIMITS_LABEL}"}}`, buildService(repo)]);
    return found.code === 0 && found.stdout.trim() === `true ${serviceKey(repo)}`;
  }

  // Create the build service anew. Returns what it failed on (a message), otherwise null.
  async function startService(repo) {
    await docker(['rm', '-f', buildService(repo)]);
    // Its volumes must belong to the user of the service. Build layers of an earlier privileged service belong to
    // root and are no use to it: they are cleared once.
    await docker(['run', '--rm', '-v', `${buildVolume(repo)}:/b`, '-v', `${buildSocket(repo)}:/s`, ...asRoot(dind),
      `[ "$(stat -c %u /b)" = ${SERVICE_USER} ] || find /b -mindepth 1 -delete; chown ${SERVICE_USER}:${SERVICE_USER} /b /s`]);
    const service = await docker(['run', '-d', '--name', buildService(repo), '--label', serviceMark, '--label', `${LIMITS_LABEL}=${serviceKey(repo)}`,
      '--restart', 'no', '--network', buildNetwork(repo),
      '--cpus', String(limitsOf(repo).dockerCpus), '--memory', limitsOf(repo).dockerMemory, '--pids-limit', String(PIDS_MAX),
      // Without privileges buildkit needs its own namespaces, which Docker's defaults forbid, and its own /proc for the
      // sandbox of its build steps (see docs/rootless.md of buildkit, and dind.js on the seccomp profile). With the
      // sandbox a step sees neither buildkitd nor the steps of other builds of the same repo.
      ...SECURITY_FLAGS,
      '-v', `${buildVolume(repo)}:/home/user/.local/share/buildkit`, '-v', `${buildSocket(repo)}:${SOCKET_DIR}`,
      buildkit, '--addr', `unix://${SOCKET}`]);
    if (service.code !== 0) return msg('m_serviceFailed', lastLine(service.stderr));
    // If, say, the seccomp profile forbids buildkit a call, it ends right after the start. That should go into the log
    // here with the reason, not only show up at the next build as a missing socket.
    await sleep(SERVICE_SETTLE);
    const state = await docker(['inspect', '--format', '{{.State.Running}}', buildService(repo)]);
    if (state.code !== 0) return msg('m_serviceUnreadable', lastLine(state.stderr));
    return state.stdout?.trim() === 'true' ? null : msg('m_serviceEnded', await whyNotReady(docker, buildService(repo)));
  }

  // Set up the package cache and build service of a repo.
  async function prepareCaches(repo) {
    if (!settingsOf(repo)?.cache) { await removeService(repo); return; }
    await docker(['volume', 'create', cacheVolume(repo)]);
    await docker(['run', '--rm', '-v', `${cacheVolume(repo)}:/c`, ...asRoot(dind),
      `mkdir -p /c/nuget /c/npm && chown ${RUNNER_USER}:${RUNNER_USER} /c /c/nuget /c/npm`]);
    await docker(['volume', 'create', buildVolume(repo)]);
    await docker(['volume', 'create', buildSocket(repo)]);
    // Own network per repo: in the shared default network a build could address the service of another repo.
    // It stays as long as the repo has a cache; that it already exists is therefore no error.
    const network = await createNetwork(docker, ['--label', serviceMark, buildNetwork(repo)]);
    let failure = network.code !== 0 && !alreadyExists(network.stderr) ? msg('m_serviceNetFailed', lastLine(network.stderr)) : null;
    if (!failure && !(await serviceCurrent(repo))) failure = await startService(repo);
    const pool = poolOf(repo);
    if (failure) log(failure, repo, 'error');
    if (!pool) return;
    // After a failure `renewService` tries again, at growing intervals (at most half an hour).
    pool.serviceFailures = failure ? (pool.serviceFailures ?? 0) + 1 : 0;
    pool.serviceRetryAt = Date.now() + Math.min(2 ** pool.serviceFailures * MINUTE, RETRY_MAX);
    pool.serviceFailed = Boolean(failure);
    pool.serviceBuilt = failure ? null : serviceKey(repo);
  }

  // Stop the build service along with its network; its build layers stay.
  async function removeService(repo) {
    await docker(['rm', '-f', buildService(repo)]);
    await docker(['network', 'rm', buildNetwork(repo)]);
  }

  // Delete the package cache and build layers, as far as asked. The pool must be at rest for that (`withPoolAtRest` in
  // pools.js): a volume that is still mounted cannot be deleted, and that is then an error.
  async function removeCaches(repo, { packages = false, build = false }) {
    const volumes = [...(packages ? [cacheVolume(repo)] : []), ...(build ? [buildVolume(repo), buildSocket(repo)] : [])];
    if (build) await removeService(repo);
    if (!volumes.length) return;
    const removed = await docker(['volume', 'rm', '-f', ...volumes]);
    if (removed.code !== 0) throw new Fault('m_cachesNotRemoved', lastLine(removed.stderr));
  }

  // The size of a pool's volumes in bytes (`pool.sizes`: { packages, images, build }); what is missing counts 0.
  // A pool that is being removed is no longer measured: the measuring container would hold on to its volumes.
  async function measureSizes(pool) {
    if (pool.removed || pool.measuring) return;
    pool.measuring = true;
    try { pool.sizes = await sizesOf(pool.repo); } finally { pool.measuring = false; }
  }

  // All volumes of caches and template begin with `rc-` (see names.js).
  async function sizesOf(repo) {
    const existing = new Set(await dockerList(['volume', 'ls', '-q', '--filter', `name=${VOLUME_PREFIX}`]));
    const parts = [['packages', cacheVolume(repo)], ['images', seedVolume(repo)], ['build', buildVolume(repo)]].filter(([, volume]) => existing.has(volume));
    const sizes = { packages: 0, images: 0, build: 0 };
    if (!parts.length) return sizes;
    const mounts = parts.flatMap(([key, volume]) => ['-v', `${volume}:/m/${key}:ro`]);
    const result = await docker(['run', '--rm', ...mounts, ...asRoot(dind), 'du -sm /m/* 2>/dev/null']);
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\d+)\s+\/m\/(\w+)/);
      if (match) sizes[match[2]] = Number(match[1]) * MB;
    }
    return sizes;
  }

  return { prepareCaches, renewService, removeService, removeCaches, measureSizes };
}

module.exports = { createCaches, SOCKET_DIR, SOCKET, SERVICE_USER, PIDS_MAX };
