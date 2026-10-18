// What the images RunClub uses are called, and how it names its containers, volumes and networks.
//
// The mark (`mark`) carries the data folder in it, so that a second instance (for trying things out, with its own
// data folder) does not remove the first one's pairs when cleaning up. Caches, template and build service are named
// after the repo, the copy of the runner's tools after the runner image; a second instance (other port) appends its id
// so that it takes nothing away from the first when both serve a repo of the same name or run the same image.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { slug } = require('./images');

const DEFAULT_PORT = 8770;
const IMAGE = 'runclub-runner:latest';
// Docker daemon and build service are pinned by version and digest, in linux/pins.Dockerfile (it says why
// and how to raise them). Returns `{ dind, buildkit }`; if a line is missing, it throws.
const PINS_FILE = path.join(__dirname, '..', 'linux', 'pins.Dockerfile');
function pinnedImages(text = fs.readFileSync(PINS_FILE, 'utf8')) {
  const pins = Object.fromEntries([...String(text).matchAll(/^FROM\s+(\S+)\s+AS\s+(\w+)\s*$/gim)].map((match) => [match[2], match[1]]));
  for (const name of ['dind', 'buildkit']) if (!pins[name]) throw new Error(`The image ${name} is missing from linux/pins.Dockerfile.`);
  return { dind: pins.dind, buildkit: pins.buildkit };
}

function createNames({ dataDir, port }) {
  const instance = crypto.createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 10);
  const suffix = port === DEFAULT_PORT ? '' : `-${instance}`;
  const named = (kind) => (repo) => `rc-${kind}-${slug(repo)}${suffix}`;
  return {
    mark: `runclub.runner=${instance}`, // pairs: their containers, volumes and networks
    serviceMark: `runclub.service=${instance}`, // build services and their networks (see caches.js)
    toolsMark: `runclub.tools=${instance}`, // copies of the runner's tools; they stay across restarts (see externals.js)
    toolsVolume: (id) => `rc-tools-${id}${suffix}`, // per runner image, by its short id
    cacheVolume: named('cache'),
    seedVolume: named('seed'),
    buildVolume: named('build'),
    buildSocket: named('buildsock'),
    buildService: named('buildkit'),
    buildNetwork: named('buildnet'),
  };
}

// Runners of this machine are called `<machine>-linux-<pair id>`; that is how RunClub recognizes them at GitHub.
const runnerPrefix = (host) => `${host}-linux-`;
const runnerName = (host, id) => `${runnerPrefix(host)}${id}`;

module.exports = { createNames, pinnedImages, runnerPrefix, runnerName, DEFAULT_PORT, IMAGE };
