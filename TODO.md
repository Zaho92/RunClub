# Offene Punkte

Stand: 16.10.2026. Die Reihenfolge innerhalb eines Abschnitts ist die empfohlene. Wie hier gearbeitet wird, steht in
`CLAUDE.md`; wofür die App da ist, in `PRODUCT.md`; wie sie aussieht und warum, in `DESIGN.md`.

## Weg zur Veröffentlichung

Besprochen mit dem Nutzer am 16.10.2026. Ziel: RunClub als öffentliches Repo unter MIT, mit Installer zum Herunterladen
und einem Updater, der sich aus den GitHub-Releases selbst aktualisiert. Entschieden:

- **Lizenz MIT.**
- **Installer erst unsigniert** (Windows warnt beim Installieren „Unbekannter Herausgeber“); Signatur später nachrüstbar.
- **Updater:** lädt im Hintergrund, meldet „Update bereit“, eingespielt wird auf Klick und nur, wenn kein Runner arbeitet
  (Beenden baut alle Runner ab).
- **QS vor Live als Beta-Kanal** (entschieden 16.10.2026), keine zweite Instanz (zwei Instanzen mit denselben Pools
  melden sich gegenseitig die Runner ab). Tags `vX.Y.Z-beta.N` erzeugen Vorabversionen, `vX.Y.Z` stabile; der Updater
  hat einen Kanal „Stabil“/„Beta“, der Rechner des Nutzers läuft auf Beta. **Kein `qs`-Branch:** Feature-Branches →
  `main`, Betas werden von `main` getaggt; nimmt der Nutzer eine Beta ab, kommt der stabile Tag auf genau deren Commit.
- **Updater als eigenes Modul**, nicht `electron-updater` (bleibt ohne Laufzeit-Abhängigkeiten): GitHub-Releases-API,
  Download, SHA512-Prüfung gegen `latest.yml`, NSIS-Installer still starten; solange das Repo privat ist, mit dem
  Token der gh-Anmeldung.
- **Repo ganz englisch** (README, Doku, Kommentare, TODO, DESIGN; die Regel in `CLAUDE.md` ändert sich dann). Die
  Oberfläche bleibt zweisprachig. Erst in Schritt 3, damit nicht Code übersetzt wird, der gleich umgebaut wird.

Schritte, in dieser Reihenfolge:

1. **Installer und Updater** (siehe den Punkt unter „Als Nächstes“): `electron-builder` mit NSIS, Release-Workflow auf
   `windows-latest` bei Versions-Tags (umgeht die `winCodeSign`-Hürde auf diesem Rechner), eigener Updater mit den
   GitHub-Releases, Kanal Stabil/Beta, Anzeige in den Einstellungen (Abschnitt App: Version, Update bereit, Kanal),
   Startmenü und Autostart auf die installierte App umstellen, Branching und Ablauf QS → Live festlegen und in
   `README.md` beschreiben. Danach selbst über Wochen auf Beta betreiben.
2. **Sicher für Fremde:** Fork-PRs in Org-Repos und Seccomp-Profil (siehe „Aus den Reviews noch offen“), `SECURITY.md`
   mit Bedrohungsmodell.
3. **Verständlich für Fremde:** eigene OAuth-App (siehe „Offene Entscheidungen“), Backend-Meldungen als Schlüssel
   (siehe „Kleinere Punkte“), Repo ins Englische, README mit Bildschirmfotos, Prüfung beim ersten Start (Docker Desktop
   installiert und gestartet, WSL).
4. **Öffnen:** Übergangscode und Demo-Pipeline entfernen, `LICENSE`, Git-Historie auf Geheimnisse und Persönliches
   prüfen (sie wird mit öffentlich), Repo öffentlich stellen, Release 0.1.0.

Offen und unabhängig davon: Docker Engine statt Docker Desktop (Punkt 3 unten) und der MCP-Server (Punkt 4 unten).

## Als Nächstes

1. **Installer** (Schritt 1 des Wegs zur Veröffentlichung). Eigenständige App statt der Verknüpfung auf den Entwicklungsordner (`electron-builder`, NSIS). Bekannte
   Hürde unter Windows: Das Paket `winCodeSign` enthält symbolische Links und lässt sich ohne Entwicklermodus oder
   Administratorrechte nicht entpacken. `asar` muss aus bleiben oder `linux/` als `extraResources` mitkommen, weil
   `docker build` einen echten Ordner braucht. Mit dem Installer erledigt sich der Repo-Umzug (Punkt 2) fast
   nebenbei, weil Startmenü und Autostart dann nicht mehr auf den Entwicklungsordner zeigen.
