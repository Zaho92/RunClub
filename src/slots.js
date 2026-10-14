// Lebenslauf eines Platzes: Ein Platz eines Pools bedient Job um Job, jeden auf einem frischen Paar aus
// Runner-Container und eigenem Docker-Daemon. Hier liegt, was mit einem einzelnen Paar geschieht: aufbauen
// (`provision`), anmelden und einen Job bedienen (`serveOneJob`), abräumen (`teardown`, `removePair`), im Leerlauf
// abbrechen (`abortIdle`) und die Schleife, die das wiederholt (`slotLoop`).
//
// Was zum Pool im Ganzen gehört, kommt als Funktion herein: die Reserve (`replenish`, `discardReserve`, beide aus
// pools.js), die Vorlage (`withSeed`, `learnImages`, beide aus seed.js), aus names.js die Namen der Caches und des
// Build-Dienstes, die Einstellungen und Limits eines Repos. Zustand, den beide Seiten brauchen (`stopping`,
// `dockerReady`, `poolResting`), wird bei jedem Gebrauch frisch erfragt.
//
//   Pool    { repo, slots, reserve, seeded, removed, … }   (angelegt in `startPool` in pools.js)
//   Platz   { repo, state, jobs, base, name, runnerId, job, aborted, building, retired, kept, … }
//   Paar    { id, base, copied, extras, limits }; `base` ist der Name, den Container, Volumes und Netz tragen
//
// Zustände eines Platzes: siehe states.js.

const crypto = require('node:crypto');
const { lastLine } = require('./run');
const { slug } = require('./images');
const { createNetwork } = require('./subnets');
const { resultKind, resultText } = require('./journal');
const limitRules = require('./limits');
const { SOCKET_DIR, SOCKET, SERVICE_USER, RUNNER_USER, PIDS_MAX } = require('./caches');
const { SECOND } = require('./units');
const { waitForDaemon, PAIR_SOCKET, DOCKER_GROUP } = require('./dind');
const { unregisterRunner } = require('./github');
const { runnerName } = require('./names');
const { SLOT, busy } = require('./states');

const ROUND_PAUSE = 5 * SECOND; // nach einem unerwarteten Fehler, bevor der Platz es wieder versucht
const REATTACH_MAX = 5; // so oft wird nach einem Abriss der Verbindung wieder mitgelesen
const IDLE_PAUSE = SECOND; // eine Runde eines Platzes, solange der Pool ruht oder Docker fehlt
const BROKEN_PAUSE = 60 * SECOND; // Pause nach einem Fehler, in Sekundenschritten: Ein Abbruch beendet sie sofort
const ABORT_TRIES = 60; // so oft, im Abstand von ABORT_PAUSE, wird ein entstehender Runner-Container entfernt
const ABORT_PAUSE = SECOND;
const REFRESH_AGAIN = 4 * SECOND; // GitHub zeigt einen eben begonnenen Job oft erst nach einem Augenblick

