---
name: RunClub
description: Eigene GitHub-Actions-Runner als Liniennetz auf mitternachtsblauem Grund.
colors:
  ground: "#0c1838"
  rail: "#091230"
  surface: "#14224f"
  raised: "#1a2b60"
  edge: "#26366e"
  rule: "#1f2d62"
  cap: "#33427a"
  track: "#6a7bb5"
  track-open: "#5b6a94"
  ink: "#dfe5f5"
  text: "#c9d2ea"
  muted: "#8793b8"
  chart: "#8fa4e0"
  run: "#ffc53d"
  done: "#3fcf8e"
  fail: "#f0524a"
  fail-text: "#f58a8f"
  cancel: "#c084fc"
  skip: "#7a85a3"
  wait: "#5b6a94"
  rail-hover: "#0f1b44"
  fail-edge: "#7a2f38"
typography:
  display:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "56px"
    fontWeight: 200
    lineHeight: 1
  display-small:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 300
    lineHeight: 1
  headline:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 400
    lineHeight: 1.2
  title:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.45
  figure:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 300
    lineHeight: 1.25
    fontFeature: "tabular-nums"
  body:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 300
    lineHeight: 1.45
    fontFeature: "tabular-nums"
  body-strong:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  meta:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  axis:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  brand:
    fontFamily: "Overpass, 'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.45
  mono:
    fontFamily: "Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  float: "6px"
  control: "8px"
  pill: "21px"
  full: "999px"
spacing:
  rail-gap: "4px"
  pill-gap: "12px"
  run-inner: "14px"
  stack: "22px"
  band: "34px"
  main-x: "44px"
  rail-width: "232px"
components:
  pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.pill}"
    padding: "8px 16px 8px 9px"
  pill-hover:
    backgroundColor: "{colors.raised}"
  pill-open:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
  state-icon:
    backgroundColor: "{colors.run}"
    textColor: "{colors.ground}"
    size: "22px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.control}"
    padding: "8px 12px 8px 36px"
  nav-item-hover:
    backgroundColor: "{colors.rail-hover}"
  nav-item-current:
    backgroundColor: "{colors.surface}"
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-hover:
    backgroundColor: "{colors.raised}"
  button-active:
    backgroundColor: "{colors.edge}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fail-text}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-step:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "5px 0"
    width: "30px"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "5px 14px"
  segment-pressed:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "1px 10px"
  tooltip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.float}"
    padding: "3px 9px"
---

# Design System: RunClub

Abgeleitet aus dem gebauten Stand von `src/ui.html`. Die Werte im Kopf dieser Datei sind maßgeblich; der Text erklärt, wo und warum sie gelten. Die Token heißen wie im CSS (`--ground` → `ground`). `rail-hover` und `fail-edge` stehen im CSS als feste Werte, nicht als Variablen.

## Overview

**Creative North Star: "Midnight Transit"**

Ein Lauf ist ein Liniennetz auf einem mitternachtsblauen Emailleschild. Jobs sind Stationen in Form von Pills, die Abhängigkeiten zwischen ihnen sind geschwungene Strecken. Wer hinsieht, liest ohne ein Wort Text, was auf was wartet und wo es hängt. Die Oberfläche arbeitet im Modus Operate: Sie wird nebenbei für zwei Sekunden angesehen oder beim Verfolgen eines Laufs genau gelesen, und beides muss dieselbe Ansicht tragen.

Das System ist ruhig und flach. Es gibt genau ein dunkles Thema, keine Schatten, keine Verläufe und kein reines Weiß. Tiefe entsteht aus vier eng gestuften Blautönen, Gliederung aus feinen Haarlinien. Die Schrift ist Overpass in leichten Schnitten; alle Zahlen stehen in Tabellenziffern, weil sie im Sekundentakt weiterzählen. Sättigung ist dem Zustand vorbehalten: Sechs Zustandsfarben, jede mit eigenem gezeichnetem Symbol, sind das Einzige auf der Fläche, das leuchtet.

Die Dichte folgt der Aufgabe. Im Kompaktmodus zeigt eine Pill Symbol, Name und Zeit; beim Überfahren verlängert sie sich nach unten und legt ihre Details über das, was darunter liegt – nichts verschiebt sich. Im Detailmodus trägt jede Pill eine gekürzte zweite Zeile. Über allem steht die Auslastung des Rechners als Verlauf über die Zeit, nicht als Momentwert; sie bleibt beim Scrollen stehen.

**Key Characteristics:**
- Netzplan statt Jobliste: Stufen von links nach rechts, Strecken zwischen den Pills.
- Nur dunkel, mitternachtsblau; hellster Ton ist Porzellan-Blaugrau, nie Weiß.
- Zustand immer doppelt: Farbe und gezeichnetes Symbol.
- Leichte Schrift (200 bis 400), Tabellenziffern überall.
- Flach: Tonstufen und Haarlinien statt Schatten.
- Verlauf der Auslastung als Linie mit zarter Fläche darunter.

## Colors

Eine einfarbige Welt in Blau um Farbton 268°, in der allein die sechs Zustände Farbe tragen.

