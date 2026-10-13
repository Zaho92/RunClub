// Lebenslauf eines Platzes: Ein Platz eines Pools bedient Job um Job, jeden auf einem frischen Paar aus
// Runner-Container und eigenem Docker-Daemon. Hier liegt, was mit einem einzelnen Paar geschieht: aufbauen
// (`provision`), anmelden und einen Job bedienen (`serveOneJob`), abräumen (`teardown`, `removePair`), im Leerlauf
// abbrechen (`abortIdle`) und die Schleife, die das wiederholt (`slotLoop`).
//
// Was zum Pool im Ganzen gehört, bleibt in backend.js und kommt als Funktion herein: die Reserve (`replenish`,
// `discardReserve`), die Vorlage (`withSeed`, `learnImages`), die Namen der Caches und des Build-Dienstes, die
// Einstellungen und Limits eines Repos. Zustand, den beide Seiten brauchen (`stopping`, `linuxReady`,
// `poolResting`), wird bei jedem Gebrauch frisch erfragt.
//
//   Pool    { repo, slots, reserve, seeded, removed, … }   (angelegt in `startPool` in backend.js)
//   Platz   { repo, state, jobs, base, name, runnerId, job, aborted, building, retired, … }
//   Paar    { id, base, copied, extras, limits }; `base` ist der Name, den Container, Volumes und Netz tragen
//
// Zustände eines Platzes: startet, bereit, arbeitet, räumt auf, gestört, wartet, pausiert, wartet auf Docker, aus.

const crypto = require('node:crypto');
const { lastLine } = require('./run');
const { slug } = require('./images');
const { createNetwork } = require('./subnets');
const { resultKind, resultText } = require('./journal');
const limitRules = require('./limits');

