// Builds the installer for a tag on HEAD, signs its manifest and publishes it as a GitHub release – on this machine
// only: the signing key never goes to CI. The maintainer runs it in a terminal and types the passphrase.
//   Usage:  git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1 && npm run release
//           npm run release -- v0.2.0                     (HEAD carries more than one tag, e.g. beta and stable)
//           npm run release -- --key <stick>\backup.pem   (another key file, e.g. the backup key, see SECURITY.md)
//           npm run release -- --keys-changed             (the public keys differ from the last release; see below)
// Only a clean state is built: no changed or new file in the working tree, HEAD on origin/main, the tag pushed and
// pointing at HEAD, no release for the tag yet, checks and tests pass. If the public keys in src/signature.js differ
// from those of the last release, it stops unless --keys-changed says that is intended: a key slipped into main would
// otherwise be signed along unnoticed. The release is created as a draft, its files are checked, and only then it is
// published; if that fails, the draft is deleted.

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
const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const TRIES = 3; // passphrase attempts

// The tag to release: the one asked for (it must be on HEAD), otherwise the only one on HEAD. Returns { tag } or
// { error }.
function chooseTag(onHead, asked) {
  const tags = onHead.filter((tag) => TAG.test(tag));
  if (asked) return tags.includes(asked) ? { tag: asked } : { error: `${asked} is not a version tag on HEAD (found: ${tags.join(', ') || 'none'}).` };
  if (tags.length === 1) return { tag: tags[0] };
  return { error: tags.length ? `HEAD carries ${tags.join(', ')}; name the one to release: npm run release -- ${tags[tags.length - 1]}` : 'HEAD carries no version tag.' };
}

// The public keys as written in a version of src/signature.js, as sorted “id:key” entries.
function keysOf(source) {
  const block = String(source ?? '').match(/\/\/ KEYS-BEGIN[\s\S]*?\/\/ KEYS-END/)?.[0] ?? '';
  return [...block.matchAll(/'([0-9a-f]{16})':\s*'([A-Za-z0-9+/=]+)'/g)].map((m) => `${m[1]}:${m[2]}`).sort();
}

// What is missing or wrong among the files of the draft: the installer with its size, manifest and signature.
function missingAssets(assets, expected) {
  const problems = [];
  for (const [name, size] of Object.entries(expected)) {
    const found = (assets ?? []).find((item) => item.name === name);
    if (!found) problems.push(`${name} is missing`);
    else if (found.size !== size) problems.push(`${name} has ${found.size} bytes instead of ${size}`);
  }
  return problems;
}

