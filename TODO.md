# Offene Punkte

Stand: 14.10.2026. Die Reihenfolge innerhalb eines Abschnitts ist die empfohlene. Wie hier gearbeitet wird, steht in
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
3. **Docker Engine statt Docker Desktop** (Idee des Nutzers, 14.10.2026; erst Analyse, dann entscheiden). Ziel: eine
   Abhängigkeit weniger. Eine eigene Docker Engine in einer eigenen WSL-Distro statt Docker Desktop. Für
   die Veröffentlichung spricht die Lizenz von Docker Desktop (in größeren Firmen kostenpflichtig) und mehr Kontrolle
   über den Daemon (rootless dind oder sysbox gegen den Ausbruch aus privilegierten Containern, siehe unten). Dagegen:
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
  Host-Prüfung in `src/backend.js`), alles, was aus GitHub-Antworten in Befehle oder ins HTML gelangt (Repo-, Job- und
  Schrittnamen), und die Abschottung der Runner (privilegierte Container, Volumes, was Jobs schreiben dürfen).
- Drei Durchgänge liefen am 13.10.2026 (jeweils beide): über den ganzen Stand, über die Änderungen danach bis
  `4af3618` und über die bis `eba81c1` (Protokoll, GitHub-Anfragen). Behoben ist, was unten nicht mehr steht; der
  nächste Durchgang prüft die Änderungen danach. Über die Korrekturen aus dem dritten lief ein Abschluss-Review; was es
  fand, ist ebenfalls behoben (im Commit nach `eba81c1`), aber nicht noch einmal gegengelesen.
- Ein vierter Durchgang lief am 14.10.2026 über die Kontingent-Anzeige und die Korrekturen der Anmeldung
  (`19ae429..ab8212c`): Richtigkeit, Standards, Sicherheit und der Gutachter der Oberfläche. Alle Befunde sind
  behoben, und die Korrekturen sind gegengelesen (Code und Oberfläche); was das Gegenlesen fand, ist ebenfalls
  behoben, aber nicht noch einmal gelesen. `src/seed.js` und `src/caches.js` sind dabei mitgelesen worden.

## Aus den Reviews noch offen

Fünfter Durchgang am 14.10.2026 über den ganzen Stand nach `08949b0` (Richtigkeit, Sicherheit, Standards samt
Schnittplan für `src/backend.js`). Was er fand, steht hier zusammen mit den älteren offenen Punkten. Reihenfolge je
Gruppe: empfohlen.

Richtigkeit:

1. **Entfernen eines Pools gegen laufende Hintergrundarbeit.** `pool/remove` wartet nur auf `pool.preparing` und
   `quiesce`. Ein laufendes `renewService` legt danach Netz, Volume und einen privilegierten `rc-buildkit-…` neu an; der
   trägt kein Kennzeichen und überlebt jeden Neustart. `refreshSeed` und der `du`-Container von `measureSizes` halten das
   Seed-Volume fest, `volume rm` scheitert still, das Protokoll meldet trotzdem „entfernt“. Vorschlag: `pool.hold`
   während des Entfernens, auf `renewingService` warten, das Löschen in `withSeed(repo, true, …)`, `code` prüfen.
2. **Neue Vorbereitung nach einem Docker-Ausfall reißt den Build-Dienst weg.** `prepareCaches` entfernt ihn
   unbedingt; laufende Builds brechen ab, und der neue Dienst hängt in keinem Paar-Netz mehr, die Paare bauen still
   ohne Cache. Vorschlag: nur neu anlegen, wenn er fehlt oder andere Limits trägt; danach die stehenden Paare wieder
   anbinden (oder Socket statt Netz, siehe Sicherheit 4).
3. **Beenden wartet nicht auf Paare im Aufbau.** `shutdown` baut nur Plätze mit `slot.base` ab; Reserve-Einträge und
   Plätze mit `building` können nach `removeLeftovers` noch einen privilegierten Daemon starten. Vorschlag: vor
   `removeLeftovers` die Reserve verwerfen und auf `!slot.building` warten, mit Zeitgrenze.
