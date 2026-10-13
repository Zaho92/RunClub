# RunClub

Eigene GitHub-Actions-Runner auf dem eigenen Windows-Rechner: je Job ein frischer Linux-Container mit eigenem
Docker-Daemon, dazu eine Reserve vorbereiteter Runner und Caches je Repo. RunClub liegt im Infobereich und
zeigt seine Oberfläche in einem Fenster.

## Voraussetzungen

- Docker Desktop, gestartet
- GitHub CLI, angemeldet (`gh auth login`), mit Verwaltungsrecht auf den Repos
- Node.js (nur für `npm install`)

Die Jobs eines Repos müssen auf eigene Runner zeigen: `runs-on: [self-hosted, Linux]`. Wer umschaltbar bleiben
will, liest das Ziel aus einer Repo-Variablen:

```yaml
runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-latest"') }}
```

und setzt `CI_RUNNER` im Repo auf `["self-hosted","Linux"]`.

## Start

```sh
npm install
npm start
```

Das Fenster zu schließen beendet nichts. Beendet wird über das Symbol im Infobereich (Rechtsklick → Beenden)
oder „Alles beenden“ in der Oberfläche; dabei enden auch die Runner.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/main.js` | Fenster, Infobereich, Start mit Windows |
| `src/backend.js` | Pools, Reserve, Caches, GitHub-Abfragen, lokaler Dienst für die Oberfläche |
| `src/pipeline.js` | Läufe mit ihren Jobs, Abhängigkeiten aus der Workflow-Datei (`needs`), übliche Dauer, Restzeit |
| `src/metrics.js` | Verlauf der Auslastung von Windows und Docker-VM, Verbrauch je Job |
| `src/routing.js` | Repo-Variable `CI_RUNNER`: schaltet die Jobs eines Repos auf die eigenen Runner und zurück |
| `src/access.js` | Wer den lokalen Dienst benutzen darf: Schlüssel je Programmlauf, Cookie, Kopfzeilen der Seite |
| `src/run.js`, `src/store.js`, `src/images.js` | Programmaufrufe mit Zeitgrenze, Dateien im Datenordner, Regeln für gelernte Abbilder |
| `src/ui.html` | Oberfläche: Projektleiste, Netzplan je Lauf, Auslastung, Verbrauch, Einstellungen (Deutsch und Englisch) |
| `src/fonts/` | Schrift Overpass (OFL), liegt in der App, damit sie ohne Internet funktioniert |
| `linux/` | Abbild der Runner |
| `scripts/make-icon.js` | zeichnet das Symbol nach `build/` (`npm run icon`) |

Einstellungen, Gelerntes und Protokoll liegen unter `%APPDATA%\RunClub\data`.
`npm run backend` startet nur den Dienst, ohne Fenster (Daten dann in `data/`); die Adresse zum Öffnen steht dann in der Konsole.

Die Oberfläche und ihre Daten bekommt nur das eigene Fenster: Der Dienst ist unter Docker Desktop auch aus den
Containern der Jobs erreichbar, deshalb verlangt er einen Schlüssel, der bei jedem Start neu entsteht
(`access.key` im Datenordner, siehe `src/access.js`).

Die Runner trennen Jobs voneinander, sind aber keine Sicherheitsgrenze: Der Docker-Daemon eines Jobs läuft
privilegiert. Auf ihnen darf nur Code laufen, dem du vertraust; Pools gibt es deshalb nur für private Repos.

## Entwicklung

```sh
npm run check   # Syntax aller Skripte, auch des Skripts in der Oberfläche
npm test        # Tests aller Module außer backend.js und main.js
```

Dieselben beiden Schritte laufen als CI bei jedem Push und Pull Request (`.github/workflows/ci.yml`).
Hinweise für die Arbeit mit Claude Code stehen in `CLAUDE.md`, die Produktbeschreibung für die Gestaltung in `PRODUCT.md`.
Die Gestaltung folgt dem Skill [Impeccable](https://github.com/pbakaus/impeccable) (`npx impeccable install --providers=claude --project`).
