const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { waitForDaemon, whyNotReady, asRoot, SECCOMP_PROFILE, SECURITY_FLAGS, READY_TRIES, DAEMON_POLL, PROBE_TIMEOUT, PAIR_SOCKET } = require('../src/dind');
const { render } = require('../src/messages');

// A daemon that answers after `answersAfter` questions (never if null). `calls` keeps the calls, `slept` the pauses.
function daemon(answersAfter) {
  const d = { calls: [], slept: [] };
  d.docker = async (args, options) => { d.calls.push({ args, options }); return { code: answersAfter !== null && d.calls.length > answersAfter ? 0 : 1 }; };
  d.sleep = async (ms) => { d.slept.push(ms); };
  return d;
}

test('waitForDaemon asks through the given socket until the daemon answers', async () => {
  const d = daemon(2);
  assert.equal(await waitForDaemon({ docker: d.docker, sleep: d.sleep, container: 'pair-dind', host: PAIR_SOCKET }), true);
  assert.equal(d.calls.length, 3);
  assert.deepEqual(d.calls[0].args, ['exec', 'pair-dind', 'docker', '-H', PAIR_SOCKET, 'info', '--format', 'ok']);
  assert.deepEqual(d.calls[0].options, { timeout: PROBE_TIMEOUT });
  assert.deepEqual(d.slept, [DAEMON_POLL, DAEMON_POLL]);
});

test('waitForDaemon without a socket asks the usual one', async () => {
  const d = daemon(0);
  assert.equal(await waitForDaemon({ docker: d.docker, sleep: d.sleep, container: 'loader' }), true);
  assert.deepEqual(d.calls[0].args, ['exec', 'loader', 'docker', 'info', '--format', 'ok']);
  assert.deepEqual(d.slept, []);
});

test('waitForDaemon gives up after READY_TRIES questions', async () => {
  const d = daemon(null);
  assert.equal(await waitForDaemon({ docker: d.docker, sleep: d.sleep, container: 'pair-dind' }), false);
  assert.equal(d.calls.length, READY_TRIES);
  assert.equal(d.slept.length, READY_TRIES);
});

test('waitForDaemon stops as soon as it is cancelled', async () => {
  const d = daemon(null);
  let cancel = false;
  const sleep = async (ms) => { d.slept.push(ms); if (d.slept.length === 2) cancel = true; };
  assert.equal(await waitForDaemon({ docker: d.docker, sleep, container: 'pair-dind', cancelled: () => cancel }), false);
  assert.equal(d.calls.length, 2);

  const early = daemon(0);
  assert.equal(await waitForDaemon({ docker: early.docker, sleep: early.sleep, container: 'pair-dind', cancelled: () => true }), false);
  assert.equal(early.calls.length, 0);
});

test('asRoot starts the image as root with a script for sh', () => {
  assert.deepEqual([...asRoot('dind:test'), 'echo ok'], ['--user', '0', '--entrypoint', 'sh', 'dind:test', '-c', 'echo ok']);
});

test('the daemons run with their own seccomp profile, never without', () => {
  assert.equal(SECURITY_FLAGS.includes('seccomp=unconfined'), false);
  assert.ok(SECURITY_FLAGS.includes(`seccomp=${SECCOMP_PROFILE}`));
  assert.ok(fs.existsSync(SECCOMP_PROFILE));
});

test('whyNotReady only takes whole words as errors: "errors=0" is none', async () => {
  const logs = (stdout) => async () => ({ code: 0, stdout, stderr: '' });
  assert.equal(render(await whyNotReady(logs('level=error msg="broken"\nlevel=info msg="errors=0"\nlevel=info msg="bye"\n'), 'x')), ' – level=error msg="broken"');
});

test('whyNotReady names the daemon\'s last error line and with "operation not permitted" the seccomp profile', async () => {
  const logs = (stdout, stderr) => async (args) => { assert.deepEqual(args, ['logs', '--tail', '30', 'pair-dind']); return { code: 0, stdout, stderr }; };
  const blocked = render(await whyNotReady(logs('', 'level=info msg="start"\n[rootlesskit:parent] error: fork/exec /proc/self/exe: operation not permitted\nlevel=info msg="bye"\n'), 'pair-dind'));
  assert.match(blocked, /^ – \[rootlesskit:parent\] error: fork\/exec \/proc\/self\/exe: operation not permitted \(the seccomp profile linux\/seccomp\.json may block/);
  assert.equal(render(await whyNotReady(logs('only this\n', ''), 'pair-dind')), ' – only this');
  assert.equal(render(await whyNotReady(logs('', ''), 'pair-dind')), '');
  assert.equal(render(await whyNotReady(async () => ({ code: 1, stdout: '', stderr: 'Error: No such container: pair-dind' }), 'pair-dind')), ' – Error: No such container: pair-dind');
});
