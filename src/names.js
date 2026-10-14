// Wie die Abbilder heißen, die RunClub nutzt, und wie es seine Container, Volumes und Netze nennt.
//
// Das Kennzeichen (`mark`) trägt den Datenordner in sich, damit eine zweite Instanz (zum Ausprobieren, mit eigenem
// Datenordner) beim Aufräumen nicht die Paare der ersten entfernt. Caches, Vorlage und Build-Dienst heißen nach dem
// Repo; eine zweite Instanz (anderer Port) hängt ihre Kennung an, damit sie der ersten nichts wegnimmt, wenn beide
// ein Repo gleichen Namens bedienen.

const crypto = require('node:crypto');
const path = require('node:path');
const { slug } = require('./images');

const DEFAULT_PORT = 8770;
const IMAGE = 'runclub-runner:latest';
// Docker-Daemon und Build-Dienst sind per Digest festgenagelt: Ein bewegliches Etikett (`dind`, `latest`) kann von heute
// auf morgen etwas anderes sein. Anheben: das neue Abbild laden (`docker pull docker:dind`,
// `docker pull moby/buildkit:rootless`), die Version darin ablesen (`docker --version`, `buildkitd --version`) und mit
// dem Digest aus `docker image inspect --format '{{index .RepoDigests 0}}'` hier eintragen. Das Runner-Abbild selbst
// (linux/Dockerfile) folgt bewusst dem neuesten Stand: GitHub weist zu alte Runner ab.
const DIND = 'docker:29.9.0-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470';
const BUILDKIT = 'moby/buildkit:v0.34.0-rootless@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855';

function createNames({ dataDir, port }) {
  const instance = crypto.createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 10);
  const suffix = port === DEFAULT_PORT ? '' : `-${instance}`;
  const named = (kind) => (repo) => `rc-${kind}-${slug(repo)}${suffix}`;
  return {
    mark: `runclub.runner=${instance}`, // Paare: ihre Container, Volumes und Netze
    serviceMark: `runclub.service=${instance}`, // Build-Dienste und ihre Netze (siehe caches.js)
    cacheVolume: named('cache'),
    seedVolume: named('seed'),
    buildVolume: named('build'),
    buildSocket: named('buildsock'),
    buildService: named('buildkit'),
    buildNetwork: named('buildnet'),
  };
}

module.exports = { createNames, DEFAULT_PORT, IMAGE, DIND, BUILDKIT };