2. **Repo umziehen** nach `D:\Development\Projects\` (dort liegen alle anderen Repos des Nutzers; dieses liegt nur
   deshalb unter `C:\actions-runner\runclub`, weil hier begonnen wurde). Nur bei beendeter App. Mitziehen: die
   Startmenü-Verknüpfung und der Autostart-Eintrag (beide zeigen auf den Entwicklungsordner) sowie alles, was den alten
   Pfad fest nennt (`TODO.md`, `README.md`, Skripte). Der Datenordner unter `%APPDATA%\RunClub` bleibt, wo er ist.
3. **Docker Engine statt Docker Desktop** (Idee des Nutzers, 14.10.2026; erst Analyse, dann entscheiden). Ziel: eine
   Abhängigkeit weniger. Eine eigene Docker Engine in einer eigenen WSL-Distro statt Docker Desktop. Für
   die Veröffentlichung spricht die Lizenz von Docker Desktop (in größeren Firmen kostenpflichtig) und mehr Kontrolle
   über den Daemon (etwa ein eigenes Seccomp-Profil oder sysbox, siehe unten). Dagegen:
   RunClub müsste die Distro selbst einrichten, starten und aktuell halten, und die Windows-CLI erreicht den Daemon nur
   über einen Umweg (Aufruf über `wsl`, gesicherter TCP-Port oder Weiterleitung einer Named Pipe). Erster Schritt erledigt
   (14.10.2026): Der Zugang zu Docker ist austauschbar (`src/engine.js`, Umgebungsvariablen `RUNCLUB_DOCKER_HOST`,
   `RUNCLUB_DOCKER_CERTS` und `RUNCLUB_DOCKER_DISTRO`; ohne Angabe wie bisher Docker Desktop). Bedingung für den
   Prototyp: Der Daemon ist nur über eine Named Pipe mit Rechten für den eigenen Benutzer, über `ssh://` oder über
   `tcp://` mit TLS und Client-Zertifikat erreichbar, nie über ein offenes `tcp://` (ein Job käme sonst ohne Ausbruch
   an den Daemon). Als Nächstes ein Prototyp mit einer Engine in einer Distro `runclub` messen (Kosten je
   `docker`-Aufruf, Start nach dem Booten, Speicher im Leerlauf gegenüber Docker Desktop).
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
  Host-Prüfung in `src/server.js` und `src/access.js`), alles, was aus GitHub-Antworten in Befehle oder ins HTML gelangt (Repo-, Job- und
  Schrittnamen), und die Abschottung der Runner (Daemons ohne Rechte, `sudo` im Runner-Container, Volumes, was Jobs schreiben dürfen).
- Drei Durchgänge liefen am 13.10.2026 (jeweils beide): über den ganzen Stand, über die Änderungen danach bis
  `4af3618` und über die bis `eba81c1` (Protokoll, GitHub-Anfragen). Behoben ist, was unten nicht mehr steht; der
  nächste Durchgang prüft die Änderungen danach. Über die Korrekturen aus dem dritten lief ein Abschluss-Review; was es
  fand, ist ebenfalls behoben (im Commit nach `eba81c1`), aber nicht noch einmal gegengelesen.
- Ein vierter Durchgang lief am 14.10.2026 über die Kontingent-Anzeige und die Korrekturen der Anmeldung
  (`19ae429..ab8212c`): Richtigkeit, Standards, Sicherheit und der Gutachter der Oberfläche. Alle Befunde sind
  behoben, und die Korrekturen sind gegengelesen (Code und Oberfläche); was das Gegenlesen fand, ist ebenfalls
  behoben, aber nicht noch einmal gelesen. `src/seed.js` und `src/caches.js` sind dabei mitgelesen worden.
- Ein fünfter Durchgang lief am 14.10.2026 über den ganzen Stand (Richtigkeit, Sicherheit, Standards), danach ein
  Abschluss-Review über die Korrekturen und den Umbau des Backends (`e427360..95f6a0c`). Was beide fanden, ist behoben
  (Commit nach `95f6a0c`), aber nicht noch einmal gelesen. Der nächste Durchgang prüft die Änderungen danach.
