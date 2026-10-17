// Builds the installer for the tag HEAD is on and publishes it as a GitHub release – like .github/workflows/release.yml,
// but on this machine. For the time the repo is private and GitHub's Windows runners cost minutes.
//   Usage:  git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1 && npm run release
// Only a clean state is built: no changed or new file in the working tree, HEAD carries exactly one tag v*.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (text) => { console.error(text); process.exit(1); };

if (git('status', '--porcelain')) fail('The working tree has changes. Commit or discard them first.');
const tags = git('tag', '--points-at', 'HEAD').split('\n').filter((tag) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag));
if (tags.length !== 1) fail(`HEAD needs exactly one version tag (found: ${tags.join(', ') || 'none'}).`);
const [tag] = tags;
const version = tag.slice(1);
if (!git('ls-remote', '--tags', 'origin', tag)) fail(`The tag ${tag} is not pushed yet: git push origin ${tag}`);

fs.rmSync(dist, { recursive: true, force: true });
// The version comes from the tag; package.json stays unchanged.
const cli = require.resolve('electron-builder/cli.js', { paths: [root] });
const build = spawnSync(process.execPath, [cli, '--win', 'nsis', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) fail('The build failed.');

// Next to the installer the file for the updater (latest.yml, beta.yml for betas), not builder-debug.yml.
const files = fs.readdirSync(dist).filter((name) => /\.exe$|\.blockmap$|^(latest|beta|alpha)\.yml$/.test(name)).map((name) => path.join(dist, name));
const flags = ['--title', `RunClub ${version}`, '--generate-notes', '--verify-tag', ...(version.includes('-') ? ['--prerelease'] : [])];
execFileSync('gh', ['release', 'create', tag, ...files, ...flags], { cwd: root, stdio: 'inherit' });
console.log(`Release ${tag} created.`);
