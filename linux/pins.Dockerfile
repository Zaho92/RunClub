# The images RunClub starts next to the runner image, pinned by version and digest: a moving tag
# (`dind`, `latest`) can be something else overnight. Nothing is built from this file:
# src/names.js reads the FROM lines, and Dependabot (.github/dependabot.yml) proposes new versions. To bump by
# hand: pull the new version, read `docker image inspect --format '{{index .RepoDigests 0}}'`, enter both here.
FROM docker:29.9.0-dind-rootless@sha256:54155db4950e2f9af3bb829fcfe627030576fc7ae235018be63175fca7326171 AS dind
FROM moby/buildkit:v0.34.2-rootless@sha256:c8252268760e1baba80780d63d738ef9f260fb7c7c0973c78494cb9ddd99eda1 AS buildkit
