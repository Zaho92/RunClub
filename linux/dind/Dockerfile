# Der Docker-Daemon eines Paars, ohne Rechte: `docker:dind-rootless` (Version und Digest in linux/pins.Dockerfile),
# aber als Benutzer 1001 wie `runner` im Runner-Abbild. Dann gehören Dateien, die ein Job-Container in den
# Arbeitsordner schreibt, dem Runner, und root in einem Job-Container ist außerhalb nur dieser Benutzer.
# Gebaut wird beim Start der Runner-Verwaltung (siehe src/dockerwatch.js), mit dem festgenagelten Abbild als BASE.

ARG BASE
FROM ${BASE}

# 1001 ist RUNNER_USER, /sock der Ordner von PAIR_SOCKET (beide in src/dind.js); ändert sich dort etwas, dann auch hier.
USER root
RUN sed -i 's/^rootless:x:1000:1000:/rootless:x:1001:1001:/' /etc/passwd \
 && sed -i 's/^rootless:x:1000:/rootless:x:1001:/' /etc/group \
 && chown -R 1001:1001 /home/rootless \
 && mkdir -p /run/user/1001 /sock \
 && chown 1001:1001 /run/user/1001 /sock

# Nur der Socket, kein TCP-Port mit eigenen Zertifikaten.
ENV XDG_RUNTIME_DIR=/run/user/1001 \
    DOCKER_TLS_CERTDIR=
USER rootless
