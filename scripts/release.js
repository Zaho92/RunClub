// Baut den Installer zum Tag, auf dem HEAD steht, und legt ihn als GitHub-Release ab – wie .github/workflows/release.yml,
// aber auf diesem Rechner. Für die Zeit, in der das Repo privat ist und die Windows-Runner von GitHub Minuten kosten.
//   Aufruf:  git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1 && npm run release
// Gebaut wird nur ein sauberer Stand: keine geänderte oder neue Datei im Arbeitsordner, HEAD trägt genau ein Tag v*.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (text) => { console.error(text); process.exit(1); };

if (git('status', '--porcelain')) fail('Der Arbeitsordner hat Änderungen. Erst committen oder verwerfen.');
const tags = git('tag', '--points-at', 'HEAD').split('\n').filter((tag) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag));
if (tags.length !== 1) fail(`HEAD braucht genau ein Versions-Tag (gefunden: ${tags.join(', ') || 'keins'}).`);
const [tag] = tags;
const version = tag.slice(1);
if (!git('ls-remote', '--tags', 'origin', tag)) fail(`Das Tag ${tag} ist noch nicht gepusht: git push origin ${tag}`);

fs.rmSync(dist, { recursive: true, force: true });
// Die Version kommt aus dem Tag; package.json bleibt unverändert.
const build = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: root, stdio: 'inherit', shell: true });
if (build.status !== 0) fail('Der Bau ist gescheitert.');

// Neben dem Installer die Datei für den Updater (latest.yml, bei Betas beta.yml), nicht builder-debug.yml.
const files = fs.readdirSync(dist).filter((name) => /\.exe$|\.blockmap$|^(latest|beta|alpha)\.yml$/.test(name)).map((name) => path.join(dist, name));
const flags = ['--title', `RunClub ${version}`, '--generate-notes', '--verify-tag', ...(version.includes('-') ? ['--prerelease'] : [])];
execFileSync('gh', ['release', 'create', tag, ...files, ...flags], { cwd: root, stdio: 'inherit' });
console.log(`Release ${tag} angelegt.`);
