---
name: RunClub
description: Self-hosted GitHub Actions runners as a transit map on a midnight-blue ground.
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
  info:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    size: "18px"
  info-hover:
    textColor: "{colors.ink}"
  info-panel:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.meta}"
    rounded: "{rounded.float}"
    padding: "10px 14px 11px"
    width: "44ch"
---

# Design System: RunClub

Derived from the built state of `src/ui.html`. The values in the header of this file are authoritative; the text explains where and why they apply. The tokens are named as in the CSS (`--ground` → `ground`). `rail-hover` and `fail-edge` are fixed values in the CSS, not variables.

Interface text quoted below is the English text from `TEXT.en` in `src/ui.html`; the German version lives in `TEXT.de`.

## Overview

**Creative North Star: "Midnight Transit"**

A run is a transit map on a midnight-blue enamel sign. Jobs are stations shaped as pills, the dependencies between them are curved tracks. Anyone who looks reads, without a word of text, what waits on what and where it is stuck. The interface works in Operate mode: it is glanced at for two seconds in passing or read closely while following a run, and the same view has to carry both.

The system is calm and flat. There is exactly one dark theme, no shadows, no gradients and no pure white. Depth comes from four closely stepped blues, structure from fine hairlines. The typeface is Overpass in light weights; all numbers use tabular figures because they keep counting every second. Saturation is reserved for state: six state colors, each with its own drawn icon, are the only things on the surface that glow.

Density follows the task. In compact mode a pill shows icon, name and time; on hover it extends downwards and lays its details over whatever lies below – nothing shifts. In detail mode every pill carries a shortened second line. Above everything sits the machine's load as a history over time, not as a momentary value; it stays put while scrolling.

**Key Characteristics:**
- Network map instead of job list: stages from left to right, tracks between the pills.
- Dark only, midnight blue; the lightest tone is porcelain blue-grey, never white.
- State always twice: color and drawn icon.
- Light type (200 to 400), tabular figures everywhere.
- Flat: tonal steps and hairlines instead of shadows.
- Load history as a line with a faint area below it.

## Colors

A monochrome world in blue around hue 268°, in which only the six states carry color.

### Primary
- **Track Blue** (`track`): The tracks of the network map (2.5 px, round caps), the border of a hovered pill or button, the border of tooltip and toast. The muted steel blue is the line color of the system.
- **Open Track** (`track-open`): The same track when its target is still waiting or skipped; then dotted (`2 7`). Same value as `wait`.
- **Chart Blue** (`chart`): Line and area (16 % opacity) of the history charts, plus focus ring, text caret and the check mark of checkboxes.

### Secondary
The six state colors. Their lightness follows urgency: what runs is lightest, what waits is darkest.
- **Signal Yellow** (`run`): Job running. Fills the icon, colors the 2 px progress stroke at the bottom edge of the pill and the time of a job that takes longer than usual.
- **Signal Green** (`done`): Job done; also the word "done" for the last run.
- **Signal Red** (`fail`): Failure. Fills the icon and colors a history chart when memory runs low.
- **Fail Text** (`fail-text`): Red for type, lightened so it stays legible on the blue surfaces: failure count, failed step, warning sentences, dangerous buttons.
- **Fail Edge** (`fail-edge`): Darkened red for borders: failed pill, warning tag, dangerous button.
- **Violet** (`cancel`): Cancelled.
- **Slate** (`skip`): Skipped. Ring and dash only, no fill.
- **Wait Grey** (`wait`): Waiting. Ring and dot only, no fill; also the vertical "run started" mark in the charts.

### Neutral
- **Midnight Ground** (`ground`): Background of the main area; also the color of the drawing on filled state circles.
- **Rail** (`rail`): One step darker; project rail and input fields.
- **Rail Hover** (`rail-hover`): Hovered entry of the project rail.
- **Surface** (`surface`): One step lighter; pills, buttons, selected entry of the rail.
- **Raised** (`raised`): Hovered pill or button, selected segment, tooltip and toast.
- **Edge** (`edge`): Border of pills, buttons, fields, tags; pressed button; scrollbars.
- **Hairline** (`rule`): Dividers between sections and table rows, center line of the charts.
- **Cap** (`cap`): The line that marks the maximum in a chart.
- **Porcelain** (`ink`): Lightest tone. Headings, names, large figures, highlighted track.
- **Text** (`text`): Running text and times.
- **Muted** (`muted`): Sublines, labels, axes, hints.

### Named Rules
**The No-White Rule.** The lightest tone is `ink`. Pure white appears nowhere, not even in icons: on filled state circles the drawing is cut out in `ground`.

**The Color-Plus-Icon Rule.** A state never appears as color alone. Each of the six colors has its drawn icon (triangle, check, cross, square, dash, dot); anyone who cannot tell the colors apart reads the icon.

**The Tracks-Stay-Blue Rule.** Tracks never carry a state color. They are `track`, dotted `track-open` while the target's turn has not come, and `ink` when the pill at their end is hovered. The state sits at the station, not on the line.

**The Red-Means-Trouble Rule.** Red means something needs the user to step in: a failure in the run, full memory, a missing GitHub sign-in, an action that deletes something. Nothing else.

## Typography

