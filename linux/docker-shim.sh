#!/bin/bash
# Sits in the runner image as `docker` in front of the real program.
# A plain `docker build` goes to the repo's build service, which keeps its layers between jobs
# (RC_BUILDER, set by the runner management). Everything else passes through unchanged – including
# `docker buildx build`: whoever sets up their own builder, say for publishing, builds without the
# shared cache. If the build service is unreachable, the job's own daemon builds, just slower.

real=/usr/bin/docker
# The build service's socket (SOCKET in src/caches.js).
socket=/run/rc-buildkit/buildkitd.sock

# The service is reachable if the socket can be opened. curl does not speak buildkit, but code 7 means
# "no connection" (service stopped, socket orphaned) and 28 "no answer"; anything else reached it.
reachable() {
  [ -S "$socket" ] || return 1
  curl -s --max-time 3 --unix-socket "$socket" http://buildkit/ -o /dev/null
  case $? in 7|28) return 1 ;; esac
}

if [ "$1" = "build" ] && [ -n "$RC_BUILDER" ] && reachable; then
  shift
  exec "$real" buildx build --builder "$RC_BUILDER" "$@"
fi

exec "$real" "$@"
