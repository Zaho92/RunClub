# The images RunClub starts next to the runner image, pinned by version and digest: a moving tag
# (`dind`, `latest`) can be something else overnight. Nothing is built from this file:
# src/names.js reads the FROM lines, and Dependabot (.github/dependabot.yml) proposes new versions. To bump by
# hand: pull the new version, read `docker image inspect --format '{{index .RepoDigests 0}}'`, enter both here.
FROM docker:29.9.1-dind-rootless@sha256:825e451c9bd898245ca8fb07bd9a48999ccf33c0192fd68594c73aed7b67d11f AS dind
FROM moby/buildkit:v0.34.0-rootless@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855 AS buildkit