**Display Font:** Overpass (with "Segoe UI", system-ui, sans-serif), shipped locally as a variable font (`src/fonts/overpass-latin.woff2`, weights 100–900)
**Body Font:** Overpass (the same family)
**Label/Mono Font:** Consolas, monospace, for code only (the expression for `runs-on`, the names of GitHub variables, the one-time code of the sign-in)

**Character:** A single family whose origin in traffic signage fits the imagery. Hierarchy comes from size and color, hardly from weight: running text in 300, names and headings in 400, the large remaining time in 200.

### Hierarchy
- **Display** (200, 56 px, line height 1): The remaining time of the run at the top right. Below 760 px width 40 px.
- **Display small** (300, 34 px, line height 1): In the same place when a word stands there instead of a time ("done", "failed", "waiting for a runner").
- **Headline** (400, 26 px, line height 1.2): Title of the run or view, one per view or run; balanced wrapping.
- **Title** (400, 18 px): Sections in "Usage" and "Settings".
- **Figure** (`figure`; 300, 26 px, line height 1.25): The current value above a history chart, followed by the reference value in 13 px `muted`.
- **Body** (300, 14 px, line height 1.45): Running text, table cells, times in the pills.
- **Body strong** (400, 14 px): Names of jobs and projects, in `ink`.
- **Meta** (400, 13 px): Sublines, hints, legend, tables, buttons, the info panel.
- **Label** (400, 12 px): Label above figures, second line in rail and pill, tags, tooltip.
- **Axis** (400, 11 px): Time axis below the charts.
- **Wordmark** (600, 22 px): "RunClub" at the top of the rail; the only place with a heavy weight.
- **Mono** (Consolas, 12 px): Code, wherever it appears; in a highlighted sentence in `ink` so it does not fall behind the sentence. The log is set in Overpass.

### Named Rules
**The Light-Weights Rule.** Running text is 300, emphasis 400, nothing above that except the wordmark. The larger the type, the lighter the weight.

**The Tabular-Figures Rule.** `font-variant-numeric: tabular-nums` applies to the whole page. Times keep counting every second; without fixed figure widths pills and columns would jitter.

**The No-Caps Rule.** Labels use normal case without letter spacing. All caps and tracking do not occur.

## Layout

Two columns over the full window height: on the left the project rail (232 px), on the right the main area, which alone scrolls. The main area has 26 px padding at the top, 44 px at the sides and 40 px at the bottom. Its content is a vertical stack with 22 px gaps; within a run it is 14 px, between several runs and between the columns of the load band 34 px.

The header of a run sets title and origin on the left against the baseline of the large remaining time on the right. The network map fills the width: each stage is a column (at least 180 px, at most 280 px), the columns sit side by side with `clamp(40px, 6vw, 96px)` spacing and are vertically centered, the pills of a column have 12 px spacing. If a run has no dependencies, the jobs stand in start order, six per column. In compact mode the map reserves 44 px of height so that expanding a pill shifts nothing below it. If the width is not enough, the map scrolls horizontally.

At the very top of the main area sits the load band, which stays put while scrolling (`position: sticky`), set off below by a hairline: three equally wide history charts and on the right the somewhat wider column with the slots (ratio 1 : 1 : 1 : 1.7, so the project names stay legible in two columns). The slots are as tall as the chart column next to them; their rows scroll within, the legend stays below. Below that the runs stand one under another, each with header and network map, after the last one the legend, then the quiet projects as rows. "Usage", like the settings, is a line of stops (at most 860 px wide): the first stop shows the same three charts over 24 hours, the second the GitHub requests, the third the GitHub minutes (without a sign-in it is missing), after that each project has its own stop with the highest measured peak of a job (two bars as on the slider, runner and Docker, measured against the allowed limit; red from 85 %, then with a link to the limits) and a table of its jobs across the full width of the stop (number columns 96 px, 84 px in a narrow window; if the width is not enough, it scrolls horizontally). The table lists usage first, runner and Docker separately; the value that sets the bar is in `ink`. A dotted mark on each bar shows the 85 %. "Settings" is limited to 860 px and structured as a line: on the left runs a vertical line at which each of the five sections (GitHub, Projects, Limits per job, App, Log) begins with a stop; the content sits 44 px to the right of the line, between the sections lie 44 px without any further divider.

Breakpoints:
- **up to 1100 px:** The band becomes two columns, the side padding of the main area drops to 24 px.
- **up to 900 px:** The rows of quiet projects in "All projects" become two lines.
- **up to 760 px:** The rail becomes a horizontally scrolling row at the top, the band two columns with lower charts (44 px) and the slots across the full width, title and remaining time stack. The band does not stick there. The network map scrolls the column with the first red or running job into the middle.

## Elevation & Depth

The system is flat. There is no shadow, no gradient and no blur. Depth comes from tonal steps: `rail` lies below `ground`, `surface` above it, `raised` one step higher still. What floats (tooltip, info panel, toast) is `raised` with a border in `track`, not lifted by a shadow. Surfaces whose turn has not come are not surfaces at all: waiting and skipped pills are transparent with a dashed border.

### Named Rules
**The Tonal-Step Rule.** A surface stands out through the next lighter step and a 1 px border, never through a shadow. The order is fixed: `rail`, `ground`, `surface`, `raised`.

**The Response-Is-One-Step Rule.** Hover lifts a surface exactly one step (`surface` → `raised`) and turns its border from `edge` to `track`. Nothing moves from its place.

## Shapes

