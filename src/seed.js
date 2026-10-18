// The template of a repo and what was learned behind it (see “Images” in the head of backend.js): after each job
// `learnImages` records the names of the images it pulled itself. `refreshSeed` fetches them from the registry into a
// volume, the template; every new pair gets a copy of it (`provision` in slots.js) and no longer has to pull them.
// No job writes to the template: only names are recorded, pulling happens from here.
//
//   Learned   `state.learned[repo]`  { image: ISO time of last use }; drops out after `LEARNED_DAYS`
//   Rejected  `state.rejected[repo]` { image: ISO time }; what the registry does not have is not learned again for
//             that long
//   Template  `pool.seeded`: the images that are in the volume right now
//
// The rules for single images are in images.js.

const { lastLine } = require('./run');
const { SECOND } = require('./units');
const { waitForDaemon, whyNotReady, RUNNER_USER, PAIR_SOCKET, DATA_ROOT, DAEMON_FLAGS, DAEMON_COMMAND, asRoot } = require('./dind');
const { permanentPullError, daysSince, pruneOlder } = require('./images');
const { errorLog } = require('./journal');
const { msg, Fault } = require('./messages');

const LEARNED_DAYS = 14;
const LEARNED_MAX = 25;
const LOCK_PAUSE = SECOND / 2; // how often whoever waits for the template checks
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:-]*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

