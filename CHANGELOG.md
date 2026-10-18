# Changelog

All notable changes to RunClub are noted here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/). A beta (`0.2.0-beta.3`) is released with the section of its
version (`0.2.0`), or with `Unreleased` as long as that does not exist yet.

## [Unreleased]

### Added

- `CHANGELOG.md`; releases take their notes from it.
- Issue forms for bug reports, `CONTRIBUTING.md`.

### Changed

- When signing in fails, the window gives the reason in the same words as the log.
- A pool can only be created while Docker is ready.

### Fixed

- After the daily rebuild of the runner image, a container job could get an empty folder of runner tools; the old
  copy now stays until the pairs that are about to use it have started.
- An image from the template could show files that one of its layers had deleted, if that layer created the folder
  again; the template is now copied with its extended attributes and hard links, which also saves space.

### Security

- Caches and template of a removed pool that could not be deleted no longer reach a new pool for another repo with the
  same name: they are deleted before it starts, or the pool is not created.
- Links to jobs and runs open only if they point to `https://github.com/`.
- The updater accepts a public key only under its own id, and `npm run release` signs only while the keys the app
  loads are the ones written in `src/signature.js`.

## [0.1.0] - 2026-10-18

The first release. It sums up the betas `0.1.0-beta.1` to `0.1.0-beta.8`; `0.1.0` is the same commit as `0.1.0-beta.8`.

### Added

- **Runners per repo without typing.** Pick a repo, and RunClub registers just-in-time runners for it, keeps a reserve
  of prepared ones, and switches its jobs to them and back through the repository variable `CI_RUNNER`. Limits for
  memory and CPU per project, with a suggestion from what was measured; a pool can be paused and its runners rebuilt.
- **A clean machine per job.** Every job runs in a new Linux container with its own Docker daemon. Caches per repo carry
  over: packages, build layers (a build service per repo) and the images the jobs use. Runs waiting for a runner in
  repos without a pool are found and offered.
- **Runs you can follow.** Each run is drawn as a network of its jobs (`needs`, also jobs from called workflows), with
  times and an estimate of when it is done, learned from earlier successful runs. Runs and jobs can be started again
  from the window; runs that GitHub does not start for lack of minutes are named.
- **Load in view.** Memory and CPU of the Docker VM, memory of Windows, the peak of each job against its limit, the
  load over the day, and usage per workflow and job.
- **GitHub's quotas.** The request budget of the hour (conditional requests, slower polling when it runs low, a pause
  when GitHub asks for one) and the Actions minutes of the account this month, with a warning before GitHub stops
  running jobs of private repos on its own runners.
- **Sign-in through the GitHub App “RunClub”** with a one-time code (device flow), with only the permissions it needs;
  the token renews itself and is stored encrypted. `gh` is no longer needed.
- **Check on first start.** If WSL or Docker Desktop is missing, not running or not responding, RunClub says what to do
  and starts Docker Desktop on click.
- **Installer and updater.** An NSIS installer with Start menu entry and autostart; the app downloads new versions in
  the background and installs them on click while no runner is working. Channels Stable and Beta.
- **Window and log.** A window in the style of the app with its own dialogs, a view while RunClub quits, a log with a
  filter per project that survives restarts and can be saved or copied, info symbols instead of long texts. The
  interface follows the system language (English or German).

### Security

- Access to the local service only with a key of the running program; requests that change something also need the
  token of the page.
- Pools only for private repos. A pool pauses when its repo becomes public, or when an organization repo allows
  workflows from fork pull requests (checked on creation, on start and every 10 minutes); details in `SECURITY.md`.
- The jobs' Docker daemons run rootless with a seccomp profile of their own; runners drop capabilities, get their
  registration through standard input instead of the environment or the command line, and have a deadline and a capped log. Images that
  run with more rights are pinned by digest.
- Updates are signed: every release carries an Ed25519-signed manifest, and the updater refuses anything unsigned,
  older or bigger than signed. Releases are built and signed only on the maintainer's machine, never in CI.

[Unreleased]: https://github.com/Zaho92/RunClub/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Zaho92/RunClub/releases/tag/v0.1.0
