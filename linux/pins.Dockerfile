# The images RunClub starts next to the runner image, pinned by version and digest: a moving tag
# (`dind`, `latest`) can be something else overnight. Nothing is built from this file:
# src/names.js reads the FROM lines, and Dependabot (.github/dependabot.yml) proposes new versions. To bump by
# hand: pull the new version, read `docker image inspect --format '{{index .RepoDigests 0}}'`, enter both here.
FROM docker:29.9.0-dind-rootless@sha256:54155db4950e2f9af3bb829fcfe627030576fc7ae235018be63175fca7326171 AS dind
FROM moby/buildkit:v0.34.1-rootless@sha256:f68752a5a94acfcdad2d07867b7075601a421638e17fc5f28efc1c814d0c4f89 AS buildkit