Three shapes, each with a fixed meaning. The **pill** (radius 21 px, half the height of the closed station) is reserved for the job; on hover it grows downwards as one shape with an unchanged radius. The **circle** is the state icon (22 px, 18 px in the legend, 16 px in rail and lists; border 2 px). Everything operable outside the network map (button, segment, field, rail entry) has **softly rounded corners** (8 px); tooltip and toast 6 px, tags are fully rounded.

Tracks are cubic Bézier curves: they leave the right middle of the predecessor horizontally and run horizontally into the left middle of the successor (handles 55 % of the distance, at least 30 px), 2.5 px thick with round caps. Straight or right-angled tracks do not exist in the network map. The only straight track is the vertical line of the settings (see "Stop"): there it is a guide through the page, not a dependency.

Borders are 1 px. Solid means: its turn is now or was. Dashed (pill) and dotted (track) means: still open. Dividers are 1 px in `rule` and always horizontal; the line of the settings is not a divider but a track (2.5 px, `track`).

## Components

### Pill (Station)
The signature component; a job in the network map, as a whole a link to the job on GitHub.
- **Structure:** Three-column grid: state icon (22 px), name (`ink`, 400, truncated with an ellipsis), time on the right. The height is fixed. The details (step, slot, usual duration; 12 px `muted`) lie in a second surface in the shape of the pill, exactly behind its content; it shifts nothing.
- **Shape and color:** Surface `surface`, border 1 px `edge`, radius 21 px, padding 8 px 16 px 8 px 9 px.
- **Hover / focus:** Surface `raised`, border `track` (180 ms). This surface (`raised`, border `track`, radius 21 px, no shadow) grows downwards after an 80 ms delay over 280 ms (`grid-template-rows` 0fr → 1fr); corners and border do not change. At the same time the tracks of this pill stand out in `ink` and all others drop to 30 % opacity.
- **Running:** At the bottom edge a 2 px stroke in `run` grows up to the usual duration. If the job takes noticeably longer (over 115 % and more than 10 s), the time turns `run`.
- **Failed:** Border `fail-edge`; a second, shortened line names in both modes, in `fail-text`, the step at which it failed.
- **Waiting / skipped:** Transparent, dashed border, name `muted`; the time is an estimate ("about 2:19").
- **Detail mode:** Every pill carries a second detail line, truncated to one line; the overlay then starts below the first line.
- **Re-run:** A finished job of a finished run carries, on the right in its expanded details, the button "Re-run job" (icon only, 30 px, radius 8 px; on `raised` with the border tones as steps, as in the confirmation). It is not part of the link but sits next to the pill in the same frame and appears with the details, on hover and on keyboard focus; in the tab order it comes right after its pill. While the pointer is on it, the pill stays expanded. The closed pill does not change.

### State icon
A circle with a drawing on a 16 grid, stroke 2.2 with round caps. Running: filled triangle on `run`. Done: check on `done`. Failed: cross on `fail`. Cancelled: filled square on `cancel`. Skipped: dash in the empty ring `skip`. Waiting: dot in the empty ring `wait`. An empty ring without a drawing stands in the rail for a project in which nothing is running. The legend below the network map shows all six with their word.

### Track
See Shapes. A track to a waiting or skipped job is dotted in `track-open`. Color and opacity change over 150 ms.

### History chart
- **Structure:** Label (12 px `muted`), below it the figure with reference value, the chart (74 px tall, full column width), an axis with two or three words ("30 min ago", "run started", "now") and a line with the peak.
- **Drawing:** Line 2 px in `chart` with round joins, below it the same color as an area at 16 % opacity. Guide lines 1 px: cap (`cap`), middle (`rule`), peak (dotted, `chart`), start of a run (vertical, dashed, `wait`).
- **Warning:** When memory runs low, line, area, figure and peak line switch to red, and before the peak it says how little is still free ("only 0.9 GB free"). This applies to Windows and to the Docker VM (there below 15 % free, measured inside the VM itself).
- **Mouse pointer:** Crosshair; a vertical line in `ink` and a tooltip with time and value.

### Slots
A quick overview in the band: per project, how many runners it has and what they are doing right now. Run times, job names and usage are not shown here.
- **Structure:** Label "Slots", below it the projects in two columns (gap 18 px). One row of 22 px per project: on the left the short name (13 px, 400, `text`, truncated with an ellipsis), on the right without wrapping one state icon per slot (14 px, border 1.5 px, 4 px gap), then after 8 px the reserve. The reserve is as wide in all rows as the widest one, so the slot icons end at one edge.
- **One project:** In the view of a single project there is one row per slot: icon (16 px), "Slot 2" and the state in words (`muted`), below that the reserve with its dots and "1 of 2 ready". No legend is needed there.
- **States:** the same icons as in the network map. Working: running (`run`). Ready: empty ring. Starting, waiting, waiting for Docker, cleaning up: dot in the ring (`wait`, larger here than in the network map so it stands out from the empty ring); the legend calls this "starting", the tooltip gives the exact state. Faulty: cross on `fail`, the only red. Off and a slot paused on its own: dash in the ring (`skip`). A paused project shows "paused" in `muted` instead of the icons, a blocked one (repo public, workflows from forks allowed or not checkable) the cross on `fail` and "blocked". In the rail and the quiet projects a blocked project likewise shows the cross and "blocked", one without a fresh check with GitHub a dot in the ring (`wait`) and "being checked".
- **Reserve:** one dot (7 px, border 1.5 px `track`) per runner, filled when it is ready, half filled while it is still being prepared (an empty ring would mean "ready" in the slots).
- **Tooltip:** per icon the slot, state and, when working, the job ("Slot 2 · working · build"), per reserve dot the project's total ("Reserve: 1 of 3 ready"); on the name the full repo.
- **Legend:** fixed at the bottom of the box, outside the scrolling part (11 px `muted`): working, ready, starting, Reserve; faulty and off only when they currently exist. If reserve is missing anywhere, the full and the half dot stand before "Reserve", and the tooltip explains them. In a narrow window the rows scroll from 132 px.