- Ein sechster Durchgang lief am 15.10.2026 über den ganzen Stand mit Schwerpunkt `95f6a0c..9686428` (Daemons ohne
  Rechte, festgenagelte Abbilder): Richtigkeit, Sicherheit, Standards. Alle Befunde sind behoben oder nach Entscheidung
  des Nutzers vermerkt (Fork-PRs, `--network host`), im Commit `1098b74`. Darüber lief ein Abschluss-Review
  (`9686428..1098b74`, Richtigkeit, Sicherheit, Standards); was es fand, ist im Commit danach behoben (vor allem: Ende
  und Ergebnis eines Jobs nicht mehr aus der Ausgabe des Runners), aber nicht noch einmal gelesen. Der nächste
  Durchgang prüft die Änderungen danach.

## Aus den Reviews noch offen

Der fünfte Durchgang (14.10.2026, über den Stand nach `08949b0`) und das Abschluss-Review über seine Korrekturen
(`e427360..95f6a0c`) sind abgearbeitet, ebenso der sechste (15.10.2026); behoben ist, was hier nicht mehr steht.
Entschieden am 15.10.2026: Die Docker-Daemons der Jobs laufen ohne Rechte (umgesetzt), `node` und das .NET-SDK sind
festgenagelt und Dependabot meldet neue Stände (umgesetzt); der localhost von Windows bleibt für die Jobs erreichbar
(siehe unten). Noch offen:

1. **Seccomp-Profil für Daemon und Build-Dienst.** Beide laufen ohne Rechte, brauchen dafür aber `seccomp=unconfined`
   (eigene Namensräume). Ein eigenes Profil, das nur das Nötige erlaubt, verkleinerte die Angriffsfläche am Kernel weiter.
   Erst angehen, wenn RunClub veröffentlicht wird.
2. **Fork-PRs in Org-Repos** (sechster Durchgang, 15.10.2026; Entscheidung des Nutzers: nur vormerken). Vor der
   Veröffentlichung: Pools von Org-Repos pausieren, solange dort Workflows aus Fork-PRs erlaubt sind (Einstellung bei
   GitHub lesen, wie `pauseForPublic`). Sonst forkt ein Leser, sein PR-Workflow läuft auf dem Pool und vergiftet
   Paket-Cache und Build-Layer. Heute ohne Risiko: Alle Pools gehören zu Repos auf dem eigenen Konto Zaho92, und dort
   kann nur forken, wer ohnehin Schreibrecht hat.

Bewusst so gelassen:

- **`--network host` und Dienste auf dem localhost des Runners** (Entscheidung des Nutzers, 15.10.2026): Seit die
  Daemons ohne Rechte laufen, hat jeder Daemon ein eigenes Netz im Daemon-Container. Veröffentlichte Ports (`-p`,
  `services:`) erreicht der Runner weiter auf `localhost`; ein Job-Container mit `--network host` sieht aber keine
  Dienste, die ein Schritt im Runner auf `localhost` startet, und umgekehrt. Steht so in der README.

- **Jobs erreichen den localhost von Windows** über `host.docker.internal` (Entscheidung des Nutzers, 15.10.2026):
  Sperren bräche Jobs, die einen Dienst auf diesem Rechner brauchen. RunClub warnt, wenn Docker seinen Daemon dort ohne
  Schutz anbietet.
- **Caches sind zwischen Branches beschreibbar** (entschieden am 13.10.2026: Läufe auf Branches blieben sonst
  langsamer). Dazu gehört: Jeder Job eines Repos steuert dessen Build-Dienst über den Socket ganz (bauen, den Cache
  leeren, vermutlich auch frühere Builds desselben Repos lesen). Andere Repos erreicht er nicht.
- **Die Anmeldung eines Runners ist für seine Job-Schritte lesbar** (`/proc` des Runners, gleicher Benutzer). Sie gilt
  nur für diesen einen Job; in `env`, `ps` und `docker inspect` steht sie nicht mehr.
- **Ein laufender Job eines öffentlich gewordenen Repos läuft zu Ende**; danach nimmt der Pool nichts mehr an.

## Noch nicht echt ausprobiert