### Primary
- **Streckenblau** (`track`): Die Strecken des Netzplans (2,5 px, runde Enden), der Rahmen einer überfahrenen Pill oder Schaltfläche, der Rahmen von Tooltip und Meldung. Das gedämpfte Stahlblau ist die Linienfarbe des Systems.
- **Offene Strecke** (`track-open`): Dieselbe Strecke, wenn ihr Ziel noch wartet oder ausgesetzt ist; dann gepunktet (`2 7`). Wertgleich mit `wait`.
- **Kurvenblau** (`chart`): Linie und Fläche (16 % Deckkraft) der Verlaufskurven, außerdem Fokusring, Schreibmarke und Häkchen der Auswahlkästchen.

### Secondary
Die sechs Zustandsfarben. Ihre Helligkeit folgt der Dringlichkeit: was läuft, ist am hellsten, was wartet, am dunkelsten.
- **Signalgelb** (`run`): Job läuft. Füllt das Symbol, färbt den 2 px hohen Fortschrittsstrich am unteren Rand der Pill und die Zeit eines Jobs, der länger braucht als üblich.
- **Signalgrün** (`done`): Job fertig; auch das Wort „fertig“ beim letzten Lauf.
- **Signalrot** (`fail`): Fehler. Füllt das Symbol und färbt eine Verlaufskurve, wenn der Speicher knapp wird.
- **Fehlertext** (`fail-text`): Rot für Schrift, aufgehellt, damit es auf den blauen Flächen lesbar bleibt: Fehlerzahl, fehlgeschlagener Schritt, Warnsätze, gefährliche Schaltflächen.
- **Fehlerrand** (`fail-edge`): Abgedunkeltes Rot für Rahmen: fehlgeschlagene Pill, Warn-Tag, gefährliche Schaltfläche.
- **Violett** (`cancel`): Abgebrochen.
- **Schiefer** (`skip`): Ausgesetzt. Nur Ring und Strich, keine Füllung.
- **Wartegrau** (`wait`): Wartet. Nur Ring und Punkt, keine Füllung; auch die senkrechte Marke „Lauf gestartet“ in den Kurven.

### Neutral
- **Mitternachtsgrund** (`ground`): Hintergrund des Hauptbereichs; zugleich die Farbe der Symbolzeichnung auf gefüllten Zustandskreisen.
- **Leiste** (`rail`): Eine Stufe dunkler; Projektleiste und Eingabefelder.
- **Leisten-Hover** (`rail-hover`): Überfahrener Eintrag der Projektleiste.
- **Fläche** (`surface`): Eine Stufe heller; Pills, Schaltflächen, gewählter Eintrag der Leiste.
- **Angehoben** (`raised`): Überfahrene Pill oder Schaltfläche, gewähltes Segment, Tooltip und Meldung.
- **Kante** (`edge`): Rahmen von Pills, Schaltflächen, Feldern, Tags; gedrückte Schaltfläche; Rollbalken.
- **Haarlinie** (`rule`): Trennlinien zwischen Abschnitten und Tabellenzeilen, Mittellinie der Kurven.
- **Obergrenze** (`cap`): Die Linie, die in einer Kurve das Maximum markiert.
- **Porzellan** (`ink`): Hellster Ton. Überschriften, Namen, große Zahlen, hervorgehobene Strecke.
- **Text** (`text`): Lauftext und Zeiten.
- **Gedämpft** (`muted`): Unterzeilen, Beschriftungen, Achsen, Hinweise.

### Named Rules
**Die Kein-Weiß-Regel.** Der hellste Ton ist `ink`. Reines Weiß kommt nirgends vor, auch nicht in Symbolen: Auf gefüllten Zustandskreisen ist die Zeichnung in `ground` ausgespart.

**Die Farbe-plus-Symbol-Regel.** Ein Zustand erscheint nie nur als Farbe. Jede der sechs Farben hat ihr gezeichnetes Symbol (Dreieck, Haken, Kreuz, Quadrat, Strich, Punkt); wer die Farbe nicht unterscheidet, liest das Symbol.

**Die Strecken-bleiben-blau-Regel.** Strecken tragen nie eine Zustandsfarbe. Sie sind `track`, gepunktet `track-open`, solange das Ziel noch nicht dran ist, und `ink`, wenn die Pill an ihrem Ende überfahren wird. Der Zustand steht an der Station, nicht auf der Linie.

**Die Rot-ist-Störung-Regel.** Rot bedeutet, dass etwas das Eingreifen des Nutzers verlangt: ein Fehler im Lauf, ein voller Speicher, eine Aktion, die etwas löscht. Für nichts anderes.

## Typography

**Display Font:** Overpass (mit „Segoe UI“, system-ui, sans-serif), als variable Schrift lokal ausgeliefert (`src/fonts/overpass-latin.woff2`, Strichstärken 100–900)
**Body Font:** Overpass (dieselbe Familie)
**Label/Mono Font:** Consolas, monospace, nur für Code (der Ausdruck für `runs-on` in den Einstellungen)

**Character:** Eine einzige Familie, deren Herkunft aus der Verkehrsbeschilderung zur Bildwelt passt. Die Hierarchie entsteht aus Größe und Farbe, kaum aus Gewicht: Lauftext in 300, Namen und Überschriften in 400, die große Restzeit in 200.

