const test = require('node:test');
const assert = require('node:assert/strict');
const { run, locate } = require('../src/run');

const node = (script, options) => run(process.execPath, ['-e', script], options);

test('collects output and code', async () => {
  const result = await node('console.log("hello"); console.error("oops"); process.exit(3)');
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'hello');
  assert.equal(result.stderr.trim(), 'oops');
  assert.equal(result.timedOut, false);
});

test('passes on input and environment', async () => {
  const result = await node('process.stdin.on("data", (d) => process.stdout.write(process.env.RC_TEST + d))', { input: 'in', env: { RC_TEST: 'x:' } });
  assert.equal(result.stdout, 'x:in');
});

test('delivers lines one by one, and an error while handling one takes nothing down', async () => {
  const lines = [];
  const result = await node('console.log("one"); console.log("two"); console.log("three")', { onLine: (line) => { if (line === 'two') throw new Error('broken'); lines.push(line); } });
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['one', 'three']);
});

test('ends a program that does not answer', async () => {
  const started = Date.now();
  const result = await node('setTimeout(() => {}, 60000)', { timeout: 300 });
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /no answer/);
  assert.ok(Date.now() - started < 10000);
});

test('delivers the lines of error output one by one, also a last one without a line ending, and still collects them', async () => {
  const lines = [];
  const result = await node('console.error("one"); console.error("two"); process.stderr.write("no end")', { onErrLine: (line) => { lines.push(line); if (line === 'one') throw new Error('broken'); } });
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['one', 'two', 'no end']);
  assert.equal(result.stderr, 'one\ntwo\nno end');
  assert.equal(result.aborted, undefined);
});

// The line arrives while the program is still running: only it triggers the cancel here.
test('a program can be ended from outside', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = await node('console.error("ready"); setTimeout(() => {}, 60000)', { signal: controller.signal, timeout: 30000, onErrLine: () => controller.abort() });
  assert.deepEqual({ code: result.code, timedOut: result.timedOut, aborted: result.aborted }, { code: -1, timedOut: false, aborted: true });
  assert.match(result.stderr, /cancelled/);
  assert.ok(Date.now() - started < 10000);
});

test('an already triggered signal ends the program at once, and the time limit still applies alongside', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal((await node('setTimeout(() => {}, 60000)', { signal: controller.signal })).aborted, true);
  const late = await node('setTimeout(() => {}, 60000)', { signal: new AbortController().signal, timeout: 300 });
  assert.deepEqual({ timedOut: late.timedOut, aborted: late.aborted }, { timedOut: true, aborted: undefined });
});

test('a missing program ends with a result instead of a crash', async () => {
  const result = await run('does-not-exist-runclub', []);
  assert.equal(result.code, -1);
});

test('an invalid call also ends with a result', async () => {
  const result = await run(process.execPath, 'not an array');
  assert.equal(result.code, -1);
});

test('keeps only the end of a lot of error output', async () => {
  const result = await node('process.stderr.write("x".repeat(400000) + "\\nend")');
  assert.ok(result.stderr.length <= 140000);
  assert.ok(result.stderr.endsWith('end'));
});

test('on Windows a program without a path is only looked up in the folders from PATH, never in the working directory', () => {
  const there = new Set(['C:\\Tools\\gh.exe', 'D:\\Old\\gh.com', 'D:\\Old\\docker.exe', 'C:\\Tools\\script.cmd', 'gh.exe', '.\\gh.exe']);
  const seek = (command, PATH = '.;;relative;"C:\\Tools";D:\\Old') => locate(command, { platform: 'win32', env: { PATH }, exists: (file) => there.has(file) });
  assert.equal(seek('gh'), 'C:\\Tools\\gh.exe');
  assert.equal(seek('gh', 'D:\\Old;C:\\Tools'), 'D:\\Old\\gh.com');
  assert.equal(seek('docker'), 'D:\\Old\\docker.exe');
  assert.equal(seek('docker.exe'), 'D:\\Old\\docker.exe');
  assert.equal(seek('script'), null); // a batch file cannot be started without a command shell
  assert.equal(seek('missing'), null);
  assert.equal(seek('gh', '.;relative'), null); // only in the working directory
  assert.equal(locate('gh', { platform: 'win32', env: { Path: 'C:\\Tools' }, exists: (file) => there.has(file) }), 'C:\\Tools\\gh.exe');
  assert.equal(locate('gh', { platform: 'win32', env: {}, exists: () => true }), null);
  // Only folders with a drive or machine name; a folder with a semicolon in its name is not searched in pieces.
  const anywhere = (PATH) => locate('gh', { platform: 'win32', env: { PATH }, exists: () => true });
  assert.equal(anywhere('\\tools;/tools;tools'), null);
  assert.equal(anywhere('"C:\\a;b";D:\\c'), 'D:\\c\\gh.exe');
  assert.equal(anywhere('\\\\server\\share'), '\\\\server\\share\\gh.exe');
  // A dot in the name is not yet an extension.
  assert.equal(locate('tool.v2', { platform: 'win32', env: { PATH: 'C:\\Tools' }, exists: (file) => file === 'C:\\Tools\\tool.v2.exe' }), 'C:\\Tools\\tool.v2.exe');
  // With a path and outside Windows the name stays as it is.
  assert.equal(seek('C:\\Other\\gh.exe'), 'C:\\Other\\gh.exe');
  assert.equal(seek('./gh'), './gh');
  assert.equal(locate('gh', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), 'gh');
});