- **Ansicht „RunClub wird beendet“** (`src/shutdown.js`, `renderShutdown` in `src/ui.html`, `quit` in `src/main.js`):
  Am 16.10.2026 zweimal über `POST /api/shutdown` im Betrieb beendet (4 Projekte, je 2 Paare, kein Job lief).
  `/api/status` lieferte bis zum Schluss den Stand: Projekte zählten 0/2 → 2/2, dann Aufräumen, dann Abmelden mit
  Zählung; der Dienst schwieg nach etwa 16 s. Beim ersten Mal ohne Schätzung, beim zweiten mit `last: 13`; das
  geschätzte Ende traf auf etwa eine Sekunde. Die Ansicht selbst ist nur als Standbild mit festem Zustand angesehen.
  Echt prüfen: einmal über das Symbol im Infobereich beenden (Fenster kommt nach vorn, Menü zeigt „Wird beendet …“,
  ein Klick aufs Symbol holt nur das Fenster), einmal über „RunClub beenden“ in den Einstellungen, und einmal, während
  ein Job läuft (Zeile „Abbruch „Name““).

- **Anmeldung bei GitHub in der App** (`src/auth.js`, Aktionen `auth/…` in `src/actions.js`, Haltestelle „GitHub“ in
  `src/ui.html`): „Recht ergänzen“ für `user` hat der Nutzer am 14.10.2026 echt benutzt (Einmalcode, Bestätigung im
  Browser, die App bemerkt es von selbst), und die Oberfläche ist als Standbild angesehen. Ebenfalls echt benutzt am
  14.10.2026: „Abmelden“ und danach „Bei GitHub anmelden“; beides ging durch, nur fehlte danach `user`, weil das
  Anmelden damals nur `repo` verlangte. Seither verlangt es `repo` und `user` in einem Schritt (Wunsch des Nutzers);
  vom Nutzer am 14.10.2026 echt geprüft: Danach fehlt kein Recht. Echt prüfen, bei ruhenden Runnern:
  „Abbrechen“ (danach läuft kein `gh` mehr; ist `gh` über einen Zwischenstarter wie den von scoop installiert, beendet
  das Abbrechen womöglich nur diesen), dann „Abmelden“ und „Bei GitHub anmelden“ (das Protokoll nennt nur, dass und
  als wer; der Code steht nirgends).
  Offen ist dabei: ob `gh auth login --web` ohne Terminal und ohne `--git-protocol` wirklich ohne weitere Rückfrage
  durchläuft (die Option ist entfallen, damit die Einstellung des Nutzers in `gh` bleibt), was
  `gh auth status --json hosts` ohne Anmeldung und mit abgelaufenem Token schreibt (angenommen: `{"hosts":{}}`, und
  für ein abgelehntes Token `state: "error"` mit „HTTP 401“ oder „Bad credentials“ in `error`; nur das meldet ab,
  jeder andere Fehler lässt den Stand stehen. Nennt `gh` ein abgelaufenes Token anders, bliebe der Stand
  „angemeldet“, und die Abfragen der Repos zeigten ihre Fehler), ob `gh auth status` gegen das Anfragelimit zählt
  (deshalb wird ein guter Stand nur alle zehn Minuten nachgelesen), und wie die App dasteht, solange niemand
  angemeldet ist: Die Abfragen der Repos scheitern dann weiter im gewohnten Takt und zeigen ihre Fehler als Warn-Tags.
  Ebenfalls nur gegen ein nachgestelltes `gh` geprüft: dass `gh` mit leeren Umgebungsvariablen (`GH_TOKEN`, `GH_HOST`,
  `GH_DEBUG` und verwandte, siehe `GH_ENV` in `src/github.js`) so arbeitet, als fehlten sie.
  Bekannt und hingenommen: Wird die App hart beendet (Absturz, Task-Manager), bleibt ein wartendes `gh` bis zu einer
  Viertelstunde stehen; eine Bestätigung im Browser gilt dann trotzdem.
- **Abmelden von Windows** (`watchSession` in `src/main.js`, `releaseIdle` in `src/runners.js`): nur am Code geprüft. Nach
  einem Abmelden bei laufender App nachsehen, ob bei GitHub unter Settings → Actions → Runners keine Einträge des
  Rechners stehen geblieben sind.
- **Startzustand der Oberfläche** („Verbinde mit RunClub …“, bei ausbleibender Antwort „RunClub antwortet nicht.“): nur
  am Code geprüft.
- **Belegung der Docker-VM aus der VM selbst und die Warnung** (`src/vmmemory.js`, `src/usage.js`).
  Getestet sind das Lesen und die Regel (unter 15 % frei in drei Proben in Folge). Nur am Code geprüft: der Dauerlauf
  `wsl -d docker-desktop` (startet er, liefert er alle 2 s, endet er mit der App), das stille Ausbleiben ohne die
  Distro, der Neustart nach einem Neustart von Docker, die beiden Meldungen im Protokoll und die rote Kennzahl mit
  „nur x frei“ im Auslastungsband. Im Betrieb prüfen: Die Kurve „Docker-VM · Arbeitsspeicher“ liegt nach dem Neustart
  der App höher als zuvor (im Leerlauf rund 1,9 statt 1,1 GB) und macht dabei einen Sprung im Verlauf.
