# The images RunClub starts next to the runner image, pinned by version and digest: a moving tag
# (`dind`, `latest`) can be something else overnight. Nothing is built from this file:
# src/names.js reads the FROM lines, and Dependabot (.github/dependabot.yml) proposes new versions. To bump by
# hand: pull the new version, read `docker image inspect --format '{{index .RepoDigests 0}}'`, enter both here.
FROM docker:29.9.0-dind-rootless@sha256:54155db4950e2f9af3bb829fcfe627030576fc7ae235018be63175fca7326171 AS dind
FROM moby/buildkit:v0.34.0-rootless@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855 AS buildkit
