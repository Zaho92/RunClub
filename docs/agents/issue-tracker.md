# Issue tracker: GitHub

Issues and specs for RunClub live as GitHub issues in `Zaho92/RunClub`. Use the `gh` CLI for all operations; it
infers the repo from `git remote -v`. Labels, priorities and epics: `docs/agents/triage-labels.md`.

## How work flows

- Work happens directly on `main`: no feature branches, no pull requests. Temporary local branches (a worktree for a
  parallel agent) are merged back into `main` and deleted before anything is pushed.
- A commit that finishes an issue closes it with `Fixes #<n>` in the message (one line per issue). A commit that only
  contributes names it with `#<n>`.
- Commits stay local until the owner has accepted the work; pushing `main` closes the issues. CI (`.github/workflows/ci.yml`)
  runs on every push to `main`.
- Releases are separate (Jade flow `runclub-release`, process in `README.md` under "Release: QA → Live"). What changed
  goes into `CHANGELOG.md` under "Unreleased".

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..." --label "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --limit 200 --json number,title,labels` with `--label` and `--search` filters.
- **Search for duplicates**: `gh issue list --state all --search "<keywords>"`.
- **Make an issue a sub-issue of an epic**: `gh issue create --parent <epic> ...`, or `gh issue edit <epic> --add-sub-issue <n>,<n>` afterwards; read them with `gh issue view <epic> --json subIssues`.
- **Blocking**: GitHub's native issue dependencies: `gh api --method POST repos/Zaho92/RunClub/issues/<n>/dependencies/blocked_by -F issue_id=<blocker-db-id>` (database id from `gh api repos/Zaho92/RunClub/issues/<blocker> --jq .id`). Fallback: a `Blocked by: #<n>` line at the top of the body.
- **Comment**: `gh issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close without a commit**: `gh issue close <number> --comment "..."`; discarded issues with `--reason "not planned"` and the label `wontfix`.

Titles and bodies are English, like everything else in the repo.

## Pull requests as a triage surface

**PRs as a request surface: no.** External pull requests are rare; read them by hand.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.
