---
name: BB Squadron
description: The ready-room sortie board, live: the whole path in dithered pixels on BB's own theme.
colors:
  needs-you-amber: "#f2a900"
  working-sky: "#3fa7d6"
  stopped-red: "#d7263d"
  landed-green: "#2fa36b"
  on-amber: "#1d1600"
  amber-ink: "color-mix(in oklab, #f2a900 46%, var(--foreground))"
  sky-ink: "color-mix(in oklab, #3fa7d6 50%, var(--foreground))"
  red-ink: "color-mix(in oklab, #d7263d 62%, var(--foreground))"
  green-ink: "color-mix(in oklab, #2fa36b 52%, var(--foreground))"
  board-ground: "var(--background)"
  board-ink: "var(--foreground)"
  muted-ink: "var(--muted-foreground)"
  hairline: "var(--border)"
  band: "color-mix(in oklab, var(--foreground) 4.5%, var(--background))"
  rule-ink: "color-mix(in oklab, var(--foreground) 30%, transparent)"
typography:
  display:
    fontFamily: "5x7 pixel cell font (lib/pixels.ts, SVG rects)"
    fontSize: "34px (7 cells of 4px on a 5px pitch)"
    lineHeight: 1
  headline:
    fontFamily: "inherit (BB UI font)"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline-narrow:
    fontFamily: "inherit (BB UI font)"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.15
  path-count:
    fontFamily: "inherit (BB UI font)"
    fontSize: "22px (18px in a narrow box)"
    fontWeight: 650
    lineHeight: 1.1
    fontFeature: "tnum"
  title:
    fontFamily: "inherit (BB UI font)"
    fontSize: "14px"
    fontWeight: 620
    lineHeight: 1.3
  body:
    fontFamily: "inherit (BB UI font)"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: "inherit (BB UI font)"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.3
  label:
    fontFamily: "inherit (BB UI font)"
    fontSize: "12px"
    fontWeight: 650
    letterSpacing: "0.08em"
  meta:
    fontFamily: "inherit (BB UI font)"
    fontSize: "11px"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 650
    fontFeature: "tnum"
rounded:
  none: "0px"
  control: "2px"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  page-x: "28px"
  section: "30px"
components:
  button:
    backgroundColor: "{colors.board-ground}"
    textColor: "{colors.board-ink}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "28px"
  button-primary:
    backgroundColor: "{colors.board-ink}"
    textColor: "{colors.board-ground}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "28px"
  button-amber:
    backgroundColor: "{colors.needs-you-amber}"
    textColor: "{colors.on-amber}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "28px"
  button-danger:
    textColor: "{colors.red-ink}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "28px"
  tag:
    textColor: "{colors.board-ink}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "1px 6px"
  tag-amber:
    backgroundColor: "{colors.needs-you-amber}"
    textColor: "{colors.on-amber}"
    rounded: "{rounded.control}"
    padding: "1px 6px"
  peg:
    backgroundColor: "{colors.board-ground}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.none}"
    padding: "8px 9px 7px"
    width: "190px"
  peg-waiting:
    padding: "6px 8px"
    width: "168px"
  peg-compact:
    padding: "6px 7px"
    width: "84px"
  tail-card:
    backgroundColor: "{colors.band}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.none}"
    padding: "11px 12px 10px"
  needs-you-row:
    backgroundColor: "{colors.board-ground}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
  needs-you-kind:
    backgroundColor: "{colors.needs-you-amber}"
    textColor: "{colors.on-amber}"
    padding: "2px 7px"
  picker-button:
    backgroundColor: "{colors.board-ground}"
    textColor: "{colors.board-ink}"
    rounded: "{rounded.control}"
    padding: "0 10px 0 11px"
    height: "32px"
  doctor-status:
    backgroundColor: "{colors.board-ground}"
    textColor: "{colors.board-ink}"
    typography: "{typography.meta}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "28px"
  path-station:
    typography: "{typography.path-count}"
    padding: "10px 12px 12px 0"
  list-plate:
    backgroundColor: "{colors.band}"
    rounded: "{rounded.none}"
    padding: "6px 8px"
---

# Design System: BB Squadron

This describes the board as shipped in SIZE-958, built to the approved SIZE-948 comp (`comps/live-board/index.html`). The comp and this file agree; where they ever differ, the shipped code and this file win.

