#!/bin/bash
# Steht im Runner-Abbild als `docker` vor dem echten Programm.
# Ein einfaches `docker build` geht an den Build-Dienst des Repos, der seine Layer zwischen den Jobs behält
# (RC_BUILDER, von der Runner-Verwaltung gesetzt). Alles andere reicht es unverändert durch – auch
# `docker buildx build`: Wer einen eigenen Builder einrichtet, etwa zum Veröffentlichen, baut ohne den
# geteilten Cache. Ist der Build-Dienst nicht erreichbar, baut der Daemon des Jobs selbst, nur langsamer.

real=/usr/bin/docker

if [ "$1" = "build" ] && [ -n "$RC_BUILDER" ] && timeout 3 bash -c '</dev/tcp/buildkit/1234' 2>/dev/null; then
  shift
  exec "$real" buildx build --builder "$RC_BUILDER" "$@"
fi

exec "$real" "$@"
