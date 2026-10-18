# Contributing

Thanks for wanting to help. Bugs and ideas go into [issues](https://github.com/Zaho92/RunClub/issues/new/choose);
security problems are reported privately (see [SECURITY.md](SECURITY.md)). How RunClub is built: [README.md](README.md),
section "Development".

## Before you send a change

- `npm run check` (syntax, including the script in `src/ui.html`) and `npm test` pass.
- No build step and no runtime dependencies: plain Node (CommonJS) and one HTML file. Electron is the only
  development dependency.
- New logic goes into its own module without side effects on load and gets tests in `test/`. `src/backend.js` only
  wires things together.
- Comments, identifiers, test names and commit messages are English.

## Texts

- The interface exists in German and English: every new text goes into both tables in `src/ui.html`.
- What the backend reports to the interface (log, errors, states) is a key with values, not a sentence:
  `msg('m_…', …)` or `new Fault('m_…', …)` from `src/messages.js`. The English sentence goes into `EN` there and, with
  the German one, into the tables of `src/ui.html`; `test/states.test.js` checks that they match.

## Files that run in Linux

Everything under `linux/` runs in the runner container and must not contain CRLF line endings; `npm run check` rejects
them.

## Workflow

Work happens directly on `main`, without long-lived branches; pull requests go to `main`. A commit that finishes an issue closes it with `Fixes #<n>`;
what changed goes into `CHANGELOG.md` under `Unreleased`. Details: [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
