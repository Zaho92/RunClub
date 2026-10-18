// The runner's own tools (`/home/runner/externals`, above all the Node versions JavaScript actions run with) for the
// pairs' Docker daemons. For a job with `container:` the runner mounts that folder read-only into the job container
// (`/__e`). The path is resolved by the job's daemon, which runs in the neighbouring container: there the folder does not
// exist, and without privileges the daemon may not create it (`mkdir /home/runner: permission denied`). Everything else
// the runner mounts lies in `_work`, which both containers already share (as of runner 2.338.0,
// `MountWellKnownDirectories` in its ContainerOperationProvider.cs).
//
// So every version of the runner image gets a volume with a copy of its folder, which the daemons mount read-only at
// the same path. Copying takes a few seconds; it happens once per image and the volume stays across restarts. A pair
// runs its runner from exactly the image whose copy its daemon carries (the image's id, not its name: the daily
// rebuild may meanwhile have given the name to a newer one). Copies of older images go as soon as no daemon uses them.

const { asRoot } = require('./dind');
const { lastLine } = require('./run');
const { Fault, msg } = require('./messages');

const EXTERNALS = '/home/runner/externals';
// Written last: a volume without it holds an aborted copy and is filled anew.
const COMPLETE = '.runclub-complete';
const FILL = `[ -f /x/${COMPLETE} ] || { find /x -mindepth 1 -delete && cp -a ${EXTERNALS}/. /x/ && touch /x/${COMPLETE}; }`;

// The first 12 hex digits of an image id (`sha256:…`), as Docker shows it.
const shortId = (id) => String(id).replace(/^sha256:/, '').slice(0, 12);

//   docker(args, options), dockerList(args)   from engine.js
//   image                   name of the runner image
//   mark                    mark of our own containers (the copying container counts as a leftover after a crash)
//   toolsMark               mark of the volumes with the copies (see names.js)
//   toolsVolume(id)         name of the volume for an image's short id
//   longTimeout             time limit for copying
// `prepare()` returns `{ image, volume }`: the runner image's id and the volume with its tools; it throws a Fault if
// that does not work.
function createExternals({ docker, dockerList, image, mark, toolsMark, toolsVolume, longTimeout }) {
  let current = null; // { id, promise }: the copy for the image that carries the name right now

  async function fill(id) {
    const volume = toolsVolume(shortId(id));
    const created = await docker(['volume', 'create', '--label', toolsMark, volume]);
    if (created.code !== 0) throw new Fault('m_toolsFailed', lastLine(created.stderr) || msg('m_exitCode', created.code));
    const copy = await docker(['run', '--rm', '--label', mark, '-v', `${volume}:/x`, ...asRoot(id), FILL], { timeout: longTimeout });
    if (copy.code !== 0) throw new Fault('m_toolsFailed', lastLine(copy.stderr) || msg('m_exitCode', copy.code));
    // Docker refuses to remove a volume a container still uses: such a copy goes on a later round.
    for (const old of await dockerList(['volume', 'ls', '-q', '--filter', `label=${toolsMark}`])) if (old !== volume) await docker(['volume', 'rm', old]);
    return { image: id, volume };
  }

  async function prepare() {
    const found = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    const id = String(found.stdout ?? '').trim();
    if (found.code !== 0 || !id) throw new Fault('m_toolsFailed', lastLine(found.stderr) || msg('m_exitCode', found.code));
    if (current?.id !== id) current = { id, promise: fill(id) };
    const attempt = current;
    try { return await attempt.promise; } catch (error) {
      if (current === attempt) current = null; // the next pair tries again
      throw error;
    }
  }

  return { prepare };
}

module.exports = { createExternals, shortId, EXTERNALS, COMPLETE, FILL };