### Hierarchy
- **Display** (200, 56 px, Zeilenhöhe 1): Die Restzeit des Laufs oben rechts. Unter 760 px Breite 40 px.
- **Display klein** (300, 34 px, Zeilenhöhe 1): An derselben Stelle, wenn dort ein Wort statt einer Zeit steht („fertig“, „Fehler“, „wartet auf einen Runner“).
- **Headline** (400, 26 px, Zeilenhöhe 1,2): Titel des Laufs oder der Ansicht, eine je Ansicht oder Lauf; ausgeglichener Umbruch.
- **Title** (400, 18 px): Abschnitte in „Verbrauch“ und „Einstellungen“.
- **Kennzahl** (`figure`; 300, 26 px, Zeilenhöhe 1,25): Der aktuelle Wert über einer Verlaufskurve, mit der Bezugsgröße in 13 px `muted` dahinter.
- **Body** (300, 14 px, Zeilenhöhe 1,45): Lauftext, Tabellenzellen, Zeiten in den Pills.
- **Body betont** (400, 14 px): Namen von Jobs und Projekten, in `ink`.
- **Meta** (400, 13 px): Unterzeilen, Hinweise, Legende, Tabellen, Schaltflächen.
- **Label** (400, 12 px): Beschriftung über Kennzahlen, zweite Zeile in Leiste und Pill, Tags, Tooltip.
- **Achse** (400, 11 px): Zeitachse unter den Kurven.
- **Wortmarke** (600, 22 px): „RunClub“ oben in der Leiste; die einzige Stelle mit kräftigem Schnitt.
- **Mono** (Consolas, 12 px): Code in den Einstellungen. Das Protokoll steht in Overpass.

### Named Rules
**Die Leichte-Schnitte-Regel.** Lauftext steht in 300, Betonung in 400, nichts außer der Wortmarke darüber. Je größer die Schrift, desto leichter der Schnitt.

**Die Tabellenziffern-Regel.** `font-variant-numeric: tabular-nums` gilt für die ganze Seite. Zeiten zählen im Sekundentakt weiter; ohne feste Ziffernbreite würden Pills und Spalten zittern.

**Die Kleinschreib-Regel.** Beschriftungen stehen in normaler Schreibung ohne Sperrung. Versalien und Laufweiten kommen nicht vor.

## Layout

Zwei Spalten über die volle Fensterhöhe: links die Projektleiste (232 px), rechts der Hauptbereich, der allein rollt. Der Hauptbereich hat 26 px Abstand oben, 44 px seitlich und 40 px unten. Sein Inhalt ist ein senkrechter Stapel mit 22 px Abstand; innerhalb eines Laufs sind es 14 px, zwischen mehreren Läufen und zwischen den Spalten des Auslastungsbands 34 px.

Der Kopf eines Laufs stellt Titel und Herkunft links an die Grundlinie der großen Restzeit rechts. Der Netzplan füllt die Breite: Jede Stufe ist eine Spalte (mindestens 180 px, höchstens 280 px), die Spalten stehen mit `clamp(40px, 6vw, 96px)` Abstand nebeneinander und sind senkrecht mittig ausgerichtet, die Pills einer Spalte haben 12 px Abstand. Hat ein Lauf keine Abhängigkeiten, stehen die Jobs in Startreihenfolge zu sechst je Spalte. Im Kompaktmodus hält der Plan 44 px Höhe vor, damit das Aufklappen einer Pill nichts darunter verschiebt. Reicht die Breite nicht, rollt der Plan waagerecht.

Ganz oben im Hauptbereich steht das Auslastungsband und bleibt beim Scrollen stehen (`position: sticky`), nach unten durch eine Haarlinie abgesetzt: drei gleich breite Verlaufskurven und rechts die etwas breitere Spalte mit den Plätzen (Verhältnis 1 : 1 : 1 : 1,25). Die Plätze sind so hoch wie die Kurven (132 px) und rollen in sich. Darunter stehen die Läufe untereinander, jeder mit Kopf und Netzplan, nach dem letzten die Legende, danach die ruhigen Projekte als Zeilen. „Verbrauch“ ist wie die Einstellungen eine Strecke (höchstens 860 px breit): Die erste Haltestelle zeigt dieselben drei Kurven über 24 Stunden, die zweite die GitHub-Anfragen, danach hat jedes Projekt seine eigene Haltestelle mit der höchsten gemessenen Spitze eines Jobs (zwei Schienen wie beim Regler, Runner und Docker, gemessen am erlaubten Limit; rot ab 85 %, dann mit Verweis auf die Limits) und einer Tabelle seiner Jobs über die volle Breite der Haltestelle (Zahlenspalten 96 px, im schmalen Fenster 84 px; reicht die Breite nicht, rollt sie waagerecht). Die Tabelle nennt den Verbrauch zuerst, Runner und Docker getrennt; der Wert, der die Schiene bestimmt, steht in `ink`. Eine gepunktete Marke auf jeder Schiene zeigt die 85 %. „Einstellungen“ ist auf 860 px begrenzt und als Strecke gegliedert: Links läuft eine senkrechte Linie, an der jeder der vier Abschnitte (Projekte, Limits je Job, App, Protokoll) mit einer Haltestelle beginnt; der Inhalt steht 44 px rechts der Linie, zwischen den Abschnitten liegen 44 px ohne weitere Trennlinie.