## Overview

**Creative North Star: "The Ready-Room Sortie Board, live"**

The board is a squadron ready room's sortie board drawn inside BB, now covering the whole path a spec travels: Open issues, Shaping, Ready, Flying, Landed. Each Flying lane is one ruled line; its tickets sit on that line as pegs in dependency order, left to right, with small pixel chevrons between columns, and a sky airstream flows behind them at the pace of the lane's working threads. What waits on the owner sits pinned near the top in amber. The path reads as a route, never as kanban columns or count tiles.

The material is BB's own theme. Ground, ink, muted ink and hairlines are BB's theme tokens, so the board works on any BB theme, light or dark. The only texture is ordered dither drawn on canvas: Bayer 8x8 thresholds, one cell per device pixel, so fills read as fine halftone grain. The only display type is a 5x7 pixel cell font for spec numbers, used like tail numbers on an airframe. Four state inks sit on top of the theme, and each state is also carried by form, never by colour alone.

Motion is continuous and only where something is happening: the Flying airstream, working pegs, the Needs-you edge, the header's formation mark and the one-time landing. It pauses while the page is hidden. Under reduced motion every canvas draws one still frame and CSS motion stops.

**Key characteristics:**
- BB theme tokens for every neutral; four fixed state inks layered on top.
- Canvas Bayer 8x8 ordered dither at device-pixel density is the only texture. CSS adds none.
- A 5x7 pixel cell font for spec numbers only; BB's UI font for everything else; mono for ids and branches.
- Square board marks, 1px hairlines, 2px pixel rules (2px on, 2px off), 2px controls, no shadows.
- Every state is ink plus form; every animation has a still fallback.
- No visual is demo-only: the synthetic demo and the live board draw the same parts.

## Colors

The theme supplies the neutrals; four state inks supply the meaning.

### Primary
- **Needs-You Amber** (needs-you-amber): the one colour that means "the owner". It fills the Needs-you count and kind tags and the Answer, Merge, Resume-in-Needs-you and Set up buttons, edges Needs-you rows and question pegs with a doubled line, tops the tail card of a lane whose merge waits on the owner, outlines Doctor's square when something needs fixing, dashes Doctor's Fix tags, and tints text selection at 38%. Text on solid amber is always **On-Amber** (on-amber), never white. Amber ink names what a Shaping spec is missing.

### Secondary
- **Working Sky** (working-sky): an agent is on it. The airstream, the working peg's march and grain, the striped working and review progress segments, the formation mark's flying chevrons, the Flying station's rule and count while anything flies, the pace square, and the auto-start switch when on. Sky ink also marks "N can start" on Ready rows and is the focus outline.

### Tertiary
- **Stopped Red** (stopped-red): failed or stopped. Doubles the failed peg's border to 2px with a red grain, raises its progress segment to full height, tops a stopped lane's tail card, and colours the urgent-priority mark and failing-checks dot.
- **Landed Green** (landed-green): in the integration branch or merged. Fills branch and done segments solid, edges compact branch pegs with their still green grain, grains the landed number plates, fills Doctor's square when Start is ready, and is the colour of the landing burst and stamp.

### Neutral
- **Board Ground** (board-ground): BB's `--background`. Page, pegs, buttons, the picker list and Needs-you rows all sit on it.
- **Board Ink** (board-ink): BB's `--foreground`. Body text, section labels, spec numbers at rest, the primary button fill, and the base every `-ink` variant mixes toward.
- **Muted Ink** (muted-ink): BB's `--muted-foreground`. Station labels, zero counts, meta lines, branch names, waiting pegs, the tracker line.
- **Hairline** (hairline): BB's `--border`. Every 1px row rule, peg border and control border.
- **Band** (band): foreground at 4.5% over the ground. The one tonal step: the tail card behind each lane and the plate behind spec numbers in lists.
- **Rule Ink** (rule-ink): foreground at 30%. The 2px-on, 2px-off pixel rule under section labels, under the path stations and along each sortie line; hollow progress segments; the outside-lane tag's dashes.

### Named Rules

**The Theme-Owns-Neutrals Rule.** No neutral is ever a literal value. Ground, ink, muted ink and hairline are BB's tokens; the band, hover tint and rule ink are mixes of them. The board must look right on any BB theme without a single override.

