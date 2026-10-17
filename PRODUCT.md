# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who use GitHub Actions for several of their own projects and run the jobs on their own Windows machine instead of on GitHub's paid runners. Today that is a single user (the author) with several parallel repos; the app is built so that it can be published later and then also tells strangers something on first start.

Two situations, equally important:

- **A quick glance on the side.** The user is working on something else and wants to know within two seconds: is something running, how much longer, is something red?
- **Looking closely.** A run hangs or is slow; the user follows it: which job, which step, what is waiting for what, why is it taking so long.

Setting up and maintaining (pools, slots, caches, limits) happens less often and is secondary.

## Product Purpose

RunClub manages self-hosted GitHub Actions runners on a Windows machine and shows what they are doing right now. It exists because setting this up by hand is tedious and GitHub itself does not show how a run progresses on self-hosted runners and what it costs the machine.

Success means: the user starts runners for a repo without typing, can estimate from the app when a run will be done, and sees whether the machine can carry the load.

## Positioning

Every job gets a fresh, isolated Linux container with its own Docker daemon and is still fast: a reserve of prepared runners and caches per repo (packages, build layers, images learned from the jobs) absorbs the setup. Comparable tools keep runners alive permanently and do not give jobs their own Docker.

## Operating Context

- Runs on a Windows machine with Docker Desktop; signs in to GitHub through its own GitHub App "RunClub" (device flow with a one-time code) and acts only in the repos the app is installed on.
- Sits in the notification area and runs in the background; the window is opened when needed and closed again without runners ending.
- Several projects (repos) in parallel, each with its own pool.
- The machine is also a work machine: memory is scarce, the Docker VM has less memory than Windows.
- The repos' workflows point to the self-hosted runners through a repo variable (`CI_RUNNER`).

## Capabilities and Constraints

Available:

- Pool per repo with an adjustable number of slots, pause, reserve, caches to clear; limits per job (memory and cores) with a suggestion from the measurements.
- Repo selection from the GitHub account.
- Running runs as a network plan: all jobs with their dependencies (from `needs` in the workflow file), current step, usual duration and rough remaining time.
- History of the load on Windows and the Docker VM, usage per job (duration, peak RAM, CPU), waiting time for a runner.
- Start with Windows, icon in the notification area.

Terms: **Pool** (runners of a repo), **Slot** (one job that can run at the same time), **Reserve** (prepared runners without a job), **Run** (workflow run), **Job**, **Step**.

Limits:

- Linux runners only. Windows runners were dropped on purpose.
- Remaining time is an estimate from earlier runs.
- Technology: plain HTML, CSS and JavaScript without a build step in an Electron window.

Open:

- Whether and under which license RunClub will be published.

## Brand Commitments

- Name: **RunClub**.
- Icon: running track in orange and white on midnight blue with a green dot (`build/icon.png`).
- Interface in German and English, switchable.

## Evidence on Hand

- Real data from live operation: `/api/status` of the app, plus `history.json` and `metrics.json` under `%APPDATA%\RunClub\data`.
- Three earlier layout drafts with feedback from the user: the sidebar with projects is liked; the pipeline should be visible as a whole, not as a list; the drafts were too text-heavy and looked like AI.
- No user numbers, testimonials or comparative measurements. Do not invent any of them.

## Product Principles

1. **State first, then settings.** What is running and how much longer comes first; setup lives one level deeper.
2. **One glance must be enough.** The answer to “is something running, how long, is something red” can be seen without reading.
3. **Show relationships, don't enumerate.** A run is a pipeline with dependencies and bottlenecks, not a list of rows.
4. **Estimates are recognizable as estimates.** Remaining times and suggestions do not pretend to be more precise than they are.
5. **The machine belongs to the user.** The app shows honestly what it costs in memory and CPU, and warns before things get tight.
