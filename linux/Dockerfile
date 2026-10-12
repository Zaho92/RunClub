# Abbild für die eigenen Linux-Runner: GitHubs Runner-Abbild plus das, was die Jobs voraussetzen und
# GitHubs eigene Rechner mitbringen. Was hier liegt, ist je Job frisch und muss nicht geladen werden.
# Gebaut wird beim Start der Runner-Verwaltung (monitor.js), jeweils mit dem neuesten Runner.

FROM node:24-slim AS node
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet

FROM ghcr.io/actions/actions-runner:latest

USER root

# GitHub CLI: die Workflows rufen `gh` auf. zstd: `actions/cache` packt damit.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh zstd \
 && rm -rf /var/lib/apt/lists/*

# Node: Skripte der Workflows (`node .github/scripts/...`).
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# .NET-SDK: `actions/setup-dotnet` findet die Version vor und lädt nur, wenn eine neuere verlangt ist –
# dafür gehört der Ordner dem Benutzer des Runners.
COPY --from=dotnet --chown=runner:runner /usr/share/dotnet /usr/share/dotnet
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_INSTALL_DIR=/usr/share/dotnet \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

# Der Docker-Daemon gehört zum Job und läuft im Nachbar-Container; erreicht wird er über diesen Socket.
ENV DOCKER_HOST=unix:///sock/docker.sock

# `docker build` nutzt den Build-Dienst des Repos, wenn es einen gibt (siehe docker-shim.sh).
COPY --chmod=755 docker-shim.sh /usr/local/bin/docker

USER runner