### Navigation (project rail)
- **Entry:** Two lines: name (`ink`, 400) and state in words (12 px `muted`), on the left the state icon (16 px). Radius 8 px, padding 8 px 12 px 8 px 36 px, 4 px gap between entries.
- **States:** at rest transparent, hovered `rail-hover`, selected `surface`.
- **Footer:** "Usage" and "Settings" on one line each without an icon at the bottom edge. "Usage" carries a second line when the GitHub requests or the GitHub minutes are running low (`muted`) or used up (`fail-text`). It stays one line even if both apply: used up comes before running low, otherwise the requests before the minutes. If there is something to do in the settings (a job reached its limit or came close to it), "Settings" carries a second line in `fail-text` that says what and for which project; in a narrow window a dot after the word stands for it. If the GitHub sign-in is missing ("Not signed in to GitHub"), that is shown there instead; it takes precedence over the limits. If there is no project yet and nobody is signed in, that is the beginning and not a fault: the line is then in `muted`.
- **Narrow:** A horizontally scrolling row of icon and name; the selected entry scrolls into view.

### Buttons
Restrained and small; they belong to setup, not to state.
- **Shape:** Radius 8 px, border 1 px `edge`, surface `surface`, 13 px, padding 5 px 12 px.
- **Hover / pressed / disabled:** `raised` with border `track` (150 ms); pressed `edge`; disabled 50 % opacity.
- **Dangerous:** Type `fail-text`, border `fail-edge`; sits at the right end of the row, apart from the harmless actions.
- **Icon only:** 30 px wide and tall, for actions repeated in a list (one more, one fewer, clear a cache). The action is attached as the app's tooltip, on hover and on keyboard focus.
- **Icon with word:** for rare and dangerous actions; 8 px between icon and word.
- **On the run:** Below the header of a finished run, left-aligned with the title, stands "Re-run" (icon with word; the whole run), after a failure next to it "Failed only" (word only, because it narrows the same action). They sit below the header and not in it, so title and remaining time stay on one baseline. Re-running deletes nothing and therefore does not ask; a toast confirms it, because the run only reappears on GitHub after a moment. A running run carries no buttons.
- **Disabled with a reason:** If an action cannot apply right now (at most 4 slots), the button stays hoverable and gives the reason in the tooltip.
- What deletes sits apart at the right end of the row; only what does not come back (Remove project, Quit RunClub) is red.
- There is no filled primary button.

### Control icons
Drawn on the same 16 grid as the state icons, but as a line without a circle: stroke 1.7 with round caps, in the button's text color. They never carry a state color. One icon stands for exactly one action: plus means add, the trash can clear, the fork "where the jobs go". The clockwise arc means "Rebuild runners"; the arc back to the start with the triangle inside means "re-run", for the run as well as for a single job. The arrow up to the line means "install update" (the mirror image of "Save"). The "i" in a circle means "more about this" and appears only on the info element.

### Info element
Explanations do not stand as a wall of text on the surface but behind a small "i". **The Short-On-The-Surface Rule:** what stays visible is what something is, its state and what to do, in one terse line. Reasons, consequences, background and what nobody reads the third time go into the info. What disappears from the surface is there; nothing is lost. Confirmations and error messages stay fully visible; a red warning sentence keeps fault and way out on the surface, only the explanation moves into the info.
- **Icon:** a button (18 px, larger hit area) with the drawn "i" in a circle (16 grid, stroke 1.7), in `muted`, `ink` on hover and focus. It sits directly after a title: the heading of a stop or view, the title of a row, a label above a figure. A row without a title carries it at the end of its sentence. At most one per title.
- **Info panel:** like the tooltip `raised` with border 1 px `track` and radius 6 px, but multi-line: at most 44ch wide, padding 10 px 14 px, 13 px in `text` with line height 1.45; code inside in `ink`. Several paragraphs have 7 px spacing, the state-dependent one first, the general one after. It is anchored to the icon (not to the mouse pointer), sits below it and above only when there is no room below, and stays within the window horizontally.
- **Behavior:** Hover and keyboard focus open it; the pointer can move from the icon onto the panel to read or select (leaving only closes after 180 ms, so the gap between them does not close it). Leaving, focus change and Escape close it. A click pins it, a second click or a click elsewhere closes it. The button sits next to the heading, not inside it, so the heading keeps its name. Screen readers hear the reference as the button's name ("More about “…”") and the explanation, hidden inside the button, as its description.
- **Where:** Settings: "Signed in as …", "Not signed in to GitHub", the stops Projects, Limits per job and Log, "Display", the route of jobs without `CI_RUNNER`, "limit generous", the suggestions, the sentence below the memory bar, the version, the update channel and the ready update. Set up Docker: the heading and each row. Usage: the stops "The last 24 hours", "GitHub requests" and "GitHub minutes", the label of the memory peaks. Without projects: the heading of the first step.