//   docker(args, options)   wie `run('docker', …)`: liefert `{ code, stdout, stderr }` und wirft nie
//   gh(args, body)          Aufruf der GitHub-API, liefert die Antwort als Objekt oder wirft
//   log(text, repo, kind, about), sleep(ms), timer (wie `setTimeout`), newId() (Kennung eines neuen Paars)
//   host, mark, image, dind Name des Rechners, Kennzeichen der eigenen Container, Abbild des Runners und des Daemons
//   longTimeout             Zeitgrenze für das Kopieren der Vorlage
//   metrics                 `{ meter(), recordJob(repo, record) }` (siehe metrics.js)
//   settingsOf(repo), limitsOf(repo), seedVolume(repo), cacheVolume(repo), buildService(repo)
//   stopping(), linuxReady(), poolResting(pool)
//   withSeed(repo, exclusive, work), learnImages(pool, slot), replenish(pool), discardReserve(pool)
//   refreshRepo(repo)       den Stand des Repos bei GitHub neu holen
//   forgetStats(name)       die Messwerte eines Containers verwerfen
function createSlots({
  docker, gh, log, sleep, timer = setTimeout, newId = () => crypto.randomBytes(3).toString('hex'),
  host, mark, image, dind, longTimeout, metrics,
  settingsOf, limitsOf, seedVolume, cacheVolume, buildService,
  stopping, linuxReady, poolResting,
  withSeed, learnImages, replenish, discardReserve, refreshRepo, forgetStats,
}) {
  const livePairs = new Map(); // Name des Paars -> Repo, vom Beginn des Aufbaus bis zum Abräumen

  // Entfernt ein Paar: Container, Volumes, Netz und – wenn kein Job darauf lief – die Anmeldung bei GitHub.
  async function removePair(repo, base, runnerId) {
    await docker(['rm', '-f', '-v', `${base}-runner`, `${base}-dind`, `${base}-seed`]);
    await docker(['network', 'disconnect', '-f', base, buildService(repo)]);
    await docker(['volume', 'rm', '-f', `${base}-work`, `${base}-sock`, `${base}-docker`]);
    await docker(['network', 'rm', base]);
    for (const name of [`${base}-runner`, `${base}-dind`]) forgetStats(name);
    livePairs.delete(base);
    if (runnerId) {
      // 404 heißt: schon weg (der Runner meldet sich nach seinem Job selbst ab). Alles andere bleibt bei GitHub als
      // toter Eintrag stehen, bis der nächste Start aufräumt, und gehört deshalb ins Protokoll.
      try { await gh(['api', '-X', 'DELETE', `repos/${repo}/actions/runners/${runnerId}`]); } catch (error) {
        if (!/HTTP 404/.test(error.message)) log(`Runner ließ sich bei GitHub nicht abmelden – ${error.message}`, repo, 'error');
      }
    }
  }

  async function teardown(slot) {
    if (!slot.base) return;
    const { base, runnerId, job } = slot;
    await removePair(slot.repo, base, job ? null : runnerId);
    slot.base = null;
    slot.runnerId = null;
  }

  // Baut ein Paar bis kurz vor die Anmeldung: Netz, Volumes, Kopie der Vorlage, laufender Docker-Daemon.
  // Das ist der lange Teil. Er geschieht deshalb im Voraus, als Reserve des Pools
  // (`replenish` in backend.js); der Wechsel zum nächsten Job kostet dann nur noch Anmeldung und Start des Runners.
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
      '--cpus', String(limits.dockerCpus), '--memory', limits.dockerMemory,
      '-v', `${base}-work:/home/runner/_work`, '-v', `${base}-sock:/sock`, '-v', `${base}-docker:/var/lib/docker`,
      '--entrypoint', 'sh', dind, '-c',
      'chown 1001:1001 /home/runner/_work && exec dockerd-entrypoint.sh dockerd --host=unix:///sock/docker.sock --group=123']);
    if (daemon.code !== 0) return giveUp(new Error(`Docker-Daemon startet nicht: ${lastLine(daemon.stderr)}`));
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready && !cancelled(); attempt += 1) {
      ready = (await docker(['exec', `${base}-dind`, 'docker', '-H', 'unix:///sock/docker.sock', 'info', '--format', 'ok'])).code === 0;
      if (!ready) await sleep(1000);
    }
    if (cancelled()) return giveUp();
    if (!ready) return giveUp(new Error('Docker-Daemon wurde nicht bereit'));

    if (settingsOf(pool.repo)?.cache) {
      pair.extras.push('-v', `${cacheVolume(pool.repo)}:/opt/rc-cache`, '-e', 'NUGET_PACKAGES=/opt/rc-cache/nuget', '-e', 'npm_config_cache=/opt/rc-cache/npm');
      // Der Build-Dienst hängt im Netz des Paars und heißt dort `buildkit`.
      const joined = await docker(['network', 'connect', '--alias', 'buildkit', base, buildService(pool.repo)]);
      if (joined.code === 0) pair.extras.push('-e', 'RC_BUILDER=rc');
    }
    return pair;
  }

  async function serveOneJob(pool, slot) {
    Object.assign(slot, { state: 'startet', job: null, finished: false, error: null, aborted: false, building: true });
    let pair = null;
    try {
      const entry = pool.reserve.shift();
      replenish(pool);
      if (entry) pair = await entry.promise;
      if (!pair) pair = await provision(pool, () => slot.aborted);
    } finally { slot.building = false; }
    if (!pair) return;
    // Runner und Docker-Daemon eines Paars tragen dieselben Limits: die, mit denen es gebaut wurde.
    const limits = pair.limits;
    Object.assign(slot, { base: pair.base, name: `${host}-linux-${pair.id}`, copied: pair.copied, built: limitRules.key(limits) });
    if (slot.aborted) return;

    // Anmeldung für genau einen Job; danach verfällt sie von selbst.
    const jit = await gh(['api', '-X', 'POST', `repos/${pool.repo}/actions/runners/generate-jitconfig`],
      JSON.stringify({ name: slot.name, runner_group_id: 1, labels: ['self-hosted', 'Linux', 'X64'], work_folder: '_work' }));
    slot.runnerId = jit.runner?.id ?? null;
    if (slot.aborted) return;

    // Der Runner teilt das Netz des Daemons: Ports, die ein Job veröffentlicht, liegen für ihn auf localhost.
    const start = 'if [ -n "$RC_BUILDER" ]; then docker buildx create --name "$RC_BUILDER" --driver remote --driver-opt default-load=true tcp://buildkit:1234 >/dev/null 2>&1 || unset RC_BUILDER; fi; exec ./run.sh --jitconfig "$JITCONFIG"';
    const runner = await docker(['run', '--rm', '--label', mark, '--name', `${pair.base}-runner`, '--network', `container:${pair.base}-dind`,
      '--cpus', String(limits.runnerCpus), '--memory', limits.runnerMemory,
      '-v', `${pair.base}-work:/home/runner/_work`, '-v', `${pair.base}-sock:/sock`, ...pair.extras,
      '-e', 'JITCONFIG', image, 'bash', '-c', start], {
      timeout: 0, // läuft, solange der Job läuft
      env: { JITCONFIG: jit.encoded_jit_config },
      onLine: (line) => {
        const started = line.match(/Running job: (.+)$/);
        const finished = line.match(/Job (.+) completed with result: (\w+)/);
        if (/Listening for Jobs/.test(line) && slot.state === 'startet') slot.state = 'bereit';
        if (started && slot.state !== 'arbeitet') {
          Object.assign(slot, { state: 'arbeitet', job: started[1], jobStartedAt: new Date().toISOString(), workflow: '', meter: metrics.meter() });
          log(`Job „${started[1]}“ läuft auf ${slot.name}`, pool.repo, 'run', { job: started[1], runner: slot.name });
          refreshRepo(pool.repo);
          timer(() => refreshRepo(pool.repo), 4000);
        }
        if (finished && !slot.finished) {
          if (slot.meter) metrics.recordJob(pool.repo, { job: finished[1], workflow: slot.workflow, result: finished[2], duration: Math.round((Date.now() - new Date(slot.jobStartedAt)) / 1000), ...slot.meter.finish() });
          slot.meter = null;
          refreshRepo(pool.repo);
          Object.assign(slot, { finished: true, lastResult: `${finished[1]}: ${finished[2]}`, jobs: slot.jobs + 1 });
          log(`Job „${finished[1]}“ – ${resultText(finished[2])}`, pool.repo, resultKind(finished[2]), { job: finished[1] });
        }
      },
    });
    if (slot.aborted) return;
    if (!slot.job) throw new Error(`Runner endete ohne Job (${lastLine(runner.stderr) || `Code ${runner.code}`})`);
    await learnImages(pool, slot);
  }

  const slotWanted = (pool, slot) => !stopping() && !pool.removed && !slot.retired;

  async function slotLoop(pool, slot) {
    while (slotWanted(pool, slot)) {
      if (!linuxReady() || poolResting(pool)) {
        slot.state = !linuxReady() ? 'wartet auf Docker' : settingsOf(pool.repo)?.paused ? 'pausiert' : 'wartet';
        await discardReserve(pool);
        await sleep(1000);
        continue;
      }
      try {
        await serveOneJob(pool, slot);
      } catch (error) {
        if (!slot.aborted) {
          Object.assign(slot, { error: error.message, state: 'gestört' });
          log(error.message, pool.repo, 'error');
          await teardown(slot);
          for (let waited = 0; waited < 60 && slotWanted(pool, slot) && !poolResting(pool); waited += 1) await sleep(1000);
          continue;
        }
      }
      slot.state = 'räumt auf';
      await teardown(slot);
    }
    slot.state = 'aus';
    pool.slots = pool.slots.filter((other) => other !== slot);
  }

  // Ein Paar ohne Job vorzeitig beenden.
  async function abortIdle(slot) {
    if (slot.state === 'arbeitet' || slot.state === 'räumt auf') return;
    slot.aborted = true;
    // Der Runner-Container kann gerade erst entstehen: so lange entfernen, bis der Platz sein Paar abgeräumt hat.
    // Hat der Runner inzwischen doch einen Job angenommen, läuft der zu Ende.
    const { base } = slot;
    for (let attempt = 0; attempt < 60 && base && slot.base === base && slot.state !== 'arbeitet'; attempt += 1) {
      await docker(['rm', '-f', `${base}-runner`]);
      if (slot.base === base) await sleep(1000);
    }
    // Der Abbruch gilt nicht mehr: Sonst würden die Abbilder dieses Jobs nicht gelernt.
    if (slot.state === 'arbeitet') slot.aborted = false;
  }

  return { livePairs, provision, removePair, teardown, serveOneJob, slotLoop, abortIdle, slotWanted };
}

module.exports = { createSlots };
