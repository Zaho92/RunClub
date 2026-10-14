# RunClub

Electron-App, die eigene GitHub-Actions-Runner auf einem Windows-Rechner verwaltet. Aufbau und Voraussetzungen: `README.md`.
Was noch ansteht: `TODO.md`. Wofür die App da ist: `PRODUCT.md`. Wie sie aussieht und welche Regeln gelten: `DESIGN.md`.

## Arbeitsweise im Code

- Kein Build-Schritt, keine Laufzeit-Abhängigkeiten: reines Node (CommonJS) und eine HTML-Datei. Electron ist die einzige Entwicklungs-Abhängigkeit.
- Kommentare und Meldungen sind deutsch, Bezeichner im Code englisch. Die Oberfläche gibt es deutsch und englisch: Jeder neue Text kommt in beide Tabellen in `src/ui.html`.
- Neue Logik kommt als eigenes Modul ohne Nebenwirkungen beim Laden (wie `src/pipeline.js`, `src/metrics.js`) und bekommt Tests in `test/`. `src/backend.js` startet beim Laden und ist deshalb nicht direkt testbar.
- Die Syntaxprüfung lehnt CRLF in `linux/` ab: Diese Dateien laufen im Runner-Container; mit Windows-Zeilenenden scheitert dort jeder `docker`-Aufruf.
- Prüfen: `npm run check` (Syntax, auch des Skripts in `src/ui.html`) und `npm test`.

## Die laufende App

- Die App läuft meist und bedient echte CI-Jobs. `src/ui.html` wird bei jedem Laden der Seite frisch gelesen; Änderungen an den anderen Dateien in `src/` brauchen einen Neustart der App. Liest die Seite ein neues Feld aus `/api/status`, bricht sie deshalb an der laufenden App, bis diese neu gestartet ist: solche Änderungen erst mit dem Neustart zusammen abschließen.
- Der Dienst antwortet nur mit dem Schlüssel des laufenden Programms als Cookie: `curl -b "rc=$(cat "$APPDATA/RunClub/data/access.key")" http://127.0.0.1:8770/api/status`. Ohne Schlüssel gibt es nur `/api/ping` und die Schriften.
- Neustart nur, wenn kein Runner „arbeitet“ (siehe `/api/status`): `POST /api/shutdown` mit demselben Cookie und dem Token aus der Seite (`const TOKEN` in `GET /`) als Kopfzeile `x-rc-token`, dann über die Startmenü-Verknüpfung starten. Beim Beenden werden alle Runner abgebaut.
- Nie zwei Instanzen mit denselben Pools: Sie melden sich gegenseitig die Runner bei GitHub ab. Zum Ausprobieren `RUNCLUB_DATA` auf einen leeren Ordner und `RUNCLUB_PORT` auf einen anderen Port setzen (`npm run backend`); eine solche Instanz räumt in Docker nur ab, was ihr eigenes Kennzeichen trägt, und hängt es an die Namen ihrer Caches und Build-Dienste. Bei GitHub meldet sie aber beim Start und Beenden alle freien Runner dieses Rechners in ihren Repos ab, also auch die der laufenden App, wenn beide ein Repo bedienen.
- Die Oberfläche lässt sich ohne App ansehen, indem `fetch` in einer Kopie von `src/ui.html` durch einen festen Zustand ersetzt und die Seite mit Electron in ein Bild gerendert wird.

## Oberfläche

- Gestaltung mit dem Skill Impeccable (`.claude/skills/impeccable`, eingerichtet mit `npx impeccable install --providers=claude --project`). Vor jeder Änderung an `src/ui.html` `reference/craft-floor.md` lesen und `DESIGN.md` einhalten.
- Nach größeren Änderungen Bildschirmfotos aufnehmen und den Gutachter als frischen Subagenten starten (`.claude/agents/impeccable-finish-reviewer.md`). Der Nutzer wünscht das ausdrücklich öfter.
- `src/ui.html` lädt sich im Fenster selbst neu, sobald die Datei sich ändert.
- Einen mehrstufigen Lauf zum Ansehen startet `gh workflow run demo.yml -R Zaho92/RunClub` (mit `-f fehler=true` scheitert ein Job).
