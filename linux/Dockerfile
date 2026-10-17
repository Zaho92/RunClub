# Image for our own Linux runners: GitHub's runner image plus what the jobs expect and what GitHub's own
# machines ship with. Whatever lives here is fresh for each job and need not be downloaded.
# Built when the runner management starts (see src/dockerwatch.js), each time with the latest runner.

# Node and the .NET SDK are pinned by digest: the image holds the Docker daemon's socket inside the job, so a
# substituted image would be as powerful as that daemon. Dependabot proposes new versions (.github/dependabot.yml).
# The runner itself deliberately tracks the latest version: GitHub rejects runners that are too old.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS node
FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:0d99ebf1ccad15037b5c98c9fe8979d6b8dbac23812feae2277a0b277b5c5ffa AS dotnet

FROM ghcr.io/actions/actions-runner:latest

USER root

# GitHub CLI: the workflows call `gh`. zstd: `actions/cache` compresses with it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh zstd \
 && rm -rf /var/lib/apt/lists/*

# Node: scripts of the workflows (`node .github/scripts/...`).
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# .NET SDK: `actions/setup-dotnet` finds the version in place and only downloads when a newer one is required –
# for that the folder belongs to the runner's user.
COPY --from=dotnet --chown=runner:runner /usr/share/dotnet /usr/share/dotnet
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_INSTALL_DIR=/usr/share/dotnet \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

# The Docker daemon belongs to the job and runs in the neighbouring container; it is reached through this socket.
ENV DOCKER_HOST=unix:///sock/docker.sock

# `docker build` uses the repo's build service if there is one (see docker-shim.sh).
COPY --chmod=755 docker-shim.sh /usr/local/bin/docker
# Checked out on Windows the script may carry CRLF; then the kernel cannot find the shell.
RUN sed -i 's/\r$//' /usr/local/bin/docker

USER runner
