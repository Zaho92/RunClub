#!/bin/bash
# Steht im Runner-Abbild als `docker` vor dem echten Programm.
# Ein einfaches `docker build` geht an den Build-Dienst des Repos, der seine Layer zwischen den Jobs behält
# (RC_BUILDER, von der Runner-Verwaltung gesetzt). Alles andere reicht es unverändert durch – auch
# `docker buildx build`: Wer einen eigenen Builder einrichtet, etwa zum Veröffentlichen, baut ohne den
# geteilten Cache. Ist der Build-Dienst nicht erreichbar, baut der Daemon des Jobs selbst, nur langsamer.

real=/usr/bin/docker
# Der Socket des Build-Dienstes (SOCKET_DIR in src/caches.js).
socket=/run/rc-buildkit/buildkitd.sock

# Erreichbar ist der Dienst, wenn sich der Socket öffnen lässt. curl versteht buildkit nicht, aber Code 7 heißt
# „keine Verbindung“ (Dienst beendet, Socket verwaist) und 28 „keine Antwort“; alles andere hat ihn erreicht.
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
