---
version: 1
slug: "src-ui-html"
primary_target: "src/ui.html"
related_targets: []
---

# App interface (src/ui.html)

Mode: Operate. Audience and task: see PRODUCT.md (a quick glance on the side, closely following a run).

Scope: the whole app in one window – project rail, project view, “All projects”, “Usage”, “Settings”.
Set by the user: Midnight Transit with pills; one line color; state as color plus symbol; curved lines;
light type, no pure white; load history as curves; compact and detail mode as an option, in compact mode
a pill extends downward on hover over what lies below, without moving anything; German and English switchable; dark only.
Open: whether the delay stands as “+0:33” after the time (currently: the time changes color, the difference is in the detail).

## Direction contract

THESIS: A run is a transit network. Jobs are stations, dependencies are the lines between them; you read what waits for
what without a line of text. Refused: the job list with status dots in a card dashboard.

OWN-WORLD: Midnight-blue enamel sign. Ground #0c1838, bar darker, surfaces one step lighter, lines in muted
steel blue, text in porcelain blue-grey, never white. Six matched state colors, each with its own drawn
symbol; brightness follows urgency (running brightest, waiting darkest). Overpass in light weights. Stations are pills, lines enter and leave at their ends.

STORY: The user sees on the left which project is running or red; on the right, how far the run is and how much longer;
below, whether the machine carries the load – not as a momentary value but as a history.

FIRST VIEWPORT: On the left the project rail (232 px). On the right at the very top, sticky while scrolling, the band with three history curves
(Docker VM memory, Docker VM CPU, Windows memory) and the slots rolling within it. Below, for each running run, the title,
below it repo, workflow and branch, far right the remaining time large and light, then the network map across the full width, stages
from left to right; after the last network map the legend, then the quiet projects as rows.

FORM: Transit network map (Midnight Transit), chosen and refined by the user after two dice rounds; seed key ead5eeac.
Signature motion: the hovered pill extends downward over what lies below without moving anything; its lines stand out.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
