// Life of a slot: a slot of a pool serves job after job, each on a fresh pair of runner container and its own
// Docker daemon. This module holds what happens to a single pair: build it (`provision`), register and serve one job
// (`serveOneJob`), tear it down (`teardown`, `removePair`), abort it while idle (`abortIdle`) and the loop that
// repeats all this (`slotLoop`).
//
// What belongs to the pool as a whole comes in as functions: the reserve (`replenish`, `discardReserve`, both from
// pools.js), the template (`withSeed`, `learnImages`, both from seed.js), from names.js the names of the caches and the
// build service, the settings and limits of a repo. State both sides need (`stopping`, `dockerReady`,
// `poolResting`) is asked for fresh on every use.
//
//   Pool    { repo, slots, reserve, seeded, removed, … }   (created in `startPool` in pools.js)
//   Slot    { repo, state, jobs, base, name, runnerId, job, outcome, aborted, building, retired, kept, … }
//   Pair    { id, base, copied, extras, limits }; `base` is the name its containers, volumes and network carry
//
// States of a slot: see states.js.

const crypto = require('node:crypto');
const { lastLine } = require('./run');
const { slug } = require('./images');
const { createNetwork } = require('./subnets');
const { resultKind, resultText } = require('./journal');
const { msg, Fault, reason } = require('./messages');
const limitRules = require('./limits');
const { SOCKET_DIR, SOCKET, SERVICE_USER, PIDS_MAX } = require('./caches');
const { SECOND, HOUR } = require('./units');
const { waitForDaemon, whyNotReady, RUNNER_USER, PAIR_SOCKET, DATA_ROOT, DAEMON_FLAGS, DAEMON_COMMAND, asRoot } = require('./dind');
const { unregisterRunner } = require('./github');
const { runnerName } = require('./names');
const { EXTERNALS } = require('./externals');
const { SLOT, busy } = require('./states');

const ROUND_PAUSE = 5 * SECOND; // after an unexpected error, before the slot tries again
const REATTACH_MAX = 5; // how often output is followed again after the connection broke
const IDLE_PAUSE = SECOND; // one round of a slot while the pool rests or Docker is missing
const BROKEN_PAUSE = 60 * SECOND; // pause after an error, in one-second steps: an abort ends it at once
const ABORT_TRIES = 60; // how often, ABORT_PAUSE apart, a runner container that is just starting gets removed
const ABORT_PAUSE = SECOND;
const REFRESH_AGAIN = 4 * SECOND; // GitHub often shows a job that just started only a moment later
// Lengths from the runner's output: a job can write lines of any length there, which would otherwise reach the
// interface with every update. GitHub allows less for job names; results are short words (Succeeded, Failed, Canceled).
const JOB_NAME_MAX = 200;
const RESULT_MAX = 20;
// A job on GitHub lasts at most six hours without its own timeout-minutes; RunClub does not let a runner run longer
// than a day, so a job cannot keep it alive beyond its end.
const RUNNER_MAX = 24 * HOUR;
const RUNNER_LOG_MAX = '20m'; // log of a runner container in the Docker VM, per file (two files)
// The runner container runs without privileges, but job steps have root in it via `sudo`. What no usual step needs
// is dropped: raw sockets (`ping` works without), creating devices, setting or passing on file capabilities,
// `chroot`, ports below 1024 (a job's services run on its Docker daemon). Tested with `sudo`, `sudo -u`,
// `apt-get install`, `ping`, `dotnet` and `node`; AUDIT_WRITE stays, otherwise every `sudo` warns in the log.
const RUNNER_CAP_DROP = ['NET_RAW', 'MKNOD', 'SETFCAP', 'SETPCAP', 'SYS_CHROOT', 'NET_BIND_SERVICE'];