Umbrüche:
- **bis 1100 px:** Das Band wird zweispaltig, der seitliche Abstand des Hauptbereichs sinkt auf 24 px.
- **bis 900 px:** Die Zeilen ruhiger Projekte in „Alle Projekte“ werden zweizeilig.
- **bis 760 px:** Die Leiste wird zur waagerecht rollenden Zeile oben, das Band zweispaltig mit niedrigeren Kurven (44 px) und den Plätzen über die volle Breite, Titel und Restzeit stehen untereinander. Das Band bleibt dort nicht stehen. Der Netzplan rollt die Spalte mit dem ersten roten oder laufenden Job in die Mitte.

## Elevation & Depth

Das System ist flach. Es gibt keinen Schatten, keinen Verlauf und keine Unschärfe. Tiefe entsteht aus Tonstufen: `rail` liegt unter `ground`, `surface` darüber, `raised` noch eine Stufe höher. Was schwebt (Tooltip, Meldung), ist `raised` mit einem Rahmen in `track`, nicht mit Schatten abgehoben. Flächen, die noch nicht dran sind, sind gar keine: Wartende und ausgesetzte Pills sind durchsichtig mit gestricheltem Rand.

### Named Rules
**Die Tonstufen-Regel.** Eine Fläche hebt sich durch die nächsthellere Stufe und einen 1 px breiten Rahmen ab, nie durch einen Schatten. Die Reihenfolge ist fest: `rail`, `ground`, `surface`, `raised`.

**Die Antwort-ist-eine-Stufe-Regel.** Überfahren hebt eine Fläche genau eine Stufe (`surface` → `raised`) und färbt ihren Rahmen von `edge` nach `track`. Nichts bewegt sich dabei von der Stelle.

## Shapes

Drei Formen, jede mit fester Bedeutung. Die **Pill** (Radius 21 px, die halbe Höhe der geschlossenen Station) ist dem Job vorbehalten; beim Überfahren wächst sie als eine Form mit unverändertem Radius nach unten. Der **Kreis** ist das Zustandssymbol (22 px, in Legende 18 px, in Leiste und Listen 16 px; Rand 2 px). Alles Bedienbare außerhalb des Netzplans (Schaltfläche, Segment, Feld, Eintrag der Leiste) hat **sanft gerundete Ecken** (8 px); Tooltip und Meldung 6 px, Tags sind voll gerundet.

Strecken sind kubische Bézierkurven: Sie verlassen die rechte Mitte des Vorgängers waagerecht und laufen waagerecht in die linke Mitte des Nachfolgers ein (Anfasser 55 % des Abstands, mindestens 30 px), 2,5 px stark mit runden Enden. Gerade oder rechtwinklig geführte Strecken gibt es im Netzplan nicht. Die einzige gerade Strecke ist die senkrechte Linie der Einstellungen (siehe „Haltestelle“): Dort ist sie Wegweiser durch die Seite, keine Abhängigkeit.

Rahmen sind 1 px. Durchgezogen heißt: ist dran oder war dran. Gestrichelt (Pill) und gepunktet (Strecke) heißt: noch offen. Trennlinien sind 1 px in `rule` und immer waagerecht; die Linie der Einstellungen ist keine Trennlinie, sondern eine Strecke (2,5 px, `track`).

## Components

### Pill (Station)
Die Signaturkomponente; ein Job im Netzplan, als Ganzes ein Link zum Job bei GitHub.
- **Aufbau:** Dreispaltiges Raster: Zustandssymbol (22 px), Name (`ink`, 400, mit Auslassungspunkten gekürzt), Zeit rechts. Die Höhe ist fest. Die Details (Schritt, Platz, übliche Dauer; 12 px `muted`) liegen in einer zweiten Fläche in der Form der Pill, deckungsgleich hinter ihrem Inhalt; sie verschiebt nichts.
- **Form und Farbe:** Fläche `surface`, Rahmen 1 px `edge`, Radius 21 px, Innenabstand 8 px 16 px 8 px 9 px.
- **Überfahren / Fokus:** Fläche `raised`, Rahmen `track` (180 ms). Diese Fläche (`raised`, Rahmen `track`, Radius 21 px, kein Schatten) wächst nach 80 ms Verzögerung in 280 ms nach unten (`grid-template-rows` 0fr → 1fr); Ecken und Rand ändern sich dabei nicht. Zugleich treten die Strecken dieser Pill in `ink` hervor und alle anderen gehen auf 30 % Deckkraft zurück.
- **Läuft:** Am unteren Rand wächst ein 2 px hoher Strich in `run` bis zur üblichen Dauer. Braucht der Job spürbar länger (über 115 % und mehr als 10 s), färbt sich die Zeit `run`.
- **Fehler:** Rahmen `fail-edge`; eine zweite, gekürzte Zeile nennt in beiden Modi in `fail-text` den Schritt, an dem es scheiterte.
- **Wartet / ausgesetzt:** Durchsichtig, Rahmen gestrichelt, Name `muted`; die Zeit ist eine Schätzung („ca. 2:19“).
- **Detailmodus:** Jede Pill trägt eine zweite, auf eine Zeile gekürzte Detailzeile; die Überlagerung setzt dann unter der ersten Zeile an.
- **Erneut starten:** Ein abgeschlossener Job eines abgeschlossenen Laufs trägt rechts in seinen aufgeklappten Details die Schaltfläche „Job erneut starten“ (nur Symbol, 30 px, Radius 8 px; auf `raised` mit den Rahmentönen als Stufen wie in der Rückfrage). Sie ist kein Teil des Links, sondern steht neben der Pill im selben Rahmen und erscheint mit den Details, bei Überfahren und bei Tastaturfokus; in der Tastaturfolge kommt sie direkt nach ihrer Pill. Steht der Zeiger auf ihr, bleibt die Pill aufgeklappt. Die geschlossene Pill ändert sich nicht.