- **Build-Dienst im Speicherbalken** (Einstellungen → Limits): nur am Code geprüft, nicht angesehen. Am Bild prüfen:
  das Feld des Build-Diensts hebt sich von den Plätzen ab, die Beschriftung „2 × 8 GB + Build-Dienst 4 GB“ passt
  unter schmale Gruppen, und ein pausiertes Projekt mit Cache zeigt nur dieses Feld.
- **Wartende Läufe ohne Pool** (`src/waiting.js`): nur gegen ein nachgestelltes GitHub getestet und als Standbild
  angesehen. Echt prüfen: in einem privaten Repo ohne Pool einen Lauf mit `runs-on: [self-hosted, Linux]` starten;
  nach spätestens fünf Minuten steht in „Alle Projekte“ die Zeile mit „Pool anlegen“.
- **Läufe, die am Kontingent von GitHub gescheitert sind** (`src/waiting.js`): Die Form von Job und Anmerkung stammt
  aus einem echten Lauf (38468791627 in `Zaho92/RunClub`), die Suche selbst ist nur gegen ein nachgestelltes GitHub
  getestet. Echt prüfen: Ein privates Repo ohne Pool, dessen Lauf in den letzten 24 Stunden so gescheitert ist, steht
  nach spätestens fünf Minuten in „Alle Projekte“ als Zeile mit rotem Symbol „Keine GitHub-Minuten: …“ mit „Pool anlegen“; nach einem
  gelungenen Lauf oder einem Tag verschwindet sie. Nicht angesehen: Zeile und Symbol. Gezählt werden
  höchstens die jüngsten abgeschlossenen Läufe (`DONE_MAX` in `src/waiting.js`).
- **Minuten-Kontingent in „Verbrauch“** (`src/minutes.js`, `watchMinutes` in `src/account.js`, `minutesStop` in
  `src/ui.html`; in der Oberfläche „GitHub-Minuten“): Echt gelesen ist nur die Antwort der Abrechnung für ein Konto im
  Tarif Free, dessen Minuten aufgebraucht waren (ihre Einträge stehen in `test/minutes.test.js`), und zwar ohne die
  Angabe von Jahr und Monat, mit der seit dem Review gefragt wird (`?year=&month=`). Die Zustände in Ordnung, knapp
  und bezahlt, macOS und ein unbekannter Tarif sind nur mit nachgestellten Antworten geprüft und als Standbild
  angesehen. Annahmen, die bei Tarifänderungen von GitHub anzupassen sind: die Tabelle der enthaltenen Minuten
  (`INCLUDED` in `src/minutes.js`; die Schnittstelle nennt sie nicht, und die echte Antwort zeigte 2.097 verbrauchte
  Minuten ohne Berechnung, also mehr als die angenommenen 2.000), dass jede Minute einfach zählt, gleich auf welchem
  Betriebssystem, und dass der Monat am Ersten (UTC) neu beginnt. Offen:
  - ob Minuten größerer Runner (`actions_linux_4_core` und ähnliche, die das Enthaltene nicht deckt) mitzuzählen
    sind; heute zählen sie mit. Ebenso zählt jedes unbekannte Kürzel als „andere“ mit.
  - ob sich das Budget lesen lässt. Heute sieht RunClub nur, ob schon etwas berechnet wurde: „aufgebraucht“ heißt
    deshalb „ohne Budget startet nichts mehr“, und wer bezahlt, erfährt nicht, ob sein Budget erreicht ist.
  - ob für die Abrechnung das Recht `read:user` genügte. Verlangt wird `user`, das auch das Ändern des Profils
    erlaubt (die Oberfläche sagt das).
  - Im Betrieb nachsehen: Nach einem Start ohne Netz kommt die Haltestelle binnen einer Minute nach der Anmeldung;
    scheitert die Abfrage, steht dort „ließ sich nicht lesen“ und der Grund einmal im Protokoll.
