const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareInstall, launchInstaller } = require('../src/install');

const INSTALLER = { file: 'C:\\update\\RunClub-Setup-0.2.0.exe', args: ['--updated'], version: '0.2.0' };

// The updater faked: `ready` is what the view reports, `installer()` answers one after the other from `answers`.
function updater({ ready = true, answers = [INSTALLER] } = {}) {
  const u = { held: false, asked: 0 };
  Object.assign(u, {
    view: () => ({ ready }),
    installer: () => { const answer = answers[Math.min(u.asked, answers.length - 1)]; u.asked += 1; if (answer instanceof Error) throw answer; return answer; },
    hold: () => { u.held = true; },
  });
  return u;
}
const status = (...states) => ({ repos: [{ runners: states.map((state) => ({ state })) }] });

test('an update is installed only when it is ready and no runner is working; then the updater holds the file', () => {
  const u = updater();
  assert.equal(prepareInstall(u, status('ready', 'off')), INSTALLER);
  assert.equal(u.held, true);
  assert.throws(() => prepareInstall(updater({ ready: false }), status()), (error) => error.msg.key === 'm_noUpdate');
  assert.throws(() => prepareInstall(updater(), status('working', 'working', 'ready')), (error) => error.msg.key === 'm_updateBusy' && error.msg.args[0] === 2);
  // Ready in the view, but the file no longer checks out.
  const gone = updater({ answers: [null] });
  assert.throws(() => prepareInstall(gone, status()), (error) => error.msg.key === 'm_noUpdate');
  assert.equal(gone.held, false);
});

test('after teardown the installer starts detached if it still checks out, otherwise RunClub starts again', () => {
  const started = [];
  let relaunched = 0;
  const spawn = (file, args, options) => { started.push([file, args, options]); return { on() { return this; }, unref() {} }; };
  const relaunch = () => { relaunched += 1; };
  launchInstaller(updater(), { spawn, relaunch });
  assert.deepEqual(started, [[INSTALLER.file, INSTALLER.args, { detached: true, stdio: 'ignore' }]]);
  assert.equal(relaunched, 0);
  launchInstaller(updater({ answers: [null] }), { spawn, relaunch });
  launchInstaller(updater({ answers: [new Error('EBUSY')] }), { spawn, relaunch });
  assert.equal(started.length, 1);
  assert.equal(relaunched, 2);
});