4. **Abmeldungen bleiben liegen** (bekannt, genauer gefasst). `teardown` meldet bei laufendem Job nicht ab, und
   `removeRegistrations` (nur beim ersten Start) überspringt Runner, die GitHub noch als `busy` führt. Startet die App
   neu, bevor GitHub den Job abschreibt, räumt niemand mehr auf. Dieselbe Lücke: Job ohne Ergebnis, gescheitertes
   DELETE, 409/422 bei der Anmeldung; `release` übersieht einen Platz mitten in der Anmeldung. Vorschlag: regelmäßig
   Runner `<Rechner>-linux-*` löschen, die offline, nicht `busy` und keinem stehenden Platz zugeordnet sind.
5. **Zuordnung im Netzplan** (bekannt, genauer gefasst). `Test ${{ matrix.os }}` passt auf „Test / Docker“, aber nicht
   auf „Test“ (leerer Ausdruck). Der angekündigte Job zeigt den rohen Namen und findet keine gelernte Dauer; dasselbe
   bei Matrix-Jobs ohne Ausdruck („Build“ angekündigt, gelernt „Build (x)“). Vorschlag: Ausdruck als optionaler Text
   ohne „ / “, angrenzende Leerzeichen optional; angekündigt als „Test …“, Dauer als Median aller passenden Jobs.
6. **Abbruch eines Platzes durch einen Wurf** (bekannt als „`discardReserve` mittendrin“). Heute nicht erreichbar,
   weil `removePair` nicht wirft. Wirft künftig etwas in `slotLoop`, endet die Schleife ohne `.catch`, und dem Pool
   fehlt dauerhaft ein Platz. Vorschlag: `discardReserve` je Eintrag mit `allSettled`, `livePairs.delete` im
   `finally`, `slotLoop(…).catch` setzt den Platz auf „aus“.
7. **Abriss der Verbindung zu `docker run` beendet den Job.** Endet der Aufruf, während der Container weiterläuft
   (Docker Desktop verliert kurz die Verbindung), gilt das als „ohne Ergebnis“, und das Paar wird mitten im Job
   entfernt. Vorschlag: `docker inspect` prüfen und mit `docker logs -f` weiter mitlesen.
8. **`renewReserve` hält die Reihenfolge nicht.** Während die alten Paare abgebaut werden, füllt der Minutentakt
   schon nach; kurz stehen doppelt so viele Paare. Vorschlag: `replenish` überspringen, solange erneuert wird.
9. **`withPoolAtRest` wartet nicht auf `renewService` und `preparePool`.** Cache leeren kann still scheitern, ein
   doppeltes `prepareCaches` markiert einen laufenden Dienst als gescheitert.

Sicherheit:

1. **Privilegierte Container sind keine Sicherheitsgrenze** (bekannt). dind (`slots.js`), Build-Dienst (`caches.js`)
   und Lade-Daemon (`seed.js`) laufen `--privileged`; ein Job erreicht nach dem Ausbruch die Volumes aller Repos, die
   `JITCONFIG` anderer Paare und vermutlich das Windows-Laufwerk mit `access.key` und der Anmeldung von `gh` (Recht
   `repo` auf das ganze Konto). Bis das gelöst ist, gibt es Pools nur für private Repos. Optionen: rootless dind (geht
   mit Docker Desktop, Haken bei den Rechten am geteilten Arbeitsordner, 1–2 Tage mit echten Jobs; empfohlener erster
   Schritt), ECI (nur mit Docker Business, unter WSL2 schwächer), Sysbox in eigener Engine (WSL2 nicht offiziell
   unterstützt; zusammen mit „Docker Engine statt Docker Desktop“). Vor einer Veröffentlichung klären.
2. **„Nur private Repos“ gilt nur beim Anlegen.** Wird ein Repo mit Pool später öffentlich, laufen fremde Pull
   Requests auf den eigenen Runnern. Vorschlag: Sichtbarkeit regelmäßig lesen; wird es öffentlich, Pool pausieren,
   Reserve verwerfen, `CI_RUNNER` entfernen, laut melden.
3. **Jobs erreichen den localhost von Windows** über `host.docker.internal`, also jeden Dienst dort; mit „Expose
   daemon on tcp://localhost:2375“ in Docker Desktop auch den äußeren Daemon. Vorschlag: Port 2375 beim Vorbereiten
   prüfen und warnen; den Weg zu `host.docker.internal` aus den Paar-Netzen sperren (zu prüfen).
4. **Das Netz je Repo trennt die Paare eines Repos nicht** (bekannt). Der Build-Dienst hängt in allen Paar-Netzen
   und lauscht ohne TLS auf Port 1234. Vorschlag: Build-Dienst über einen Unix-Socket in einem Volume statt über die
   Netze anbinden; dann teilt kein Paar-Netz mehr einen Teilnehmer.
