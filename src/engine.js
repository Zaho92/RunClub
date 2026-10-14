// Wo Docker läuft, an einer Stelle. Heute ist es Docker Desktop: Die Windows-CLI `docker` spricht mit dessen Daemon,
// und die VM, in der die Container laufen, ist die WSL-Distro `docker-desktop`. Eine andere Engine (etwa eine eigene
// Docker Engine in einer eigenen WSL-Distro, siehe „Docker Engine statt Docker Desktop“ in TODO.md) braucht nur
// andere Werte hier; der Rest von RunClub ruft Docker ausschließlich über dieses Modul auf.
//
//   RUNCLUB_DOCKER_HOST    Endpunkt des Daemons für die CLI (wird ihr als DOCKER_HOST mitgegeben), etwa
//                          `tcp://127.0.0.1:2376` oder `npipe:////./pipe/runclub`. Ohne Angabe gilt, was die CLI
//                          ohnehin nimmt (bei Docker Desktop dessen Daemon).
//   RUNCLUB_DOCKER_DISTRO  WSL-Distro, in der der Daemon läuft; dort wird die Belegung der VM gemessen (vmmemory.js).
//                          Ohne Angabe `docker-desktop`; leer gesetzt: keine Messung.

const DESKTOP_DISTRO = 'docker-desktop';

// Liest die Engine aus der Umgebung. { host (oder null), distro (oder null), desktop (ob es Docker Desktop ist) }
function engineFrom(env = process.env) {
  const host = String(env.RUNCLUB_DOCKER_HOST ?? '').trim() || null;
  const distro = env.RUNCLUB_DOCKER_DISTRO === undefined ? DESKTOP_DISTRO : String(env.RUNCLUB_DOCKER_DISTRO).trim() || null;
  return { host, distro, desktop: !host && distro === DESKTOP_DISTRO };
}

// `run` wie in run.js; `timeout` gilt für gewöhnliche Aufrufe, wer länger braucht, nennt seine Grenze selbst.
//   docker(args, options)   wie `run('docker', …)`: liefert `{ code, stdout, stderr }` und wirft nie
//   dockerList(args)        dasselbe, liefert die Zeilen der Ausgabe
//   inVm(script, options)   ein Shell-Skript in der VM; ohne Distro ein Ergebnis ohne Ausgabe (`code` -1)
//   unreachable             die Meldung, wenn Docker nicht antwortet
function createEngine({ run, timeout, host = null, distro = DESKTOP_DISTRO, desktop = true }) {
  const env = host ? { DOCKER_HOST: host } : undefined;
  const docker = (args, options) => run('docker', args, { timeout, ...options, ...(env ? { env } : {}) });
  const dockerList = async (args) => (await docker(args)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const inVm = (script, options) => (distro ? run('wsl', ['-d', distro, 'sh', '-c', script], options)
    : Promise.resolve({ code: -1, stdout: '', stderr: 'keine Distro für die Messung', timedOut: false }));
  const unreachable = desktop ? 'Docker ist nicht erreichbar – läuft Docker Desktop?'
    : `Docker ist nicht erreichbar – läuft der Daemon${host ? ` unter ${host}` : ''}${distro ? ` in der WSL-Distro ${distro}` : ''}?`;
  return { docker, dockerList, inVm, unreachable, distro };
}

module.exports = { engineFrom, createEngine, DESKTOP_DISTRO };
