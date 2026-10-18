const test = require('node:test');
const assert = require('node:assert/strict');
const { createExternals, shortId, FILL, COMPLETE } = require('../src/externals');

const ID = 'sha256:0123456789abcdef0123';
const MARK = 'runclub.runner=test';
const TOOLS_MARK = 'runclub.tools=test';

// Docker simulated: `calls` holds the calls in short form, `answer(args)` can give one a result (otherwise it succeeds),
// `volumes` is what `volume ls` lists.
function world() {
  const w = { calls: [], details: [], volumes: [], image: ID, answer: () => undefined };
  const brief = (args) => (args[0] === 'run' ? `run ${args.at(-3)}` : args.slice(0, args[0] === 'volume' ? 3 : 2).join(' '));
  w.externals = createExternals({
    docker: async (args, options = {}) => {
      w.calls.push(brief(args));
      w.details.push({ args, options });
      return { code: 0, stderr: '', stdout: args[1] === 'inspect' ? `${w.image}\n` : '', ...(await w.answer(args)) };
    },
    dockerList: async (args) => { w.calls.push(args.slice(0, 2).join(' ')); return w.volumes; },
    image: 'runner:test', mark: MARK, toolsMark: TOOLS_MARK, toolsVolume: (id) => `rc-tools-${id}`, longTimeout: 1234,
  });
  return w;
}

test('the tools are copied once per image into a volume of their own, and the runner image is named by its id', async () => {
  const w = world();
  w.volumes = ['rc-tools-0123456789ab'];
  assert.deepEqual(await w.externals.prepare(), { image: ID, volume: 'rc-tools-0123456789ab' });
  assert.deepEqual(w.calls, ['image inspect', 'volume create --label', `run ${ID}`, 'volume ls']);
  assert.deepEqual(w.details[1].args, ['volume', 'create', '--label', TOOLS_MARK, 'rc-tools-0123456789ab']);
  // As root in a container of the runner image, labelled like the pairs: after a crash it counts as a leftover.
  assert.deepEqual(w.details[2].args, ['run', '--rm', '--label', MARK, '-v', 'rc-tools-0123456789ab:/x', '--user', '0', '--entrypoint', 'sh', ID, '-c', FILL]);
  assert.deepEqual(w.details[2].options, { timeout: 1234 });

  // The next pair only asks which image carries the name.
  assert.deepEqual(await w.externals.prepare(), { image: ID, volume: 'rc-tools-0123456789ab' });
  assert.deepEqual(w.calls.slice(4), ['image inspect']);
});

test('the copy only counts once it is complete; an aborted one is filled anew', () => {
  assert.match(FILL, new RegExp(`^\\[ -f /x/${COMPLETE.replace('.', '\\.')} \\] \\|\\| `));
  assert.match(FILL, /find \/x -mindepth 1 -delete && cp -a \/home\/runner\/externals\/\. \/x\/ && touch \/x\/\.runclub-complete/);
});

test('pairs asking at the same time share one copy', async () => {
  const w = world();
  const both = await Promise.all([w.externals.prepare(), w.externals.prepare()]);
  assert.deepEqual(both[0], both[1]);
  assert.equal(w.calls.filter((call) => call.startsWith('run ')).length, 1);
});

test('after a rebuild the new image gets its copy, and older copies go unless a daemon still uses them', async () => {
  const w = world();
  await w.externals.prepare();
  w.image = 'sha256:fedcba9876543210';
  w.volumes = ['rc-tools-0123456789ab', 'rc-tools-fedcba987654', 'rc-tools-aaaaaaaaaaaa'];
  w.answer = (args) => (args[0] === 'volume' && args[1] === 'rm' && args[2] === 'rc-tools-aaaaaaaaaaaa' ? { code: 1, stderr: 'volume is in use' } : undefined);
  w.calls.length = 0;
  assert.deepEqual(await w.externals.prepare(), { image: 'sha256:fedcba9876543210', volume: 'rc-tools-fedcba987654' });
  assert.deepEqual(w.calls, ['image inspect', 'volume create --label', 'run sha256:fedcba9876543210', 'volume ls', 'volume rm rc-tools-0123456789ab', 'volume rm rc-tools-aaaaaaaaaaaa']);
  // Without `-f`: Docker refuses to remove a volume a container still uses.
  assert.ok(w.details.filter(({ args }) => args[1] === 'rm').every(({ args }) => args.length === 3));
});

test('if copying fails, the pair fails with the reason, and the next one tries again', async () => {
  const w = world();
  w.answer = (args) => (args[0] === 'run' ? { code: 1, stderr: 'no space left on device\n' } : undefined);
  await assert.rejects(w.externals.prepare(), (error) => error.message === 'Could not copy the runner tools for container jobs: no space left on device');
  w.answer = () => undefined;
  w.calls.length = 0;
  await w.externals.prepare();
  assert.deepEqual(w.calls, ['image inspect', 'volume create --label', `run ${ID}`, 'volume ls']);
});

test('without a runner image there is nothing to copy', async () => {
  const w = world();
  w.answer = (args) => (args[1] === 'inspect' ? { code: 1, stdout: '', stderr: 'Error: No such image: runner:test' } : undefined);
  await assert.rejects(w.externals.prepare(), (error) => error.message === 'Could not copy the runner tools for container jobs: Error: No such image: runner:test');
  assert.deepEqual(w.calls, ['image inspect']);
});

test('shortId: the first 12 hex digits, as Docker shows them', () => {
  assert.equal(shortId('sha256:0123456789abcdef'), '0123456789ab');
  assert.equal(shortId('0123456789abcdef'), '0123456789ab');
});