5. **Der Build-Dienst läuft unnötig privilegiert.** Vorschlag: `moby/buildkit:…-rootless` ohne `--privileged`.
6. **Digests anheben** (bekannt). `docker:dind` und `moby/buildkit` sind per Digest festgenagelt (`DIND`, `BUILDKIT`);
   von Zeit zu Zeit bewusst anheben. Neu: `BUILDKIT` trägt kein Etikett, die Version ist nicht ablesbar. `node` und
   das .NET-SDK im Runner-Abbild sind nicht festgenagelt; das Abbild hält den Socket des privilegierten Daemons, ist
   also nicht harmloser als dieser. Vorschlag: Etikett zum Digest, `node` und SDK per Digest, dazu etwas, das neue
   Digests meldet (Renovate oder ein Workflow).
7. **`JITCONFIG` steht in der Umgebung der Job-Schritte** (Vermutung); ein `env` schreibt sie ins Protokoll bei
   GitHub. Vorschlag: im Startskript lesen und `unset`.
8. **Keine Grenze für Prozesse je Paar.** Eine Fork-Bomb legt die VM für alle Repos lahm. Vorschlag: `--pids-limit`.
9. **Kleinigkeiten am lokalen Dienst.** Der Einstieg nennt `localhost`, der Dienst lauscht auf `127.0.0.1` (Chromium
   kann `::1` versuchen); `readBody` liest nach dem Überschreiten der Grenze weiter.

Standards (Clean Code, Doppelungen):

- Doppelt: `logError` (dreimal), Steuerzeichen-Muster (`auth.js`, `backend.js`), `median` (dreimal), JSON schreiben
  ohne `store.writeJson` (`metrics.js`, `pipeline.js`), Build-Dienst samt Netz entfernen (dreimal), Gelerntes
  löschen (zweimal, gehört `seed.js`), Vorgaben und Grenze von `parallel` (zweimal), „Diesen Pool gibt es nicht“
  (fünfmal), `serviceKey` baut `limits.key` nach, `daysSince` rechnet wie `images.pruneOlder`, `shutdown` und
  `release` beginnen gleich.
- Tot oder ohne Namen: `PROCESS_INTERVAL_S` unbenutzt; Zahlen ohne Namen in `backend.js` (5000, 15000, 500, 100,
  10000, Seiten von `listRepos`), Zeiten ohne `units` in `run.js`, `vmmemory.js`, `main.js`; `8770` doppelt.
- Zeichenketten als Zustände: Zustände eines Platzes sind deutsche Sätze an über 20 Stellen (auch `main.js`,
  `ui.html`); „läuft aus“ wird angehängt und mit `startsWith` verglichen; `machine.docker` ist `'bereit'` oder ein
  Fehlertext; `SERVICE_FAILED` als Wert im Schlüsselfeld.
- Namen: `rerun(…, path, unknown)` verdeckt `node:path`; `github` neben `githubApi`; Kopfkommentare verweisen auf
  `backend.js`. Fremder Zustand: Die GitHub-Abfrage schreibt `slot.workflow`, `shutdown` setzt `slot.aborted`,
  `release` liest `slot.runnerId`.
- Tests: `pools.test.js` kopiert die „läuft aus“-Logik und die Verdrahtung aus `backend.js`; Hilfen (`turn`,
  `until`, nachgestelltes Docker) sind in mehreren Tests kopiert; Einheiten von Hand gerechnet. Ungetestet: der
  HTTP-Dienst mit seiner Zugriffskontrolle, die Prüfungen von `pool/add`, `status()`, das Lesen von `docker stats`.

Backend-Umbau, letzter Schritt (Schnittplan aus dem Review): `src/backend.js` wird Verdrahtung mit
`start({ port, dataDir, hooks })`, `main.js` ruft es auf (braucht einen Neustart der App). Neue Module, jedes mit
Tests: `settings.js` (Einstellungen, Gelerntes, Vorgaben), `names.js` (Kennzeichen, Abbilder, Namen von Volumes und
Diensten), `usage.js` (Messung, `docker stats`, VM), `remote.js` (GitHub-Abfragen, Anfragelimit, wartende Läufe,
erneut starten), `account.js` (Anmeldung und Minuten), `status.js` (was die Oberfläche sieht), `actions.js` (Aufrufe
der Oberfläche), `server.js` (lokaler Dienst, ohne `listen`).