**The Ink-Toward-Foreground Rule.** State colours as fills stay fixed; state colours as text or marks use their `-ink` variant, mixed in OKLab toward the theme foreground (amber 46%, sky 50%, red 62%, green 52%), so labels stay legible on light and dark grounds. The dither renderer reads the fixed inks from the board's CSS, so a theme change redraws the art.

**The Four-Inks Rule.** Amber means the owner, sky means an agent is working, red means stopped, green means in the branch or landed. No fifth hue, and no ink used for decoration.

## Typography

**Display Font:** a 5x7 pixel cell font drawn as SVG rects (`lib/pixels.ts`), with a screen-reader copy of the text.
**Body Font:** BB's inherited UI font; the board sets no family of its own.
**Label/Mono Font:** the system monospace stack, for ticket ids, branch names, Open issue ids and file paths.

**Character:** a crisp, built-from-cells display set against BB's plain UI type, so the spec numbers look painted on and everything else reads like the rest of BB.

### Hierarchy
- **Display** (pixel cells: 4px cells on a 5px pitch, 34px tall, in lane tails; 2px cells with no gap, 14px tall, on list plates and in Needs-you rows): spec numbers only. Ink follows lane state: board ink, red ink when stopped, amber ink when the merge waits or in Needs you, green ink when landed.
- **Headline** (650, 22px, 1.15, -0.02em): the page title "Squadron", once. 18px in a narrow box.
- **Path count** (650, 22px, 1.1, tabular): each station's count; 500 and muted at zero, sky ink on Flying while anything flies. 18px in a narrow box.
- **Title** (620, 14px, 1.3, balanced wrap): the spec title in each tail card and the project name on the picker. List-row titles are 600 at 13.5px; Open issue and Landed titles are 400 at 13px.
- **Body** (400, 13px, 1.45): Needs-you text, empty-state lines (max 70ch), Doctor messages.
- **Body small** (400, 12.5px, 1.3, clamped to two lines): peg titles; one line on waiting pegs.
- **Label** (650, 12px, 0.08em, uppercase): section headings, each on a pixel rule with its count beside it. Station labels use the same voice at 11px. The Needs-you kind tag is 700, 11px, 0.04em on solid amber.
- **Meta** (600, 11–12px): buttons (12px), peg state, tags, AI chips, counts, the picker's tracker-and-counts line (11.5px).
- **Mono** (650, 11px, tabular figures): ticket ids on pegs; branch names, Open issue ids, "after" lines (10.5px) and file paths at 400 in muted ink.

### Named Rules

**The Tail-Number Rule.** The pixel font is for spec numbers and nothing else. Prose, buttons and ticket ids stay in BB's UI font or mono; a second display face is never added.

**The Tabular Rule.** Every count, duration and id that can change while the owner watches uses tabular figures, so the line does not jitter as numbers tick.

## Layout

One centred column (max 1480px) with 22px top and 28px side padding.

