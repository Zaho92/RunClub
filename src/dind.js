// Der Docker-Daemon in einem Container (`docker:dind`): der Daemon eines Paars (slots.js) und der Lade-Daemon der
// Vorlage (seed.js). Beide brauchen nach dem Start einen Augenblick, bis sie antworten.

const { SECOND } = require('./units');

// Der Daemon eines Paars lauscht nur auf diesem Socket, den der Runner im selben Pfad einhängt (linux/Dockerfile).
const PAIR_SOCKET = 'unix:///sock/docker.sock';
const DOCKER_GROUP = 123; // die Gruppe `docker` im Runner-Abbild: Sie darf an den Socket
const READY_TRIES = 40;
const READY_PAUSE = SECOND;
const PROBE_TIMEOUT = 20 * SECOND;

// Fragt den Daemon im Container `container` (über `host`, sonst über seinen gewöhnlichen Socket), bis er antwortet:
// höchstens READY_TRIES Mal im Abstand von READY_PAUSE; `cancelled()` bricht vorher ab. Liefert, ob er antwortet.
async function waitForDaemon({ docker, sleep, container, host = null, cancelled = () => false }) {
  for (let attempt = 0; attempt < READY_TRIES && !cancelled(); attempt += 1) {
    const probe = await docker(['exec', container, 'docker', ...(host ? ['-H', host] : []), 'info', '--format', 'ok'], { timeout: PROBE_TIMEOUT });
    if (probe.code === 0) return true;
    await sleep(READY_PAUSE);
  }
  return false;
}

module.exports = { waitForDaemon, PAIR_SOCKET, DOCKER_GROUP, READY_TRIES, READY_PAUSE, PROBE_TIMEOUT };
