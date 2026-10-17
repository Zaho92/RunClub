// Checks the syntax of all scripts, including the script in the interface.  Usage:  npm run check
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = ['src', 'scripts', 'test'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.js')).map((name) => path.join(root, dir, name)));

const inline = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8').match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
const extracted = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runclub-')), 'ui.js');
fs.writeFileSync(extracted, inline);

for (const file of [...files, extracted]) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
// Whatever runs in the runner container must not carry CRLF.
for (const name of fs.readdirSync(path.join(root, 'linux'), { recursive: true })) {
  const file = path.join(root, 'linux', name);
  if (fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes('\r')) { console.error(`linux/${name} contains CRLF`); process.exit(1); }
}
console.log(`${files.length + 1} scripts OK`);