### Zustandssymbol
Ein Kreis mit einer Zeichnung aus einem 16er-Raster, Strich 2,2 mit runden Enden. Läuft: gefülltes Dreieck auf `run`. Fertig: Haken auf `done`. Fehler: Kreuz auf `fail`. Abgebrochen: gefülltes Quadrat auf `cancel`. Ausgesetzt: Strich im leeren Ring `skip`. Wartet: Punkt im leeren Ring `wait`. Ein leerer Ring ohne Zeichnung steht in der Leiste für ein Projekt, in dem nichts läuft. Die Legende unter dem Netzplan zeigt alle sechs mit ihrem Wort.

### Strecke
Siehe Shapes. Eine Strecke zu einem wartenden oder ausgesetzten Job ist gepunktet in `track-open`. Farbe und Deckkraft wechseln in 150 ms.

### Verlaufskurve
- **Aufbau:** Beschriftung (12 px `muted`), darunter die Kennzahl mit Bezugsgröße, die Kurve (74 px hoch, volle Spaltenbreite), eine Achse mit zwei oder drei Wörtern („vor 30 min“, „Lauf gestartet“, „jetzt“) und eine Zeile mit der Spitze.
- **Zeichnung:** Linie 2 px in `chart` mit runden Ecken, darunter dieselbe Farbe als Fläche mit 16 % Deckkraft. Hilfslinien 1 px: Obergrenze (`cap`), Mitte (`rule`), Spitze (gepunktet, `chart`), Beginn eines Laufs (senkrecht, gestrichelt, `wait`).
- **Warnung:** Wird der Speicher knapp, wechseln Linie, Fläche, Kennzahl und Spitzenzeile auf Rot, und vor der Spitze steht, wie wenig noch frei ist („nur 0,9 GB frei“). Das gilt für Windows und für die Docker-VM (dort unter 15 % frei, in der VM selbst gemessen).
- **Mauszeiger:** Fadenkreuz; eine senkrechte Linie in `ink` und ein Tooltip mit Uhrzeit und Wert.

### Navigation (Projektleiste)
- **Eintrag:** Zweizeilig: Name (`ink`, 400) und Zustand in Worten (12 px `muted`), links das Zustandssymbol (16 px). Radius 8 px, Innenabstand 8 px 12 px 8 px 36 px, 4 px Abstand zwischen Einträgen.
- **Zustände:** Ruhe durchsichtig, überfahren `rail-hover`, gewählt `surface`.
- **Fuß:** „Verbrauch“ und „Einstellungen“ einzeilig ohne Symbol am unteren Rand. „Verbrauch“ trägt eine zweite Zeile, wenn die GitHub-Anfragen knapp (`muted`) oder aufgebraucht (`fail-text`) sind. Gibt es in den Einstellungen etwas zu tun (ein Job hat sein Limit erreicht oder kam ihm nahe), trägt „Einstellungen“ eine zweite Zeile in `fail-text`, die sagt, was und bei welchem Projekt; im schmalen Fenster steht dafür ein Punkt hinter dem Wort.
- **Schmal:** Eine waagerecht rollende Zeile aus Symbol und Name; der gewählte Eintrag rückt in den Blick.

### Schaltflächen
Zurückhaltend und klein; sie gehören zum Einrichten, nicht zum Zustand.
- **Form:** Radius 8 px, Rahmen 1 px `edge`, Fläche `surface`, 13 px, Innenabstand 5 px 12 px.
- **Überfahren / gedrückt / gesperrt:** `raised` mit Rahmen `track` (150 ms); gedrückt `edge`; gesperrt 50 % Deckkraft.
- **Gefährlich:** Schrift `fail-text`, Rahmen `fail-edge`; steht am rechten Ende der Zeile, getrennt von den harmlosen Aktionen.
- **Nur Symbol:** 30 px breit und hoch, für Aktionen, die sich in einer Liste wiederholen (eins mehr, eins weniger, einen Cache leeren). Die Aktion steht als Tooltip der App daran, bei Überfahren und bei Tastaturfokus.
- **Symbol mit Wort:** für seltene und gefährliche Aktionen; 8 px zwischen Symbol und Wort.
- **Am Lauf:** Unter dem Kopf eines abgeschlossenen Laufs, linksbündig mit dem Titel, steht „Erneut starten“ (Symbol mit Wort; der ganze Lauf), nach einem Fehler daneben „Nur Gescheiterte“ (nur Wort, weil es dieselbe Aktion enger fasst). Sie stehen unter dem Kopf und nicht in ihm, damit Titel und Restzeit auf einer Grundlinie bleiben. Erneut starten löscht nichts und fragt deshalb nicht nach; eine Meldung bestätigt es, weil der Lauf bei GitHub erst nach einem Augenblick wieder erscheint. Ein laufender Lauf trägt keine Schaltflächen.
- **Gesperrt mit Grund:** Kann eine Aktion gerade nicht gelten (höchstens 4 Plätze), bleibt die Schaltfläche überfahrbar und nennt den Grund im Tooltip.
- Was löscht, steht abgesetzt am rechten Ende der Zeile; nur was nicht wiederkommt (Projekt entfernen, RunClub beenden), ist rot.
- Eine gefüllte Hauptschaltfläche gibt es nicht.

