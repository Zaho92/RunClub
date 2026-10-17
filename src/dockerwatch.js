// The Docker watch: Docker may start later than RunClub, drop out in between or restart.
// `watchLoop` prepares Docker as soon as it answers (`prepareDocker`: read the VM's limits, build our own images
// of runner and Docker daemon, pull the build service's image, clear leftovers), then checks it regularly
// and gives it up only after several missing answers. Plus the daily rebuild of our own images
// (`refreshImage`, because of the runner) and clearing leftovers (`removeLeftovers` at start and shutdown,
// `removeOrphans` after an interruption, `removeRegistrations` at GitHub).
//
// Where Docker runs is in engine.js; `docker`, `dockerList` and the message `unreachableText` come from there.

const { lastLine } = require('./run');
const { SECOND } = require('./units');
const { orphaned } = require('./pairs');
const { unregisterRunner, PAGE_MAX } = require('./github');
const { PROBE_TIMEOUT } = require('./dind');
const { runnerPrefix } = require('./names');
const { msg, Fault, render, reason } = require('./messages');

const MISSES = 3; // Docker must stay silent this many times in a row before it counts as gone
const READY_PAUSE = 30 * SECOND; // interval between checks while Docker answers
const WAIT_PAUSE = 15 * SECOND; // … and while it isn't prepared yet
const MISS_PAUSE = 5 * SECOND; // after a missing answer

