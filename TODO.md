# Offene Punkte

Stand: 13.10.2026. Die Reihenfolge innerhalb eines Abschnitts ist die empfohlene. Wie hier gearbeitet wird, steht in
`CLAUDE.md`; wofür die App da ist, in `PRODUCT.md`; wie sie aussieht und warum, in `DESIGN.md`.

## Als Nächstes

1. **Wartende Läufe ohne Pool finden.** Die Repos des Kontos nach Läufen durchsuchen, die auf einen Runner warten, und
   anbieten, einen Pool anzulegen. Auf das Anfragelimit achten (5.000 je Stunde; im Leerlauf verbraucht RunClub rund 720).
2. **Installer.** Eigenständige App statt der Verknüpfung auf den Entwicklungsordner (`electron-builder`, NSIS). Bekannte
   Hürde unter Windows: Das Paket `winCodeSign` enthält symbolische Links und lässt sich ohne Entwicklermodus oder
   Administratorrechte nicht entpacken. `asar` muss aus bleiben oder `linux/` als `extraResources` mitkommen, weil
   `docker build` einen echten Ordner braucht.
3. **Repo umziehen** nach `D:\Development\Projects\` (dort liegen alle anderen Repos des Nutzers; dieses liegt nur
   deshalb unter `C:\actions-runner\runclub`, weil hier begonnen wurde). Nur bei beendeter App. Mitziehen: die
   Startmenü-Verknüpfung und der Autostart-Eintrag (beide zeigen auf den Entwicklungsordner) sowie alles, was den alten
   Pfad fest nennt (`TODO.md`, `README.md`, Skripte). Der Datenordner unter `%APPDATA%\RunClub` bleibt, wo er ist.
4. **MCP-Server aus der App heraus.** Idee des Nutzers: KIs (Claude Code und andere) sollen RunClub befragen und steuern
   können. Lesen: Auslastung von Rechner und Docker-VM samt Verlauf, Plätze und ihr Zustand, Verbrauch je Job, Limits,
   Größe der Caches, Protokoll. Steuern: Zahl der Plätze, Pause, Limits („wie stark die Runner sind“). Die Läufe selbst
   holt eine KI schon von GitHub; RunClub liefert, was GitHub nicht weiß (Restzeit, Wartezeit auf einen Runner, was ein
   Job den Rechner kostet). Vor dem Bau klären: welche weiteren Werkzeuge sinnvoll sind, und der Zugriff. Der Server
   darf nicht zum Weg um den Schlüssel aus `src/access.js` werden, über den ein Job die App steuert; Löschendes
   (Pool entfernen, Caches leeren, beenden) bleibt außen vor oder braucht eine Bestätigung in der App.

## Zwischendurch, regelmäßig

- **Code-Review.** Nach größeren Blöcken den Stand prüfen lassen, im Stil von Matt Pocock: Skill
  `mattpocock-skills:code-review` (Regeln des Repos und Auftragstreue, zwei getrennte Durchgänge) über die Änderungen
  seit dem letzten Review.
- **Sicherheitsdurchgang** dazu: Skill `security-review`. Besonders ansehen: der lokale Dienst (Port 8770, Token und
  Host-Prüfung in `src/backend.js`), alles, was aus GitHub-Antworten in Befehle oder ins HTML gelangt (Repo-, Job- und
  Schrittnamen), und die Abschottung der Runner (privilegierte Container, Volumes, was Jobs schreiben dürfen).
- Der erste Durchgang über den ganzen Stand lief am 13.10.2026 (beide). Behoben ist, was unten nicht mehr steht;
  der nächste Durchgang prüft die Änderungen seit diesem Tag.

## Aus dem ersten Review noch offen

Sicherheit:

- **Privilegierte Container sind keine Sicherheitsgrenze.** Ein Job kann aus seinem Docker-Daemon in die Docker-VM
  ausbrechen und erreicht dort die Paare und Caches der anderen Repos. Bis das gelöst ist, gibt es Pools nur für private
  Repos (`pool/add` lehnt öffentliche ab). Grundsätzliche Lösung: Daemon ohne `--privileged` (rootless dind, sysbox oder
  Enhanced Container Isolation von Docker Desktop). Vor einer Veröffentlichung von RunClub klären.
- **Caches sind zwischen Branches beschreibbar.** Ein Job auf einem Branch kann den NuGet-Ordner und den Build-Cache
  verändern, den ein späterer Job auf `main` benutzt. Möglich: Caches nur für den Standard-Branch beschreibbar einhängen.
  Entscheidung des Nutzers, weil es Läufe auf Branches langsamer macht.
- **Abbilder ohne feste Version** (`docker:dind`, `moby/buildkit:latest`, `actions-runner:latest`, `node:24-slim`) laufen
  privilegiert. Per Digest festnageln und gezielt anheben.

Richtigkeit:

- **Anfragelimit.** Ein Lauf, der tagelang offen bleibt (wartet auf Freigabe oder auf ein Label ohne Runner), hält sein
  Repo im 8-Sekunden-Takt; drei Repos mit je zwei solchen Läufen liegen über 5.000 Anfragen je Stunde. Gebraucht:
  bedingte Abfragen (ETag), schneller Takt nur bei Jobs auf eigenen Runnern, Takt strecken bei 403/429.
- **Phantom-Jobs im Netzplan.** Jobs mit Ausdruck im Namen (`Test ${{ matrix.os }}`) und Jobs aus wiederverwendeten
  Workflows (`uses:`) heißen bei GitHub anders als in der Datei; der angekündigte Job verschwindet dann nie und
  verlängert die Restzeit (`src/pipeline.js`, `actual()`).
- **Abmeldungen bleiben liegen**, wenn Windows abgemeldet wird (kein Haken in `src/main.js`) oder ein Job beim Beenden
  noch läuft. Aufgeräumt wird erst beim nächsten Start.
- **Runner-Abbild veraltet** bei wochenlanger Laufzeit; gebaut wird nur beim Start. Ohne Netz beim Start gibt es gar
  keine Runner, obwohl ein brauchbares Abbild vorliegt.
- **Auslastung der Docker-VM** zählt nur die Container (ohne Kernel, Daemon, Seitencache) und warnt nie; `PRODUCT.md`
  verspricht die Warnung. Die Summe „zusammen bis zu“ in „Verbrauch“ lässt den Build-Dienst je Repo aus.
- **Zwei verschiedene „übliche Dauern“**: `src/metrics.js` nimmt den Median aller Durchläufe, `src/pipeline.js` nur der
  erfolgreichen. Verbrauch wird nur nach Jobname geführt; gleichnamige Jobs aus zwei Workflows mischen sich.
- **Ein gescheiterter Reserve-Eintrag** zählt als vorhanden, bis ein Platz ihn zieht (`replenish` in `src/backend.js`).
- Die Endpunkte `slot/restart`, `run/rerun` und `api/ping` ruft die Oberfläche nicht auf: behalten oder entfernen?

Oberfläche:

- Nach mehr als 24 Stunden Pause zeichnet der Tagesverlauf alte Minuten und meldet eine Spitze „vor x Tagen“.

## Noch nicht echt ausprobiert

- **CI_RUNNER setzen und entfernen** gegen GitHub. Gelesen wird richtig, das Schreiben ist nur gegen ein nachgestelltes
  GitHub getestet (`test/routing.test.js`). Ausprobieren in Einstellungen → Projekt RunClub.
- **Stehenbleiben des Auslastungsbands** beim Scrollen und die Ansicht im **schmalen Fenster**: nur im Code und als Standbild geprüft.
- **Die letzte Korrekturrunde der Oberfläche** hat der Gutachter nicht mehr gegengeprüft.

## Offene Entscheidungen des Nutzers

- **Verspätung als „+0:33“** hinter der Zeit? Heute färbt sich die Zeit gelb, und das Detail sagt „länger als üblich (1:40)“.
  Idee des Nutzers, von ihm selbst als möglicherweise zu unruhig eingeschätzt.
- **Lizenz**, falls RunClub veröffentlicht wird. Das Repo ist privat und hat keine.
- **Alte Reste löschen** (nur mit ausdrücklichem Ja): der Ordner `C:\actions-runner\monitor` (das Vorgängerwerkzeug) und die
  Docker-Volumes mit Präfix `qd-` (rund 0,5 GB Caches des Vorgängers).

## Kleinere Punkte

- **Meldungen des Backends sind nur deutsch** (Protokoll, Fehlermeldungen, Zustände der Runner). Die Oberfläche übersetzt
  nur die Runner-Zustände nach. Für eine Veröffentlichung müsste das Backend Schlüssel statt Sätze liefern.
- **Fenster im Stil der App.** Titelleiste und die Knöpfe zum Minimieren, Maximieren und Schließen kommen von Windows
  und passen nicht zur Bildwelt. Gewünscht: rahmenloses Fenster mit eigener Titelleiste (in Electron `frame: false` oder
  `titleBarStyle: 'hidden'` mit `titleBarOverlay`, dazu ein ziehbarer Bereich). Schließen muss weiter nur das Fenster
  verstecken. Dazu gehört die **Rückfrage**: `confirm()` öffnet heute den nativen Dialog; eine in der Bildwelt der App fehlt.
  Ohne Eile, vom Nutzer als „finde ich gut“ eingestuft.
- **Erster Bildschirm** ist bis zur ersten Antwort leer; ein Gerüstzustand fehlt.
- **`src/backend.js` aufteilen.** Es startet beim Laden und ist deshalb nicht testbar. Pools, Reserve und Caches sind der
  ungetestete Kern; jede Änderung dort erst mit einem leeren Datenordner ausprobieren (siehe `CLAUDE.md`). Vorschlag aus
  dem Review: `createPools({ docker, gh, config, state, log, sleep })` als Modul, `backend.js` wird Verdrahtung mit
  einem `start()`. Zuerst testen: Lebenslauf eines Platzes (`serveOneJob`, `abortIdle`, `quiesce`), dann Vorlage und
  Gelerntes, dann die Docker-Überwachung.
- **Demo-Pipeline** (`.github/workflows/demo.yml`) entfernen, sobald sie zum Ansehen des Netzplans nicht mehr gebraucht wird.
- **Impeccable** liegt zusätzlich für GitHub Copilot unter `.github/skills` (nicht eingecheckt, 21 MB). Kann lokal weg.

## Erledigt (zur Einordnung)

Electron-App mit Symbol im Infobereich und Autostart · Windows-Runner entfernt · Repo-Auswahl aus dem GitHub-Konto ·
Netzplan je Lauf mit Abhängigkeiten aus `needs`, üblicher Dauer und Restzeit · Verlauf der Auslastung und Verbrauch je Job ·
neue Oberfläche „Midnight Transit“ mit Kompakt- und Detailmodus, Deutsch und Englisch · Läufe erscheinen sofort ·
CI_RUNNER wird beim Anlegen und Entfernen eines Pools gesetzt · Tests und CI auf den eigenen Runnern ·
erstes Code- und Sicherheits-Review mit Korrekturen (Zugriff nur mit Schlüssel, Zeitgrenzen, Docker-Aussetzer) ·
Einstellungen und Verbrauch als Strecke mit Haltestellen, Limits je Job einstellbar mit Vorschlag aus den Messwerten.
