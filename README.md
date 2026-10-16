# RunClub

Eigene GitHub-Actions-Runner auf dem eigenen Windows-Rechner: je Job ein frischer Linux-Container mit eigenem
Docker-Daemon, dazu eine Reserve vorbereiteter Runner und Caches je Repo. RunClub liegt im Infobereich und
zeigt seine Oberfläche in einem Fenster.

## Voraussetzungen

- Docker Desktop, gestartet
- GitHub CLI (`gh`), installiert; das Konto braucht Verwaltungsrecht auf den Repos
- Node.js nur zum Entwickeln (siehe unten); der Installer bringt alles mit

RunClub nutzt die Anmeldung von `gh`, dieselbe wie im Terminal, und braucht dafür das Recht `repo`; mit dem
Recht `user` zeigt es zusätzlich das Minuten-Kontingent des Kontos. Das Anmelden in der App verlangt beide in einem
Schritt; `user` ist freiwillig in dem Sinn, dass sein Fehlen keine Störung ist. Anmelden geht in
der App (Einstellungen → GitHub: Einmalcode, Bestätigung im Browser) oder wie bisher im Terminal
(`gh auth login`). Dort lässt sich auch ein fehlendes Recht ergänzen und wieder abmelden; Abmelden meldet
auch `gh` im Terminal ab. Ein Token oder ein anderer Host aus der Umgebung (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`)
gilt für RunClub nicht: Es arbeitet nur mit der Anmeldung von `gh` bei github.com.

Die Jobs eines Repos müssen auf eigene Runner zeigen: `runs-on: [self-hosted, Linux]`. Wer umschaltbar bleiben
will, liest das Ziel aus einer Repo-Variablen:

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}
```

und setzt `CI_RUNNER` im Repo auf `["self-hosted","Linux"]`.

## Installieren

Den Installer `RunClub-Setup-X.Y.Z.exe` aus den [Releases](https://github.com/Zaho92/RunClub/releases) laden und
starten. Er ist nicht signiert: Windows warnt deshalb „Unbekannter Herausgeber“ („Weitere Informationen“ → „Trotzdem
ausführen“). RunClub landet in `%LOCALAPPDATA%\Programs\RunClub`, mit Verknüpfung im Startmenü; die Daten liegen in
`%APPDATA%\RunClub` und bleiben beim Aktualisieren und Deinstallieren erhalten.

## Aktualisieren

RunClub sieht kurz nach dem Start und danach alle sechs Stunden in den Releases nach, lädt eine neuere Version im
Hintergrund und prüft sie gegen die Prüfsumme im Release. Eingespielt wird erst auf Klick (Einstellungen → App →
„Jetzt aktualisieren“), und nur, wenn kein Runner arbeitet: RunClub baut dabei wie beim Beenden alle Runner ab, startet
den Installer und öffnet sich danach wieder.

Der Kanal steht in denselben Einstellungen: **Stabil** bekommt nur abgenommene Versionen, **Beta** auch Vorabversionen.
Solange das Repo privat ist, liest RunClub die Releases mit der Anmeldung von `gh`.

Das Fenster zu schließen beendet nichts. Beendet wird über das Symbol im Infobereich (Rechtsklick → Beenden)
oder „Alles beenden“ in der Oberfläche; dabei enden auch die Runner.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/main.js` | Fenster, Infobereich, Start mit Windows |
| `src/backend.js` | Nur Verdrahtung: `start()` legt die Module an, startet die Takte und den lokalen Dienst und beendet alles wieder (Ablauf in `src/lifecycle.js`) |
| `src/lifecycle.js` | Start und Ende eines Programmlaufs: Takte, Start der Pools, Schlüsseldatei, Beenden, schnelles Abmelden beim Abmelden von Windows |
| `src/settings.js`, `src/names.js` | Einstellungen und Gelerntes im Datenordner; Namen der Abbilder, Kennzeichen und Namen der Caches und Build-Dienste je Repo |
| `src/runners.js` | Verdrahtet Vorlage, Plätze, Caches und Pools miteinander (auch für die Tests) |
| `src/remote.js` | Was bei GitHub gelesen wird: Läufe und Jobs, Anfragelimit, Repos des Kontos, wartende Läufe, Sichtbarkeit der Repos; Läufe erneut starten |
| `src/account.js` | Anmeldung bei GitHub und Minuten-Kontingent im selben Takt |
| `src/usage.js` | Messung: `docker stats`, Belegung der VM, Auslastung von Windows, Verbrauch je Job |
| `src/status.js`, `src/actions.js`, `src/server.js` | Was die Oberfläche sieht, was sie auslösen kann, und der lokale Dienst dafür |
| `src/engine.js` | Wo Docker läuft (heute Docker Desktop): Aufrufe der CLI, Endpunkt, WSL-Distro für die Messung der VM |
| `src/dockerwatch.js` | Die Docker-Überwachung: vorbereiten, sobald Docker antwortet, regelmäßig prüfen, die beiden eigenen Abbilder (Runner und Docker-Daemon) bauen, Reste abräumen |
| `src/dind.js` | Der Docker-Daemon in einem Container (Daemon eines Paars, Lade-Daemon der Vorlage): Abbild, Benutzer, Socket, Optionen für den Betrieb ohne Rechte, Warten, bis er antwortet; dasselbe Abbild als Werkzeug für Volumes |
| `src/slots.js` | Lebenslauf eines Platzes: ein Paar aufbauen, den Runner anmelden, einen Job bedienen, abräumen, im Leerlauf abbrechen |
| `src/pools.js` | Einen Pool anlegen und vorbereiten, Reserve eines Pools (nachfüllen, erneuern, abbauen), Zahl der Plätze angleichen, einen Pool zur Ruhe bringen |
| `src/seed.js` | Vorlage eines Repos: die Abbilder eines Jobs lernen, die Vorlage auffrischen, Kopieren und Auffrischen gegeneinander sperren |
| `src/housekeeping.js` | Der Takt der Aufräumarbeit bei GitHub: Sichtbarkeit der Repos prüfen (öffentlich gewordene pausieren) und verwaiste Runner abmelden, nur wenn das Anfragelimit es erlaubt |
| `src/caches.js` | Paket-Cache und Build-Dienst eines Repos (ohne Rechte, über einen Socket erreichbar) bereitstellen, mit neuen Limits oder nach einem Fehlschlag neu anlegen, leeren, die Volumes messen |
| `src/pipeline.js` | Läufe mit ihren Jobs, Abhängigkeiten aus der Workflow-Datei (`needs`), übliche Dauer, Restzeit |
| `src/metrics.js` | Verlauf der Auslastung von Windows und Docker-VM, Verbrauch je Job |
| `src/vmmemory.js` | Belegung der Docker-VM aus `/proc/meminfo` (mit Kernel und Daemon), Regel für die Warnung, wenn kaum noch Speicher frei ist |
| `src/routing.js` | Repo-Variable `CI_RUNNER`: schaltet die Jobs eines Repos auf die eigenen Runner und zurück |
| `src/access.js` | Wer den lokalen Dienst benutzen darf: Schlüssel je Programmlauf, Cookie, Kopfzeilen der Seite |
| `src/limits.js` | Limits je Job: Grenzen aus der Docker-VM, Vorschlag aus den Messwerten, Standard und Ausreißer |
| `src/github.js` | Aufrufe von `gh`: bedingte Abfragen (ETag), Stand des Anfragelimits, wann seltener oder nicht mehr abgefragt wird, die Umgebung, mit der `gh` läuft |
| `src/auth.js` | Anmeldung bei GitHub über `gh auth`: Stand lesen (Konto, Rechte, was fehlt), Anmelden und Ergänzen eines Rechts mit Einmalcode führen, abbrechen, abmelden |
| `src/minutes.js` | Minuten-Kontingent von GitHub Actions: Verbrauch des Monats aus der Abrechnung des Kontos (je Betriebssystem, bezahlt), enthaltene Minuten als Annahme je Tarif, Zustand knapp, aufgebraucht oder bezahlt, wann wieder gelesen wird |
| `src/journal.js` | Protokoll: Einträge mit Zeit, Projekt, Meldung und Art; die letzten im Speicher und für den nächsten Start in `runclub.log.entries`, alle lesbar in `runclub.log` |
| `src/subnets.js` | Netze der Paare und Build-Dienste: je ein zufälliges /28 aus einem eigenen Bereich statt aus Dockers knappem Vorrat |
| `src/waiting.js` | Läufe ohne Pool, die nicht vorankommen: Repos des Kontos, in denen Jobs auf einen eigenen Runner warten oder Läufe am aufgebrauchten Kontingent von GitHub gescheitert sind |
| `src/run.js`, `src/store.js`, `src/images.js`, `src/pairs.js`, `src/states.js`, `src/units.js`, `src/numbers.js` | Programmaufrufe mit Zeitgrenze und Abbruch von außen (das Programm wird unter Windows nur in PATH gesucht), Dateien im Datenordner, Regeln für gelernte Abbilder, Namen der Runner-Paare, Zustände eines Platzes, Einheiten für Zeit und Speicher, Median |
| `src/ui.html` | Oberfläche: Projektleiste, Netzplan je Lauf, Auslastung, Verbrauch, Einstellungen (Deutsch und Englisch) |
| `src/fonts/` | Schrift Overpass (OFL), liegt in der App, damit sie ohne Internet funktioniert |
| `linux/` | Abbild der Runner (`Dockerfile`, mit `docker-shim.sh`), Abbild des Docker-Daemons ohne Rechte (`dind/Dockerfile`) und die festgenagelten Abbilder von Daemon und Build-Dienst (`pins.Dockerfile`, nur gelesen, nicht gebaut) |
| `scripts/make-icon.js` | zeichnet das Symbol nach `build/` (`npm run icon`) |

Einstellungen, Gelerntes und Protokoll liegen unter `%APPDATA%\RunClub\data`.
`npm run backend` startet nur den Dienst, ohne Fenster (Daten dann unter `%APPDATA%\RunClub\backend`, getrennt von denen der App); die Adresse zum Öffnen steht dann in der Konsole.

Umgebungsvariablen: `RUNCLUB_DATA` (Datenordner), `RUNCLUB_PORT` (Port des Dienstes, sonst 8770) und
`RUNCLUB_SUBNETS` (Bereich, aus dem die Netze der Runner ihr Subnetz bekommen, sonst `10.213.0.0/16`; von /8 bis /24.
Nötig nur, wenn der Bereich schon vergeben ist, etwa durch ein VPN). Für eine andere Docker-Engine als Docker Desktop:
`RUNCLUB_DOCKER_HOST` (Endpunkt des Daemons, geht als `DOCKER_HOST` an die CLI; am besten eine Named Pipe oder `ssh://`,
ein `tcp://` nur mit TLS über `RUNCLUB_DOCKER_CERTS`, dem Ordner mit `ca.pem`, `cert.pem` und `key.pem`, weil sonst
jeder, der den Port erreicht, auch ein Job, den Daemon steuert) und `RUNCLUB_DOCKER_DISTRO` (WSL-Distro des Daemons für
die Messung der VM; ohne Angabe `docker-desktop`, mit eigenem Endpunkt keine; leer: keine Messung). Ohne
`RUNCLUB_DOCKER_HOST` gilt, was die Docker-CLI ohnehin nimmt (auch ein `DOCKER_HOST` oder Kontext des Benutzers).

Die Oberfläche und ihre Daten bekommt nur das eigene Fenster: Der Dienst ist unter Docker Desktop auch aus den
Containern der Jobs erreichbar, deshalb verlangt er einen Schlüssel, der bei jedem Start neu entsteht
(`access.key` im Datenordner, siehe `src/access.js`). Gedacht ist das für das eigene Fenster. Wer die Einstiegsadresse
stattdessen in einem gewöhnlichen Browser öffnet, sollte wissen: Das Cookie gilt dort für alle Ports auf `127.0.0.1`,
also auch für andere lokale Dienste, und die Adresse mit dem Schlüssel bleibt im Verlauf.

Kein Container der Runner läuft mit `--privileged`: Der Docker-Daemon jedes Jobs und der Build-Dienst laufen als
gewöhnliche Benutzer (rootless). Wer aus einem Container ausbricht, den ein Job startet, landet im Daemon-Container
seines Jobs, nicht in der Docker-VM. Die Schritte des Jobs selbst haben im Runner-Container per `sudo` root, mit
Dockers üblichen Capabilities ohne `NET_RAW`, `MKNOD`, `SETFCAP`, `SETPCAP`, `SYS_CHROOT` und `NET_BIND_SERVICE`; wer
aus dem Runner-Container ausbricht, ist root in der Docker-VM. Gegen jeden Angriff schützt das nicht; auf den Runnern
soll nur Code laufen, dem du vertraust. Pools gibt es deshalb nur für private Repos, und wird ein Repo öffentlich,
pausiert sein Pool.
Neue Versionen der festgenagelten Abbilder (`linux/Dockerfile`, `linux/pins.Dockerfile`) schlägt Dependabot vor.

Was der Daemon ohne Rechte für Jobs ändert: Er hat sein eigenes Netz im Daemon-Container. Ports, die ein Job
veröffentlicht (`docker run -p`, `services:` im Workflow), erreicht der Runner auf `localhost`; `--network host`
meint dagegen das Netz des Daemons, nicht das des Runners. Ein Container mit `--network host` sieht also keine Dienste,
die ein Schritt im Runner auf `localhost` startet, und umgekehrt.

## Entwicklung

```sh
npm run check   # Syntax aller Skripte, auch des Skripts in der Oberfläche
npm test        # Tests aller Module außer backend.js und main.js
```

Ohne Installer starten:

```sh
npm install
npm start
```

Neben der installierten App läuft eine Entwicklungsinstanz nur mit eigenem Datenordner und Port und nur als Dienst
(`RUNCLUB_DATA` auf einen leeren Ordner, `RUNCLUB_PORT` auf einen anderen Port, `npm run backend`); siehe `CLAUDE.md`,
warum zwei Instanzen nie dieselben Repos bedienen dürfen. Den Installer lokal bauen: `npm run dist` (landet in `dist/`).

### Release: QS → Live

Es gibt keinen eigenen QS-Zweig. QS ist der Kanal Beta.

1. Entwickelt wird auf Feature-Branches, fertig geht es nach `main`.
2. Eine Beta entsteht mit einem Tag auf `main`: `git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1`. Der Workflow
   `.github/workflows/release.yml` baut auf Windows den Installer und legt ihn als Vorabversion ab; jede RunClub im
   Kanal Beta bietet ihn danach an.
3. Die Beta wird im eigenen Betrieb erprobt. Was auffällt, kommt als nächste Beta (`-beta.2`).
4. Ist eine Beta abgenommen, bekommt **derselbe Commit** den stabilen Tag: `git tag v0.2.0 v0.2.0-beta.2 && git push
   origin v0.2.0`. Der Workflow legt ihn als gewöhnlichen Release ab, den auch der Kanal Stabil bekommt.

Die Version kommt aus dem Tag; `version` in `package.json` wird dafür nicht angefasst.

Dieselben beiden Schritte laufen als CI bei jedem Push und Pull Request (`.github/workflows/ci.yml`).
Hinweise für die Arbeit mit Claude Code stehen in `CLAUDE.md`, die Produktbeschreibung für die Gestaltung in `PRODUCT.md`.
Die Gestaltung folgt dem Skill [Impeccable](https://github.com/pbakaus/impeccable) (`npx impeccable install --providers=claude --project`).