## Noch nicht echt ausprobiert

- **Anmeldung bei GitHub in der App** (`src/auth.js`, Aktionen `auth/…` in `src/backend.js`, Haltestelle „GitHub“ in
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
- **Abmelden von Windows** (`watchSession` in `src/main.js`, `release` in `src/backend.js`): nur am Code geprüft. Nach
  einem Abmelden bei laufender App nachsehen, ob bei GitHub unter Settings → Actions → Runners keine Einträge des
  Rechners stehen geblieben sind.
- **Startzustand der Oberfläche** („Verbinde mit RunClub …“, bei ausbleibender Antwort „RunClub antwortet nicht.“): nur
  am Code geprüft.
- **Belegung der Docker-VM aus der VM selbst und die Warnung** (`src/vmmemory.js`, `startVmFeed` in `src/backend.js`).
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
- **Minuten-Kontingent in „Verbrauch“** (`src/minutes.js`, `watchMinutes` in `src/backend.js`, `minutesStop` in
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
- **Lauf und Job erneut starten** (`run/rerun`, `job/rerun` in `src/backend.js`; Schaltflächen in `src/ui.html`): nur
  am Code geprüft, kein Aufruf ging an GitHub. Echt prüfen: „Erneut starten“ und „Nur Gescheiterte“ unter dem Kopf des
  letzten Laufs, „Job erneut starten“ in den aufgeklappten Details einer Pill; der Lauf erscheint nach wenigen
  Sekunden wieder als laufend, im Protokoll steht die Meldung, und eine Absage von GitHub kommt als Meldung unten an.
  Am Bild prüfen: Die Schaltfläche des Jobs sitzt rechts in den Details, ohne Text zu verdecken oder aus der
  gerundeten Fläche zu ragen (kompakt und im Detailmodus, auch bei einer gescheiterten Pill mit langem Schrittnamen);
  die Pill bleibt aufgeklappt, solange der Zeiger auf der Schaltfläche steht; das Symbol ist vom „Runner neu
  aufbauen“ zu unterscheiden.
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
    der Fehler von `discardReserve` beim Pausieren im Protokoll (`pool/set` in `src/backend.js`, ohne Test, weil
    `backend.js` sich nicht laden lässt) und der Abbruch während der Pause nach einem Fehler.
- **CI_RUNNER setzen und entfernen** gegen GitHub. Gelesen wird richtig, das Schreiben ist nur gegen ein nachgestelltes
  GitHub getestet (`test/routing.test.js`). Ausprobieren in Einstellungen → Projekt RunClub.
- **Stehenbleiben des Auslastungsbands** beim Scrollen und die Ansicht im **schmalen Fenster**: nur im Code und als Standbild geprüft.
- **Die letzte Korrekturrunde der Oberfläche** hat der Gutachter nicht mehr gegengeprüft.

## Offene Entscheidungen des Nutzers

- **Lizenz.** RunClub soll später veröffentlicht werden (Entscheidung des Nutzers, 13.10.2026); bis dahin eine wählen.
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
- **`src/backend.js` aufteilen.** Es startet beim Laden und ist deshalb nicht testbar. Pools, Reserve und Caches sind der
  ungetestete Kern; jede Änderung dort erst mit einem leeren Datenordner ausprobieren (siehe `CLAUDE.md`). Vorschlag aus
  dem Review: `createPools({ docker, gh, config, state, log, sleep })` als Modul, `backend.js` wird Verdrahtung mit
  einem `start()`.
  - Erledigt: der Lebenslauf eines Platzes als `src/slots.js` mit Tests (`provision`, `serveOneJob`, `teardown`,
    `removePair`, `slotLoop`, `abortIdle`, `slotWanted`, `livePairs`). Der Code ist unverändert umgezogen (Zeile für
    Zeile gegengelesen) und am 13.10.2026 im Betrieb geprüft: Demo-Lauf mit Fehler, Plätze verringern, pausieren,
    Beenden ohne Reste.
  - Erledigt: die Reserve und das Anhalten eines Pools als `src/pools.js` mit Tests (`replenish`, `renewReserve`,
    `discardReserve`, `reserveSize`, `staleCount`, `poolResting`, `reconcile`, `quiesce`, `withPoolAtRest`,
    `rebuildIdle`). Keine der beiden Dateien lädt die andere: `backend.js` reicht `pools.js` die Funktionen der
    Plätze herein und `slots.js` die der Reserve (dort als Rückruf, weil die Reserve erst danach entsteht). Der Code
    ist unverändert umgezogen; anders sind nur `stopping()` und `linuxReady()` als Abfrage statt als Variable und ein
    eigenes `logError` (Zeile für Zeile gegengelesen). Getestet gegen nachgestellte und gegen die echten Plätze mit
    nachgestelltem Docker. Im Betrieb geprüft am 13.10.2026: Start, die Reserve füllt sich, im Demo-Lauf nehmen die
    Plätze Paare aus der Reserve und sie füllt nach, Beenden ohne Reste. Im Betrieb noch nicht geprüft: Limits ändern
    (Reserve erneuert sich), „Runner neu aufbauen“ mit und ohne laufenden Job, Cache leeren, Pool entfernen.
  - Erledigt: Vorlage und Gelerntes als `src/seed.js` mit Tests (`wantedImages`, `withSeed`, `refreshSeed`,
    `learnImages`). Der Code ist unverändert umgezogen (Zeile für Zeile verglichen); anders sind nur die Namen des
    Hereingereichten (`mark`, `dind`, `longTimeout`, `poolOf`). Getestet gegen ein nachgestelltes Docker. Im Betrieb
    geprüft am 14.10.2026: Nach dem Start steht „Frische die Vorlage auf (3 Abbilder) …“ im Protokoll, die
    Einstellungen zeigen dieselben gelernten Abbilder wie zuvor, und ein Demo-Lauf geht durch. Im Betrieb noch nicht
    gesehen: dass ein Job ein neues Abbild lädt und die Vorlage danach aufgefrischt wird.
  - Erledigt: Caches und Build-Dienst als `src/caches.js` mit Tests (`prepareCaches`, `renewService`). Der Code ist
    unverändert umgezogen (Zeile für Zeile verglichen); anders sind nur `stopping()` und `linuxReady()` als Abfrage
    und die Namen des Hereingereichten. Im Betrieb geprüft am 14.10.2026: `docker ps` zeigt
    je Projekt einen `rc-buildkit-…`, und ein Demo-Lauf geht durch. Im Betrieb noch nicht gesehen: der Build-Dienst
    mit neuen Limits (`renewService`) und der erneute Versuch nach einem Fehlschlag.
  - Seit dem Review der Kontingent-Anzeige sucht `src/run.js` Programme ohne Pfad (`gh`, `docker`, `wsl`) unter
    Windows selbst in den Ordnern aus PATH und nie im Arbeitsverzeichnis (`locate`). Geprüft am echten Rechner für
    alle drei, auch im Betrieb (Start und Demo-Lauf am 14.10.2026). Liegt eines davon nur als `.cmd` vor, findet RunClub es nicht
    mehr (das ließ sich auch vorher nicht starten).
  - Erledigt am 14.10.2026: die Docker-Überwachung als `src/linux.js` (`linuxLoop`, nach außen `watch`, `prepareLinux`, `buildImage`,
    `refreshImage`, `removeOrphans`, `removeLeftovers`, `removeRegistrations`), dazu `startPool` und `preparePool` in
    `src/pools.js` und `measureSizes` in `src/caches.js`, alle mit Tests. Der Code ist unverändert umgezogen (Zeile für
    Zeile verglichen); anders sind die Namen des Hereingereichten, `stopping()` und `linuxReady()` als Abfrage, die
    beiden zu ladenden Abbilder als Liste, die Messungen, die `linuxLoop` über `onReady` und `onAlive` startet, die
    Meldung „nicht erreichbar“ aus der Engine, `docker stats` über `docker()` mit `timeout: 0` und der Dauerlauf in der
    VM über `engine.inVm` (jetzt mit `wsl --exec`, ohne die Shell der Distro). Nach dem Review: Ein Pool, der gerade
    entfernt wird, wird nicht mehr vorbereitet, und das Entfernen wartet eine laufende Vorbereitung ab. Im Betrieb geprüft am 14.10.2026: Start, Messung der VM, Demo-Lauf.
    Neu: `src/engine.js` als einzige Stelle, die weiß, wo Docker läuft (siehe „Docker Engine statt Docker Desktop“).
    In `src/backend.js` bleiben die Verdrahtung, die GitHub-Abfragen, die Messung und der Dienst.
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
am 14.10.2026 im Fenster bestätigt, auch das Hinüberführen des Zeigers auf die Info-Fläche).
