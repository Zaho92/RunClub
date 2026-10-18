# RunClub

Electron app that manages self-hosted GitHub Actions runners on a Windows machine. Structure and requirements: `README.md`.
What is still pending: the GitHub issues (`docs/agents/issue-tracker.md`). What the app is for: `PRODUCT.md`. What it looks like and which rules apply: `DESIGN.md`.

## Working in the code

- No build step, no runtime dependencies: plain Node (CommonJS) and one HTML file. Electron is the only development dependency.
- Comments, identifiers, test names and commit messages are English. The interface exists in German and English: every new text goes into both tables in `src/ui.html`.
- What the backend reports to the interface (log, errors, states) is a key with values, not a sentence: `msg('m_…', …)` or `new Fault('m_…', …)` from `src/messages.js`. The English sentence lives there in `EN` (log file, console, `error.message`); the same English sentence and the German one go into the tables of `src/ui.html` (`test/states.test.js` checks that). Texts from outside (Docker, GitHub) stay text.
- New logic goes into its own module without side effects on load (like `src/pipeline.js`, `src/metrics.js`) and gets tests in `test/`. `src/backend.js` is wiring only (`start()`); logic does not belong there but in a module.
- The syntax check rejects CRLF in `linux/`: these files run in the runner container; with Windows line endings every `docker` call fails there.
- Issues live on GitHub; work happens directly on `main`, commits close issues with `Fixes #<n>`. Tracker: `docs/agents/issue-tracker.md`, labels and priorities: `docs/agents/triage-labels.md`. The Jade flows for this are in `.jade/ablaeufe/` (local only, excluded from git).
- Check: `npm run check` (syntax, including the script in `src/ui.html`) and `npm test`.
- After larger blocks, run `mattpocock-skills:code-review` and a security pass over the changes since the last pass; the next one is an issue.

## The running app

- The app is usually running and serves real CI jobs. It is installed (`%LOCALAPPDATA%\Programs\runclub`, channel Beta) and runs from its own copy, not from this repo: changes here only reach it as a release (push a tag `vX.Y.Z-beta.N` on `main`, then `npm run release`; QA → Live process in `README.md`). Releases are signed: `npm run release` asks for the passphrase of the signing key, so the user runs it in their own terminal. Claude does the code, the tag and the push, then asks the user to run it; Claude never handles the private key or its passphrase, and nothing in CI may sign or publish releases. The app downloads a new version itself and installs it on click; without a click: `POST /api/app/check`, then `POST /api/app/update` (only when no runner is working). Every release is a beta for the user to try out: do not set a stable tag without asking.
- The service only answers with the key of the running program as a cookie: `curl -b "rc=$(cat "$APPDATA/RunClub/data/access.key")" http://127.0.0.1:8770/api/status`. Without the key there is only `/api/ping` and the fonts.
- Restart only when no runner is working (state `working` in `/api/status`): `POST /api/shutdown` with the same cookie and the token from the page (`const TOKEN` in `GET /`) as header `x-rc-token`, then start via the Start menu shortcut (it points to the installed app). On quitting, all runners are torn down.
- Never two instances with the same pools: they unregister each other's runners at GitHub. To try things out, set `RUNCLUB_DATA` to an empty folder and `RUNCLUB_PORT` to another port (`npm run backend`); such an instance only cleans up in Docker what carries its own tag, and appends it to the names of its caches and build services. At GitHub, however, on start and quit it unregisters all idle runners of this machine in its repos, including those of the running app if both serve a repo.
- The interface can be viewed without the app by replacing `fetch` in a copy of `src/ui.html` with a fixed state and rendering the page to an image with Electron.

## Interface

- Design with the skill Impeccable (`.claude/skills/impeccable`, set up with `npx impeccable install --providers=claude --project`). Before every change to `src/ui.html`, read `reference/craft-floor.md` and follow `DESIGN.md`.
- After larger changes, take screenshots and start the reviewer as a fresh subagent (`.claude/agents/impeccable-finish-reviewer.md`). The user explicitly wants this more often.
- `src/ui.html` reloads itself in the window as soon as the file changes.
