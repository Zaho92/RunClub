const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForDaemon, asRoot, READY_TRIES, DAEMON_POLL, PROBE_TIMEOUT, PAIR_SOCKET } = require('../src/dind');

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
