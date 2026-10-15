// Der Docker-Daemon in einem Container: der Daemon eines Paars (slots.js) und der Lade-Daemon der Vorlage (seed.js).
// Beide laufen ohne Rechte aus dem Abbild `DAEMON_IMAGE` (linux/dind/Dockerfile): als Benutzer RUNNER_USER, in eigenen
// Namensräumen (rootless), ohne `--privileged`. Ein Job, der aus seinem Container ausbricht, landet so nur in diesem
// Container als gewöhnlicher Benutzer, nicht in der Docker-VM. Dasselbe Abbild dient als Werkzeug für Volumes
// (`asRoot`). Beide Daemons brauchen nach dem Start einen Augenblick, bis sie antworten.

const { SECOND } = require('./units');

const DAEMON_IMAGE = 'runclub-dind:latest';
const RUNNER_USER = 1001; // der Benutzer `runner` im Runner-Abbild; der Daemon läuft unter demselben
// Der Daemon lauscht nur auf diesem Socket, den der Runner im selben Pfad einhängt (DOCKER_HOST in linux/Dockerfile).
const PAIR_SOCKET = 'unix:///sock/docker.sock';
const DATA_ROOT = '/home/rootless/.local/share/docker'; // hier legt der Daemon ohne Rechte Abbilder und Container ab
// Was ein Daemon ohne Rechte braucht: ein TUN-Gerät für sein Netz, eigene Namensräume und ein eigenes /proc, die Dockers
// Vorgaben sonst verbieten (siehe „Rootless mode“ in der Doku von Docker).
const DAEMON_FLAGS = ['--device', '/dev/net/tun', '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--security-opt', 'systempaths=unconfined'];
const DAEMON_COMMAND = ['dockerd', `--host=${PAIR_SOCKET}`];
// Ein Werkzeug für Volumes (Rechte setzen, kopieren, messen): das Abbild des Daemons mit einem Skript als root – root
// nur in seinem eigenen Container. Dahinter folgt das Skript.
const asRoot = (image) => ['--user', '0', '--entrypoint', 'sh', image, '-c'];
const READY_TRIES = 40;
const DAEMON_POLL = SECOND; // Abstand der Fragen, bis ein Daemon antwortet
const PROBE_TIMEOUT = 20 * SECOND; // so lange darf eine Frage an einen Daemon dauern (auch an Docker selbst, siehe dockerwatch.js)

// Fragt den Daemon im Container `container` (über `host`, sonst über seinen gewöhnlichen Socket), bis er antwortet:
// höchstens READY_TRIES Mal im Abstand von DAEMON_POLL; `cancelled()` bricht vorher ab. Liefert, ob er antwortet.
async function waitForDaemon({ docker, sleep, container, host = null, cancelled = () => false }) {
  for (let attempt = 0; attempt < READY_TRIES && !cancelled(); attempt += 1) {
    const probe = await docker(['exec', container, 'docker', ...(host ? ['-H', host] : []), 'info', '--format', 'ok'], { timeout: PROBE_TIMEOUT });
    if (probe.code === 0) return true;
    await sleep(DAEMON_POLL);
  }
  return false;
}

module.exports = { waitForDaemon, DAEMON_IMAGE, RUNNER_USER, PAIR_SOCKET, DATA_ROOT, DAEMON_FLAGS, DAEMON_COMMAND, asRoot, READY_TRIES, DAEMON_POLL, PROBE_TIMEOUT };