function main() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
  const fail = (text) => { console.error(text); process.exit(1); };
  const args = process.argv.slice(2);
  const option = args.indexOf('--key');
  const keyFile = path.resolve(option >= 0 ? args[option + 1] ?? '' : path.join(os.homedir(), '.runclub-signing', 'primary.pem'));
  const asked = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--key');
  const repo = require('../package.json').repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1]; // as in src/main.js

  if (git('status', '--porcelain')) fail('The working tree has changes. Commit or discard them first.');
  const chosen = chooseTag(git('tag', '--points-at', 'HEAD').split('\n'), asked);
  if (chosen.error) fail(chosen.error);
  const { tag } = chosen;
  const version = tag.slice(1);
  const head = git('rev-parse', 'HEAD');
  // The remote tag must name this very commit (an annotated tag through its peeled line `^{}`).
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n').filter(Boolean);
  if (!remote.length) fail(`The tag ${tag} is not pushed yet: git push origin ${tag}`);
  const remoteCommit = (remote.find((line) => line.endsWith('^{}')) ?? remote[0]).split(/\s+/)[0];
  if (remoteCommit !== head) fail(`The tag ${tag} on GitHub points at ${remoteCommit.slice(0, 7)}, HEAD is ${head.slice(0, 7)}.`);
  git('fetch', '--quiet', 'origin', 'main');
  if (spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: root }).status !== 0) fail('HEAD is not on origin/main. Releases are tagged on main.');

  // Two keys, and the same as in the last release unless that is intended.
  if (Object.keys(signature.KEYS).length !== 2) fail('src/signature.js needs the primary and the backup public key (node scripts/keygen.js).');
  const previous = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const before = previous ? keysOf(spawnSync('git', ['show', `${previous}:src/signature.js`], { cwd: root, encoding: 'utf8' }).stdout) : [];
  const now = keysOf(fs.readFileSync(path.join(root, 'src', 'signature.js'), 'utf8'));
  if (before.join() !== now.join() && !args.includes('--keys-changed')) {
    fail(`The public keys differ from ${previous || 'the last release'}:\n  before: ${before.join(', ') || 'none'}\n  now:    ${now.join(', ')}\nEvery installation will trust the new ones. If that is what you want: npm run release -- --keys-changed`);
  }

  // No release for the tag yet, not even a draft: the app would otherwise see two, or an old half one.
  const existing = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100`)).filter((item) => item.tag_name === tag);
  if (existing.length) fail(`There is already a release${existing.some((item) => item.draft) ? ' (draft)' : ''} for ${tag}. Delete it on GitHub first if it is incomplete.`);
  if (!fs.existsSync(keyFile)) fail(`No key file at ${keyFile}. Restore it from the password manager (README, “Signing key”).`);

  // What CI checks on every push, once more on exactly this state.
  for (const step of [[path.join(root, 'scripts', 'check.js')], ['--test']]) {
    if (spawnSync(process.execPath, step, { cwd: root, stdio: 'inherit' }).status !== 0) fail('Checks or tests failed.');
  }

  fs.rmSync(dist, { recursive: true, force: true });
  // The version comes from the tag; package.json stays unchanged.
  const cli = require.resolve('electron-builder/cli.js', { paths: [root] });
  const build = spawnSync(process.execPath, [cli, '--win', 'nsis', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('The build failed.');

  const exe = `RunClub-Setup-${version}.exe`; // artifactName in package.json
  const installer = path.join(dist, exe);
  if (!fs.existsSync(installer)) fail(`The build wrote no ${exe}.`);
  const bytes = signature.manifestBytes({
    repo, version, file: exe, size: fs.statSync(installer).size,
    sha512: crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64'),
    commit: head, signedAt: new Date().toISOString(),
  });
  return { tag, version, repo, keyFile, bytes, exe, installer, gh, fail };
}

// The key is only opened after the build, so it is not in memory while electron-builder runs.
async function signAndPublish({ tag, version, repo, keyFile, bytes, exe, installer, gh, fail }) {
  let privateKey = null;
  for (let attempt = 1; !privateKey; attempt += 1) {
    const secret = await passphrase(`Passphrase for ${keyFile}: `);
    try { privateKey = crypto.createPrivateKey({ key: fs.readFileSync(keyFile), passphrase: secret }); } catch (failure) {
      if (attempt >= TRIES) fail(`The key does not open: ${failure.message}`);
      console.log('That did not open the key. Once more.');
    }
  }
  if (!(signature.keyId(signature.rawPublicKey(privateKey)) in signature.KEYS)) fail('This key is not one of the keys in src/signature.js; the app would refuse the update.');
  const sig = signature.sign(bytes, privateKey);
  // Checked the way the app checks it, so a broken release never goes out.
  signature.checkManifest(signature.verify(bytes, sig), { repo, version, current: '0.0.0', channel: channelOf(version) });
  fs.writeFileSync(path.join(dist, signature.MANIFEST), bytes);
  fs.writeFileSync(path.join(dist, signature.SIGNATURE), sig);

  // Next to installer and manifest the file of electron-builder (latest.yml, beta.yml for betas): RunClub up to
  // 0.1.0-beta.5 knows only that one. Not builder-debug.yml.
  const files = fs.readdirSync(dist).filter((name) => /\.exe$|\.blockmap$|^(latest|beta|alpha)\.yml$/.test(name) || name === signature.MANIFEST || name === signature.SIGNATURE)
    .map((name) => path.join(dist, name));
  const flags = ['--title', `RunClub ${version}`, '--generate-notes', '--verify-tag', '--draft', ...(version.includes('-') ? ['--prerelease'] : [])];
  let draft = null;
  try {
    execFileSync('gh', ['release', 'create', tag, ...files, ...flags], { cwd: root, stdio: 'inherit' });
    const drafts = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100`)).filter((item) => item.tag_name === tag && item.draft);
    if (drafts.length !== 1) throw new Error(`expected one draft for ${tag}, found ${drafts.length}`);
    [draft] = drafts;
    const problems = missingAssets(draft.assets, { [exe]: fs.statSync(installer).size, [signature.MANIFEST]: bytes.length, [signature.SIGNATURE]: Buffer.byteLength(sig) });
    if (problems.length) throw new Error(problems.join('; '));
    gh('api', '-X', 'PATCH', `repos/${repo}/releases/${draft.id}`, '-F', 'draft=false');
  } catch (failure) {
    // Before, there was no release for the tag; every draft for it now is from this run, also a half uploaded one.
    let left = [];
    try { left = JSON.parse(gh('api', `repos/${repo}/releases?per_page=100`)).filter((item) => item.tag_name === tag && item.draft); } catch { left = draft ? [draft] : []; }
    for (const item of left) spawnSync('gh', ['api', '-X', 'DELETE', `repos/${repo}/releases/${item.id}`], { cwd: root });
    fail(`Publishing failed${left.length ? ' (draft deleted)' : ''}: ${failure.message}`);
  }
  console.log(`Release ${tag} published, signed with key ${JSON.parse(sig).key}.`);
}

if (require.main === module) signAndPublish(main()).catch((failure) => { console.error(failure.message); process.exit(1); });

module.exports = { chooseTag, keysOf, missingAssets };