//   docker(args, options), dockerList(args)   from engine.js
//   github                  access to GitHub (see github.js)
//   log(text, repo, kind), sleep(ms)
//   host, mark              the machine's name (start of the runner names) and label of our own containers
//   serviceMark             label of the build services and their networks (see caches.js)
//   builds                  the self-built images: [{ image, dir, args, what }] (name, folder with Dockerfile,
//                           more arguments for `docker build`, label for messages as a key); the first is the runner image
//   requiredImages          images that must be pulled (today only the build service)
//   longTimeout             time limit for building and pulling
//   unreachable             the message when Docker doesn't answer (from engine.js)
//   exposure()              warning if the daemon is reachable without protection, otherwise null (promise, from engine.js)
//   buildService(repo), buildNetwork(repo)   names of the build service and its network (see names.js)
//   livePairs               name of the pair -> repo (from slots.js)
//   repos(), pools()        the repos with a pool per settings, the standing pools
//   preparePool(pool)       provide a pool's caches and template
//   stopping()
//   onReady()               Docker is prepared (again): start the measurements
//   onAlive()               a regular check got an answer while Docker is ready
function createDockerWatch({
  docker, dockerList, github, log, sleep,
  host, mark, serviceMark, builds, requiredImages, longTimeout, unreachable, exposure = async () => null,
  buildService, buildNetwork,
  livePairs, repos, pools, preparePool, stopping,
  onReady = () => {}, onAlive = () => {},
}) {
  let dockerCpus = 1;
  let dockerMemory = 0;
  let dockerReady = false;
  let dockerError = null;
  let leftoversRemoved = false;

  // Build our own images. If that fails (no network) and an earlier one exists, the runners keep working with it;
  // only without any image at all it doesn't work.
  async function buildImages() {
    for (const { image, dir, args = [], what } of builds) {
      const build = await docker(['build', '--pull', '-q', ...args, '-t', image, dir], { timeout: longTimeout });
      if (build.code === 0) continue;
      const said = lastLine(build.stderr);
      if ((await docker(['image', 'inspect', '--format', 'ok', image])).code !== 0) throw new Fault('m_buildFailed', msg(what), said);
      log(msg('m_rebuildFailed', msg(what), said), null, 'error');
    }
  }

  // Over a long uptime the runner in the image gets outdated, and GitHub rejects runners that are too old: rebuild daily.
  // New pairs start with the new image on their own; running jobs are not affected.
  async function refreshImage() {
    if (stopping() || !dockerReady) return;
    log(msg('m_imagesDaily'));
    await buildImages();
  }

  async function prepareDocker() {
    const info = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeout: PROBE_TIMEOUT });
    if (info.code !== 0) throw Fault.of(unreachable);
    dockerCpus = Number(info.stdout.trim().split(' ')[0]) || 1;
    dockerMemory = Number(info.stdout.trim().split(' ')[1]) || 0;
    log(msg('m_imagesBuild'));
    await buildImages();
    for (const name of requiredImages) await docker(['pull', '-q', name], { timeout: longTimeout });
    // Leftovers exist only from the previous program run. If Docker comes back later, the slots clear their pairs
    // themselves; removing everything labelled would then also hit pairs on which a job is running.
    if (!leftoversRemoved) { await removeLeftovers(); leftoversRemoved = true; } else await removeOrphans();
  }

  // A network along with everything still attached to it (such as the build service).
  async function removeNetwork(network) {
    for (const member of await dockerList(['network', 'inspect', network, '--format', '{{range .Containers}}{{println .Name}}{{end}}'])) await docker(['network', 'disconnect', '-f', network, member]);
    await docker(['network', 'rm', network]);
  }

  // After a Docker interruption: if Docker was unreachable while clearing a pair, its containers,
  // volumes and network were left behind. Only what no longer belongs to a standing pair is removed.
  async function removeOrphans() {
    const live = new Set(livePairs.keys());
    const containers = orphaned(await dockerList(['ps', '-a', '--filter', `label=${mark}`, '--format', '{{.Names}}']), live);
    if (containers.length) await docker(['rm', '-f', '-v', ...containers]);
    const volumes = orphaned(await dockerList(['volume', 'ls', '-q', '--filter', `label=${mark}`]), live);
    if (volumes.length) await docker(['volume', 'rm', '-f', ...volumes]);
    for (const network of orphaned(await dockerList(['network', 'ls', '--filter', `label=${mark}`, '--format', '{{.Name}}']), live)) await removeNetwork(network);
    if (containers.length || volumes.length) log(msg('m_orphansRemoved', containers.length, volumes.length));
  }

  // Leftovers of an earlier run: pairs, their volumes and networks, build services (they end with the program; what is
  // still standing belongs to a crash or to a pool that no longer exists), runners registered at GitHub. A repo's build
  // service and network are also removed by name: older versions created them without a label.
  // `step(name, count)` reports during shutdown how far it got (see shutdown.js): `cleanup` before Docker, `signoff` with
  // the number of repos before GitHub, `signedOff` after each repo.
  async function removeLeftovers(step = () => {}) {
    step('cleanup');
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
    step('signoff', repos().length);
    for (const repo of repos()) { await removeRegistrations(repo); step('signedOff'); }
  }

  // Remove this machine's runners from GitHub that no longer have a job. `keep()`: names that belong to standing pairs
  // and stay; asked only after GitHub's answer, so that a slot registering meanwhile is
  // included. With `offline` only those that have no connection any more: in operation that hits the runners whose
  // pair ended mid-job (on shutdown, after a crash) and which GitHub releases only later.
  async function removeRegistrations(repo, { keep = () => new Set(), offline = false } = {}) {
    try {
      const runners = (await github.get(`repos/${repo}/actions/runners?per_page=${PAGE_MAX}`)).runners; // a repo with a pool doesn't have more
      const kept = keep();
      const stale = runners.filter((runner) => runner.name.startsWith(runnerPrefix(host)) && !runner.busy && !kept.has(runner.name) && (!offline || runner.status === 'offline'));
      for (const runner of stale) await unregisterRunner(github, repo, runner.id);
      if (offline && stale.length) log(msg('m_staleRunners', stale.length), repo);
    } catch (error) { log(msg('m_withReason', msg('m_whatOldRunners'), reason(error)), repo, 'error'); }
  }

  // Checked as soon as Docker is prepared (again): the switch in Docker Desktop may have been flipped meanwhile.
  async function warnIfExposed() {
    const warning = await exposure();
    if (warning) log(warning, null, 'error');
  }

  // Docker may start later than this program, or restart in between.
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
          if (render(dockerError ?? '') !== error.message) log(reason(error), null, 'error');
          dockerError = reason(error);
        }
      } else if ((await docker(['info', '--format', 'ok'], { timeout: PROBE_TIMEOUT })).code !== 0) {
        // A single missing answer (full VM, brief hang) doesn't mean Docker is gone:
        // only after several in a row do the slots wait and everything is prepared again.
        misses += 1;
        if (misses >= MISSES) {
          dockerReady = false;
          log(msg('m_dockerGone'), null, 'error');
        }
        await sleep(MISS_PAUSE);
        continue;
      } else { misses = 0; onAlive(); }
      await sleep(dockerReady ? READY_PAUSE : WAIT_PAUSE);
    }
  }

  // `watch` is the loop (`watchLoop`); it ends only when RunClub ends.
  return {
    watch: watchLoop, prepareDocker, refreshImage, removeOrphans, removeLeftovers, removeRegistrations,
    ready: () => dockerReady, error: () => dockerError, cpus: () => dockerCpus, memory: () => dockerMemory,
  };
}

module.exports = { createDockerWatch, MISSES, READY_PAUSE, WAIT_PAUSE, MISS_PAUSE };
