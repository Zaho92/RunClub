// Builds the installer for the tag HEAD is on, signs its manifest and publishes it as a GitHub release – on this
// machine only: the signing key never goes to CI. The maintainer runs it in a terminal and types the passphrase.
//   Usage:  git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1 && npm run release
//           npm run release -- --key D:\backup.pem      (another key file, e.g. the backup key, see SECURITY.md)
// Only a clean state is built: no changed or new file in the working tree, HEAD carries exactly one tag v*.
// The release is created as a draft with all files and only published once complete.

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { passphrase } = require('./passphrase');
const signature = require('../src/signature');
const { channelOf } = require('../src/versions');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const REPO = require('../package.json').repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1]; // as in src/main.js
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (text) => { console.error(text); process.exit(1); };
const option = process.argv.indexOf('--key');
const keyFile = path.resolve(option > 0 ? process.argv[option + 1] ?? '' : path.join(os.homedir(), '.runclub-signing', 'primary.pem'));

async function main() {
  if (git('status', '--porcelain')) fail('The working tree has changes. Commit or discard them first.');
  const tags = git('tag', '--points-at', 'HEAD').split('\n').filter((tag) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag));
  if (tags.length !== 1) fail(`HEAD needs exactly one version tag (found: ${tags.join(', ') || 'none'}).`);
  const [tag] = tags;
  const version = tag.slice(1);
  if (!git('ls-remote', '--tags', 'origin', tag)) fail(`The tag ${tag} is not pushed yet: git push origin ${tag}`);
  if (Object.keys(signature.KEYS).length !== 2) fail('src/signature.js needs the primary and the backup public key (node scripts/keygen.js).');

  // The key first: a wrong passphrase should not cost a build.
  if (!fs.existsSync(keyFile)) fail(`No key file at ${keyFile}. Restore it from the password manager (README, “Signing key”).`);
  let privateKey;
  try { privateKey = crypto.createPrivateKey({ key: fs.readFileSync(keyFile), passphrase: await passphrase(`Passphrase for ${keyFile}: `) }); } catch (failure) { fail(`The key does not open: ${failure.message}`); }
  if (!(signature.keyId(signature.rawPublicKey(privateKey)) in signature.KEYS)) fail('This key is not one of the keys in src/signature.js; the app would refuse the update.');

  fs.rmSync(dist, { recursive: true, force: true });
  // The version comes from the tag; package.json stays unchanged.
  const cli = require.resolve('electron-builder/cli.js', { paths: [root] });
  const build = spawnSync(process.execPath, [cli, '--win', 'nsis', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('The build failed.');

  const exe = `RunClub-Setup-${version}.exe`; // artifactName in package.json
  const installer = path.join(dist, exe);
  if (!fs.existsSync(installer)) fail(`The build wrote no ${exe}.`);
  const bytes = signature.manifestBytes({
    repo: REPO, version, file: exe, size: fs.statSync(installer).size,
    sha512: crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64'),
    commit: git('rev-parse', 'HEAD'), signedAt: new Date().toISOString(),
  });
  const sig = signature.sign(bytes, privateKey);
  // Checked the way the app checks it, so a broken release never goes out.
  signature.checkManifest(signature.verify(bytes, sig), { repo: REPO, version, current: '0.0.0', channel: channelOf(version) });
  fs.writeFileSync(path.join(dist, signature.MANIFEST), bytes);
  fs.writeFileSync(path.join(dist, signature.SIGNATURE), sig);

  // Next to installer and manifest the file of electron-builder (latest.yml, beta.yml for betas): RunClub up to
  // 0.1.0-beta.5 knows only that one. Not builder-debug.yml.
  const files = fs.readdirSync(dist).filter((name) => /\.exe$|\.blockmap$|^(latest|beta|alpha)\.yml$/.test(name) || name === signature.MANIFEST || name === signature.SIGNATURE)
    .map((name) => path.join(dist, name));
  const flags = ['--title', `RunClub ${version}`, '--generate-notes', '--verify-tag', '--draft', ...(version.includes('-') ? ['--prerelease'] : [])];
  execFileSync('gh', ['release', 'create', tag, ...files, ...flags], { cwd: root, stdio: 'inherit' });
  execFileSync('gh', ['release', 'edit', tag, '--draft=false'], { cwd: root, stdio: 'inherit' });
  console.log(`Release ${tag} published, signed with key ${JSON.parse(sig).key}.`);
}

main().catch((failure) => fail(failure.message));