1. **Header** (a wrapping row): the formation mark and "Squadron", the project picker, then at the right Doctor status and New spec (primary). The demo adds its "Synthetic data" tag, auto-start switch and the demo switch before Doctor.
2. **Tracker line**, 8px under the header.
3. **Path strip**, 20px under that: five equal stations in path order.
4. **Sections**, 30px apart, in attention order, not path order: Needs you (with Doctor's open region under its rows), Flying, Ready, Shaping, Open issues, Landed. Every section always shows; an empty one says in a sentence how work gets into it, with the button that does it where there is one. Each section opens with an uppercase label on a 2px pixel rule, its count beside the label (amber for Needs you, muted otherwise).

A sortie line is a two-column grid: a tail card (208–236px) and a track, 20px apart, 16px of vertical padding, closed by a 1px hairline. The track holds the progress strip above a horizontally scrolling rail. Inside the rail, the dependency columns sit on the pixel rule at their vertical centre, with the airstream canvas behind them across the full width of the pegs; columns are joined by 6x10 pixel chevrons with 7px side margins, and pegs in one column stack 8px apart. When the rail overflows, its right 56px fades out through a mask.

List rows (Ready, Shaping, Open issues, Landed) are three-column grids on 1px hairlines: a band plate with the spec number (an 82px mono id column for Open issues), a main column of title over a meta line, and the row's one action at the right. Ready and Shaping rows pad 11px; Open issues and Landed 9px.

The board is a container (`container-type: inline-size`) and responds to its own width, not the window. At 900px and below a sortie line stacks the tail card over the track. At 560px and below (a side panel) the page padding drops to 14px, the picker takes its own full row, Doctor shows only its square and the word "Doctor", the path strip keeps five cells with "Open" for Open issues, Needs-you rows put text and actions on their own lines, row actions move under the row, and empty sections stack their button under the sentence. In a thread's side panel (the `experimental_tab`, `placement="panel"`, `data-layout="narrow"`) a sortie line is one column: the tail card with a 3px-cell tail number, the progress strip, a 26px airstream band on its pixel rule, then full-width pegs for only the tickets an agent is on or that wait on the owner (Working, In review, Needs you, Stopped). Every ticket sits behind an "All N tickets" disclosure ("1 ticket" for one): id, title and state word per row on hairlines, the state word in its ink. There is no dependency rail. Thread links there open in the main view, not beside the board.

## Elevation & Depth

The board is flat: there are no shadows anywhere. Depth comes from three things only: the band behind tail cards and number plates, doubled edges (a 1px border plus a 1px outline offset 2px) on anything amber, and dither drawn inside a mark's own box. The picker list drops over the page as a hairline box on the ground, with no shadow. The inset `box-shadow`s in the code are strokes (a hollow progress segment, Doctor's square, a hollow PR dot), not elevation.

### Named Rules

**The Flat-Board Rule.** Nothing floats. Emphasis comes from a doubled edge, a heavier border or a denser dither, never from a shadow or a lift on hover.

## Shapes

Board marks are square: pegs, tail cards, Needs-you rows, number plates, progress segments, state squares and the picker's current-project mark have no radius. Controls are almost square: buttons, tags, the picker button and Doctor round to 2px. Borders are 1px hairlines at rest and 2px for the failed peg and the tail card's top edge. Every pixel mark (chevrons, carets, formation mark, burst bits, pixel rules) is built on a 2px cell with crisp edges. Waiting pegs use a dashed hairline; the outside-lane tag a dashed rule-ink line; the synthetic-data footer sits behind a dashed hairline.

## Components