- **Lauf und Job erneut starten** (`run/rerun`, `job/rerun` in `src/actions.js` und `rerun` in `src/remote.js`; Schaltflächen in `src/ui.html`): nur
  am Code geprüft, kein Aufruf ging an GitHub. Echt prüfen: „Erneut starten“ und „Nur Gescheiterte“ unter dem Kopf des
  letzten Laufs, „Job erneut starten“ in den aufgeklappten Details einer Pill; der Lauf erscheint nach wenigen
  Sekunden wieder als laufend, im Protokoll steht die Meldung, und eine Absage von GitHub kommt als Meldung unten an.
  Am Bild prüfen: Die Schaltfläche des Jobs sitzt rechts in den Details, ohne Text zu verdecken oder aus der
  gerundeten Fläche zu ragen (kompakt und im Detailmodus, auch bei einer gescheiterten Pill mit langem Schrittnamen);
  die Pill bleibt aufgeklappt, solange der Zeiger auf der Schaltfläche steht; das Symbol ist vom „Runner neu
  aufbauen“ zu unterscheiden.
- **Zuordnung im Netzplan** für Matrix-Jobs, Namen mit Ausdruck und aufgerufene Workflows: Die Namensformen von GitHub
  stammen aus der Dokumentation, nicht aus einem echten Lauf. Die eigenen Workflows nutzen nichts davon.
- **Tägliches Neubauen der Abbilder von Runner und Docker-Daemon** und der Start ohne Netz mit vorhandenem Abbild: nur am Code geprüft.
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
- **Netze mit eigenem Subnetz** (`src/subnets.js`). Getestet sind die Rechnung und die Wiederholung gegen ein
  nachgestelltes Docker; an echten Paaren zu sehen ist es erst nach dem nächsten Neustart der App:
  `docker network inspect <Paar>` zeigt dann ein /28 aus 10.213.x. Bestehende Netze behalten ihr altes Subnetz, auch
  die der Build-Dienste (`rc-buildnet-…`), solange das Repo seinen Cache behält. Im Protokoll nachsehen, ob „Netz
  lässt sich nicht anlegen“ ausbleibt.

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

- **Korrekturen an Plätzen und Reserve nach dem Umzug** (`src/slots.js`, `src/pools.js`), alle nur mit
  nachgestelltem Docker und GitHub geprüft (`test/slots.test.js`, `test/pools.test.js`); wirksam erst nach einem
  Neustart der App. Im Betrieb sähe man es so:
  - Scheitert die Anmeldung bei GitHub (403, Anfragelimit aufgebraucht, kein Netz), bleibt der Platz „gestört“ mit
    seinem Runner-Namen stehen, der Fehler steht jede Minute im Protokoll, und `docker ps` zeigt dasselbe Paar
    (`rc-…-dind`) weiter; die Reserve baut nicht nach. Sobald GitHub wieder antwortet, wird der Platz ohne neuen Aufbau
    „bereit“. Pausieren, Plätze verringern, Beenden oder geänderte Limits bauen das Paar ab.
  - Endet ein Runner mitten im Job (etwa `docker rm -f <Paar>-runner` während eines Demo-Laufs), steht „Job „…“
    endete ohne Ergebnis (…)“ als Fehler im Protokoll, der Platz zählt den Job mit, und unter Verbrauch erscheint
    kein Eintrag dafür. Beim Beenden der App mit laufendem Job erscheint die Meldung nicht.
  - Plätze von 3 auf 1 und gleich wieder auf 3 stellen, während ein Job läuft: Es stehen nie mehr als drei Plätze in
    der Liste, keiner trägt „läuft aus“, und der arbeitende bedient nach seinem Job den nächsten.
  - „Runner neu aufbauen“ mit laufendem Job nach einer Limit-Änderung: Freie Runner, die schon neu gebaut waren,
    behalten ihren Namen; nur die mit alten Limits bekommen einen neuen.
  - Nicht herbeiführbar, nur am Test geprüft: Nachfüllen der Reserve nach einem gescheiterten Abbau (`renewReserve`),
    der Fehler von `discardReserve` beim Pausieren im Protokoll (`pool/set` in `src/actions.js`) und der Abbruch
    während der Pause nach einem Fehler.
- **CI_RUNNER setzen und entfernen** gegen GitHub. Gelesen wird richtig, das Schreiben ist nur gegen ein nachgestelltes
  GitHub getestet (`test/routing.test.js`). Ausprobieren in Einstellungen → Projekt RunClub.