//   docker(args, options)   like `run('docker', …)`: returns `{ code, stdout, stderr }` and never throws
//   github                  access to GitHub (see github.js)
//   log(text, repo, kind, about), sleep(ms), timer (like `setTimeout`), newId() (id of a new pair)
//   host, mark, dind        name of the machine, mark of our own containers, image of the daemon
//   externals               `{ prepare(), release(volume) }`: the runner image's id and the volume with its tools (see
//                           externals.js)
//   longTimeout             time limit for copying the template
//   metrics                 `{ meter(), recordJob(repo, record) }` (see metrics.js)
//   settingsOf(repo), limitsOf(repo), seedVolume(repo), cacheVolume(repo), buildSocket(repo)
//   stopping(), dockerReady(), poolResting(pool)
//   withSeed(repo, exclusive, work), learnImages(pool, slot), replenish(pool), discardReserve(pool)
//   refreshRepo(repo)       fetch the repo's state from GitHub again
//   forgetStats(name)       discard the metrics of a container
function createSlots({
  docker, github, log, sleep, timer = setTimeout, newId = () => crypto.randomBytes(3).toString('hex'),
  host, mark, dind, externals, longTimeout, metrics,
  settingsOf, limitsOf, seedVolume, cacheVolume, buildSocket,
  stopping, dockerReady, poolResting,
  withSeed, learnImages, replenish, discardReserve, refreshRepo, forgetStats,
}) {
  const livePairs = new Map(); // name of the pair -> repo, from the start of the build until teardown

  // Removes a pair: containers, volumes, network and – if no job ran on it – the registration at GitHub.
  async function removePair(repo, base, runnerId) {
    try {
      await docker(['rm', '-f', '-v', `${base}-runner`, `${base}-dind`, `${base}-seed`]);
      await docker(['volume', 'rm', '-f', `${base}-work`, `${base}-sock`, `${base}-docker`]);
      await docker(['network', 'rm', base]);
      for (const name of [`${base}-runner`, `${base}-dind`]) forgetStats(name);
    } finally { livePairs.delete(base); } // otherwise `removeOrphans` (dockerwatch.js) would take a half-removed pair for standing
    if (runnerId) {
      // What cannot be unregistered stays at GitHub as a dead entry until the Docker watch unregisters it
      // (see `removeRegistrations` in dockerwatch.js), and therefore belongs in the log.
      await unregisterRunner(github, repo, runnerId).catch((error) => log(msg('m_withReason', msg('m_unregisterFailed'), reason(error)), repo, 'error'));
    }
  }

  async function teardown(slot) {
    if (!slot.base) return;
    const { base, runnerId, job } = slot;
    await removePair(slot.repo, base, job ? null : runnerId);
    slot.base = null;
    slot.runnerId = null;
    slot.kept = null;
  }

  // Builds a pair up to just before registration: network, volumes, copy of the template, running Docker daemon.
  // That is the long part. It therefore happens ahead of time, as the pool's reserve
  // (`replenish` in pools.js); switching to the next job then only costs registration and starting the runner.
  async function provision(pool, cancelled) {
    // The runner's tools for container jobs, before anything stands that would have to be removed again. Their volume
    // must not go until the pair's daemon holds it.
    const tools = await externals.prepare();
    try { return await assemble(pool, cancelled, tools); } finally { externals.release(tools.volume); }
  }

  async function assemble(pool, cancelled, tools) {
    const limits = limitsOf(pool.repo);
    const id = newId();
    const base = `rc-${slug(pool.repo)}-${id}`;
    const label = ['--label', mark];
    const pair = { id, base, image: tools.image, copied: new Set(), extras: [], limits };
    livePairs.set(base, pool.repo);
    const giveUp = async (error) => { await removePair(pool.repo, base, null); if (error) throw error; return null; };

    // A small subnet of its own instead of one from Docker's scarce pool (see subnets.js).
    const network = await createNetwork(docker, [...label, base]);
    if (network.code !== 0) return giveUp(new Fault('m_netFailed', lastLine(network.stderr)));
    for (const volume of ['work', 'sock', 'docker']) await docker(['volume', 'create', ...label, `${base}-${volume}`]);

    // The volumes belong to the user of daemon and runner; the template is copied into the daemon's storage.
    // Both in a container of their own, before the daemon starts. It runs the runner image, not the daemon image: its
    // GNU cp keeps xattrs and hard links, busybox cp drops them. Without the xattr `user.overlay.opaque` a folder that
    // a layer deleted and created again shows the old contents of the lower layer from the copy (#6). `-a` alone would skip an attribute it cannot set without a word; `--preserve=xattr`
    // makes that an error.
    const prepared = await withSeed(pool.repo, false, async () => {
      pair.copied = cancelled() ? new Set() : new Set(pool.seeded);
      const seed = pair.copied.size ? ['-v', `${seedVolume(pool.repo)}:/seed:ro`] : [];
      return docker(['run', '--rm', ...label, '--name', `${base}-seed`, ...seed, '-v', `${base}-work:/w`, '-v', `${base}-sock:/s`, '-v', `${base}-docker:/d`,
        ...asRoot(tools.image), `chown ${RUNNER_USER}:${RUNNER_USER} /w /s /d${seed.length ? ' && cp -a --preserve=xattr /seed/. /d/' : ''}`], { timeout: longTimeout });
    });
    if (cancelled()) return giveUp();
    // If the volumes don't belong to the daemon's user, it does not start; half a copy of the template is no good.
    if (prepared.code !== 0) return giveUp(new Fault('m_volumesFailed', lastLine(prepared.stderr) || msg('m_exitCode', prepared.code)));

    // The job's daemon, without privileges (see dind.js): own network, own storage, reachable only through the shared
    // socket. The work folder sits at the same path in both containers, so `docker run -v "$PWD:..."` is right; so do
    // the runner's tools, which the runner mounts into a job container (see externals.js).
    const daemon = await docker(['run', '-d', ...label, '--name', `${base}-dind`, ...DAEMON_FLAGS, '--network', base,
      '--cpus', String(limits.dockerCpus), '--memory', limits.dockerMemory, '--pids-limit', String(PIDS_MAX), // also applies to the job's containers inside
      '-v', `${base}-work:/home/runner/_work`, '-v', `${base}-sock:/sock`, '-v', `${base}-docker:${DATA_ROOT}`, '-v', `${tools.volume}:${EXTERNALS}:ro`,
      dind, ...DAEMON_COMMAND]);
    if (daemon.code !== 0) return giveUp(new Fault('m_daemonFailed', lastLine(daemon.stderr)));
    const ready = await waitForDaemon({ docker, sleep, container: `${base}-dind`, host: PAIR_SOCKET, cancelled });
    if (cancelled()) return giveUp();
    if (!ready) return giveUp(new Fault('m_daemonNotReady', await whyNotReady(docker, `${base}-dind`)));

    if (settingsOf(pool.repo)?.cache) {
      pair.extras.push('-v', `${cacheVolume(pool.repo)}:/opt/rc-cache`, '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm');
      // The build service is reached through its socket, mounted read-only: so a job cannot replace it with one of
      // its own that the next pair would then talk to. Access via the service's group.
      pair.extras.push('-v', `${buildSocket(pool.repo)}:${SOCKET_DIR}:ro`, '--group-add', String(SERVICE_USER), '-e', 'RC_BUILDER=rc');
    }
    return pair;
  }

  async function serveOneJob(pool, slot) {
    Object.assign(slot, { state: SLOT.STARTING, job: null, outcome: null, error: null, aborted: false, building: true });
    // A pair whose registration failed last time is still standing: it is taken again instead of one from the reserve.
    let pair = slot.kept ?? null;
    slot.kept = null;
    try {
      if (!pair) {
        const entry = pool.reserve.shift();
        // Already now it is settled which limits the pair is or will be built with: so "Rebuild runners" also
        // recognises a slot that is still building as outdated (see `staleSlots` in pools.js).
        slot.built = entry ? entry.built : limitRules.key(limitsOf(pool.repo));
        replenish(pool);
        if (entry) pair = await entry.promise;
        if (!pair) pair = await provision(pool, () => slot.aborted);
      }
    } finally { slot.building = false; }
    if (!pair) return;
    // Runner and Docker daemon of a pair carry the same limits: the ones it was built with.
    const limits = pair.limits;
    Object.assign(slot, { base: pair.base, name: runnerName(host, pair.id), copied: pair.copied, built: limitRules.key(limits) });
    if (slot.aborted) return;

    // Registration for exactly one job; after that it expires by itself. If it fails (403, rate limit, no network),
    // the pair is unused: the slot keeps it (`kept`) and registers it again after the pause (see `slotLoop`).
    let jit = null;
    try {
      jit = await github.send('POST', `repos/${pool.repo}/actions/runners/generate-jitconfig`, { name: slot.name, runner_group_id: 1, labels: ['self-hosted', 'Linux', 'X64'], work_folder: '_work' });
    } catch (error) {
      // If GitHub reports that the runner already exists (an earlier registration got there, but not the reply),
      // another try with the same name does not help: then the pair goes, and the next one carries a new name.
      if (error.status !== 409 && error.status !== 422) slot.kept = pair;
      throw error;
    }
    slot.runnerId = jit.runner?.id ?? null;
    if (slot.aborted) return;

    // The runner shares the network of the daemon container: ports a job publishes (`docker run -p`, `services:`)
    // are on localhost for it. Nothing more: the unprivileged daemon has its own network inside, and `--network host`
    // of a job container means that one, not the runner's.
    // The registration comes in over standard input (not in the container's settings, which `docker inspect`
    // shows) and goes to the runner as ACTIONS_RUNNER_INPUT_JITCONFIG, which reads it and removes it from its
    // environment. So it is neither in the environment of the job steps (an `env` would write it into the log at GitHub)
    // nor in a command line that `ps` shows. It stays readable in /proc of the runner itself: the job steps run as the
    // same user. But it is only valid for this one job.
    const start = [
      `if [ -n "$RC_BUILDER" ]; then docker buildx create --name "$RC_BUILDER" --driver remote --driver-opt default-load=true unix://${SOCKET} >/dev/null 2>&1 || unset RC_BUILDER; fi`,
      'read -r ACTIONS_RUNNER_INPUT_JITCONFIG; export ACTIONS_RUNNER_INPUT_JITCONFIG',
      'exec ./run.sh',
    ].join('; ');
    // The runner's output also contains what the job's steps write (`echo … > /proc/1/fd/1`), and the steps run as
    // the same user as the runner (they can also stop it). Only the first line "Running job" is therefore credible:
    // no step runs before it, and it names the job's start and name. End and duration come from outside (the container
    // ends; `settleJob`), the metrics anyway (`docker stats`). The result from the last line "completed with result"
    // is only provisional: it is noted and replaced by the result GitHub reports for this runner's job
    // (`confirmResults` in metrics.js, from the queries in remote.js).
    // After a broken connection `docker logs` starts from the beginning; repeated lines change nothing, because only
    // the first "Running job" counts and of the results only the last.
    const follow = (line) => {
      const started = line.match(/Running job: (.+)$/);
      const finished = line.match(/Job .+ completed with result: (\w+)/);
      if (/Listening for Jobs/.test(line) && slot.state === SLOT.STARTING) slot.state = SLOT.READY;
      if (started && slot.state !== SLOT.WORKING) {
        const job = started[1].slice(0, JOB_NAME_MAX);
        Object.assign(slot, { state: SLOT.WORKING, job, jobStartedAt: new Date().toISOString(), workflow: '', meter: metrics.meter() });
        log(msg('m_jobRun', job, slot.name), pool.repo, 'run');
        refreshRepo(pool.repo);
        timer(() => refreshRepo(pool.repo), REFRESH_AGAIN);
      }
      if (finished && slot.job) slot.outcome = { result: finished[1].slice(0, RESULT_MAX) };
    };
    // A runner ends after RUNNER_MAX at the latest, even if a job keeps it alive after GitHub has ended it.
    const deadline = Date.now() + RUNNER_MAX;
    let runner = await docker(['run', '--rm', '-i', '--label', mark, '--name', `${pair.base}-runner`, '--network', `container:${pair.base}-dind`,
      '--cpus', String(limits.runnerCpus), '--memory', limits.runnerMemory, '--pids-limit', String(PIDS_MAX),
      ...RUNNER_CAP_DROP.flatMap((cap) => ['--cap-drop', cap]),
      // What a job prints ends up in the container's log in the Docker VM: limited, otherwise it would fill its disk.
      '--log-opt', `max-size=${RUNNER_LOG_MAX}`, '--log-opt', 'max-file=2',
      '-v', `${pair.base}-work:/home/runner/_work`, '-v', `${pair.base}-sock:/sock`, ...pair.extras,
      pair.image, 'bash', '-c', start], {
      timeout: RUNNER_MAX,
      input: `${jit.encoded_jit_config}\n`,
      onLine: follow,
    });
    // If the call ends while the runner keeps running (Docker Desktop briefly lost the connection), output is
    // followed again instead of tearing the pair down in the middle of the job.
    for (let attempt = 0; attempt < REATTACH_MAX && !runner.timedOut && !slot.aborted && await runnerAlive(pair.base); attempt += 1) {
      log(msg('m_reattach', slot.name), pool.repo, 'error');
      runner = await docker(['logs', '-f', `${pair.base}-runner`], { timeout: Math.max(SECOND, deadline - Date.now()), onLine: follow });
    }
    if (runner.timedOut) {
      await docker(['rm', '-f', `${pair.base}-runner`]);
      slot.outcome = null; // a result from before is not the end
      runner = { ...runner, stderr: '', ended: msg('m_runnerTimeout', RUNNER_MAX / HOUR) };
    }
    // After an abort there is nothing more to report, unless the runner had already accepted a job (the abort came
    // a moment too late); when the app quits even that does not count: then a job that only just finished is not
    // booked either.
    if (slot.aborted && (!slot.job || stopping())) return;
    if (!slot.job) throw new Fault('m_runnerNoJob', runner.ended ?? (lastLine(runner.stderr) || msg('m_exitCode', runner.code)));
    if (slot.outcome) settleJob(pool, slot);
    else {
      // The runner ended in the middle of the job without reporting a result. Duration and result are then wrong:
      // the measurement is discarded instead of being recorded as usage.
      slot.meter = null;
      Object.assign(slot, { lastResult: { job: slot.job, result: null }, jobs: slot.jobs + 1 });
      log(msg('m_jobNoResult', slot.job, runner.ended ?? (lastLine(runner.stderr) || msg('m_exitCode', runner.code))), pool.repo, 'error');
    }
    await learnImages(pool, slot);
  }

  // The job is over: record usage up to the end of the runner, with the provisional result, and report it.
  function settleJob(pool, slot) {
    const { result } = slot.outcome;
    if (slot.meter) metrics.recordJob(pool.repo, { job: slot.job, workflow: slot.workflow, runner: slot.name, result, duration: Math.round((Date.now() - new Date(slot.jobStartedAt)) / SECOND), ...slot.meter.finish() });
    slot.meter = null;
    refreshRepo(pool.repo);
    Object.assign(slot, { lastResult: { job: slot.job, result }, jobs: slot.jobs + 1 });
    log(msg('m_jobEnd', slot.job, resultText(result)), pool.repo, resultKind(result));
  }

  async function runnerAlive(base) {
    const found = await docker(['inspect', '--format', '{{.State.Running}}', `${base}-runner`]);
    return found.code === 0 && found.stdout.trim() === 'true';
  }

  const slotWanted = (pool, slot) => !stopping() && !pool.removed && !slot.retired;

  async function slotLoop(pool, slot) {
    while (slotWanted(pool, slot)) {
      // What throws during teardown or at the reserve does not end the slot: the pool would otherwise lack one for good.
      await slotRound(pool, slot).catch(async (error) => {
        log(msg('m_withReason', msg('m_whatSlot'), reason(error)), pool.repo, 'error');
        await sleep(ROUND_PAUSE);
      });
    }
    slot.state = SLOT.OFF;
    pool.slots = pool.slots.filter((other) => other !== slot);
  }

  // One round of the slot: wait while the pool rests, otherwise serve one job and tear the pair down.
  async function slotRound(pool, slot) {
    if (!dockerReady() || poolResting(pool)) {
      slot.state = !dockerReady() ? SLOT.NO_DOCKER : settingsOf(pool.repo)?.paused ? SLOT.PAUSED : SLOT.WAITING;
      await discardReserve(pool);
      await sleep(IDLE_PAUSE);
      return;
    }
    try {
      await serveOneJob(pool, slot);
    } catch (error) {
      if (!slot.aborted) {
        Object.assign(slot, { error: reason(error), state: SLOT.BROKEN });
        log(reason(error), pool.repo, 'error');
        if (!slot.kept) await teardown(slot);
        // An abort while idle (`abortIdle`) ends the pause at once; the next attempt resets `aborted` only
        // after it has taken effect here.
        for (let waited = 0; waited < BROKEN_PAUSE && slotWanted(pool, slot) && dockerReady() && !poolResting(pool) && !slot.aborted; waited += SECOND) await sleep(SECOND);
        // A kept pair goes if the slot does not carry on right away or it no longer matches the limits.
        if (slot.aborted || !slotWanted(pool, slot) || !dockerReady() || poolResting(pool) || slot.built !== limitRules.key(limitsOf(pool.repo))) await teardown(slot);
        return;
      }
    }
    slot.state = SLOT.CLEANING;
    await teardown(slot);
  }

  // End a pair without a job early.
  async function abortIdle(slot) {
    if (busy(slot)) return;
    slot.aborted = true;
    // The runner container may only just be coming up: keep removing it until the slot has torn down its pair.
    // If the runner has accepted a job after all in the meantime, that job runs to the end.
    const { base } = slot;
    for (let attempt = 0; attempt < ABORT_TRIES && base && slot.base === base && slot.state !== SLOT.WORKING; attempt += 1) {
      await docker(['rm', '-f', `${base}-runner`]);
      if (slot.base === base) await sleep(ABORT_PAUSE);
    }
    // The abort no longer applies: otherwise the images of this job would not be learned.
    if (slot.state === SLOT.WORKING) slot.aborted = false;
  }

  // Tear a pair down at once, even in the middle of a job (when RunClub quits). A slot that is just getting its
  // pair sees the abort and tears it down itself.
  function abort(slot) {
    slot.aborted = true;
    return teardown(slot);
  }

  return { livePairs, provision, removePair, teardown, abort, serveOneJob, slotLoop, abortIdle, slotWanted };
}

