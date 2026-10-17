const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccount } = require('../src/account');
const { rendered } = require('./support');
const { render, reason } = require('../src/messages');

// Anmeldung und Kontingent nachgestellt: `login` ist das angemeldete Konto (oder null).
function world() {
  const w = { calls: [], logs: [], login: 'zaho', may: true, stopping: false, pollFails: null };
  w.github = { mayPoll: (key) => { w.calls.push(`mayPoll ${key}`); return w.may; } };
  w.account = createAccount({
    auth: {
      signedIn: () => w.login,
      poll: async () => { w.calls.push('poll'); if (w.pollFails) throw new Error(w.pollFails); },
      view: () => ({ state: 'in' }), close: async () => { throw new Error('schon zu'); },
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

test('im Takt: erst die Anmeldung, dann das Kontingent', async () => {
  const w = world();
  await w.account.watch();
  assert.deepEqual(w.calls, ['poll', 'mayPoll GitHub-Minuten', 'minutes poll zaho']);
});

test('ohne Anmeldung, bei aufgebrauchtem Limit und beim Beenden wird das Kontingent nicht gelesen', async () => {
  for (const block of [(w) => { w.login = null; }, (w) => { w.may = false; }, (w) => { w.stopping = true; }]) {
    const w = world();
    block(w);
    await w.account.watch();
    assert.equal(w.calls.some((call) => call.startsWith('minutes')), false);
  }
});

test('scheitert die Anmeldung, steht das im Protokoll, und das Kontingent kommt trotzdem dran', async () => {
  const w = world();
  w.pollFails = 'GitHub nicht erreichbar';
  await w.account.watch();
  assert.deepEqual(w.logs, [['Anmeldung bei GitHub – GitHub nicht erreichbar', null, 'error']]);
  assert.equal(w.calls.at(-1), 'minutes poll zaho');
});

test('ein anderes Konto: das Kontingent sofort neu, nicht erst im Takt', async () => {
  const w = world();
  await w.account.changed();
  assert.deepEqual(w.calls, ['mayPoll GitHub-Minuten', 'minutes refresh zaho']);
  w.login = null;
  await w.account.changed();
  assert.equal(w.calls.length, 2); // ohne Anmeldung wird nicht gefragt
});

test('Meldungen: das Kontingent als Fehler, über denselben Zugang zu GitHub; Schließen wirft nie', async () => {
  const w = world();
  assert.equal(w.minutesOptions.github, w.github);
  w.minutesOptions.log('Kontingent unlesbar');
  assert.deepEqual(w.logs, [['Kontingent unlesbar', null, 'error']]);
  await w.account.close();
  assert.deepEqual(w.account.minutesView(), { login: 'zaho' });
  assert.deepEqual(w.account.authView(), { state: 'in' });
});

test('Anmelden, Abbrechen und Abmelden gehen an die Anmeldung', async () => {
  const w = world();
  await w.account.login();
  await w.account.cancel();
  await w.account.logout();
  assert.deepEqual(w.calls, ['login', 'cancel', 'logout']);
});