### Stop
The structure of the settings. An info element may follow the heading. A vertical track (2.5 px, `track`) connects the sections; at each one sits a ring (17 px, border 2.5 px `track`, surface `ground`) next to the heading. The ring is a button and scrolls to its section. The stop where the page currently is, is filled in `ink`. The track ends at the last stop.

### GitHub (sign-in)
The first stop of the settings, because the sign-in is the precondition for everything after it and the line thus reads
in the order of setting up. RunClub signs in through its own GitHub App "RunClub" with a one-time code (device flow),
independent of `gh` in the terminal, and acts only in the repos the app is installed on. The content is rows as in the
App section: title in `ink`, a sentence in `muted` below, the button on the right, hairline below. The sentences of the
rows are at most as wide as running text (56ch).
- **Signed in:** "Signed in as …" with info element, below it briefly what RunClub uses the sign-in for ("RunClub uses
  it to manage runners and runs in the repos the app is installed on.") and the link "Revoke on GitHub"; it stands in
  the sentence and not in the info, so it is visible and reachable by keyboard. In the info: what the app does in your
  name and only in the installed repos, that it can read code but not change it, how far the permission for the
  runners (Administration) reaches, and that signing out only applies to this computer. On the right "Sign out".
  Signing out asks first, because it affects jobs; the confirmation says that the authorization on GitHub stays until
  it is revoked there. It is not red, because you can sign in again.
- **Fault with a way out:** Not signed in is red: the title "Not signed in to GitHub" in `fail-text` with info element,
  the short sentence below in `text` (what does not work without it), on the right "Sign in to GitHub". In the info:
  that GitHub asks in the browser whether the app may act for the account, and what it may do there. In addition
  "Settings" in the rail carries the second line in `fail-text`, and the overview shows a warning tag. A failed flow
  appears as a sentence in `fail-text` in the row of the account, above its title and sentence ("Signing in failed:
  …"): the confirmation did not arrive in time, or GitHub gave no reason. The interface states the reason in its own
  language; only what GitHub itself reported is quoted verbatim ("GitHub says: “…”"). If the user declined in the
  browser, that is not a fault: the sentence stands in `muted` ("You did not authorize RunClub in the browser. …").
  While the sign-in is still being read, there is only a sentence in `muted` ("Checking the GitHub sign-in …").
- **During a flow** it replaces the rows: the label "One-time code" (Label, `muted`), below it the code as a figure
  (`figure`, `ink`, in mono, so 0 and O, 1 and I can be told apart; a click selects all of it), a sentence in `text` on
  what to do, and a row of buttons in the order of use: "Copy code" (icon with word), "Open GitHub" (a link that opens
  in the browser) and, set apart at the right end, "Cancel". Nothing is red here. Until the code arrives, there is only
  a row without a title, the sentence in `muted` ("Getting a one-time code from GitHub …") and "Cancel".
- **Without projects**, if the sign-in is missing, the step "First, sign in to GitHub" stands instead of "No project
  yet": heading with info element (the same info as on "Not signed in to GitHub"), a sentence, the button "Sign in to
  GitHub", a failed flow above it; during the flow the same one-time code. That nobody is signed in yet is the
  beginning and not a fault; the line in the rail is then `muted` too, and only a failed flow is red.
  If the machine lacks something for Docker, the section "Set up Docker" follows below.
  The rows of the first step carry no hairline. "All projects" carries no second line in the rail as long as there is
  no project.
- **Installing the app:** The sign-in alone grants no repo; which accounts and repos RunClub may provide runners for is
  chosen on GitHub when installing the app. Signed in, but installed nowhere yet: the step "No project yet" says so
  ("Choose on GitHub which accounts and repos RunClub may provide runners for."), with the button "Install RunClub on
  GitHub" (a link that opens in the browser) and the hint on `runs-on` below. Once repos are granted, the step offers
  them as buttons, below them "Repo missing?" with the link "Install RunClub for another account or an org"; the same
  sentence closes "Add a project" in the settings. If GitHub no longer finds the repo of a project, the expanded row
  says so in `fail-text` with "Grant access on GitHub", and its header carries the tag "not found" in `fail-text`. When
  the window comes back from the browser, RunClub reads the repos again.


### Set up Docker
What the machine lacks for Docker, as long as Docker does not respond: WSL, Docker Desktop (not installed, not
started) or its engine (Docker Desktop is running but still does not respond after three minutes). One row per piece,
as with the sign-in: title with info element, below it a sentence on what to do, the way out on the right. WSL: the
command `wsl --install` in mono in the sentence and "Copy command" (icon with word). Not installed:
"Open install guide", a link to Docker's guide that opens in the browser. Not started: "Start Docker Desktop". Engine:
"Open Docker Desktop" (brings its window to the front). In the info: what it is needed for, how it starts by itself,
what helps.
- **Without projects** the section stands below the view's step ("First, sign in to GitHub" or "No project yet"),
  because a view has one heading and the step is not held up by this: "Set up Docker" as a Title (`h2`) with info
  element, a sentence in `muted`, the rows without hairline as in the first step of the sign-in.
  That is the beginning and not a fault: titles in `ink`, sentences in `muted`.
- **In the overview** the rows stand below the warning tags and replace the Docker tag: title in `fail-text`, sentence
  in `text`, because the runners are waiting and there is a way out. At most 860 px wide like the rows of the settings,
  so fault and way out are read together.
Once everything is there, the section disappears by itself; RunClub checks every 15 seconds.

### Project row
A project in the settings: surface `surface`, border 1 px `edge`, radius 8 px. The header holds the arrow, the name, the total of the caches in `muted` and on the right the number of slots with one fewer and one more. A click on the header expands the row downwards (the same motion as the pill: `grid-template-rows` 0fr → 1fr over 280 ms, the arrow rotates); only one is ever open. Expanded, set off by a hairline: where the jobs go, the limits of the project (segmented control "Shared" or "Own"; with own values the same four sliders as in the Limits section), the caches as rows with size and an icon to clear them, below that the buttons. A project with own limits carries the tag "own limits" in its header. If the limits do not fit the measured need, that also appears as a tag in the header and as a sentence at the limits: "limit reached" and "limit tight" (over 85 %) as a warning in red, "limit generous" (more than twice the need) muted; why generous protects less is in the info on the sentence. The suggestion from the measurements stands as one sentence in `text`, what it is derived from in the info after it. If the workflows do not read `CI_RUNNER`, a red sentence says so with the expression for `runs-on`; what the expression does is in the info. Hover lifts a closed row one step.

The last row of the list is "Add a project": transparent with a dashed border in `cap`, because nothing is here yet.

### Memory bar
What all slots together may use in memory, measured against the Docker VM. Above the bar the figure (`figure`) with the reference value. The bar itself: one field per slot (26 px tall, radius 6 px), grouped by project and labeled below; the width of a field follows its project's limit. A project with the cache turned on carries a further field at the end of its group for its build service (surface `cap`, as wide as its Docker limit); the label names it separately ("2 × 8 GB + build 4 GB"). The build service also runs while the pool is paused: a paused project then shows only this field. The build services count first, the slots fit into the rest. Fields that fit into the VM at full limit are filled (`raised`, border `cap`); the others are transparent with a dashed border. A vertical mark in `track` shows the limit of the VM. The figure only turns red when a single job (with its project's build service) may already use more than the VM has; that not all slots fit at once is the normal case and stands as a short sentence in `muted` below ("…; that is common"). The info on the sentence says why it is common, what gives more safety, and how to read the bar.

### Slider
Bar 4 px, fully rounded, left of the thumb `chart`, right of it `edge`; thumb 16 px, round, `ink`. On the left the label, on the right the value in `ink`. A suggestion appears as a dotted vertical mark in `ink` across the bar. While dragging, the memory bar recalculates along; saving happens on release.

### Switch
For on and off of a single setting: 38 × 22 px, fully rounded. Off: surface `rail`, border `edge`, thumb `muted`. On: surface `raised`, border `track`, thumb `ink`.

### Segmented control
A few options in a shared frame (`edge`, radius 8 px), usually two; the log filter has one per project and wraps when the width is not enough. Not selected: transparent, `muted`. Selected: `raised`, `ink`.

### Input field
Surface `rail` (so recessed), border 1 px `edge`, radius 8 px, padding 6 px 12 px, placeholder `muted`, caret `chart`.

### Tag
Fully rounded, 12 px, border 1 px `edge`, type `muted`, transparent; for "paused" and "rebuilding". As a warning (Docker or GitHub faulty; if the machine lacks something for Docker, the rows from "Set up Docker" stand instead of the tag; not signed in to GitHub, GitHub limit reached, a project blocked; then also "blocked" in the header of the project card) type `fail-text`, border `fail-edge`.

### Tables and rows
In "Usage" there is one row per job; if the same job name occurs in two workflows of one project, the workflow follows the name in `muted`.

Above the quiet projects in "All projects", in the same grid, stand the repos without a pool in which jobs wait for a self-hosted runner: on the left the "waiting" icon with the name (a link to the waiting runs on GitHub), in the middle a sentence beginning with "No pool:", on the right, instead of the age, the button "Create pool". Which jobs are waiting is in the tooltip.

The same row stands for a repo without a pool whose runs in the last 24 hours did not start because the minutes on GitHub are used up: on the left the "failed" icon with the name (a link to the failed runs on GitHub), in the middle a sentence in `text` beginning with "No GitHub minutes:" and saying how many runs since when, on the right "Create pool". Only the icon is red; it stands here because there is a way out: with a pool the jobs need no minutes. The tooltip of the sentence names cause and way out. If jobs in the repo are also waiting for a self-hosted runner, only the "No pool" row appears.

Until the service's first answer, the page shows the wordmark in the rail and in the main area the heading "All projects" with a sentence below it ("Connecting to RunClub …"); if the answer does not come, it says there in `fail-text` that RunClub is not responding.

No borders, no zebra stripes: only a hairline below each row. (The project row of the settings is not a table row but an expandable surface.) Header row in `muted` 400, numbers right-aligned. In "All projects" each quiet project stands in a row of three columns (190 px name with icon, title of the last run preceded by a chain of small state icons, the age on the right).

### GitHub requests
The second stop in "Usage": the state of the GitHub account's rate limit in this hour. In the header on the right, what
is still free and when the window is full again. Below it the figure (`figure`) with what has been used and the
reference value, a bar across the full width with the same quantity and the dotted mark from which it is tight (the same
bar as for the memory peaks). If everything is fine, nothing stands below: whom the limit applies to and what the mark
means is said by the info on the heading. Past the mark RunClub polls less often. That is not a fault and passes by
itself: a short sentence in `text` says until when, and "Usage" in the rail carries a second line in `muted`; what
follows from it is in the info. Only at the reserve (2 %), when RunClub stops polling altogether, does it turn red:
figure, bar and the first sentence, which names the time at which it continues; the rest of the sentence names the way
out in `text`, the info what keeps running in the meantime. The line in the rail is then `fail-text`, and the overview
shows a warning tag with the time.

### GitHub minutes
The third stop in "Usage", built like the GitHub requests: what the account has used this month on GitHub's own
runners. That is its name everywhere in the interface, also in the rows of the overview ("No GitHub minutes"); in the
code and the rest of the docs it is the minutes quota. In the header on the right, what is still free and on which day
it is full again. Below it the figure (`figure`) with what has been used and the included minutes, the same bar with
the dotted mark at 85 % and a sentence in `muted`: what the number consists of (Linux, Windows, macOS, where present),
what of it is billed, and the plan with its included minutes ("Free plan with 2,000 minutes a month."). The info on the
heading names what the plans include (built from the table in the state, `plans`; it lives only in `src/minutes.js`,
`INCLUDED`), that every minute counts the same, whatever the operating system, and what applies to a different plan;
depending on the state, what follows from it comes first. If RunClub knows no number for the plan, the figure stands
alone, without limit and bar, and the sentence says so. The states and their rules live in `src/minutes.js`; the
interface only reads them.
- **Running low** (from the mark) is not a fault: a short sentence in `text` above the sentence in `muted` (what
  happens without minutes is in the info), and the second line in the rail in `muted`.
- **Used up** (the included amount is reached, nothing was billed: without a budget GitHub starts no more runs in
  private repos) is red, because there is a way out: figure, bar and the first sentence, which names the day on which
  it continues; the rest names the way out in `text` (move projects to your own runners or set a budget on GitHub),
  below it the button "Go to projects". Whether a budget is set, RunClub cannot see; the sentence therefore says
  "without a budget". That it affects private repos on GitHub's runners and why a pool helps is in the info. The line
  in the rail is then `fail-text`. There is no warning tag in the overview for this; the affected repos appear there as
  "No GitHub minutes" rows.
- **Billed** (the included amount is reached and minutes are being billed) is neither low nor red: whoever pays has set
  a budget. The header then names, instead of what is free, how many minutes are billed and what they cost so far. A
  short sentence in `text` says what follows from it: GitHub bills up to the budget and starts nothing after that; that
  RunClub cannot see this limit is in the info. The rail reports nothing. If something is already billed below the
  included amount (for example a larger runner), that appears only in the sentence in `muted`; it is not low then,
  because there is a budget.
- **Without a state** (not read yet, or the request failed) a sentence in `muted` stands there, so the stop does not
  appear only later and push the projects down. The reason for a failure is in the log; the button "Open log" leads
  there. Without a sign-in the stop is missing.


### App (version and update)
The App section begins with the version that is running ("RunClub 0.2.0-beta.1"), below it a sentence in `muted` on
what the update is doing right now: checking, downloading, up to date with the time of the last check, failed,
development mode. If nothing is in progress, "Check now" (word only) stands on the right; if an update is ready, the
sentence and "Check now" are left out, unless a renewed check has failed. Below that the update channel as a segmented
control (Stable, Beta); what the channels get is in the info. In development mode it is disabled and gives the reason
in the tooltip. Once an update is downloaded and verified, the row "Update to X is ready" follows with "Update now"
(icon with word); that this takes down all runners is in the info and in the confirmation. While a runner is working,
the button is disabled with a reason. None of this is red: a failed check retries by itself, and the reason is in the
info of the version row. Installing goes through the view "RunClub is shutting down", after which the app restarts.

### Log
The last stop of the settings; the info on the heading says where the messages come from, what Copy and Save take and
why the general errors stay when filtering. One row per message with a hairline below, newest at the top: time and
project in Meta `muted` (columns 92 px and 128 px), a state icon (16 px) and the text in Body. For today the time of
day is shown, for earlier days date and time without seconds. Only what is a result carries an icon: job done, job
failed, job cancelled, error. The start of a job stays without an icon, because yellow means "running now". The text of
an error row stays in `text`; the red icon carries the state, because an error from hours ago demands nothing anymore.
Above it on the left the filter as a segmented control (All, one per project, General; only with more than one
project), on the right "Copy" and "Save", which both take the whole file. Filtered to one project, the project column
is dropped, and the general errors stay in, because that is often where the cause is; they then carry "General" in
`muted` before the text. The interface builds the messages from key and values in its own language
(`src/messages.js`); only texts from outside (Docker, GitHub) and entries from older versions appear as they came.
Collapsed eight rows; expanded, the list scrolls within itself (at most 496 px), so "Show less" stays reachable.

### Tooltip and toast
`raised`, border 1 px `track`, radius 6 px, type `ink` 400. The tooltip (12 px, one line) follows the mouse pointer over a chart and over buttons that show only an icon; with keyboard use it sits above the element; the toast sits at the bottom center and disappears after five seconds. Whatever needs more than one line is not a tooltip but an info element (see there).

### Confirmation
Before anything that deletes or affects jobs (clear, remove project, switch back, quit, update), the app asks first, in
its own panel instead of a Windows dialog. The panel is `raised` with border 1 px `track`, radius 8 px like everything
operable, at most 440 px wide, centered over a veil in `rail` at 72 % opacity; no shadow, no blur. The heading (Title)
is the action as a question, below it the consequence as one sentence that names the project. At the bottom right
"Cancel" and next to it the action with its own word; it is red only if it does not come back. "Cancel" has the
focus, and the focus ring is always visible here; Escape and a click beside the panel cancel. Panel and veil appear in
200 ms.

Buttons on `raised` take the border tones as steps, because there is no lighter surface above it: at rest `edge`
with border `cap`, hovered `cap` with border `track`, pressed `raised`.

### Shutdown
While shutting down, the whole window belongs to the teardown, so nobody clicks several times: the rail is missing, the
strip at the top holds the wordmark (15 px, 600, `muted`). The content is at most 820 px wide and centered; the view
appears as soon as `/api/status` delivers the state `shutdown`, whether via "Quit RunClub" in the settings or via the
icon in the notification area.
- **Structure:** Header as for a run: Headline "RunClub is shutting down", below it a sentence in `text` (at most 56
  characters wide) on what is taken down and that the window closes by itself; on the right the remaining time as
  Display with the words above it ("time left"). Below that a network map of three stages: one station per project
  with a pool, then "Clean up" (build services, networks, volumes), then "Sign off" (on GitHub). Below that a hint in
  `muted` on where the estimate comes from and how long at most it waits for a runner that is being created.
- **Stations:** The shape of the pill with an always visible second line, but not a link and without expanding; they
  do not react to the pointer. A project being torn down is running (`run`, time since start, "2 of 3 runners
  removed", progress stroke by share); if a running job is cancelled there, it shows "Cancelling “Name”" in `run`
  instead. Done is `done` with the duration. Clean up and Sign off wait transparent and dashed with the estimate from
  the last shutdown ("about 0:02"), run with the time since their start and, for Sign off, count the projects, with a
  progress stroke like the projects. The column of the projects is wider than the others.
- **Without an estimate:** If there is no stored duration yet, the elapsed time stands instead of the remaining time
  ("so far 0:06"), the waiting stages carry no time, and the hint says that the estimate comes from next time on.
- **Overrun:** If the estimate is up and the teardown is not finished, the elapsed time counts instead of a frozen
  remaining time ("longer than estimated, so far 0:17"); a frozen number would look like a hung app.
- **Cancelling:** Only the job's name is truncated, never the word before it or the quotation marks.
- **No red:** The user wanted to quit, and nothing in it requires stepping in (see the Red-Means-Trouble Rule). If a
  step fails, that goes into the log, and the teardown continues. A service that no longer responds at the end is the
  expected end and not worth a message.

### Window
The app's window has no Windows title bar. The top 32 px are the drag handle across the full width and stay empty;
rail and main area start below on one line, the wordmark at the height of the heading. Minimize, maximize and close
are the Windows buttons in the app's colors (surface `ground`, glyphs `text`), so snapping and keyboard work as usual.
In a narrow window the wordmark (18 px) sits in the strip, which there takes the color of the rail.

### Focus
Every operable element shows, with keyboard use, a 2 px ring in `chart` with a 2 px offset.

### Motion
One curve for everything spatial: `--ease` (`cubic-bezier(.16, 1, .3, 1)`), 180 to 220 ms. Color changes 150 ms. The progress stroke runs linearly once per second. With `prefers-reduced-motion` the transitions of pills and buttons are dropped.

## Do's and Don'ts

### Do:
- **Do** always show state as color and icon at once, with the six fixed pairs.
- **Do** draw dependencies as a curved track from right middle to left middle, 2.5 px, round caps.
- **Do** stack surfaces by tonal steps (`rail`, `ground`, `surface`, `raised`) and frame them with 1 px `edge`.
- **Do** set numbers in tabular figures and right-align them where they stand in columns.
- **Do** show load as history over time, with cap, peak and the start of the run as reference.
- **Do** mark estimates as such ("about", "usual", "rough estimate") and keep them in `muted` or `text`, not highlighted.
- **Do** draw what is open as dashed or dotted and without fill, what is done or running as solid.
- **Do** say briefly on the surface what is and what to do; reasons and background belong in the info element.
- **Do** use `fail-text` for red type and `fail-edge` for red borders; `fail` itself only for filled icons and the warning chart.

### Don't:
- **Don't** use pure white; the lightest tone is `ink`.
- **Don't** add a light theme; the system is dark only (`color-scheme: dark`).
- **Don't** use shadows, gradients or blur.
- **Don't** color tracks in a state color or route them straight or at right angles in the network map.
- **Don't** draw a control icon in a state color or use a typed character (+, −, ×) as an icon.
- **Don't** color a permanent state red if no setting leads out of it; red needs a way out.
- **Don't** show a run as a job list with status dots in cards.
- **Don't** use one of the glowing state colors (`run`, `done`, `fail`, `cancel`) as decoration or for anything other than its state.
- **Don't** set type heavier than 400 (exception: the wordmark) or letter-space labels in all caps.
- **Don't** use the pill shape for anything other than a job. The only exception are the stations while shutting down, which presents itself as a run (see "Shutdown").