//   docker(args, options)   wie `run('docker', …)`: liefert `{ code, stdout, stderr }` und wirft nie
//   gh(args, body)          Aufruf der GitHub-API, liefert die Antwort als Objekt oder wirft
//   log(text, repo, kind, about), sleep(ms), timer (wie `setTimeout`), newId() (Kennung eines neuen Paars)
//   host, mark, image, dind Name des Rechners, Kennzeichen der eigenen Container, Abbild des Runners und des Daemons
//   longTimeout             Zeitgrenze für das Kopieren der Vorlage
//   metrics                 `{ meter(), recordJob(repo, record) }` (siehe metrics.js)
//   settingsOf(repo), limitsOf(repo), seedVolume(repo), cacheVolume(repo), buildSocket(repo)
//   stopping(), dockerReady(), poolResting(pool)
//   withSeed(repo, exclusive, work), learnImages(pool, slot), replenish(pool), discardReserve(pool)
//   refreshRepo(repo)       den Stand des Repos bei GitHub neu holen
//   forgetStats(name)       die Messwerte eines Containers verwerfen
function createSlots({
  docker, gh, log, sleep, timer = setTimeout, newId = () => crypto.randomBytes(3).toString('hex'),
  host, mark, image, dind, longTimeout, metrics,
  settingsOf, limitsOf, seedVolume, cacheVolume, buildSocket,
  stopping, dockerReady, poolResting,
  withSeed, learnImages, replenish, discardReserve, refreshRepo, forgetStats,
}) {
  const livePairs = new Map(); // Name des Paars -> Repo, vom Beginn des Aufbaus bis zum Abräumen

  // Entfernt ein Paar: Container, Volumes, Netz und – wenn kein Job darauf lief – die Anmeldung bei GitHub.
  async function removePair(repo, base, runnerId) {
    try {
      await docker(['rm', '-f', '-v', `${base}-runner`, `${base}-dind`, `${base}-seed`]);
      await docker(['volume', 'rm', '-f', `${base}-work`, `${base}-sock`, `${base}-docker`]);
      await docker(['network', 'rm', base]);
      for (const name of [`${base}-runner`, `${base}-dind`]) forgetStats(name);
    } finally { livePairs.delete(base); } // sonst hielte `removeOrphans` (dockerwatch.js) ein halb abgeräumtes Paar für stehend
    if (runnerId) {
      // Was sich nicht abmelden lässt, bleibt bei GitHub als toter Eintrag stehen, bis die Docker-Überwachung es
      // abmeldet (siehe `removeRegistrations` in dockerwatch.js), und gehört deshalb ins Protokoll.
      await unregisterRunner(gh, repo, runnerId).catch((error) => log(`Runner ließ sich bei GitHub nicht abmelden – ${error.message}`, repo, 'error'));
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

  // Baut ein Paar bis kurz vor die Anmeldung: Netz, Volumes, Kopie der Vorlage, laufender Docker-Daemon.
  // Das ist der lange Teil. Er geschieht deshalb im Voraus, als Reserve des Pools
  // (`replenish` in pools.js); der Wechsel zum nächsten Job kostet dann nur noch Anmeldung und Start des Runners.
  async function provision(pool, cancelled) {
    const limits = limitsOf(pool.repo);
    const id = newId();
    const base = `rc-${slug(pool.repo)}-${id}`;
    const label = ['--label', mark];
    const pair = { id, base, copied: new Set(), extras: [], limits };
    livePairs.set(base, pool.repo);
    const giveUp = async (error) => { await removePair(pool.repo, base, null); if (error) throw error; return null; };

    // Eigenes kleines Subnetz statt eines aus Dockers knappem Vorrat (siehe subnets.js).
    const network = await createNetwork(docker, [...label, base]);
    if (network.code !== 0) return giveUp(new Error(`Netz lässt sich nicht anlegen: ${lastLine(network.stderr)}`));
    for (const volume of ['work', 'sock', 'docker']) await docker(['volume', 'create', ...label, `${base}-${volume}`]);

    // Kopie der Vorlage in den Speicher des Daemons – in einem eigenen Container, bevor der Daemon startet.
    await withSeed(pool.repo, false, async () => {
      pair.copied = new Set(pool.seeded);
      if (!pair.copied.size || cancelled()) return;
      await docker(['run', '--rm', ...label, '--name', `${base}-seed`, '-v', `${seedVolume(pool.repo)}:/seed:ro`, '-v', `${base}-docker:/var/lib/docker`,
        '--entrypoint', 'sh', dind, '-c', 'cp -a /seed/. /var/lib/docker/'], { timeout: longTimeout });
    });
    if (cancelled()) return giveUp();

    // Der Daemon des Jobs: eigenes Netz, eigener Speicher, erreichbar nur über den geteilten Socket.
    // Der Arbeitsordner liegt in beiden Containern am selben Pfad, damit `docker run -v "$PWD:..."` stimmt.
    const daemon = await docker(['run', '-d', ...label, '--name', `${base}-dind`, '--privileged', '--network', base,
      '--cpus', String(limits.dockerCpus), '--memory', limits.dockerMemory, '--pids-limit', String(PIDS_MAX), // gilt auch für die Container des Jobs darin
      '-v', `${base}-work:/home/runner/_work`, '-v', `${base}-sock:/sock`, '-v', `${base}-docker:/var/lib/docker`,
      '--entrypoint', 'sh', dind, '-c',
      `chown ${RUNNER_USER}:${RUNNER_USER} /home/runner/_work && exec dockerd-entrypoint.sh dockerd --host=${PAIR_SOCKET} --group=${DOCKER_GROUP}`]);
    if (daemon.code !== 0) return giveUp(new Error(`Docker-Daemon startet nicht: ${lastLine(daemon.stderr)}`));
    const ready = await waitForDaemon({ docker, sleep, container: `${base}-dind`, host: PAIR_SOCKET, cancelled });
    if (cancelled()) return giveUp();
    if (!ready) return giveUp(new Error('Docker-Daemon wurde nicht bereit'));

    if (settingsOf(pool.repo)?.cache) {
      pair.extras.push('-v', `${cacheVolume(pool.repo)}:/opt/rc-cache`, '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm');
      // Der Build-Dienst ist über seinen Socket zu erreichen, nur lesend eingehängt: So kann ein Job ihn nicht durch
      // einen eigenen ersetzen, den das nächste Paar dann ansprechen würde. Zugang über die Gruppe des Dienstes.
      pair.extras.push('-v', `${buildSocket(pool.repo)}:${SOCKET_DIR}:ro`, '--group-add', String(SERVICE_USER), '-e', 'RC_BUILDER=rc');
    }
    return pair;
  }

  async function serveOneJob(pool, slot) {
    Object.assign(slot, { state: SLOT.STARTING, job: null, finished: false, error: null, aborted: false, building: true });
    // Ein Paar, dessen Anmeldung zuletzt scheiterte, steht noch: Es wird wieder genommen statt eines aus der Reserve.
    let pair = slot.kept ?? null;
    slot.kept = null;
    try {
      if (!pair) {
        const entry = pool.reserve.shift();
        // Schon jetzt steht fest, mit welchen Limits das Paar gebaut ist oder wird: So erkennt „Runner neu aufbauen“
        // auch einen Platz im Aufbau als veraltet (siehe `staleSlots` in pools.js).
        slot.built = entry ? entry.built : limitRules.key(limitsOf(pool.repo));
        replenish(pool);
        if (entry) pair = await entry.promise;
        if (!pair) pair = await provision(pool, () => slot.aborted);
      }
    } finally { slot.building = false; }
    if (!pair) return;
    // Runner und Docker-Daemon eines Paars tragen dieselben Limits: die, mit denen es gebaut wurde.
    const limits = pair.limits;
    Object.assign(slot, { base: pair.base, name: runnerName(host, pair.id), copied: pair.copied, built: limitRules.key(limits) });
    if (slot.aborted) return;

    // Anmeldung für genau einen Job; danach verfällt sie von selbst. Scheitert sie (403, Anfragelimit, kein Netz), ist
    // das Paar unbenutzt: Der Platz behält es (`kept`) und meldet es nach der Pause erneut an (siehe `slotLoop`).
    let jit = null;
    try {
      jit = await gh(['api', '-X', 'POST', `repos/${pool.repo}/actions/runners/generate-jitconfig`],
        JSON.stringify({ name: slot.name, runner_group_id: 1, labels: ['self-hosted', 'Linux', 'X64'], work_folder: '_work' }));
    } catch (error) {
      // Meldet GitHub, dass es den Runner schon gibt (eine frühere Anmeldung kam dort an, die Antwort aber nicht),
      // hilft ein neuer Versuch mit demselben Namen nicht: Dann geht das Paar, und das nächste trägt einen neuen.
      if (!/already exists|HTTP 409|HTTP 422/i.test(error.message)) slot.kept = pair;
      throw error;
    }
    slot.runnerId = jit.runner?.id ?? null;
    if (slot.aborted) return;

    // Der Runner teilt das Netz des Daemons: Ports, die ein Job veröffentlicht, liegen für ihn auf localhost.
    // Die Anmeldung kommt über die Standardeingabe herein (nicht in die Einstellungen des Containers, die `docker inspect`
    // zeigt) und geht als ACTIONS_RUNNER_INPUT_JITCONFIG an den Runner, der sie liest und aus seiner Umgebung nimmt. So
    // steht sie weder in der Umgebung der Job-Schritte (ein `env` schriebe sie ins Protokoll bei GitHub) noch in einer
    // Befehlszeile, die `ps` zeigt. Lesbar bleibt sie in /proc des Runners selbst: Die Job-Schritte laufen unter demselben
    // Benutzer. Sie gilt aber nur für diesen einen Job.
    const start = [
      `if [ -n "$RC_BUILDER" ]; then docker buildx create --name "$RC_BUILDER" --driver remote --driver-opt default-load=true unix://${SOCKET} >/dev/null 2>&1 || unset RC_BUILDER; fi`,
      'read -r ACTIONS_RUNNER_INPUT_JITCONFIG; export ACTIONS_RUNNER_INPUT_JITCONFIG',
      'exec ./run.sh',
    ].join('; ');
    const follow = (line) => {
      const started = line.match(/Running job: (.+)$/);
      const finished = line.match(/Job (.+) completed with result: (\w+)/);
      if (/Listening for Jobs/.test(line) && slot.state === SLOT.STARTING) slot.state = SLOT.READY;
      if (started && slot.state !== SLOT.WORKING) {
        Object.assign(slot, { state: SLOT.WORKING, job: started[1], jobStartedAt: new Date().toISOString(), workflow: '', meter: metrics.meter() });
        log(`Job „${started[1]}“ läuft auf ${slot.name}`, pool.repo, 'run', { job: started[1], runner: slot.name });
        refreshRepo(pool.repo);
        timer(() => refreshRepo(pool.repo), REFRESH_AGAIN);
      }
      if (finished && !slot.finished) {
        if (slot.meter) metrics.recordJob(pool.repo, { job: finished[1], workflow: slot.workflow, result: finished[2], duration: Math.round((Date.now() - new Date(slot.jobStartedAt)) / SECOND), ...slot.meter.finish() });
        slot.meter = null;
        refreshRepo(pool.repo);
        Object.assign(slot, { finished: true, lastResult: `${finished[1]}: ${finished[2]}`, jobs: slot.jobs + 1 });
        log(`Job „${finished[1]}“ – ${resultText(finished[2])}`, pool.repo, resultKind(finished[2]), { job: finished[1] });
      }
    };
    let runner = await docker(['run', '--rm', '-i', '--label', mark, '--name', `${pair.base}-runner`, '--network', `container:${pair.base}-dind`,
      '--cpus', String(limits.runnerCpus), '--memory', limits.runnerMemory, '--pids-limit', String(PIDS_MAX),
      '-v', `${pair.base}-work:/home/runner/_work`, '-v', `${pair.base}-sock:/sock`, ...pair.extras,
      image, 'bash', '-c', start], {
      timeout: 0, // läuft, solange der Job läuft
      input: `${jit.encoded_jit_config}\n`,
      onLine: follow,
    });
    // Endet der Aufruf, während der Runner weiterläuft (Docker Desktop verlor kurz die Verbindung), wird weiter
    // mitgelesen, statt das Paar mitten im Job abzuräumen. Schon gelesene Zeilen wirken dabei kein zweites Mal.
    for (let attempt = 0; attempt < REATTACH_MAX && !slot.finished && !slot.aborted && await runnerAlive(pair.base); attempt += 1) {
      log(`Die Verbindung zu ${slot.name} riss ab; es wird weiter mitgelesen`, pool.repo, 'error');
      runner = await docker(['logs', '-f', `${pair.base}-runner`], { timeout: 0, onLine: follow });
    }
    // Nach einem Abbruch ist nichts mehr zu melden, außer der Runner hatte doch schon einen Job angenommen (der
    // Abbruch kam einen Augenblick zu spät); beim Beenden der App gilt auch das nicht.
    if (slot.aborted && (!slot.job || stopping())) return;
    if (!slot.job) throw new Error(`Runner endete ohne Job (${lastLine(runner.stderr) || `Code ${runner.code}`})`);
    if (!slot.finished) {
      // Der Runner endete mitten im Job, ohne ein Ergebnis zu melden. Dauer und Ergebnis stimmen dann nicht: Die
      // Messung wird verworfen statt als Verbrauch gemerkt.
      slot.meter = null;
      Object.assign(slot, { lastResult: `${slot.job}: ohne Ergebnis`, jobs: slot.jobs + 1 });
      log(`Job „${slot.job}“ endete ohne Ergebnis (${lastLine(runner.stderr) || `Code ${runner.code}`})`, pool.repo, 'error', { job: slot.job });
    }
    await learnImages(pool, slot);
  }

  async function runnerAlive(base) {
    const found = await docker(['inspect', '--format', '{{.State.Running}}', `${base}-runner`]);
    return found.code === 0 && found.stdout.trim() === 'true';
  }

  const slotWanted = (pool, slot) => !stopping() && !pool.removed && !slot.retired;

  async function slotLoop(pool, slot) {
    while (slotWanted(pool, slot)) {
      // Was beim Abräumen oder an der Reserve wirft, beendet den Platz nicht: Dem Pool fehlte sonst dauerhaft einer.
      await slotRound(pool, slot).catch(async (error) => {
        log(`Platz – ${error.message}`, pool.repo, 'error');
        await sleep(ROUND_PAUSE);
      });
    }
    slot.state = SLOT.OFF;
    pool.slots = pool.slots.filter((other) => other !== slot);
  }

  // Eine Runde des Platzes: warten, solange der Pool ruht, sonst einen Job bedienen und das Paar abräumen.
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
        Object.assign(slot, { error: error.message, state: SLOT.BROKEN });
        log(error.message, pool.repo, 'error');
        if (!slot.kept) await teardown(slot);
        // Ein Abbruch im Leerlauf (`abortIdle`) beendet die Pause sofort; der nächste Versuch setzt `aborted` erst
        // zurück, nachdem er hier gewirkt hat.
        for (let waited = 0; waited < BROKEN_PAUSE && slotWanted(pool, slot) && dockerReady() && !poolResting(pool) && !slot.aborted; waited += SECOND) await sleep(SECOND);
        // Ein behaltenes Paar geht, wenn der Platz nicht gleich weitermacht oder es nicht mehr zu den Limits passt.
        if (slot.aborted || !slotWanted(pool, slot) || !dockerReady() || poolResting(pool) || slot.built !== limitRules.key(limitsOf(pool.repo))) await teardown(slot);
        return;
      }
    }
    slot.state = SLOT.CLEANING;
    await teardown(slot);
  }

  // Ein Paar ohne Job vorzeitig beenden.
  async function abortIdle(slot) {
    if (busy(slot)) return;
    slot.aborted = true;
    // Der Runner-Container kann gerade erst entstehen: so lange entfernen, bis der Platz sein Paar abgeräumt hat.
    // Hat der Runner inzwischen doch einen Job angenommen, läuft der zu Ende.
    const { base } = slot;
    for (let attempt = 0; attempt < ABORT_TRIES && base && slot.base === base && slot.state !== SLOT.WORKING; attempt += 1) {
      await docker(['rm', '-f', `${base}-runner`]);
      if (slot.base === base) await sleep(ABORT_PAUSE);
    }
    // Der Abbruch gilt nicht mehr: Sonst würden die Abbilder dieses Jobs nicht gelernt.
    if (slot.state === SLOT.WORKING) slot.aborted = false;
  }

  // Ein Paar sofort abbauen, auch mitten im Job (beim Beenden von RunClub). Ein Platz, der sein Paar gerade erst
  // bekommt, sieht den Abbruch und räumt es selbst ab.
  function abort(slot) {
    slot.aborted = true;
    return teardown(slot);
  }

  return { livePairs, provision, removePair, teardown, abort, serveOneJob, slotLoop, abortIdle, slotWanted };
}

// Der Platz merkt sich den Workflow seines Jobs: Am Ende nennt der Runner nur den Jobnamen (siehe metrics.js).
// `jobs`: die laufenden Jobs des Repos, wie GitHub sie meldet ({ runner, workflow }; siehe remote.js).
function noteWorkflows(pool, jobs) {
  for (const slot of pool?.slots ?? []) {
    if (slot.state === SLOT.WORKING) slot.workflow = jobs.find((job) => job.runner === slot.name)?.workflow || slot.workflow;
  }
}

// Die Anmeldungen der freien Plätze aller Pools: `[{ repo, runnerId }]`. Sie lassen sich bei GitHub zurücknehmen,
// ohne dass ein Job verloren geht.
// Die Namen der Runner, deren Paar steht (auch eines, das sich gerade anmeldet): Diese bleiben bei GitHub eingetragen.
const pairNames = (pool) => new Set(pool.slots.filter((slot) => slot.base).map((slot) => slot.name));

const idleRegistrations = (pools) => [...pools].flatMap((pool) => pool.slots.filter((slot) => slot.runnerId && !slot.job).map((slot) => ({ repo: slot.repo, runnerId: slot.runnerId })));

module.exports = { createSlots, noteWorkflows, pairNames, idleRegistrations };
