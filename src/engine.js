// Wo Docker läuft, an einer Stelle. Heute ist es Docker Desktop: Die Windows-CLI `docker` spricht mit dessen Daemon,
// und die VM, in der die Container laufen, ist die WSL-Distro `docker-desktop`. Eine andere Engine (etwa eine eigene
// Docker Engine in einer eigenen WSL-Distro, siehe „Docker Engine statt Docker Desktop“ in TODO.md) braucht nur
// andere Werte hier; der Rest von RunClub ruft Docker ausschließlich über dieses Modul auf.
//
//   RUNCLUB_DOCKER_HOST    Endpunkt des Daemons für die CLI (geht ihr als DOCKER_HOST mit), am besten eine Named Pipe
//                          (`npipe:////./pipe/runclub`, nur für den eigenen Benutzer) oder `ssh://…`. Ein `tcp://`
//                          ohne TLS gibt jedem, der den Port erreicht, die volle Gewalt über den Daemon, auch einem
//                          Job aus seinem Container heraus: dann nur mit RUNCLUB_DOCKER_CERTS.
//   RUNCLUB_DOCKER_CERTS   Ordner mit `ca.pem`, `cert.pem`, `key.pem` für einen `tcp://`-Endpunkt mit TLS (geht als
//                          DOCKER_CERT_PATH mit DOCKER_TLS_VERIFY=1 an die CLI). Gilt nur mit RUNCLUB_DOCKER_HOST; ohne
//                          ihn gehen auch TLS-Einstellungen aus der Umgebung des Benutzers nicht an den eigenen Endpunkt.
//   RUNCLUB_DOCKER_DISTRO  WSL-Distro, in der der Daemon läuft; dort wird die Belegung der VM gemessen (vmmemory.js).
//                          Ohne Angabe bei Docker Desktop `docker-desktop`, bei eigenem Endpunkt keine; leer: keine.
//
// Ohne RUNCLUB_DOCKER_HOST gilt, was die CLI ohnehin nimmt: ein DOCKER_HOST oder DOCKER_CONTEXT aus der Umgebung des
// Benutzers oder sein mit `docker context use` gewählter Kontext, sonst Docker Desktop. RunClub setzt das nicht außer
// Kraft; wer dort etwas anderes eingestellt hat, betreibt RunClub auf jenem Daemon.

const http = require('node:http');
const { SECOND } = require('./units');

const DESKTOP_DISTRO = 'docker-desktop';
// Docker Desktop kann seinen Daemon ohne TLS auf diesem Port freigeben (Settings → General).
const EXPOSED_PING = 'http://127.0.0.1:2375/_ping';
const PROBE_TIMEOUT = 2 * SECOND;

// Liest die Engine aus der Umgebung: { host, certs, distro }, jeweils oder null.
function engineFrom(env = process.env) {
  const host = String(env.RUNCLUB_DOCKER_HOST ?? '').trim() || null;
  const certs = (host && String(env.RUNCLUB_DOCKER_CERTS ?? '').trim()) || null;
  const named = env.RUNCLUB_DOCKER_DISTRO;
  const distro = named === undefined ? (host ? null : DESKTOP_DISTRO) : String(named).trim() || null;
  return { host, certs, distro };
}

//   run(command, args, options)   wie in run.js
//   timeout                       gilt für gewöhnliche Aufrufe; wer länger braucht, nennt seine Grenze selbst
//   host, certs, distro           wie aus `engineFrom`
// Liefert:
//   docker(args, options)   wie `run('docker', …)`: `{ code, stdout, stderr }`, wirft nie. Eine `env` des Aufrufers
//                           bleibt; was die Engine setzt, geht vor, damit kein Aufruf auf einen anderen Daemon zeigt.
//   dockerList(args)        dasselbe, liefert die Zeilen der Ausgabe
//   inVm(script, options)   ein festes Shell-Skript in der VM (`wsl --exec`, ohne die Shell der Distro dazwischen);
//                           ohne Distro ein Ergebnis ohne Ausgabe (`code` -1). Nie Daten von außen hineinschreiben.
//   unreachableText         die Meldung, wenn Docker nicht antwortet
//   exposedDaemon()         ob Docker Desktop seinen Daemon ohne Schutz auf tcp://localhost:2375 freigibt (Promise)
// `get` wie `http.get`; in Tests steuerbar.
function createEngine({ run, timeout, host = null, certs = null, distro = host ? null : DESKTOP_DISTRO, get = http.get }) {
  const desktop = !host && distro === DESKTOP_DISTRO;
  // Mit eigenem Endpunkt gelten nur dessen TLS-Angaben; ein leerer Wert zählt für die CLI wie ein fehlender.
  const own = host ? { DOCKER_HOST: host, DOCKER_TLS_VERIFY: certs ? '1' : '', DOCKER_CERT_PATH: certs ?? '' } : {};
  const docker = (args, options = {}) => run('docker', args, { timeout, ...options, ...(Object.keys(own).length ? { env: { ...options.env, ...own } } : {}) });
  const dockerList = async (args) => (await docker(args)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const inVm = (script, options) => (distro ? run('wsl', ['-d', distro, '--exec', 'sh', '-c', script], options)
    : Promise.resolve({ code: -1, stdout: '', stderr: 'keine Distro für die Messung', timedOut: false }));
  const unreachableText = desktop ? 'Docker ist nicht erreichbar – läuft Docker Desktop?'
    : `Docker ist nicht erreichbar – läuft der Daemon${host ? ` unter ${host}` : ''}${distro ? ` in der WSL-Distro ${distro}` : ''}?`;
  // Ein Daemon ohne Schutz auf dem Windows-localhost ist aus jedem Container erreichbar (host.docker.internal): Ein Job
  // steuerte damit ganz Docker, ohne erst ausbrechen zu müssen. Nur bei Docker Desktop gibt es diesen Schalter.
  const exposedDaemon = () => new Promise((resolve) => {
    if (!desktop) { resolve(false); return; }
    const request = get(EXPOSED_PING, { timeout: PROBE_TIMEOUT }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body.trim() === 'OK'));
      response.on('error', () => resolve(false));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false)); // nichts lauscht dort: so soll es sein
  });
  return { docker, dockerList, inVm, unreachableText, exposedDaemon };
}

module.exports = { engineFrom, createEngine, DESKTOP_DISTRO, EXPOSED_PING };
