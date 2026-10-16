const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccount } = require('../src/account');
const { SCOPE: MINUTES_SCOPE } = require('../src/minutes');
const { rendered } = require('./support');
const { render, reason } = require('../src/messages');

// Anmeldung und Kontingent nachgestellt: `login` ist das Konto mit dem Recht für die Minuten (oder null).
function world() {
  const w = { calls: [], logs: [], accounts: 0, login: 'zaho', may: true, stopping: false, pollFails: null };
  w.account = createAccount({
    run: null, timeout: 1, gh: null,
    githubApi: { mayPoll: (key) => { w.calls.push(`mayPoll ${key}`); return w.may; } },
    log: (...entry) => w.logs.push(rendered(entry)),
    logError: (repo, what) => (error) => w.logs.push([`${render(what)} – ${render(reason(error))}`, repo, 'error']),
    stopping: () => w.stopping,
    onAccount: () => { w.accounts += 1; },
    makeAuth: (options) => {
      w.authOptions = options;
      return {
        poll: async () => { w.calls.push('poll'); if (w.pollFails) throw new Error(w.pollFails); },
        loginWith: (scope) => { assert.equal(scope, MINUTES_SCOPE); return w.login; },
        view: () => ({ state: 'in' }), close: async () => { throw new Error('schon zu'); },
        login: async () => w.calls.push('login'), grant: async (scope) => w.calls.push(`grant ${scope}`), cancel: async () => {}, logout: async () => {},
      };
    },
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

test('ohne Anmeldung mit dem Recht, bei aufgebrauchtem Limit und beim Beenden wird das Kontingent nicht gelesen', async () => {
  for (const block of [(w) => { w.login = null; }, (w) => { w.may = false; }, (w) => { w.stopping = true; }]) {
    const w = world();
    block(w);
    await w.account.watch();
    assert.equal(w.calls.some((call) => call.startsWith('minutes')), false);
  }
});

test('scheitert die Anmeldung, steht das im Protokoll, und das Kontingent kommt trotzdem dran', async () => {
  const w = world();
  w.pollFails = 'gh fehlt';
  await w.account.watch();
  assert.deepEqual(w.logs, [['Anmeldung bei GitHub – gh fehlt', null, 'error']]);
  assert.equal(w.calls.at(-1), 'minutes poll zaho');
});

test('ein anderes Konto: Bescheid nach außen und das Kontingent sofort neu', async () => {
  const w = world();
  w.authOptions.onAccount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.accounts, 1);
  assert.equal(w.calls.at(-1), 'minutes refresh zaho');
});

test('Meldungen: die Anmeldung ohne Projekt, das Kontingent als Fehler; Schließen wirft nie', async () => {
  const w = world();
  w.authOptions.log('Angemeldet');
  w.minutesOptions.log('Kontingent unlesbar');
  assert.deepEqual(w.logs, [['Angemeldet'], ['Kontingent unlesbar', null, 'error']]);
  await w.account.close();
  assert.deepEqual(w.account.minutesView(), { login: 'zaho' });
  await w.account.grant('read:org');
  assert.equal(w.calls.at(-1), 'grant read:org');
});