- **Stehenbleiben des Auslastungsbands** beim Scrollen und die Ansicht im **schmalen Fenster**: nur im Code und als Standbild geprüft.
- **Die letzte Korrekturrunde der Oberfläche** hat der Gutachter nicht mehr gegengeprüft.

- **Aus dem Umbau des Backends und dem fünften Review** (14.10.2026), nur an Tests und am Code geprüft: Limits ändern
  (Reserve erneuert sich, der Build-Dienst entsteht mit neuen Limits), „Runner neu aufbauen“ mit und ohne laufenden Job,
  Cache leeren (auch wenn das Löschen scheitert), Pool entfernen (Caches, Vorlage, Variable, Anmeldungen), ein Job lädt
  ein neues Abbild und die Vorlage frischt sich auf, das Weiterlesen nach einem Abriss der Verbindung zu `docker run`,
  das Abmelden verwaister Runner, ein Repo, das öffentlich und wieder privat wird. Im Betrieb gesehen: Start, Build-Dienst
  ohne Rechte (ein `docker build` aus einem Runner geht über den Socket), Demo-Lauf und CI auf den eigenen Runnern,
  Beenden ohne Reste.

- **Daemons ohne Rechte** (seit `9686428`, App neu gestartet am 15.10.2026 um 12:43). Im Betrieb gesehen: Die Paare
  laufen mit `runclub-dind`; Jobs von RunClub und what-to-wear liefen darauf durch, auch der Job „docker“ von
  what-to-wear (Docker im Job über den Socket); die Anmeldung der Runner über die Standardeingabe trägt damit; der
  Lade-Daemon der Vorlage hat um 12:43 die Vorlage von what-to-wear aufgefrischt, ohne Fehler im Protokoll. Offen:
  ob ein Abbild aus der Vorlage einem frisch geladenen gleicht (Verdacht aus dem sechsten Durchgang, unbelegt: `cp -a`
  aus busybox übernimmt womöglich keine erweiterten Attribute wie `user.overlay.opaque`, sodass in kopierten Abbildern
  gelöschte Ordner unterer Schichten wieder auftauchen. Prüfweg: ein Abbild, das einen Ordner einer unteren Schicht
  ersetzt, einmal aus der Vorlage und einmal frisch geladen vergleichen).
- **Pause eines öffentlich gewordenen Repos über einen Neustart** (`pausedPublic` in `src/actions.js`, seit `7d36a3b`):
  nur am Test geprüft. Echt prüfen: Der Pool eines Repos, das öffentlich wurde, bleibt nach einem Neustart der App
  pausiert und wird erst wieder frei, wenn das Repo privat ist.