//   docker(args, options)   like `run('docker', …)`: returns `{ code, stdout, stderr }` and never throws
//   dockerList(args)        the same, returns the lines of the output
//   log(text, repo, kind), sleep(ms)
//   mark, dind              mark of our own containers and image of the Docker daemon
//   longTimeout             time limit for pulling an image
//   settingsOf(repo), seedVolume(repo), poolOf(repo) (the pool or undefined)
//   state, saveState()      what was learned (`learned`, `rejected`) and saving it
//   stopping()              RunClub is ending: a refresh then stops instead of holding up the shutdown
function createSeed({
  docker, dockerList, log, sleep,
  mark, dind, longTimeout,
  settingsOf, seedVolume, poolOf,
  state, saveState, stopping = () => false,
}) {
  const logError = errorLog(log);

  function wantedImages(repo) {
    const fixed = settingsOf(repo)?.preload ?? [];
    const learned = Object.entries(state.learned[repo] ?? {})
      .filter(([, usedAt]) => daysSince(usedAt) <= LEARNED_DAYS)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([image]) => image);
    return [...new Set([...fixed, ...learned])].slice(0, LEARNED_MAX);
  }

  // Copying may run at the same time, refreshing only alone.
  const seedLocks = new Map();
  async function withSeed(repo, exclusive, work) {
    if (!seedLocks.has(repo)) seedLocks.set(repo, { readers: 0, writing: false });
    const lock = seedLocks.get(repo);
    while (lock.writing || (exclusive && lock.readers > 0)) await sleep(LOCK_PAUSE);
    if (exclusive) lock.writing = true; else lock.readers += 1;
    try { return await work(); } finally { if (exclusive) lock.writing = false; else lock.readers -= 1; }
  }

  function refreshSeed(repo) {
    return withSeed(repo, true, async () => {
      const pool = poolOf(repo);
      if (pool?.removed) return; // the loader container would hold on to the volume that is about to be deleted
      const seed = seedVolume(repo);
      const loader = `${seed}-loader`;
      const wanted = wantedImages(repo);
      // `-v` on every removal: the daemon image creates its storage as a volume, which would otherwise be left behind.
      await docker(['rm', '-f', '-v', loader]);
      if (!wanted.length) { await docker(['volume', 'rm', '-f', seed]); if (pool) pool.seeded = new Set(); return; }
      log(msg('m_seedRefresh', wanted.length), repo);
      await docker(['volume', 'create', seed]);
      // The loader daemon runs without privileges like the daemon of a pair (see dind.js), so the template must belong
      // to its user.
      await docker(['run', '--rm', '-v', `${seed}:/d`, ...asRoot(dind),
        `chown ${RUNNER_USER}:${RUNNER_USER} /d`]);
      await docker(['run', '-d', '--label', mark, '--name', loader, ...DAEMON_FLAGS, '-v', `${seed}:${DATA_ROOT}`, dind, ...DAEMON_COMMAND]);
      const ready = await waitForDaemon({ docker, sleep, container: loader, host: PAIR_SOCKET, cancelled: stopping });
      // If RunClub is ending, the waiting was only cancelled, no error. The loader container goes right away anyway:
      // the shutdown does not wait for the template and may no longer have seen it.
      if (stopping()) { await docker(['rm', '-f', '-v', loader]); return; }
      // Without a running loader daemon nothing could be pulled; what was learned stays as it is.
      if (!ready) {
        const why = await whyNotReady(docker, loader);
        await docker(['rm', '-f', '-v', loader]);
        throw new Fault('m_loaderNotReady', why);
      }
      const present = new Set();
      const retry = new Set();
      for (const image of wanted) {
        // If RunClub is ending, the template stays as it was; the shutdown removes the loader container.
        if (stopping()) return;
        const pull = await docker(['exec', loader, 'docker', '-H', PAIR_SOCKET, 'pull', '-q', image], { timeout: longTimeout });
        if (pull.code === 0) { present.add(image); continue; }
        log(msg('m_seedPullFailed', image, lastLine(pull.stderr)), repo, 'error');
        // A disruption (network, rate limit) passes: what is already in the template stays there.
        if (!permanentPullError(pull.stderr)) { retry.add(image); continue; }
        // What the registry does not have, the job built itself or it is not public: do not try again.
        (state.rejected[repo] ??= {})[image] = new Date().toISOString();
        delete state.learned[repo]?.[image];
      }
      const existing = await dockerList(['exec', loader, 'docker', '-H', PAIR_SOCKET, 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
      for (const image of existing) if (retry.has(image)) present.add(image);
      const obsolete = existing.filter((image) => !present.has(image) && IMAGE_NAME.test(image));
      if (obsolete.length) await docker(['exec', loader, 'docker', '-H', PAIR_SOCKET, 'rmi', '-f', ...obsolete]);
      await docker(['exec', loader, 'docker', '-H', PAIR_SOCKET, 'image', 'prune', '-f']);
      await docker(['stop', loader]);
      await docker(['rm', '-v', loader]);
      if (pool) pool.seeded = present;
      pruneOlder(state.rejected[repo], LEARNED_DAYS);
      pruneOlder(state.learned[repo], LEARNED_DAYS);
      saveState();
    });
  }

  // After a job: record the names of the images it pulled itself.
  const refreshQueued = new Set();
  async function learnImages(pool, slot) {
    const listing = await docker(['exec', `${slot.base}-dind`, 'docker', '-H', PAIR_SOCKET, 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
    if (listing.code !== 0) return;
    const now = new Date().toISOString();
    const rejected = state.rejected[pool.repo] ?? {};
    let unknown = false;
    for (const image of new Set(listing.stdout.split('\n').map((s) => s.trim()))) {
      if (!IMAGE_NAME.test(image)) continue;
      if (rejected[image] && daysSince(rejected[image]) <= LEARNED_DAYS) continue;
      // What already came from the template may be unused: its date stays, so that it drops out after a while
      // and only comes back if a job pulls it itself again.
      if (slot.copied?.has(image)) continue;
      (state.learned[pool.repo] ??= {})[image] = now;
      if (!pool.seeded.has(image)) unknown = true;
    }
    saveState();
    if (unknown && !refreshQueued.has(pool.repo)) {
      refreshQueued.add(pool.repo);
      refreshSeed(pool.repo).catch(logError(pool.repo, msg('m_whatTemplate'))).finally(() => refreshQueued.delete(pool.repo));
    }
  }

  // Discard the template and what was learned for a repo as soon as no copy and no refresh is running. Throws if
  // the volume cannot be deleted.
  function forget(repo) {
    return withSeed(repo, true, async () => {
      delete state.learned[repo];
      delete state.rejected[repo];
      saveState();
      const pool = poolOf(repo);
      if (pool) pool.seeded = new Set();
      const removed = await docker(['volume', 'rm', '-f', seedVolume(repo)]);
      if (removed.code !== 0) throw new Fault('m_seedNotRemoved', lastLine(removed.stderr));
    });
  }

  return { wantedImages, withSeed, refreshSeed, learnImages, forget };
}

module.exports = { createSeed, LEARNED_DAYS, LEARNED_MAX };
