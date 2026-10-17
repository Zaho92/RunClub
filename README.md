# RunClub

Self-hosted GitHub Actions runners on your own Windows machine: for each job a fresh Linux container with its own
Docker daemon, plus a reserve of prepared runners and caches per repo. RunClub sits in the notification area and
shows its interface in a window.

## Requirements

- Docker Desktop with WSL, started (if one of them is missing, the app says what to do and starts Docker Desktop on click)
- a GitHub account with admin rights on the repos
- Node.js only for development (see below); the installer brings everything along

RunClub talks to GitHub through its own GitHub App “RunClub”. Sign in once (Settings → GitHub:
one-time code, confirmation in the browser), then RunClub acts on your behalf, but only in the repos the app is
installed on: [install RunClub](https://github.com/apps/runclub-runners/installations/new) for your own
account and every organization whose repos should get runners. Per repo the app may register and unregister runners
(Administration), read and re-run runs (Actions), set `CI_RUNNER` (Variables), read check results
(Checks) and read code (Contents, for the workflow files and RunClub's releases), plus the account's billing
for the minutes quota (Plan). It cannot change code directly; Administration, however, also allows changing
a repo's settings, collaborators and visibility (RunClub uses it only for the runners).

The token is valid for eight hours and renews itself; it is stored encrypted with the key of the Windows user
in `%APPDATA%\RunClub\data\github.token`. Signing out forgets it on this machine; you revoke the grant at
GitHub under [Authorized GitHub Apps](https://github.com/settings/apps/authorizations). The backend alone
(`npm run backend`) keeps the token in memory only.

A repo's jobs must point to self-hosted runners: `runs-on: [self-hosted, Linux]`. To stay switchable,
read the target from a repo variable:

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}
```

and set `CI_RUNNER` in the repo to `["self-hosted","Linux"]`.

## Installing

Download the installer `RunClub-Setup-X.Y.Z.exe` from the [releases](https://github.com/Zaho92/RunClub/releases) and
run it. It is not signed, so Windows warns “Unknown publisher” (“More info” → “Run
anyway”). RunClub ends up in `%LOCALAPPDATA%\Programs\RunClub`, with a Start menu shortcut; the data lives in
`%APPDATA%\RunClub` and is kept when updating and uninstalling.

## Updating

RunClub checks the releases shortly after starting and then every six hours, downloads a newer version in the
background and verifies it against the checksum in the release. It is only installed on click (Settings → App →
“Update now”), and only when no runner is working: RunClub then tears down all runners as on quitting, starts
the installer and opens again afterwards.

The channel is set in the same settings: **Stable** gets only approved versions, **Beta** also pre-releases.
As long as the repo is private, RunClub reads the releases with the token of the sign-in in the app (the app needs
Contents on this repo for that).

Closing the window ends nothing. Quit via the icon in the notification area (right-click → Quit)
or “Quit everything” in the interface; the runners end as well.

## Structure

| Path | Contents |
| --- | --- |
| `src/main.js` | Window, notification area, start with Windows |
| `src/backend.js` | Wiring only: `start()` creates the modules, starts the timers and the local service and shuts everything down again (sequence in `src/lifecycle.js`) |
| `src/lifecycle.js` | Start and end of a program run: timers, starting the pools, key file, quitting, fast unregistering when signing out of Windows |
| `src/settings.js`, `src/names.js` | Settings and learned data in the data folder; names of the images, tags and names of the caches and build services per repo |
| `src/runners.js` | Wires template, slots, caches and pools together (also for the tests) |
| `src/remote.js` | What is read from GitHub: runs and jobs, rate limit, repos of the account, waiting runs, visibility of the repos; re-running runs |
| `src/account.js` | Sign-in to GitHub and minutes quota in the same timer |
| `src/usage.js` | Measurement: `docker stats`, VM memory, Windows load, usage per job |
| `src/status.js`, `src/actions.js`, `src/server.js` | What the interface sees, what it can trigger, and the local service for it |
| `src/engine.js` | Where Docker runs (today Docker Desktop): CLI calls, endpoint, WSL distro for measuring the VM |
| `src/setup.js` | What the machine lacks for Docker while it does not answer: WSL, Docker Desktop installed, started, its engine; starting Docker Desktop |
| `src/dockerwatch.js` | The Docker watch: prepare as soon as Docker answers, check regularly, build the two own images (runner and Docker daemon), clean up leftovers |
| `src/dind.js` | The Docker daemon in a container (daemon of a pair, loading daemon of the template): image, user, socket, options for running without privileges, waiting until it answers; the same image as a tool for volumes |
| `src/slots.js` | Life cycle of a slot: set up a pair, register the runner, serve a job, clean up, abort when idle |
| `src/pools.js` | Create and prepare a pool, a pool's reserve (refill, renew, tear down), adjust the number of slots, bring a pool to rest |
| `src/seed.js` | Template of a repo: learn a job's images, refresh the template, lock copying and refreshing against each other |
| `src/housekeeping.js` | The timer of the cleanup work at GitHub: check the visibility of the repos (pause those that became public) and unregister orphaned runners, only when the rate limit allows it |
| `src/caches.js` | Provide a repo's package cache and build service (without privileges, reachable through a socket), recreate them with new limits or after a failure, clear them, measure the volumes |
| `src/pipeline.js` | Runs with their jobs, dependencies from the workflow file (`needs`), usual duration, remaining time |
| `src/metrics.js` | History of the load on Windows and the Docker VM, usage per job |
| `src/vmmemory.js` | Memory of the Docker VM from `/proc/meminfo` (with kernel and daemon), rule for the warning when hardly any memory is free |
| `src/routing.js` | Repo variable `CI_RUNNER`: switches a repo's jobs to the self-hosted runners and back |
| `src/access.js` | Who may use the local service: key per program run, cookie, headers of the page |
| `src/limits.js` | Limits per job: bounds from the Docker VM, suggestion from the measurements, default and outliers |
| `src/github.js` | GitHub's REST API via `fetch`: conditional requests (ETag), state of the rate limit, when to poll less often or not at all, token renewal on 401, errors with status |
| `src/auth.js` | Sign-in through the GitHub App (device flow): one-time code, waiting for confirmation, cancelling, signing out; renewing the token and storing it encrypted |
| `src/minutes.js` | GitHub Actions minutes quota: the month's usage from the account's billing (per operating system, paid), included minutes assumed per plan, state tight, used up or paid, when to read again |
| `src/messages.js` | Messages to the interface as keys with values (`{ key, args }`), with the English sentence for the log file and error text; the interface translates them with its tables |
| `src/journal.js` | Log: entries with time, project, message and kind; the latest in memory and for the next start in `runclub.log.entries`, all readable in `runclub.log` (in English from 0.1.0-beta.5 on) |
| `src/subnets.js` | Networks of the pairs and build services: a random /28 each from a separate range instead of from Docker's scarce pool |
| `src/waiting.js` | Runs without a pool that make no progress: repos of the account in which jobs wait for a self-hosted runner or runs failed on GitHub's used-up quota |
| `src/run.js`, `src/store.js`, `src/images.js`, `src/pairs.js`, `src/states.js`, `src/units.js`, `src/numbers.js` | Program calls with a time limit and abort from outside (on Windows the program is only looked up in PATH), files in the data folder, rules for learned images, names of the runner pairs, states of a slot, units for time and memory, median |
| `src/ui.html` | Interface: project bar, network plan per run, load, usage, settings (German and English) |
| `src/fonts/` | Font Overpass (OFL), shipped with the app so that it works without internet |
| `linux/` | Image of the runners (`Dockerfile`, with `docker-shim.sh`), image of the Docker daemon without privileges (`dind/Dockerfile`) and the pinned images of daemon and build service (`pins.Dockerfile`, only read, not built) |
| `scripts/make-icon.js` | draws the icon into `build/` (`npm run icon`) |

Settings, learned data and the log live under `%APPDATA%\RunClub\data`.
`npm run backend` starts only the service, without a window (data then under `%APPDATA%\RunClub\backend`, separate from the app's); the address to open is then printed in the console.

Environment variables: `RUNCLUB_DATA` (data folder), `RUNCLUB_PORT` (port of the service, otherwise 8770) and
`RUNCLUB_SUBNETS` (range from which the runners' networks get their subnet, otherwise `10.213.0.0/16`; from /8 to /24.
Only needed if the range is already taken, for example by a VPN). For a Docker engine other than Docker Desktop:
`RUNCLUB_DOCKER_HOST` (endpoint of the daemon, passed to the CLI as `DOCKER_HOST`; preferably a named pipe or `ssh://`,
a `tcp://` only with TLS via `RUNCLUB_DOCKER_CERTS`, the folder with `ca.pem`, `cert.pem` and `key.pem`, because otherwise
anyone who reaches the port, including a job, controls the daemon) and `RUNCLUB_DOCKER_DISTRO` (WSL distro of the daemon for
measuring the VM; if unset `docker-desktop`, with a custom endpoint none; empty: no measurement). Without
`RUNCLUB_DOCKER_HOST`, whatever the Docker CLI uses anyway applies (including a `DOCKER_HOST` or context of the user).

Only the app's own window gets the interface and its data: under Docker Desktop the service is also reachable from the
jobs' containers, so it requires a key that is created anew at every start
(`access.key` in the data folder, see `src/access.js`). This is meant for the app's own window. Anyone who opens the entry address
in an ordinary browser instead should know: the cookie there applies to all ports on `127.0.0.1`,
so also to other local services, and the address with the key stays in the history.

No runner container runs with `--privileged`: each job's Docker daemon and the build service run as
ordinary users (rootless). Whoever breaks out of a container that a job starts lands in the daemon container
of its job, not in the Docker VM. The job's steps themselves have root in the runner container via `sudo`, with
Docker's usual capabilities minus `NET_RAW`, `MKNOD`, `SETFCAP`, `SETPCAP`, `SYS_CHROOT` and `NET_BIND_SERVICE`; whoever
breaks out of the runner container is root in the Docker VM. This does not protect against every attack; only code
you trust should run on the runners. That is why pools exist only for private repos, and if a repo becomes public,
its pool pauses.
Dependabot proposes new versions of the pinned images (`linux/Dockerfile`, `linux/pins.Dockerfile`).

What the daemon without privileges changes for jobs: it has its own network in the daemon container. Ports that a job
publishes (`docker run -p`, `services:` in the workflow) are reached by the runner on `localhost`; `--network host`,
on the other hand, means the daemon's network, not the runner's. So a container with `--network host` sees no services
that a step starts in the runner on `localhost`, and vice versa.

## Development

```sh
npm run check   # syntax of all scripts, including the script in the interface
npm test        # tests of all modules except backend.js and main.js
```

Start without the installer:

```sh
npm install
npm start
```

Next to the installed app, a development instance runs only with its own data folder and port and only as a service
(`RUNCLUB_DATA` to an empty folder, `RUNCLUB_PORT` to another port, `npm run backend`); see `CLAUDE.md`
for why two instances must never serve the same repos. Build the installer locally: `npm run dist` (ends up in `dist/`).

### Release: QS → Live

There is no separate QS branch. QS is the Beta channel.

1. Development happens on feature branches; when done, it goes to `main`.
2. A beta is created with a tag on `main`: `git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1`. The workflow
   `.github/workflows/release.yml` builds the installer on Windows and publishes it as a pre-release; every RunClub on
   the Beta channel then offers it.
3. The beta is tried out in your own operation. Whatever comes up goes into the next beta (`-beta.2`).
4. Once a beta is approved, **the same commit** gets the stable tag: `git tag v0.2.0 v0.2.0-beta.2 && git push
   origin v0.2.0`. The workflow publishes it as an ordinary release, which the Stable channel also gets.

The version comes from the tag; `version` in `package.json` is not touched for it. As long as the repo is private,
GitHub's Windows runners cost minutes; then `npm run release` builds the same release on this machine (HEAD on
the pushed tag, working tree clean).

The same two steps run as CI on every push and pull request (`.github/workflows/ci.yml`).
Notes for working with Claude Code are in `CLAUDE.md`, the product description for the design in `PRODUCT.md`.
The design follows the skill [Impeccable](https://github.com/pbakaus/impeccable) (`npx impeccable install --providers=claude --project`).
