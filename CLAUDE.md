# RunClub

Electron-App, die eigene GitHub-Actions-Runner auf einem Windows-Rechner verwaltet. Aufbau und Voraussetzungen: `README.md`.

## Arbeitsweise im Code

- Kein Build-Schritt, keine Laufzeit-Abhängigkeiten: reines Node (CommonJS) und eine HTML-Datei. Electron ist die einzige Entwicklungs-Abhängigkeit.
- Kommentare, Meldungen und Texte der Oberfläche sind deutsch; Bezeichner im Code englisch.
- Neue Logik kommt als eigenes Modul ohne Nebenwirkungen beim Laden (wie `src/pipeline.js`, `src/metrics.js`) und bekommt Tests in `test/`. `src/backend.js` startet beim Laden und ist deshalb nicht direkt testbar.
- Prüfen: `npm run check` (Syntax, auch des Skripts in `src/ui.html`) und `npm test`.

## Die laufende App

- Die App läuft meist und bedient echte CI-Jobs. `src/ui.html` wird bei jedem Laden der Seite frisch gelesen; Änderungen an den anderen Dateien in `src/` brauchen einen Neustart der App.
- Neustart nur, wenn kein Runner „arbeitet“ (`GET http://localhost:8770/api/status`): `POST /api/shutdown` mit dem Token aus der Seite, dann über die Startmenü-Verknüpfung starten. Beim Beenden werden alle Runner abgebaut.
- Nie zwei Instanzen mit denselben Pools: Sie melden sich gegenseitig die Runner bei GitHub ab. Zum Ausprobieren `RUNCLUB_DATA` auf einen leeren Ordner und `RUNCLUB_PORT` auf einen anderen Port setzen.
- Die Oberfläche lässt sich ohne App ansehen, indem `fetch` in einer Kopie von `src/ui.html` durch einen festen Zustand ersetzt und die Seite mit Electron in ein Bild gerendert wird.
