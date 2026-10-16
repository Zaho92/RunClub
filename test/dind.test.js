const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { waitForDaemon, whyNotReady, asRoot, SECCOMP_PROFILE, SECURITY_FLAGS, READY_TRIES, DAEMON_POLL, PROBE_TIMEOUT, PAIR_SOCKET } = require('../src/dind');

// Ein Daemon, der nach `answersAfter` Fragen antwortet (nie, wenn null). `calls` hält die Aufrufe, `slept` die Pausen.
function daemon(answersAfter) {
  const d = { calls: [], slept: [] };
  d.docker = async (args, options) => { d.calls.push({ args, options }); return { code: answersAfter !== null && d.calls.length > answersAfter ? 0 : 1 }; };
  d.sleep = async (ms) => { d.slept.push(ms); };
  return d;
}

test('waitForDaemon fragt über den angegebenen Socket, bis der Daemon antwortet', async () => {
  const d = daemon(2);
  assert.equal(await waitForDaemon({ docker: d.docker, sleep: d.sleep, container: 'paar-dind', host: PAIR_SOCKET }), true);
  assert.equal(d.calls.length, 3);
  assert.deepEqual(d.calls[0].args, ['exec', 'paar-dind', 'docker', '-H', PAIR_SOCKET, 'info', '--format', 'ok']);
  assert.deepEqual(d.calls[0].options, { timeout: PROBE_TIMEOUT });
  assert.deepEqual(d.slept, [DAEMON_POLL, DAEMON_POLL]);
});

test('waitForDaemon ohne Socket fragt den gewöhnlichen', async () => {
  const d = daemon(0);
  assert.equal(await waitForDaemon({ docker: d.docker, sleep: d.sleep, container: 'lader' }), true);
  assert.deepEqual(d.calls[0].args, ['exec', 'lader', 'docker', 'info', '--format', 'ok']);
  assert.deepEqual(d.slept, []);
});

test('waitForDaemon gibt nach READY_TRIES Fragen auf', async () => {
  const d = daemon(null);
  assert.equal(await waitForDaemon({ docker: d.docker, sleep: d.sleep, container: 'paar-dind' }), false);
  assert.equal(d.calls.length, READY_TRIES);
  assert.equal(d.slept.length, READY_TRIES);
});

test('waitForDaemon hört auf, sobald abgebrochen wird', async () => {
  const d = daemon(null);
  let cancel = false;
  const sleep = async (ms) => { d.slept.push(ms); if (d.slept.length === 2) cancel = true; };
  assert.equal(await waitForDaemon({ docker: d.docker, sleep, container: 'paar-dind', cancelled: () => cancel }), false);
  assert.equal(d.calls.length, 2);

  const early = daemon(0);
  assert.equal(await waitForDaemon({ docker: early.docker, sleep: early.sleep, container: 'paar-dind', cancelled: () => true }), false);
  assert.equal(early.calls.length, 0);
});

test('asRoot startet das Abbild als root mit einem Skript für sh', () => {
  assert.deepEqual([...asRoot('dind:test'), 'echo ok'], ['--user', '0', '--entrypoint', 'sh', 'dind:test', '-c', 'echo ok']);
});

test('die Daemons laufen mit dem eigenen Seccomp-Profil, nie ohne', () => {
  assert.equal(SECURITY_FLAGS.includes('seccomp=unconfined'), false);
  assert.ok(SECURITY_FLAGS.includes(`seccomp=${SECCOMP_PROFILE}`));
  assert.ok(fs.existsSync(SECCOMP_PROFILE));
});

test('whyNotReady nennt die letzte Fehlerzeile des Daemons und bei „operation not permitted“ das Seccomp-Profil', async () => {
  const logs = (stdout, stderr) => async (args) => { assert.deepEqual(args, ['logs', '--tail', '30', 'paar-dind']); return { code: 0, stdout, stderr }; };
  const blocked = await whyNotReady(logs('', 'level=info msg="start"\n[rootlesskit:parent] error: fork/exec /proc/self/exe: operation not permitted\nlevel=info msg="bye"\n'), 'paar-dind');
  assert.match(blocked, /^ – \[rootlesskit:parent\] error: fork\/exec \/proc\/self\/exe: operation not permitted \(womöglich verbietet das Seccomp-Profil/);
  assert.equal(await whyNotReady(logs('nur das\n', ''), 'paar-dind'), ' – nur das');
  assert.equal(await whyNotReady(logs('', ''), 'paar-dind'), '');
  assert.equal(await whyNotReady(async () => ({ code: 1, stdout: '', stderr: 'Error: No such container: paar-dind' }), 'paar-dind'), ' – Error: No such container: paar-dind');
});