### Bediensymbole
Gezeichnet im selben 16er-Raster wie die Zustandssymbole, aber als Linie ohne Kreis: Strich 1,7 mit runden Enden, in der Schriftfarbe der Schaltfläche. Sie tragen nie eine Zustandsfarbe. Ein Symbol steht für genau eine Aktion: Plus heißt hinzufügen, der Papierkorb leeren, die Gabelung „wohin die Jobs gehen“. Der Bogen im Uhrzeigersinn heißt „Runner neu aufbauen“; der Bogen zurück an den Anfang mit dem Dreieck darin heißt „erneut starten“, für den Lauf wie für den einzelnen Job.

### Haltestelle
Die Gliederung der Einstellungen. Eine senkrechte Strecke (2,5 px, `track`) verbindet die Abschnitte; an jedem sitzt ein Ring (17 px, Rand 2,5 px `track`, Fläche `ground`) neben der Überschrift. Der Ring ist ein Knopf und rollt zu seinem Abschnitt. Die Haltestelle, an der die Seite gerade steht, ist in `ink` gefüllt. Die Strecke endet an der letzten Haltestelle.

### Projektzeile
Ein Projekt in den Einstellungen: Fläche `surface`, Rahmen 1 px `edge`, Radius 8 px. Im Kopf stehen Pfeil, Name, die Summe der Caches in `muted` und rechts die Zahl der Plätze mit eins weniger und eins mehr. Ein Klick auf den Kopf klappt die Zeile nach unten auf (dieselbe Bewegung wie die Pill: `grid-template-rows` 0fr → 1fr in 280 ms, der Pfeil dreht sich); es ist immer nur eine offen. Aufgeklappt, durch eine Haarlinie abgesetzt: wohin die Jobs gehen, die Limits des Projekts (Segmentschalter „Wie alle“ oder „Eigene“; mit eigenen Werten dieselben vier Regler wie im Abschnitt Limits), die Caches als Zeilen mit Größe und Symbol zum Leeren, darunter die Schaltflächen. Ein Projekt mit eigenen Limits trägt im Kopf das Tag „eigene Limits“. Passen die Limits nicht zum gemessenen Bedarf, steht das ebenfalls als Tag im Kopf und als Satz bei den Limits: „Limit erreicht“ und „Limit knapp“ (über 85 %) als Warnung in Rot, „Limit großzügig“ (mehr als das Doppelte des Bedarfs) gedämpft. Überfahren hebt eine geschlossene Zeile eine Stufe.

Die letzte Zeile der Liste ist „Projekt hinzufügen“: durchsichtig mit gestricheltem Rand in `cap`, weil hier noch nichts ist.

### Speicherbalken
Was alle Plätze zusammen an Arbeitsspeicher dürfen, gemessen an der Docker-VM. Über dem Balken die Kennzahl (`figure`) mit der Bezugsgröße. Der Balken selbst: je Platz ein Feld (26 px hoch, Radius 6 px), nach Projekten gruppiert und darunter beschriftet; die Breite eines Feldes folgt dem Limit seines Projekts. Ein Projekt mit eingeschaltetem Cache trägt am Ende seiner Gruppe ein weiteres Feld für seinen Build-Dienst (Fläche `cap`, so breit wie sein Docker-Limit); die Beschriftung nennt ihn eigens („2 × 8 GB + Build 4 GB“). Der Build-Dienst läuft auch, während der Pool pausiert: Ein pausiertes Projekt zeigt dann nur dieses Feld. Die Build-Dienste zählen zuerst, in den Rest passen die Plätze. Felder, die mit vollem Limit in die VM passen, sind gefüllt (`raised`, Rahmen `cap`); die übrigen durchsichtig mit gestricheltem Rand. Eine senkrechte Marke in `track` zeigt die Grenze der VM. Rot wird die Kennzahl erst, wenn schon ein einzelner Job (mit dem Build-Dienst seines Projekts) mehr darf, als die VM hat; dass nicht alle Plätze zugleich hineinpassen, ist der Normalfall und steht als Satz in `muted` darunter, mit der Abhilfe.

### Regler
Schiene 4 px, voll gerundet, links vom Griff `chart`, rechts `edge`; Griff 16 px, rund, `ink`. Links die Beschriftung, rechts der Wert in `ink`. Ein Vorschlag steht als gepunktete senkrechte Marke in `ink` durch die Schiene. Während des Ziehens rechnet der Speicherbalken mit; gespeichert wird beim Loslassen.

### Schalter
Für An und Aus einer einzelnen Einstellung: 38 × 22 px, voll gerundet. Aus: Fläche `rail`, Rahmen `edge`, Griff `muted`. An: Fläche `raised`, Rahmen `track`, Griff `ink`.

### Segmentschalter
Wenige Möglichkeiten in einem gemeinsamen Rahmen (`edge`, Radius 8 px), meist zwei; der Filter des Protokolls hat eine je Projekt und bricht um, wenn die Breite nicht reicht. Nicht gewählt: durchsichtig, `muted`. Gewählt: `raised`, `ink`.