### Buttons
Small, quiet, near-square; colour only when the owner is the one acting.
- **Shape:** 2px corners, 28px tall, 0 11px padding, 12px at 600.
- **Plain:** ground fill, hairline border. Hover tints the fill to foreground 6%.
- **Primary** (New spec in the header, Start, Plan tickets, Resume planning, Resume in a tail card): solid board ink with ground text. Hover mixes it 86% toward the ground. Plan on Open issues and New spec in empty sections stay plain.
- **Amber** (Answer in thread, Merge, Resume in Needs you, Set up): solid amber with on-amber text. Only for actions the owner alone can take.
- **Danger** (the demo's Cancel): transparent, red-ink text, border red at 45% over the hairline; set 14px apart from the other lane actions.
- **Focus:** a 2px sky-ink outline, offset 2px, on every focusable element.
- **Disabled:** 42% opacity, not-allowed cursor; the reason sits beside the button in 11.5px muted text ("Opening its Lead thread", Doctor's reason).

### Header
- **Formation mark** (92x40 canvas) before the title: one sky chevron per lane flying across all of the owner's projects, three slots minimum with empty ones in hairline, each bobbing under a pixel with a short dithered contrail. Labelled "N lanes flying across your projects"; the demo labels it against its lane cap ("2 of 3 lanes flying"). Still when nothing flies; absent only until the live board's first read.
- **Project picker:** a 32px button naming the project (Title voice), then its tracker kind and its Ready and Flying counts in 11.5px muted meta ("Linear · 1 ready · 0 flying"), then a pixel caret that flips when open. It opens a list under the button (min 330px): each row has a 6px square that fills for the shown project, the name at 620, the tracker kind under it in muted 11.5px, and the counts (or why there are none) at the right. Escape or a click outside closes it. With no project to show it stays open, asking.
- **Doctor status:** a 28px quiet button with an 8px square, "Doctor", and in muted ink what it means for Start: solid green "Start ready", amber-outlined "N to fix before Start", hollow muted "Needs Set up". Before Doctor has run it reads just "Doctor" with a hollow square. It expands Doctor's region.
- **Tracker line:** 12px muted ink, starting with a hairline tracker-kind tag. Linear: the bound "Team · Project" in board ink at 600 and when it was last read (a failed read in red ink). Local markdown: "**.scratch/** on main · Flying lanes read from their integration branch". GitHub: "**GitHub Issues** read through gh". No tracker: "**No tracker found**" and the short reason.

### Path strip
Five stations, each an 11px label over a path count on a 2px pixel rule, joined by 6x10 pixel chevrons in rule ink at their bottom right. Zero counts are muted; Flying turns its count sky ink and its rule sky while anything flies. While the board can't show Ready, Shaping and Open issues, those counts read "–". Each station scrolls to its section.

### Chips and tags
- **Tag:** 11px at 600, 1px 6px padding, hairline border, 2px corners; issue labels, `accept:owner`, Doctor's Pass, Warning and Fix (Fix and Warning dashed amber), Present and Missing. The amber tag (solid amber, on-amber) marks "Synthetic data".
- **AI chip:** BB's own provider icon at 12px, then model and effort, 11px at 600 in muted ink. A Lead chip prefixes "Lead ·" and turns board ink on hover.
- **Outside-lane tag:** "Started outside Squadron", 11px at 600, dashed rule-ink border.

### Needs-you row
Ground fill, 1px amber border plus a 1px amber outline offset 2px, with an amber grain along the edges (7–10px deep) breathing on a 3.6s sine, so the text sits on a clean ground. Kind tag (Setup, Failed, Blocked, Stopped, Question, Merge), the spec or ticket number in 2px pixel cells and amber ink, one line of text, then its actions. Rows stack 12px apart; with none, "Nothing needs you. Every lane is flying on its own."

### Doctor region
A flat region under the Needs-you rows: 12px padding, hairline border. A summary line, then one row per check (150px name, Pass/Warning/Fix tag, muted explanation) on hairlines, then "Configuration files" with a linked file name, Present or Missing tag and its mono path. Check again uses the plain button. In a narrow box explanations and paths move under their name and tag.

### Tail card
The lane's plate. Band fill, 2px top edge in hairline that turns red (stopped), amber (merge waits) or green (landed). Holds the pixel spec number, the title (opens the spec), the Lead chip (opens the Lead thread), the lane state with an 8px state square and its time, the PR link with its checks dot (green, red, pulsing amber while checks run, hollow when there are none or none are known), the outside-lane tag, the branch in mono, and the lane actions (Merge, Resume, Stop). An outside lane replaces the actions with a muted read-only line over a hairline: "Read-only: Squadron didn't start this lane, so it has no Stop, Resume or Merge."

### Progress strip
One segment per ticket in lane order, up to 40px wide (22px basis), 6px tall, 2px apart, then "N/M in branch" and, at the right, the pace ("2 working" with a sky square). Hollow (1px rule-ink outline) for waiting and ready; sky in 1px stripes for working and review; solid green for in branch and done; amber or red at double height for a question and a failure. The tall segment is the form cue that something on this line is stuck.

### Peg (signature component)
A ticket on the sortie line. Square, ground fill, 190px wide, 1px border at foreground 40%: the id in mono and the state on top, the title in two lines, and for full pegs the AI chip and time at the foot. State is ink plus form:
- **Waiting:** 168px, 6px 8px padding, dashed hairline, muted id and one-line title; the top line's state place reads "after SIZE-n" (its open blockers) in muted mono, or "Waiting" when none are open.
- **Ready:** full size, foreground-40% border.
- **Working:** the border becomes a sky dashed line (2px, 6 on and 4 off) running round the edge at 12px/s over a slow sky grain (7% plus drift); state in sky ink.
- **Question:** amber border plus amber outline offset 2px, amber grain at 16%; state "Needs you" in amber ink.
- **In review:** solid sky border, still sky grain at 14%; state reads "Review · model" with the reviewer's chip.
- **In branch / Done:** compact (84px, id and state only), green border (70% for in branch, full for done), still green grain (17% and 24%), state in green ink.
- **Stopped:** 2px red border, red grain at 22%, state in red ink.
Pegs with a thread are buttons that open it beside the board.

### List rows
- **Ready:** plate, title, then "**N** tickets", "N can start" in sky ink when some wait, the routes' AI chips and `accept:owner`; a disclosure "N wait on blockers" lists each waiting ticket and what it waits on. Start (primary) at the right, with its disabled reason beside it.
- **Shaping:** plate, title, what's missing in amber ink at 600 and the ticket count; Plan tickets or Resume planning (primary).
- **Open issues:** mono id, title, then a meta line of the priority mark, labels and parent context; Plan (plain).
- **Landed:** plate with a still green grain and green-ink number, title, then "PR #n merged" (or "branch merged"), when it landed and how long it flew.

### Linear connection settings
The settings page uses the same ground, ink, type and quiet controls. Workspace names use Title; connection state sits in an announced status region. BB owns the API key's secret input. Linear binding uses native team and project selects, 28px high, 2px corners, ground fill, hairline border, 12px at 600, max 220px.

## Motion

The board's art and motion come from the canvas dither renderer (`lib/dither.ts`, `lib/dither-renderer.ts`, `board/DitherCanvas.tsx`). One `requestAnimationFrame` loop paints every animated canvas that's on screen, at device-pixel density. It stops while the document is hidden. Under `prefers-reduced-motion` each canvas is painted once, at its still moment, and the loop doesn't run.

- **Airstream (signature):** behind each Flying lane's pegs, sky streaks flow left to right along the sortie line. Their speed (12px/s plus 12px/s per working thread, up to four) and density rise with the number of working threads; a lane with none working draws one still frame.
- **Working peg:** the dashed march and grain above.
- **Needs you:** the breathing amber edge grain above.
- **Formation mark:** chevrons bob and trail contrails while anything flies.
- **Landing:** once, when the board first sees a lane Landed: about 110 green pixels sweep the rail behind the pegs and leave a thinning green wake (the burst runs 1.6s); the tail number stamps green from 1.18x over 520ms (`cubic-bezier(0.16, 1, 0.3, 1)`); for the burst's last 420ms the line folds away (grid rows to 0 and opacity to 0, same curve); then the row arrives in Landed (700ms, 6px drop and fade in, same curve). A lane already Landed when the board opens goes straight to Landed. Under reduced motion there is no burst, stamp, fold or arrival: the lane shows Landed still, then moves.
- **CSS motion that remains:** the stamp, the fold and the arrival, the PR-checks-running pulse (1.6s ease-in-out), the switch knob (140ms ease-out), and hover transitions of 130–140ms. No `steps()` animation remains, and CSS draws no dither.

## Do's and Don'ts

### Do:
- **Do** take every neutral from BB's theme tokens (`--background`, `--foreground`, `--muted-foreground`, `--border`) and derive the band (4.5%), hover (6%) and rule ink (30%) by mixing them.
- **Do** use the `-ink` variant of a state colour for any text or small mark, and the fixed state colour for fills, edges and dither.
- **Do** carry every state twice: ink plus form (march, doubled edge, tall segment, hollow outline, dashed border, size).
- **Do** draw every texture and every moving art through the dither renderer, only where something is happening, with a still frame under reduced motion.
- **Do** set spec numbers in the 5x7 pixel cell font (cell 4 in lane tails, cell 2 on plates and in Needs you), always with a screen-reader copy.
- **Do** use 2px-on, 2px-off pixel rules for section labels, path stations and sortie lines, and 1px hairlines for rows and cards.
- **Do** keep amber for what waits on the owner and the actions only they can take.
- **Do** give every empty section a sentence saying how work gets in, with its button where there is one.
- **Do** draw the live board and the demo from the same parts: no visual is demo-only.

### Don't:
- **Don't** add a shadow or lift to any surface, including the picker list.
- **Don't** round board marks; pegs, cards, rows and segments stay at 0px, controls at 2px.
- **Don't** show a state by colour alone, or by motion alone.
- **Don't** introduce a neutral as a literal hex or a fifth state hue.
- **Don't** cut a CSS dither mask or a `steps()` animation; the renderer owns texture and motion.
- **Don't** use the pixel font for prose, buttons or ticket ids, and don't load a web font.
- **Don't** put white text on amber; use on-amber.