- **Korrekturen aus dem sechsten Durchgang** (15.10.2026). Im Betrieb gesehen am 15.10.2026 nach zwei Neustarts mit
  je zwei sich überlappenden Demo-Läufen (einer gescheitert): Volumes, Ende eines Jobs und Bestätigung, Capabilities
  und Protokollgrenze (unten je „Gesehen“). Offen sind nur die Fehlerwege, die im Betrieb nicht vorkamen:
  - Gesehen: Der Lade-Container der Vorlage hinterlässt kein anonymes Volume mehr (`docker rm -v`); nach zwei
    Auffrischen blieb `docker volume ls -q --filter dangling=true` bei 4.
  - Scheitert das Vorbereiten der Volumes eines Paars (Rechte, Kopie der Vorlage), steht „Volumes ließen sich nicht
    vorbereiten: …“ im Protokoll, und das Paar geht, statt mit einem Daemon zu starten, der nicht hochkommt.
  - Beim Beenden während des Auffrischens der Vorlage steht kein roter Eintrag „Lade-Daemon wurde nicht bereit“ mehr,
    und der Lade-Container geht trotzdem.
  - Scheitert das Lesen von `CI_RUNNER` beim Start, steht das im Protokoll; ebenso, wenn sich `access.key` nicht
    schreiben lässt. `npm run backend` legt seine Daten ohne `RUNCLUB_DATA` jetzt unter `%APPDATA%\RunClub\backend` ab.
  - Gesehen: Ein Job kann seinen Verbrauch nicht mehr verkürzen: Die Dauer läuft bis zum Ende des Runner-Containers, der Name
    kommt aus der ersten „Running job“-Zeile, das Ergebnis aus der Ausgabe ist vorläufig und wird durch das von GitHub
    ersetzt, sobald die üblichen Abfragen den Job des Runners abgeschlossen sehen (`confirmResults` in
    `src/metrics.js`). Nach jedem Job fragt der Platz einmal mehr `docker inspect` (läuft der Runner noch?). Ein Runner
    endet spätestens nach 24 Stunden (`RUNNER_MAX` in `src/slots.js`; ein Workflow mit längerem `timeout-minutes`
    bräche dort ab), und sein Container-Protokoll in der Docker-VM ist auf zweimal 20 MB begrenzt. Im Betrieb:
    Ergebnisse und Verbrauch erscheinen wie bisher, ein bis zwei Sekunden später; in `metrics.json` tragen die neuen
    Durchläufe `runner` und nach der Bestätigung `confirmed: true`. Gesehen: alle Jobs beider Läufe mit `runner`,
    bestätigt, der gescheiterte als „Failed“. Dabei gefunden und behoben: Endete ein früher gestarteter Lauf nach einem
    später gestarteten, blieb sein letzter Job unbestätigt, weil nur der jüngste abgeschlossene Lauf gelesen wurde;
    jetzt wird jeder eben beendete Lauf einmal abschließend gelesen und sechs Abfragen lang mitgegeben (`finishedOf`
    in `src/pipeline.js`). Bekannt: Beendet man die App, während ein Runner
    nach seinem Job noch aufräumt, wird dieser Job nicht mehr verbucht.
  - Gesehen (`docker inspect`: CapDrop mit den sechs, LogConfig `max-size=20m`, `max-file=2`; in den Demo-Läufen kein
    „Operation not permitted“): Der Runner-Container gibt `NET_RAW`, `MKNOD`, `SETFCAP`, `SETPCAP`, `SYS_CHROOT` und `NET_BIND_SERVICE` ab.
    Geprüft an einem eigenen Container aus dem Runner-Abbild: `sudo`, `sudo -u`, `apt-get install` (auch eines Pakets,
    das Capabilities setzen will), `ping`, `dotnet`, `node` gehen. Ein Dienst, den ein Schritt per `sudo` direkt im
    Runner auf einem Port unter 1024 startet, geht nicht mehr. Offen: in den Läufen der anderen Repos auf
    „Operation not permitted“ achten.

## Offene Entscheidungen des Nutzers

- **Eigene OAuth-App „RunClub“ zur Veröffentlichung.** Entschieden vom Nutzer: Bis dahin nutzt RunClub die
  Anmeldung von `gh` (dieselbe wie im Terminal; Abmelden in der App meldet deshalb auch `gh` ab). Zur Veröffentlichung
  ist eine eigene OAuth-App vorgesehen, mit eigener Anmeldung getrennt von `gh`, eigenem Namen auf der
  Bestätigungsseite von GitHub und nur den Rechten, die RunClub braucht. `src/auth.js` ist die Stelle dafür; die
  Oberfläche (Einmalcode, Bestätigung im Browser) bleibt dieselbe. Noch nicht begonnen.

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
- **Übergangscode aus der Zeit vor den Daemons ohne Rechte.** Kann entfallen, sobald jede Installation einmal mit
  dem Stand vom 15.10.2026 gestartet ist (heute nur dieser Rechner, also nach dem nächsten Neustart der App):
  `removeLeftovers` in `src/dockerwatch.js` entfernt Build-Dienst und Netz eines Repos auch beim Namen (ältere
  Versionen legten sie ohne Kennzeichen an); `startService` in `src/caches.js` leert Build-Layer, die root gehören;
  `refreshSeed` in `src/seed.js` leert eine Vorlage, die root gehört. Vor der Veröffentlichung entfernen, wenn es
  keine älteren Installationen gibt.
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
Projekt, ganze Datei speichern oder kopieren · Info-Symbole statt Textwände in Einstellungen und Verbrauch (vom Nutzer
am 14.10.2026 im Fenster bestätigt, auch das Hinüberführen des Zeigers auf die Info-Fläche) · Backend-Umbau
abgeschlossen (14.10.2026): `src/backend.js` ist nur noch Verdrahtung mit `start()`; Plätze, Reserve, Vorlage, Caches,
Docker-Überwachung, Einstellungen, Namen, Messung, GitHub-Abfragen, Konto, Stand, Aufrufe und der lokale Dienst sind
eigene Module mit Tests · fünftes Review mit Abschluss-Review: Build-Dienst ohne Rechte über einen Socket statt über die
Netze der Paare, Grenze für Prozesse, öffentlich gewordene Repos pausieren, verwaiste Runner werden abgemeldet.