// The slot remembers the workflow of its job: at the end the runner only names the job (see metrics.js).
// `jobs`: the repo's running jobs as GitHub reports them ({ runner, workflow }; see remote.js).
function noteWorkflows(pool, jobs) {
  for (const slot of pool?.slots ?? []) {
    if (slot.state === SLOT.WORKING) slot.workflow = jobs.find((job) => job.runner === slot.name)?.workflow || slot.workflow;
  }
}

// The names of the runners whose pair is standing (also one that is just registering): these stay registered at GitHub.
const pairNames = (pool) => new Set(pool.slots.filter((slot) => slot.base).map((slot) => slot.name));

// The registrations of the idle slots of all pools: `[{ repo, runnerId }]`. They can be withdrawn at GitHub
// without losing a job.
const idleRegistrations = (pools) => [...pools].flatMap((pool) => pool.slots.filter((slot) => slot.runnerId && !slot.job).map((slot) => ({ repo: slot.repo, runnerId: slot.runnerId })));

module.exports = { createSlots, noteWorkflows, pairNames, idleRegistrations, REFRESH_AGAIN, JOB_NAME_MAX, RESULT_MAX, RUNNER_MAX, RUNNER_LOG_MAX, ROUND_PAUSE, IDLE_PAUSE, BROKEN_PAUSE };