### Eingabefeld
Fläche `rail` (also vertieft), Rahmen 1 px `edge`, Radius 8 px, Innenabstand 6 px 12 px, Platzhalter `muted`, Schreibmarke `chart`.

### Tag
Voll gerundet, 12 px, Rahmen 1 px `edge`, Schrift `muted`, durchsichtig; für „pausiert“ und „wird umgebaut“. Als Warnung (Docker oder GitHub gestört, GitHub-Limit erreicht) Schrift `fail-text`, Rahmen `fail-edge`.

### Tabellen und Zeilen
In „Verbrauch“ steht je Job eine Zeile; kommt derselbe Jobname in einem Projekt in zwei Workflows vor, steht der Workflow in `muted` hinter dem Namen.

Über den ruhigen Projekten in „Alle Projekte“ stehen im selben Raster die Repos ohne Pool, in denen Jobs auf einen eigenen Runner warten: links das Symbol „wartet“ mit dem Namen (ein Link zu den wartenden Läufen bei GitHub), in der Mitte ein Satz, der mit „Kein Pool:“ beginnt, rechts statt des Alters die Schaltfläche „Pool anlegen“. Welche Jobs warten, steht im Tooltip.

Dieselbe Zeile steht für ein Repo ohne Pool, dessen Läufe in den letzten 24 Stunden nicht gestartet sind, weil die Minuten bei GitHub aufgebraucht sind: links das Symbol „Fehler“ mit dem Namen (ein Link zu den gescheiterten Läufen bei GitHub), in der Mitte ein Satz in `text`, der mit „Kein Kontingent:“ beginnt und sagt, wie viele Läufe seit wann, rechts „Pool anlegen“. Rot ist nur das Symbol; es steht hier, weil es einen Ausweg gibt: Mit einem Pool brauchen die Jobs keine Minuten. Der Tooltip des Satzes nennt Ursache und Ausweg. Warten in dem Repo zugleich Jobs auf einen eigenen Runner, steht nur die Zeile „Kein Pool“.

Bis zur ersten Antwort des Dienstes zeigt die Seite die Wortmarke in der Leiste und im Hauptbereich die Überschrift „Alle Projekte“ mit einem Satz darunter („Verbinde mit RunClub …“); bleibt die Antwort aus, steht dort in `fail-text`, dass RunClub nicht antwortet.

Keine Rahmen, keine Zebrastreifen: nur eine Haarlinie unter jeder Zeile. (Die Projektzeile der Einstellungen ist keine Tabellenzeile, sondern eine aufklappbare Fläche.) Kopfzeile in `muted` 400, Zahlen rechtsbündig. In „Alle Projekte“ steht jedes ruhige Projekt in einer Zeile aus drei Spalten (190 px Name mit Symbol, Titel des letzten Laufs mit einer Kette kleiner Zustandssymbole davor, rechts das Alter).

### GitHub-Anfragen
Die zweite Haltestelle in „Verbrauch“: der Stand des Anfragelimits des GitHub-Kontos in dieser Stunde. Im Kopf rechts,
was noch frei ist und wann das Fenster wieder voll ist. Darunter die Kennzahl (`figure`) mit dem Verbrauchten und der
Bezugsgröße, eine Schiene über die volle Breite mit derselben Größe und der gepunkteten Marke, ab der es knapp ist (dieselbe
Schiene wie bei den Speicherspitzen) und ein Satz in `muted`. Ab der Marke fragt RunClub seltener ab. Das ist keine
Störung und vergeht von selbst: Der Satz steht dann in `text`, und „Verbrauch“ trägt in der Leiste eine zweite Zeile
in `muted`. Erst an der Reserve (2 %), wenn RunClub gar nicht mehr abfragt, wird es rot: Kennzahl, Schiene und der
erste Satz, der die Uhrzeit nennt, zu der es weitergeht; der Rest des Satzes nennt in `text` den Ausweg. Die Zeile in
der Leiste ist dann `fail-text`, und in der Übersicht steht ein Warn-Tag mit der Uhrzeit.

### Protokoll
Die letzte Haltestelle der Einstellungen. Je Meldung eine Zeile mit Haarlinie darunter, die neueste oben: Zeit und
Projekt in Meta `muted` (Spalten 92 px und 128 px), ein Zustandssymbol (16 px) und der Text in Body. Von heute steht
die Uhrzeit, von früher Tag und Uhrzeit ohne Sekunden. Ein Symbol trägt nur, was ein Ergebnis ist: Job fertig, Job
gescheitert, Job abgebrochen, Fehler. Der Beginn eines Jobs bleibt ohne Symbol, weil Gelb „läuft jetzt“ heißt. Der
Text einer Fehlerzeile bleibt in `text`; das rote Symbol trägt den Zustand, denn ein Fehler von vor Stunden verlangt
nichts mehr. Darüber links der Filter als Segmentschalter (Alle, je Projekt, Allgemein; nur bei mehr als einem
Projekt), rechts „Kopieren“ und „Speichern“, die beide die ganze Datei nehmen. Auf ein Projekt gefiltert entfällt die
Projektspalte, und die allgemeinen Fehler bleiben dabei, weil dort oft die Ursache steht; sie tragen dann „Allgemein“ in
`muted` vor dem Text. Meldungen zu einem Job bildet die Oberfläche in ihrer Sprache. Eingeklappt acht Zeilen;
aufgeklappt rollt die Liste in sich (höchstens 496 px), damit „Weniger zeigen“ erreichbar bleibt.

