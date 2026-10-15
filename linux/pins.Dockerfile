# Die Abbilder, die RunClub neben dem Runner-Abbild startet, festgenagelt per Version und Digest: Ein bewegliches
# Etikett (`dind`, `latest`) kann von heute auf morgen etwas anderes sein. Gebaut wird aus dieser Datei nichts:
# src/names.js liest die FROM-Zeilen, und Dependabot (.github/dependabot.yml) schlägt neue Versionen vor. Von Hand
# anheben: neue Version laden, `docker image inspect --format '{{index .RepoDigests 0}}'` ablesen, beides hier eintragen.
FROM docker:29.9.0-dind@sha256:0b6d18a4a222e71c88be6034926b4f6cde2fc33c2218643d03ccfddc65995470 AS dind
FROM moby/buildkit:v0.34.0-rootless@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855 AS buildkit
