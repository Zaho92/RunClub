# RunClub

Electron-App, die eigene GitHub-Actions-Runner auf einem Windows-Rechner verwaltet. Aufbau und Voraussetzungen: `README.md`.
Was noch ansteht: `TODO.md`. Wofür die App da ist: `PRODUCT.md`. Wie sie aussieht und welche Regeln gelten: `DESIGN.md`.

## Arbeitsweise im Code

- Kein Build-Schritt, keine Laufzeit-Abhängigkeiten: reines Node (CommonJS) und eine HTML-Datei. Electron ist die einzige Entwicklungs-Abhängigkeit.
- Kommentare, Meldungen und Texte der Oberfläche sind deutsch; Bezeichner im Code englisch.
- Neue Logik kommt als eigenes Modul ohne Nebenwirkungen beim Laden (wie `src/pipeline.js`, `src/metrics.js`) und bekommt Tests in `test/`. `src/backend.js` startet beim Laden und ist deshalb nicht direkt testbar.
- Die Syntaxprüfung lehnt CRLF in `linux/` ab: Diese Dateien laufen im Runner-Container; mit Windows-Zeilenenden scheitert dort jeder `docker`-Aufruf.
- Prüfen: `npm run check` (Syntax, auch des Skripts in `src/ui.html`) und `npm test`.

## Die laufende App

- Die App läuft meist und bedient echte CI-Jobs. `src/ui.html` wird bei jedem Laden der Seite frisch gelesen; Änderungen an den anderen Dateien in `src/` brauchen einen Neustart der App.
- Neustart nur, wenn kein Runner „arbeitet“ (`GET http://localhost:8770/api/status`): `POST /api/shutdown` mit dem Token aus der Seite, dann über die Startmenü-Verknüpfung starten. Beim Beenden werden alle Runner abgebaut.
- Nie zwei Instanzen mit denselben Pools: Sie melden sich gegenseitig die Runner bei GitHub ab. Zum Ausprobieren `RUNCLUB_DATA` auf einen leeren Ordner und `RUNCLUB_PORT` auf einen anderen Port setzen.
- Die Oberfläche lässt sich ohne App ansehen, indem `fetch` in einer Kopie von `src/ui.html` durch einen festen Zustand ersetzt und die Seite mit Electron in ein Bild gerendert wird.

## Oberfläche

- Gestaltung mit dem Skill Impeccable (`.claude/skills/impeccable`, eingerichtet mit `npx impeccable install --providers=claude --project`). Vor jeder Änderung an `src/ui.html` `reference/craft-floor.md` lesen und `DESIGN.md` einhalten.
- Nach größeren Änderungen Bildschirmfotos aufnehmen und den Gutachter als frischen Subagenten starten (`.claude/agents/impeccable-finish-reviewer.md`). Der Nutzer wünscht das ausdrücklich öfter.
- `src/ui.html` lädt sich im Fenster selbst neu, sobald die Datei sich ändert.
- Einen mehrstufigen Lauf zum Ansehen startet `gh workflow run demo.yml -R Zaho92/RunClub` (mit `-f fehler=true` scheitert ein Job).
