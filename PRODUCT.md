# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Entwickler, die GitHub Actions für mehrere eigene Projekte nutzen und die Jobs auf dem eigenen Windows-Rechner laufen lassen statt auf GitHubs bezahlten Runnern. Heute ist das ein einzelner Nutzer (der Autor) mit mehreren parallelen Repos; die App wird so gebaut, dass sie später veröffentlicht werden kann und dann auch Fremden beim ersten Start etwas sagt.

Zwei Situationen, gleich wichtig:

- **Kurzer Blick nebenbei.** Der Nutzer arbeitet in etwas anderem und will in zwei Sekunden wissen: Läuft etwas, wie lange noch, ist etwas rot?
- **Genau hinsehen.** Ein Lauf hängt oder ist langsam; der Nutzer verfolgt ihn: welcher Job, welcher Schritt, was wartet worauf, warum dauert es.

Einrichten und Pflegen (Pools, Plätze, Caches, Limits) kommt seltener vor und ist Nebensache.

## Product Purpose

RunClub verwaltet eigene GitHub-Actions-Runner auf einem Windows-Rechner und zeigt, was sie gerade tun. Es gibt es, weil das Einrichten von Hand mühsam ist und GitHub selbst nicht zeigt, wie ein Lauf auf den eigenen Runnern vorankommt und was er den Rechner kostet.

Erfolg heißt: Der Nutzer startet Runner für ein Repo ohne Tipparbeit, kann aus der App abschätzen, wann ein Lauf fertig ist, und sieht, ob sein Rechner die Last trägt.

## Positioning

Jeder Job bekommt einen frischen, abgeschotteten Linux-Container mit eigenem Docker-Daemon und ist trotzdem schnell: Eine Reserve vorbereiteter Runner und Caches je Repo (Pakete, Build-Layer, aus den Jobs gelernte Abbilder) fangen den Aufbau ab. Vergleichbare Werkzeuge halten Runner dauerhaft am Leben und geben Jobs kein eigenes Docker.

## Operating Context

- Läuft auf einem Windows-Rechner mit Docker Desktop; Anmeldung bei GitHub über die GitHub CLI.
- Liegt im Infobereich und läuft im Hintergrund; das Fenster wird bei Bedarf geöffnet und wieder geschlossen, ohne dass Runner enden.
- Mehrere Projekte (Repos) parallel, jedes mit eigenem Pool.
- Der Rechner ist zugleich Arbeitsrechner: Arbeitsspeicher ist knapp, die Docker-VM hat weniger Speicher als Windows.
- Die Workflows der Repos zeigen über eine Repo-Variable (`CI_RUNNER`) auf die eigenen Runner.

## Capabilities and Constraints

Vorhanden:

- Pool je Repo mit einstellbarer Zahl von Plätzen, Pause, Reserve, Caches zum Leeren.
- Repo-Auswahl aus dem GitHub-Konto.
- Laufende Läufe als Netzplan: alle Jobs mit ihren Abhängigkeiten (aus `needs` der Workflow-Datei), aktuellem Schritt, üblicher Dauer und grober Restzeit.
- Verlauf der Auslastung von Windows und Docker-VM, Verbrauch je Job (Dauer, Spitzen-RAM, CPU), Wartezeit auf einen Runner.
- Start mit Windows, Symbol im Infobereich.

Begriffe: **Pool** (Runner eines Repos), **Platz** (ein gleichzeitig möglicher Job), **Reserve** (vorbereitete Runner ohne Job), **Lauf** (Workflow-Run), **Job**, **Schritt**.

Grenzen:

- Nur Linux-Runner. Windows-Runner sind bewusst entfallen.
- Restzeit ist eine Schätzung aus früheren Durchläufen.
- Technik: reines HTML, CSS und JavaScript ohne Build-Schritt in einem Electron-Fenster.

Offen:

- `CI_RUNNER` wird noch nicht von der App gesetzt.
- Limits je Job sind noch nicht in der Oberfläche einstellbar.
- Ob und unter welcher Lizenz RunClub veröffentlicht wird.

## Brand Commitments

- Name: **RunClub**.
- Symbol: Laufbahn in Orange und Weiß auf Nachtblau mit grünem Punkt (`build/icon.png`).
- Oberfläche auf Deutsch und Englisch, umschaltbar.

## Evidence on Hand

- Echte Daten aus dem laufenden Betrieb: `/api/status` der App, dazu `history.json` und `metrics.json` unter `%APPDATA%\RunClub\data`.
- Drei frühere Layout-Entwürfe mit Rückmeldung des Nutzers: Seitenleiste mit Projekten gefällt; Pipeline soll als Zusammenhang sichtbar sein, nicht als Liste; die Entwürfe waren zu textlastig und sahen nach KI aus.
- Keine Nutzerzahlen, Stimmen oder Vergleichsmessungen. Nichts davon erfinden.

## Product Principles

1. **Erst der Zustand, dann die Einstellung.** Was läuft und wie lange noch, steht vorn; Einrichten liegt eine Ebene tiefer.
2. **Ein Blick muss reichen.** Die Antwort auf „läuft was, wie lange, ist was rot" ist ohne Lesen erkennbar.
3. **Zusammenhänge zeigen, nicht aufzählen.** Ein Lauf ist eine Pipeline mit Abhängigkeiten und Engpässen, keine Liste von Zeilen.
4. **Schätzungen sind als Schätzungen erkennbar.** Restzeiten und Vorschläge geben nicht vor, genauer zu sein, als sie sind.
5. **Der Rechner gehört dem Nutzer.** Die App zeigt ehrlich, was sie an Speicher und CPU kostet, und warnt, bevor es eng wird.
