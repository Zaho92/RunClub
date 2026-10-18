// Where Docker runs, in one place. Today it is Docker Desktop: the Windows CLI `docker` talks to its daemon,
// and the VM in which the containers run is the WSL distro `docker-desktop`. Another engine (such as a separate
// Docker Engine in its own WSL distro, see issue #3) only needs
// other values here; the rest of RunClub calls Docker exclusively through this module.
//
//   RUNCLUB_DOCKER_HOST    endpoint of the daemon for the CLI (passed to it as DOCKER_HOST), ideally a named pipe
//                          (`npipe:////./pipe/runclub`, only for your own user) or `ssh://…`. A `tcp://`
//                          without TLS gives anyone who reaches the port full control over the daemon, a job
//                          from inside its container too: so only with RUNCLUB_DOCKER_CERTS.
//   RUNCLUB_DOCKER_CERTS   folder with `ca.pem`, `cert.pem`, `key.pem` for a `tcp://` endpoint with TLS (passed as
//                          DOCKER_CERT_PATH with DOCKER_TLS_VERIFY=1 to the CLI). Only applies with RUNCLUB_DOCKER_HOST;
//                          without it, TLS settings from the user's environment do not go to your own endpoint either.
//   RUNCLUB_DOCKER_DISTRO  WSL distro in which the daemon runs; the VM's usage is measured there (vmmemory.js).
//                          If not given, `docker-desktop` with Docker Desktop, none with your own endpoint; empty: none.
//
// Without RUNCLUB_DOCKER_HOST, whatever the CLI takes anyway applies: a DOCKER_HOST or DOCKER_CONTEXT from the user's
// environment or the context chosen with `docker context use`, otherwise Docker Desktop. RunClub does not override
// that; whoever has set something else there runs RunClub on that daemon.

const http = require('node:http');
const { SECOND } = require('./units');
const { msg } = require('./messages');

const DESKTOP_DISTRO = 'docker-desktop';
// Docker Desktop can expose its daemon without TLS on this port (Settings → General).
const EXPOSED_PING = 'http://127.0.0.1:2375/_ping';
const PROBE_TIMEOUT = 2 * SECOND;
const PING_MAX = 100; // characters; a daemon answers with "OK"

// Reads the engine from the environment: { host, certs, distro }, each or null.
function engineFrom(env = process.env) {
  const host = String(env.RUNCLUB_DOCKER_HOST ?? '').trim() || null;
  const certs = (host && String(env.RUNCLUB_DOCKER_CERTS ?? '').trim()) || null;
  const named = env.RUNCLUB_DOCKER_DISTRO;
  const distro = named === undefined ? (host ? null : DESKTOP_DISTRO) : String(named).trim() || null;
  return { host, certs, distro };
}

//   run(command, args, options)   as in run.js
//   timeout                       applies to ordinary calls; whoever needs longer names their own limit
//   host, certs, distro           as from `engineFrom`
// Returns:
//   docker(args, options)   like `run('docker', …)`: `{ code, stdout, stderr }`, never throws. An `env` of the caller
//                           stays; what the engine sets takes precedence, so that no call points to another daemon.
//   dockerList(args)        the same, returns the lines of the output
//   inVm(script, options)   a fixed shell script in the VM (`wsl --exec`, without the distro's shell in between);
//                           without a distro a result without output (`code` -1). Never write data from outside into it.
//   unreachable             the message when Docker does not answer (see messages.js)
//   exposure()              a warning (message) if the daemon can be reached unprotected, otherwise null (Promise)
//   desktop                 it is Docker Desktop (no own endpoint, Docker Desktop's distro)
// `get` like `http.get`; controllable in tests.
function createEngine({ run, timeout, host = null, certs = null, distro = host ? null : DESKTOP_DISTRO, get = http.get }) {
  const desktop = !host && distro === DESKTOP_DISTRO;
  // With your own endpoint only its TLS settings apply; an empty value counts for the CLI like a missing one.
  const own = host ? { DOCKER_HOST: host, DOCKER_TLS_VERIFY: certs ? '1' : '', DOCKER_CERT_PATH: certs ?? '' } : {};
  const docker = (args, options = {}) => run('docker', args, { timeout, ...options, ...(Object.keys(own).length ? { env: { ...options.env, ...own } } : {}) });
  const dockerList = async (args) => (await docker(args)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const inVm = (script, options) => (distro ? run('wsl', ['-d', distro, '--exec', 'sh', '-c', script], options)
    : Promise.resolve({ code: -1, stdout: '', stderr: 'no distro to measure in', timedOut: false }));
  const unreachable = desktop ? msg('m_dockerUnreachableDesktop')
    : host && distro ? msg('m_dockerUnreachableBoth', host, distro) : host ? msg('m_dockerUnreachableHost', host) : distro ? msg('m_dockerUnreachableDistro', distro) : msg('m_dockerUnreachable');
  // An unprotected daemon on the Windows localhost can be reached from every container (host.docker.internal): a job
  // would control all of Docker with it, without having to break out first. Docker Desktop has a switch for that; your
  // own endpoint over `tcp://` without certificates is that from the start.
  const desktopExposed = () => new Promise((resolve) => {
    const request = get(EXPOSED_PING, { timeout: PROBE_TIMEOUT }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; if (body.length > PING_MAX) request.destroy(); });
      response.on('end', () => resolve(body.trim() === 'OK'));
      response.on('error', () => resolve(false));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false)); // nothing listens there: that is how it should be
  });
  async function exposure() {
    if (host && /^tcp:\/\//i.test(host) && !certs) return msg('m_exposedTcp', host);
    if (desktop && await desktopExposed()) return msg('m_exposedDesktop');
    return null;
  }
  return { docker, dockerList, inVm, unreachable, exposure, desktop };
}

module.exports = { engineFrom, createEngine, DESKTOP_DISTRO, EXPOSED_PING };