### Tooltip und Meldung
`raised`, Rahmen 1 px `track`, Radius 6 px, Schrift `ink` 400. Der Tooltip (12 px) folgt dem Mauszeiger über einer Kurve und über Schaltflächen, die nur ein Symbol zeigen; bei Tastaturbedienung steht er über dem Element; die Meldung steht unten mittig und verschwindet nach fünf Sekunden.

### Rückfrage
Vor allem, was löscht oder Jobs trifft (leeren, Projekt entfernen, zurückschalten, beenden), fragt die App nach, im
eigenen Feld statt im Dialog von Windows. Das Feld ist `raised` mit Rahmen 1 px `track`, Radius 8 px wie alles
Bedienbare, höchstens 440 px breit, mittig über einem Schleier in `rail` mit 72 % Deckkraft; kein Schatten, keine
Unschärfe. Die Überschrift (Title) ist die Aktion als Frage, darunter steht die Folge als ein Satz, der das Projekt
nennt. Rechts unten „Abbrechen“ und daneben die Aktion mit ihrem eigenen Wort; rot ist sie nur, wenn sie nicht
wiederkommt. „Abbrechen“ hat den Fokus, und der Fokusring ist hier immer sichtbar; Escape und ein Klick neben das Feld
brechen ab. Feld und Schleier erscheinen in 200 ms.

Schaltflächen auf `raised` nehmen die Rahmentöne als Stufen, weil es darüber keine hellere Fläche gibt: Ruhe `edge`
mit Rahmen `cap`, überfahren `cap` mit Rahmen `track`, gedrückt `raised`.

### Fenster
Im Fenster der App gibt es keine Titelleiste von Windows. Die obersten 32 px sind über die ganze Breite der Griff zum
Ziehen und bleiben leer; Leiste und Hauptbereich beginnen darunter auf einer Linie, die Wortmarke auf Höhe der
Überschrift. Minimieren, Maximieren und Schließen sind die Knöpfe von Windows in den Farben der App (Fläche `ground`,
Zeichen `text`), damit Andocken und Tastatur wie gewohnt funktionieren. Im schmalen Fenster steht die Wortmarke
(18 px) im Streifen, der dort die Farbe der Leiste trägt.

### Fokus
Jedes bedienbare Element zeigt bei Tastaturbedienung einen 2 px breiten Ring in `chart` mit 2 px Abstand.

### Bewegung
Eine Kurve für alles Räumliche: `--ease` (`cubic-bezier(.16, 1, .3, 1)`), 180 bis 220 ms. Farbwechsel 150 ms. Der Fortschrittsstrich läuft linear im Sekundentakt. Mit `prefers-reduced-motion` entfallen die Übergänge von Pills und Schaltflächen.

## Do's and Don'ts

### Do:
- **Do** Zustand immer als Farbe und Symbol zugleich zeigen, mit den sechs festen Paaren.
- **Do** Abhängigkeiten als geschwungene Strecke von rechter Mitte zu linker Mitte zeichnen, 2,5 px, runde Enden.
- **Do** Flächen über Tonstufen staffeln (`rail`, `ground`, `surface`, `raised`) und mit 1 px `edge` fassen.
- **Do** Zahlen in Tabellenziffern setzen und rechts ausrichten, wo sie untereinander stehen.
- **Do** Auslastung als Verlauf über die Zeit zeigen, mit Obergrenze, Spitze und dem Beginn des Laufs als Bezug.
- **Do** Schätzungen als solche kennzeichnen („ca.“, „üblich“, „grob geschätzt“) und in `muted` oder `text` halten, nicht hervorheben.
- **Do** Offenes gestrichelt oder gepunktet und ohne Füllung zeichnen, Erledigtes und Laufendes durchgezogen.
- **Do** `fail-text` für rote Schrift und `fail-edge` für rote Rahmen nehmen; `fail` selbst nur für gefüllte Symbole und die Warnkurve.

### Don't:
- **Don't** reines Weiß verwenden; der hellste Ton ist `ink`.
- **Don't** ein helles Thema anlegen; das System ist nur dunkel (`color-scheme: dark`).
- **Don't** Schatten, Verläufe oder Unschärfe einsetzen.
- **Don't** Strecken in einer Zustandsfarbe färben oder im Netzplan gerade beziehungsweise rechtwinklig führen.
- **Don't** ein Bediensymbol in einer Zustandsfarbe zeichnen oder ein Schriftzeichen (+, −, ×) als Symbol verwenden.
- **Don't** einen Dauerzustand rot färben, aus dem keine Einstellung herausführt; Rot braucht einen Ausweg.
- **Don't** einen Lauf als Jobliste mit Statuspunkten in Karten darstellen.
- **Don't** eine der leuchtenden Zustandsfarben (`run`, `done`, `fail`, `cancel`) als Schmuck oder für etwas anderes als ihren Zustand verwenden.
- **Don't** Schrift schwerer als 400 setzen (Ausnahme: die Wortmarke) oder Beschriftungen in Versalien sperren.
- **Don't** die Pill-Form für etwas anderes als einen Job verwenden.
