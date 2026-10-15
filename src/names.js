// Wie die Abbilder heißen, die RunClub nutzt, und wie es seine Container, Volumes und Netze nennt.
//
// Das Kennzeichen (`mark`) trägt den Datenordner in sich, damit eine zweite Instanz (zum Ausprobieren, mit eigenem
// Datenordner) beim Aufräumen nicht die Paare der ersten entfernt. Caches, Vorlage und Build-Dienst heißen nach dem
// Repo; eine zweite Instanz (anderer Port) hängt ihre Kennung an, damit sie der ersten nichts wegnimmt, wenn beide
// ein Repo gleichen Namens bedienen.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { slug } = require('./images');

const DEFAULT_PORT = 8770;
const IMAGE = 'runclub-runner:latest';
// Docker-Daemon und Build-Dienst sind per Version und Digest festgenagelt, in linux/pins.Dockerfile (dort steht, warum
// und wie man sie anhebt). Liefert `{ dind, buildkit }`; fehlt eine Zeile, wirft es.
const PINS_FILE = path.join(__dirname, '..', 'linux', 'pins.Dockerfile');
function pinnedImages(text = fs.readFileSync(PINS_FILE, 'utf8')) {
  const pins = Object.fromEntries([...String(text).matchAll(/^FROM\s+(\S+)\s+AS\s+(\w+)\s*$/gim)].map((match) => [match[2], match[1]]));
  for (const name of ['dind', 'buildkit']) if (!pins[name]) throw new Error(`In linux/pins.Dockerfile fehlt das Abbild ${name}.`);
  return { dind: pins.dind, buildkit: pins.buildkit };
}

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

// Runner dieses Rechners heißen `<Rechner>-linux-<Kennung des Paars>`; daran erkennt RunClub sie bei GitHub wieder.
const runnerPrefix = (host) => `${host}-linux-`;
const runnerName = (host, id) => `${runnerPrefix(host)}${id}`;

module.exports = { createNames, pinnedImages, runnerPrefix, runnerName, DEFAULT_PORT, IMAGE };
