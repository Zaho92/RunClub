# The Docker daemon of a pair, without privileges: `docker:dind-rootless` (version and digest in linux/pins.Dockerfile),
# but as user 1001 like `runner` in the runner image. Then files a job container writes into the work folder
# belong to the runner, and root in a job container is only this user outside of it.
# Built when the runner management starts (see src/dockerwatch.js), with the pinned image as BASE.

ARG BASE
FROM ${BASE}

# 1001 is RUNNER_USER, /sock the folder of PAIR_SOCKET (both in src/dind.js); if something changes there, change it here too.
USER root
RUN sed -i 's/^rootless:x:1000:1000:/rootless:x:1001:1001:/' /etc/passwd \
 && sed -i 's/^rootless:x:1000:/rootless:x:1001:/' /etc/group \
 && chown -R 1001:1001 /home/rootless \
 && mkdir -p /run/user/1001 /sock \
 && chown 1001:1001 /run/user/1001 /sock

# Only the socket, no TCP port with its own certificates.
ENV XDG_RUNTIME_DIR=/run/user/1001 \
    DOCKER_TLS_CERTDIR=
USER rootless
