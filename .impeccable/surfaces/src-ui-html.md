---
version: 1
slug: "src-ui-html"
primary_target: "src/ui.html"
related_targets: []
---

# Oberfläche der App (src/ui.html)

Modus: Operate. Publikum und Aufgabe: siehe PRODUCT.md (kurzer Blick nebenbei, genaues Verfolgen eines Laufs).

Umfang: ganze App in einem Fenster – Projektleiste, Projektansicht, „Alle Projekte“, „Verbrauch“, „Einstellungen“.
Vom Nutzer festgelegt: Midnight Transit mit Pills; eine Linienfarbe; Zustand als Farbe plus Symbol; geschwungene Linien;
leichte Schrift, kein reines Weiß; Verlauf der Auslastung als Kurven; Kompakt- und Detailmodus als Option, im Kompaktmodus
klappt eine Pill beim Überfahren auf und die anderen machen Platz; Deutsch und Englisch umschaltbar; nur dunkel.
Offen: ob die Verspätung als „+0:33“ hinter der Zeit steht (derzeit: Zeit färbt sich, Differenz im Detail).

## Direction contract

THESIS: Ein Lauf ist ein Liniennetz. Jobs sind Stationen, Abhängigkeiten sind die Strecken dazwischen; man liest, was auf
was wartet, ohne eine Zeile Text. Verweigert wird die Jobliste mit Statuspunkten in einem Karten-Dashboard.

OWN-WORLD: Mitternachtsblaues Emailleschild. Grund #0c1838, Leiste dunkler, Flächen eine Stufe heller, Strecken in gedämpftem
Stahlblau, Text in Porzellan-Blaugrau, nie Weiß. Sechs Zustandsfarben gleicher Helligkeit, jede mit eigenem gezeichnetem
Symbol. Overpass in leichten Schnitten. Stationen sind Pills, Strecken laufen an ihren Enden ein und aus.

STORY: Der Nutzer sieht links, welches Projekt läuft oder rot ist; rechts, wie weit der Lauf ist und wie lange noch; darunter,
ob der Rechner die Last trägt – nicht als Momentwert, sondern als Verlauf.

FIRST VIEWPORT: Links die Projektleiste (232 px). Rechts oben Titel des Laufs, darunter Repo, Workflow und Branch, ganz rechts
die Restzeit groß und leicht. Mitte: der Netzplan über die volle Breite, Stufen von links nach rechts. Darunter die Legende
und ein Band mit drei Verlaufskurven (Docker-VM-Speicher, Docker-VM-CPU, Windows-Speicher) und den Plätzen.

FORM: Liniennetzplan (Midnight Transit), vom Nutzer nach zwei Würfelrunden gewählt und verfeinert; seed key ead5eeac.
Signaturbewegung: Im Kompaktmodus öffnet sich die überfahrene Pill, die Strecken folgen ihr.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
