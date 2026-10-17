const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccount } = require('../src/account');
const { rendered } = require('./support');
const { render, reason } = require('../src/messages');

// Sign-in and quota simulated: `login` is the signed-in account (or null).
function world() {
  const w = { calls: [], logs: [], login: 'zaho', may: true, stopping: false, pollFails: null };
  w.github = { mayPoll: (key) => { w.calls.push(`mayPoll ${key}`); return w.may; } };
  w.account = createAccount({
    auth: {
      signedIn: () => w.login,
      poll: async () => { w.calls.push('poll'); if (w.pollFails) throw new Error(w.pollFails); },
      view: () => ({ state: 'in' }), close: async () => { throw new Error('already closed'); },
      login: async () => w.calls.push('login'), cancel: async () => w.calls.push('cancel'), logout: async () => w.calls.push('logout'),
    },
    github: w.github,
    log: (...entry) => w.logs.push(rendered(entry)),
    logError: (repo, what) => (error) => w.logs.push([`${render(what)} – ${render(reason(error))}`, repo, 'error']),
    stopping: () => w.stopping,
    makeMinutes: (options) => {
      w.minutesOptions = options;
      return { poll: async (login) => w.calls.push(`minutes poll ${login}`), refresh: async (login) => w.calls.push(`minutes refresh ${login}`), view: (login) => ({ login }) };
    },
  });
  return w;
}

test('on the timer: first the sign-in, then the quota', async () => {
  const w = world();
  await w.account.watch();
  assert.deepEqual(w.calls, ['poll', 'mayPoll GitHub minutes', 'minutes poll zaho']);
});

test('without a sign-in, with a used-up limit and on shutdown the quota is not read', async () => {
  for (const block of [(w) => { w.login = null; }, (w) => { w.may = false; }, (w) => { w.stopping = true; }]) {
    const w = world();
    block(w);
    await w.account.watch();
    assert.equal(w.calls.some((call) => call.startsWith('minutes')), false);
  }
});

test('if the sign-in fails, that is logged, and the quota still gets its turn', async () => {
  const w = world();
  w.pollFails = 'GitHub not reachable';
  await w.account.watch();
  assert.deepEqual(w.logs, [['Signing in to GitHub – GitHub not reachable', null, 'error']]);
  assert.equal(w.calls.at(-1), 'minutes poll zaho');
});

test('another account: the quota anew right away, not only on the timer', async () => {
  const w = world();
  await w.account.changed();
  assert.deepEqual(w.calls, ['mayPoll GitHub minutes', 'minutes refresh zaho']);
  w.login = null;
  await w.account.changed();
  assert.equal(w.calls.length, 2); // without a sign-in nothing is asked
});

test('messages: the quota as an error, through the same access to GitHub; closing never throws', async () => {
  const w = world();
  assert.equal(w.minutesOptions.github, w.github);
  w.minutesOptions.log('quota unreadable');
  assert.deepEqual(w.logs, [['quota unreadable', null, 'error']]);
  await w.account.close();
  assert.deepEqual(w.account.minutesView(), { login: 'zaho' });
  assert.deepEqual(w.account.authView(), { state: 'in' });
});

test('signing in, cancelling and signing out go to the sign-in', async () => {
  const w = world();
  await w.account.login();
  await w.account.cancel();
  await w.account.logout();
  assert.deepEqual(w.calls, ['login', 'cancel', 'logout']);
});
