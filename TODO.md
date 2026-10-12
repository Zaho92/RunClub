# Offene Punkte

Stand: 12.10.2026. Die Reihenfolge innerhalb eines Abschnitts ist die empfohlene. Wie hier gearbeitet wird, steht in
`CLAUDE.md`; wofür die App da ist, in `PRODUCT.md`; wie sie aussieht und warum, in `DESIGN.md`.

## Als Nächstes

1. **Einstellungen überarbeiten.** Vom Nutzer angemerkt, noch ohne Einzelheiten: vor dem Umbau nachfragen, was stört.
   Die Ansicht ist funktional vollständig (Plätze, Pause, Caches, CI_RUNNER, Projekt hinzufügen, Autostart,
   Darstellung, Sprache), aber gestalterisch der schwächste Teil. Vorgehen wie bei der Hauptansicht: Impeccable
   (`shape`, dann bauen), danach der Gutachter.
2. **Limits je Job einstellbar machen.** Heute stehen sie nur in `runners.json` (`limits`: je 4 GB und 6 Kerne für Runner
   und Docker, also 8 GB je Job). Die Docker-VM hat 9,7 GB, bei mehreren Plätzen schützen die Limits nicht. Gebraucht:
   Regler in den Einstellungen und der Vorschlag aus den Messwerten (die Ansicht „Verbrauch“ rechnet ihn schon aus).
   Neue Limits gelten erst für neu gebaute Runner-Paare.
3. **Wartende Läufe ohne Pool finden.** Die Repos des Kontos nach Läufen durchsuchen, die auf einen Runner warten, und
   anbieten, einen Pool anzulegen. Auf das Anfragelimit achten (5.000 je Stunde; im Leerlauf verbraucht RunClub rund 720).
4. **Installer.** Eigenständige App statt der Verknüpfung auf den Entwicklungsordner (`electron-builder`, NSIS). Bekannte
   Hürde unter Windows: Das Paket `winCodeSign` enthält symbolische Links und lässt sich ohne Entwicklermodus oder
   Administratorrechte nicht entpacken. `asar` muss aus bleiben oder `linux/` als `extraResources` mitkommen, weil
   `docker build` einen echten Ordner braucht.

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
- **`confirm()`** öffnet den nativen Dialog; eine Rückfrage in der Bildwelt der App fehlt.
- **Erster Bildschirm** ist bis zur ersten Antwort leer; ein Gerüstzustand fehlt.
- **„−“ und „+“** auf den Schrittknöpfen sind Textzeichen, keine gezeichneten Symbole.
- **`src/backend.js` aufteilen.** Es startet beim Laden und ist deshalb nicht testbar. Pools, Reserve und Caches sind der
  ungetestete Kern; jede Änderung dort erst mit einem leeren Datenordner ausprobieren (siehe `CLAUDE.md`).
- **Demo-Pipeline** (`.github/workflows/demo.yml`) entfernen, sobald sie zum Ansehen des Netzplans nicht mehr gebraucht wird.
- **Impeccable** liegt zusätzlich für GitHub Copilot unter `.github/skills` (nicht eingecheckt, 21 MB). Kann lokal weg.

## Erledigt (zur Einordnung)

Electron-App mit Symbol im Infobereich und Autostart · Windows-Runner entfernt · Repo-Auswahl aus dem GitHub-Konto ·
Netzplan je Lauf mit Abhängigkeiten aus `needs`, üblicher Dauer und Restzeit · Verlauf der Auslastung und Verbrauch je Job ·
neue Oberfläche „Midnight Transit“ mit Kompakt- und Detailmodus, Deutsch und Englisch · Läufe erscheinen sofort ·
CI_RUNNER wird beim Anlegen und Entfernen eines Pools gesetzt · Tests und CI auf den eigenen Runnern.
