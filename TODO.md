# Offene Punkte

Stand: 13.10.2026. Die Reihenfolge innerhalb eines Abschnitts ist die empfohlene. Wie hier gearbeitet wird, steht in
`CLAUDE.md`; wofür die App da ist, in `PRODUCT.md`; wie sie aussieht und warum, in `DESIGN.md`.

## Als Nächstes

1. **Installer** (zurückgestellt am 13.10.2026, nicht jetzt). Eigenständige App statt der Verknüpfung auf den Entwicklungsordner (`electron-builder`, NSIS). Bekannte
   Hürde unter Windows: Das Paket `winCodeSign` enthält symbolische Links und lässt sich ohne Entwicklermodus oder
   Administratorrechte nicht entpacken. `asar` muss aus bleiben oder `linux/` als `extraResources` mitkommen, weil
   `docker build` einen echten Ordner braucht.
2. **Repo umziehen** nach `D:\Development\Projects\` (dort liegen alle anderen Repos des Nutzers; dieses liegt nur
   deshalb unter `C:\actions-runner\runclub`, weil hier begonnen wurde). Nur bei beendeter App. Mitziehen: die
   Startmenü-Verknüpfung und der Autostart-Eintrag (beide zeigen auf den Entwicklungsordner) sowie alles, was den alten
   Pfad fest nennt (`TODO.md`, `README.md`, Skripte). Der Datenordner unter `%APPDATA%\RunClub` bleibt, wo er ist.
3. **MCP-Server aus der App heraus.** Idee des Nutzers: KIs (Claude Code und andere) sollen RunClub befragen und steuern
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
- Drei Durchgänge liefen am 13.10.2026 (jeweils beide): über den ganzen Stand, über die Änderungen danach bis
  `4af3618` und über die bis `eba81c1` (Protokoll, GitHub-Anfragen). Behoben ist, was unten nicht mehr steht; der
  nächste Durchgang prüft die Änderungen danach. Über die Korrekturen aus dem dritten lief ein Abschluss-Review; was es
  fand, ist ebenfalls behoben (im Commit nach `eba81c1`), aber nicht noch einmal gegengelesen.

## Aus den Reviews noch offen

Sicherheit:

- **Privilegierte Container sind keine Sicherheitsgrenze.** Ein Job kann aus seinem Docker-Daemon in die Docker-VM
  ausbrechen und erreicht dort die Paare und Caches der anderen Repos. Bis das gelöst ist, gibt es Pools nur für private
  Repos (`pool/add` lehnt öffentliche ab). Vermutet, nicht geprüft: Unter Docker Desktop mit WSL2 liegt in der VM auch
  das Windows-Laufwerk; ein ausgebrochener Job käme dann an `access.key` und die Dateien des Nutzers. Der Schlüssel
  schützt also nur gegen Jobs, die nicht ausbrechen. Grundsätzliche Lösung: Daemon ohne `--privileged` (rootless dind, sysbox oder
  Enhanced Container Isolation von Docker Desktop). Vor einer Veröffentlichung von RunClub klären.
- **Caches sind zwischen Branches beschreibbar.** Ein Job auf einem Branch kann den NuGet-Ordner und den Build-Cache
  verändern, den ein späterer Job auf `main` benutzt. Möglich: Caches nur für den Standard-Branch beschreibbar einhängen.
  Entschieden am 13.10.2026: bleibt so, weil es Läufe auf Branches sonst langsamer macht.
- **Das Netz je Repo trennt Repos, nicht die Paare eines Repos.** Der Build-Dienst hängt in allen Paar-Netzen seines
  Repos; ein Build-Schritt könnte Ports erreichen, die ein gleichzeitig laufender Job desselben Repos veröffentlicht.
- **Abbilder ohne feste Version** (`docker:dind`, `moby/buildkit:latest`, `actions-runner:latest`, `node:24-slim`) laufen
  privilegiert. Per Digest festnageln und gezielt anheben.

Richtigkeit:

- **Zuordnung im Netzplan, Rest.** Ein Ausdruck im Namen passt auf beliebigen Text: `Test ${{ matrix.os }}` schluckt auch
  einen fremden `Test / Docker`. Wird ein Ausdruck leer ausgewertet, greift die Zuordnung nicht. Der angekündigte Job
  zeigt den rohen Namen mit `${{ … }}` und hat keine gelernte Dauer.
- **Abmeldungen bleiben liegen**, wenn Windows abgemeldet wird (kein Haken in `src/main.js`) oder ein Job beim Beenden
  noch läuft. Aufgeräumt wird erst beim nächsten Start.
- **Auslastung der Docker-VM** zählt nur die Container (ohne Kernel, Daemon, Seitencache) und warnt nie; `PRODUCT.md`
  verspricht die Warnung. Die Summe „zusammen bis zu“ in „Verbrauch“ lässt den Build-Dienst je Repo aus.
- **Verbrauch wird nur nach Jobname geführt**; gleichnamige Jobs aus zwei Workflows mischen sich.
- **Vorrat an Docker-Netzen.** Jedes Paar und jeder Build-Dienst belegt ein eigenes Netz; Docker hält in der
  Voreinstellung rund 30 bereit. Mit vielen Pools oder Plätzen reicht das nicht. Möglich: Netze mit kleinen, selbst
  vergebenen Subnetzen anlegen.
- **„Runner neu aufbauen“ kann einen Pool anhalten**, wenn gerade ein Cache geleert wird und in der Zwischenzeit ein Job
  startet: Der Pool nimmt dann bis zu dessen Ende keine weiteren Jobs an (`withPoolAtRest`). Selten.

## Noch nicht echt ausprobiert

- **Wartende Läufe ohne Pool** (`src/waiting.js`): nur gegen ein nachgestelltes GitHub getestet und als Standbild
  angesehen. Echt prüfen: in einem privaten Repo ohne Pool einen Lauf mit `runs-on: [self-hosted, Linux]` starten;
  nach spätestens fünf Minuten steht in „Alle Projekte“ die Zeile mit „Pool anlegen“.
- **Zuordnung im Netzplan** für Matrix-Jobs, Namen mit Ausdruck und aufgerufene Workflows: Die Namensformen von GitHub
  stammen aus der Dokumentation, nicht aus einem echten Lauf. Die eigenen Workflows nutzen nichts davon.
- **Tägliches Neubauen des Runner-Abbilds** und der Start ohne Netz mit vorhandenem Abbild: nur am Code geprüft.
- **Pause auf Bitte von GitHub** (403/429 mit `retry-after`): nur gegen ein nachgestelltes `gh` getestet.
- **GitHub-Anfragen knapp und aufgebraucht.** Echt gemessen ist nur der Normalfall (bedingte Abfragen zählen nicht; im
  Leerlauf 0 statt rund 36 Anfragen in drei Minuten). Seltener abfragen, nicht mehr abfragen und die Meldungen dazu
  sind nur gegen ein nachgestelltes `gh` getestet (`test/github.test.js`) und als Standbild angesehen.
- **Protokoll speichern und kopieren** im Fenster der App. Geprüft sind die Endpunkte (`/api/log`, `/api/log/file`) an
  einer Testinstanz und die Darstellung als Standbild. Am echten Fenster prüfen: „Speichern“ öffnet den Dialog von
  Windows, „Kopieren“ legt die ganze Datei in die Zwischenablage und meldet die Zahl der Zeilen.
- **Fenster ohne Titelleiste von Windows.** Am echten Fenster prüfen: Ziehen und Doppelklick am oberen Streifen (auch über
  der Leiste), Größe ändern an der oberen Kante, Andocken und Maximieren; ob die Knöpfe von Windows bündig mit dem
  32 px hohen Streifen abschließen; ob die Knöpfe im schmalen Fenster (bis 760 px) die Farbe der Leiste
  annehmen und beim Verbreitern zurückwechseln (`matchBar` in `src/main.js`).
- **Die Rückfrage der App** per Tastatur: „Abbrechen“ hat den Fokus mit sichtbarem Ring, Escape bricht ab.

- **Korrekturen aus dem zweiten Review**, alle nur am Code und in einer Testinstanz ohne Pools geprüft:
  der Build-Dienst zieht neue Limits von selbst nach, sobald im Pool nichts läuft (`renewService`, im Minutentakt);
  nach einer Unterbrechung von Docker werden liegen gebliebene Paare entfernt (`removeOrphans`); Runner und Docker
  eines Jobs bleiben zusammen unter dem Speicher der Docker-VM (der Regler springt nach dem Loslassen zurück, wenn
  die Summe zu hoch war). Im Betrieb beobachten, ob das Protokoll dazu passt.

- **Limits je Projekt und „Runner neu aufbauen“** (Einstellungen → Projekt aufklappen → Limits → „Eigene“). Getestet sind
  nur die Rechenregeln (`test/limits.test.js`). Im Betrieb prüfen: Ein Projekt mit eigenen Werten baut seine Paare damit
  (`docker inspect`), „Wie alle“ nimmt sie wieder weg, und „Runner neu aufbauen“ ersetzt die freien Runner, ohne einen
  laufenden Job zu stören.
- **„Vorschlag übernehmen“ für alle Projekte** (`limits/plan`): setzt den Standard und eigene Limits für Ausreißer in einem
  Schritt und nimmt allen anderen Projekten ihre eigenen Werte. Die Regeln sind getestet (`plan`, `rate` in
  `test/limits.test.js`), der Aufruf gegen die laufende App nicht.
- **Mehrere Limit-Änderungen kurz nacheinander.** Am 13.10.2026 scheiterten danach sieben Paare mit „Docker-Daemon
  startet nicht“, und die Reserve dreier Pools blieb leer. Vermutete Ursache: Docker gingen die Netze aus, weil alte und
  neue Paare zugleich standen (belegt ist das nicht, die Meldung zeigte nur den Hilfe-Hinweis). Seither laufen die
  Erneuerungen nacheinander, ein gescheiterter Eintrag verlässt die Reserve, und die Meldung nennt die Ursache. Beim
  nächsten Mal im Protokoll nachsehen, ob es dabei bleibt.

- **CI_RUNNER setzen und entfernen** gegen GitHub. Gelesen wird richtig, das Schreiben ist nur gegen ein nachgestelltes
  GitHub getestet (`test/routing.test.js`). Ausprobieren in Einstellungen → Projekt RunClub.
- **Stehenbleiben des Auslastungsbands** beim Scrollen und die Ansicht im **schmalen Fenster**: nur im Code und als Standbild geprüft.
- **Die letzte Korrekturrunde der Oberfläche** hat der Gutachter nicht mehr gegengeprüft.

## Offene Entscheidungen des Nutzers

- **Lizenz.** RunClub soll später veröffentlicht werden (Entscheidung des Nutzers, 13.10.2026); bis dahin eine wählen.

## Später

- **Schmale Ansicht als eigener Entwurf.** Einschätzung des Nutzers (13.10.2026): RunClub ist ein Werkzeug für den
  Desktop; die heutige schmale Ansicht (bis 760 px) schiebt nur alles untereinander, der Inhalt trägt dort nicht und
  ist schlecht bedienbar. Für jetzt genügt das, es gibt keinen Anspruch darauf. Wenn es einmal gebraucht wird, dann als
  Fenster, das am Rand mitläuft, mit eigenem Inhalt (was läuft, wie lange noch, ist etwas rot) statt der gestauchten
  Vollansicht. Bis dahin keinen Aufwand in die schmale Ansicht stecken; sie muss nur nicht kaputtgehen.

## Kleinere Punkte

- **Meldungen des Backends sind nur deutsch** (Protokoll, Fehlermeldungen, Zustände der Runner). Die Oberfläche übersetzt
  nur die Runner-Zustände nach. Für eine Veröffentlichung müsste das Backend Schlüssel statt Sätze liefern. Das
  Protokoll liefert schon Einträge mit Zeit, Projekt und Art getrennt (`src/journal.js`); nur `text` ist noch ein Satz.
- **Erster Bildschirm** ist bis zur ersten Antwort leer; ein Gerüstzustand fehlt.
- **`src/backend.js` aufteilen.** Es startet beim Laden und ist deshalb nicht testbar. Pools, Reserve und Caches sind der
  ungetestete Kern; jede Änderung dort erst mit einem leeren Datenordner ausprobieren (siehe `CLAUDE.md`). Vorschlag aus
  dem Review: `createPools({ docker, gh, config, state, log, sleep })` als Modul, `backend.js` wird Verdrahtung mit
  einem `start()`. Zuerst testen: Lebenslauf eines Platzes (`serveOneJob`, `abortIdle`, `quiesce`), dann Vorlage und
  Gelerntes, dann die Docker-Überwachung.
- **Demo-Pipeline** (`.github/workflows/demo.yml`) entfernen, sobald sie zum Ansehen des Netzplans nicht mehr gebraucht wird.

## Erledigt (zur Einordnung)

Electron-App mit Symbol im Infobereich und Autostart · Windows-Runner entfernt · Repo-Auswahl aus dem GitHub-Konto ·
Netzplan je Lauf mit Abhängigkeiten aus `needs`, üblicher Dauer und Restzeit · Verlauf der Auslastung und Verbrauch je Job ·
neue Oberfläche „Midnight Transit“ mit Kompakt- und Detailmodus, Deutsch und Englisch · Läufe erscheinen sofort ·
CI_RUNNER wird beim Anlegen und Entfernen eines Pools gesetzt · Tests und CI auf den eigenen Runnern ·
erstes Code- und Sicherheits-Review mit Korrekturen (Zugriff nur mit Schlüssel, Zeitgrenzen, Docker-Aussetzer) ·
Einstellungen und Verbrauch als Strecke mit Haltestellen, Limits je Job einstellbar mit Vorschlag aus den Messwerten,
auch je Projekt; freie Runner lassen sich mit neuen Limits neu aufbauen · eigene Rückfrage statt des Dialogs von
Windows, Fenster ohne Titelleiste von Windows · Protokoll als Liste mit Zeit, Projekt und Zustandssymbol, Filter nach
Projekt, ganze Datei speichern oder kopieren.
