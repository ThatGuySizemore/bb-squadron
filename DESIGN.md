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
  path-count:
    fontFamily: "5x7 pixel cell font (lib/pixels.ts, SVG rects)"
    fontSize: "21px (14px in narrow layout)"
    lineHeight: 1
  section-label:
    fontFamily: "5x7 pixel cell font (lib/pixels.ts, SVG rects)"
    fontSize: "14px"
    lineHeight: 1
  banner-stencil:
    fontFamily: "5x7 pixel cell font (lib/pixels.ts, SVG rects)"
    fontSize: "34px wide, 21px narrow; shrinks to fit stands"
    lineHeight: 1
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
  section: "26px"
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
    padding: "11px 12px 26px"
  needs-you-row:
    backgroundColor: "{colors.board-ground}"
    rounded: "{rounded.none}"
    padding: "16px 22px"
  needs-you-kind:
    textColor: "{colors.amber-ink}"
    padding: "0"
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

This describes the implemented board through SQD-221's delivered tickets, read from `board/Board.tsx`, `board/board.css`, `board/FlipCount.tsx`, `board/DitherCanvas.tsx`, `lib/runway.ts`, `lib/dither.ts`, `lib/board-model.ts`, `lib/working-agents.ts` and `lib/fly-past.ts`. The runway replaces the former small formation header. Where a comp differs, the implemented code wins. SQD-247's first-read loading state remains Held and is excluded here. This is source-derived documentation; live visual acceptance in BB is unproven.

## Overview

**Creative North Star: "The Ready-Room Sortie Board, live"**

The board is a squadron ready room's sortie board drawn inside BB, now covering the whole path a spec or work item travels: Open issues, Shaping, Ready, Flying, Landed. Each Flying spec has one ruled line with tickets in dependency order, small pixel chevrons between columns and a sky airstream behind the pegs. Work items have compact lane rows. The banner and lanes share the board's working-agent wind. What waits on the owner sits pinned near the top in amber. The path reads as a route, never as kanban columns or count tiles.

The material is BB's own theme. Ground, ink, muted ink and hairlines are BB's theme tokens, so the board works on any BB theme, light or dark. The only texture is ordered dither drawn on canvas: Bayer 8x8 thresholds, one cell per device pixel, so fills read as fine halftone grain. The only display type is a 5x7 pixel cell font for spec numbers, the banner stencil, section labels and path counts. Text sits on clean ground or flat tarmac. Four state inks sit on top of the theme, and each state is also carried by form, never by colour alone.

Motion follows real work: the shared wind, working pegs, the Needs-you edge, each banner plane's lane state and observed takeoffs and landings. An observed queue-clearing landing earns one V fly-past. It pauses while the page is hidden. Under reduced motion every canvas draws one still frame and CSS motion stops.

**Key characteristics:**
- BB theme tokens for every neutral; four fixed state inks layered on top.
- Canvas Bayer 8x8 ordered dither at device-pixel density is the only texture. CSS adds none.
- A 5x7 pixel cell font for spec numbers, SQUADRON, section labels and path counts; BB's UI font or mono for other text.
- Square board marks, 1px hairlines, dotted section separators, 2px-on/2px-off path and rail rules, 2px control corners, no shadows.
- Every state is ink plus form; every animation has a still fallback.
- No visual is demo-only: the synthetic demo and the live board draw the same parts.

## Colors

The theme supplies the neutrals; four state inks supply the meaning.

### Primary
- **Needs-You Amber** (needs-you-amber): the one colour that means "the owner". It fills the Needs-you count, the square before each Needs-you kind label and the Answer, Merge, Resume-in-Needs-you and Set up buttons, edges Needs-you rows and question pegs with a doubled line, tops the tail card of a lane whose merge waits on the owner, outlines Doctor's square when something needs fixing, dashes Doctor's Fix tags, and tints text selection at 38%. Text on solid amber is always **On-Amber** (on-amber), never white. Amber ink names what a Shaping spec is missing.

### Secondary
- **Working Sky** (working-sky): an agent is on it. The airstream, the working peg's march and grain, the striped working and review progress segments, the runway's flying planes and contrails, the Flying station's rule and count while anything flies, the pace square, and the auto-start switch when on. Sky ink also marks "N can start" on Ready rows and is the focus outline.

### Tertiary
- **Stopped Red** (stopped-red): failed or stopped. Doubles the failed peg's border to 2px with a red grain, raises its progress segment to full height, tops a stopped lane's tail card, and colours the urgent-priority mark and failing-checks dot.
- **Landed Green** (landed-green): in the integration branch or merged. Fills branch and done segments solid, edges compact branch pegs with their still green grain, grains the landed number plates, fills Doctor's square when Start is ready, and is the colour of the landing burst and stamp.

### Neutral
- **Board Ground** (board-ground): BB's `--background`. Page, pegs, buttons, the picker list and Needs-you rows all sit on it.
- **Board Ink** (board-ink): BB's `--foreground`. Body text, section labels, spec numbers at rest, the primary button fill, and the base every `-ink` variant mixes toward.
- **Muted Ink** (muted-ink): BB's `--muted-foreground`. Station labels, zero counts, meta lines, branch names, waiting pegs, the tracker line.
- **Hairline** (hairline): BB's `--border`. Every 1px row rule, peg border and control border.
- **Band** (band): foreground at 4.5% over the ground. The one tonal step: the tail card behind each lane and the plate behind spec numbers in lists.
- **Rule Ink** (rule-ink): foreground at 30%. The section separator dots, the 2px-on, 2px-off rule under path stations and along each lane; hollow progress segments; the outside-lane tag's dashes.

### Named Rules

**The Theme-Owns-Neutrals Rule.** No neutral is ever a literal value. Ground, ink, muted ink and hairline are BB's tokens; the band, hover tint and rule ink are mixes of them. The board must look right on any BB theme without a single override.

**The Ink-Toward-Foreground Rule.** State colours as fills stay fixed; state colours as text or marks use their `-ink` variant, mixed in OKLab toward the theme foreground (amber 46%, sky 50%, red 62%, green 52%), so labels stay legible on light and dark grounds. The dither renderer reads the fixed inks from the board's CSS, so a theme change redraws the art.

**The Four-Inks Rule.** Amber means the owner, sky means an agent is working, red means stopped, green means in the branch or landed. No fifth hue, and no ink used for decoration.

## Typography

**Display Font:** a 5x7 pixel cell font drawn as SVG rects (`lib/pixels.ts`), with a screen-reader copy of the text.
**Body Font:** BB's inherited UI font; the board sets no family of its own.
**Label/Mono Font:** the system monospace stack, for ticket ids, branch names, Open issue ids and file paths.

**Character:** crisp cell lettering marks the board's structure and spec numbers. BB's plain UI type carries prose, actions and lane details.

### Hierarchy
- **Spec number** (4px cells on a 5px pitch, 34px tall in wide lane tails; 2px cells with no gap, 14px tall on list plates, compact lanes and in Needs you): ink follows lane state, with red for stopped, amber when the merge waits or in Needs you, green when landed.
- **Banner stencil:** SQUADRON on plain tarmac. The geometry starts with 4px cells and a 1px gap wide, 3px cells and no gap narrow. It shrinks cells and spacing as stands need room, then removes the visible stencil if it cannot fit; the accessible heading remains.
- **Path count:** 3px cells with no gap, 21px tall wide; 2px cells, 14px tall narrow. Zero is muted; Flying uses sky ink while anything flies. The Landed count changes one digit at a time, with one accessible copy of the whole number.

- **Title** (620, 14px, 1.3, balanced wrap): the spec title in each tail card and the project name on the picker. List-row titles are 600 at 13.5px; Open issue and Landed titles are 400 at 13px.
- **Body** (400, 13px, 1.45): Needs-you text, empty-state lines (max 70ch), Doctor messages.
- **Body small** (400, 12.5px, 1.3, clamped to two lines): peg titles; one line on waiting pegs.
- **Section label:** uppercase 2px pixel cells, 14px tall, on clean ground with a normal-type count beside it. A dotted separator sits above each section. Path station labels stay in normal UI type at 650, 11px and 0.08em spacing. The Needs-you kind label is 700, 11px, 0.08em in amber ink after a 6px solid amber square, with no fill or box: it names the row and is never pressable, so only the row's buttons look like controls.
- **Meta** (600, 11–12px): buttons (12px), peg state, tags, AI chips, counts, the picker's tracker-and-counts line (11.5px).
- **Mono** (650, 11px, tabular figures): ticket ids on pegs; branch names, Open issue ids, "after" lines (10.5px) and file paths at 400 in muted ink.

### Named Rules

**The Pixel-Type Rule.** The pixel font is for spec numbers, the banner's SQUADRON, section labels and the path strip's counts, and nothing else. It never sits on busy dither. Prose, buttons, ticket ids, lane times and every other count stay in BB's UI font or mono. A second display face is never added.

**The Tabular Rule.** Normal-type counts, durations and ids use tabular figures. Pixel path counts use the cell font, with separate digit windows for the Landed count.

## Layout

A full-width runway banner sits above a centred controls row and content column, each capped at 1480px. Content has 28px side padding and no top padding; controls have 14px top padding.

1. **Runway banner**, 164px high wide, 140px in the narrow layout. Light clouds occupy the sky; the flat tarmac below carries the title, capacity label and plane stands.
2. **Controls row:** project picker at the left; How it works, Doctor, Helper, New spec and Autopilot in the action group at the right. Controls wrap. The capacity label moves here when it cannot fit on the tarmac. The synthetic demo keeps its labelled simulation controls.
3. **Tracker line**, 8px below the header, then the path strip with 20px top margin and five equal stations in path order.
4. **Sections** in attention order: Needs you, Flying, Ready, Shaping, Open issues, Landed. Each starts with a full-width canvas separator of 2px square dots on an 8px pitch. The section has 26px top margin and 22px top padding; below 560px its margin is 24px. Its pixel label has a normal-type count beside it, amber for Needs you and muted otherwise. Empty sections explain how work gets in and offer the action where there is one.

A wide sortie line is a two-column grid: a tail card (208–236px) and a track, 20px apart, 16px of vertical padding, closed by a 1px hairline. The tail holds the Lead's live step and a 16px contrail progress bar along its bottom edge. The track keeps the progress strip above a horizontally scrolling rail. Inside the rail, the dependency columns sit on the pixel rule at their vertical centre, with the airstream canvas behind them across the full width of the pegs; columns are joined by 6x10 pixel chevrons with 7px side margins, and pegs in one column stack 8px apart. When the rail overflows, its right 56px fades out through a mask.

List rows (Ready, Shaping, Open issues, Landed) are three-column grids on 1px hairlines: a band plate with the spec number (an 82px mono id column for Open issues), a main column of title over a meta line, and the row's one action at the right. Ready and Shaping rows pad 11px; Open issues and Landed 9px.

The board is a container (`container-type: inline-size`) and responds to its own width, not the window. At 900px and below, and always in a thread's side panel (`experimental_tab`, `placement="panel"`, `data-layout="narrow"`), a sortie line is one column: the compact lane row with its contrail bar, then slim rows for tickets an agent is on or that wait on the owner (Working, In review, Needs you, Stopped). Every ticket sits behind an "All N tickets" disclosure ("1 ticket" for one): id, title and state word per row on hairlines, the state word in its ink. There is no dependency rail. Thread links in the side panel open in the main view; on the full page they open beside the board. At 560px and below the page padding drops to 14px, the picker takes its own full row, Doctor shows only its square and the word "Doctor", the path strip keeps five cells with "Open" for Open issues, Needs-you rows put text and actions on their own lines, row actions move under the row, and empty sections stack their button under the sentence.

## Elevation & Depth

The board is flat: there are no shadows anywhere. Depth comes from three things only: the band behind tail cards and number plates, doubled edges (a border plus a 1px outline offset 2px) on amber rows and pegs, and dither drawn inside a mark's own box. The picker list drops over the page as a hairline box on the ground, with no shadow. The inset `box-shadow`s in the code are strokes (a hollow progress segment, Doctor's square, a hollow PR dot), not elevation.

### Named Rules

**The Flat-Board Rule.** Nothing floats. Emphasis comes from a doubled edge, a heavier border or a denser dither, never from a shadow or a lift on hover.

## Shapes

Board marks are square: pegs, tail cards, Needs-you rows, number plates, progress segments, state squares and the picker's current-project mark have no radius. Controls are almost square: buttons, tags, the picker button and Doctor round to 2px. Borders are 1px hairlines at rest and 2px for Needs you rows, the failed peg and the tail card's top edge. Chevrons, carets, section dots and rule marks use crisp 2px cells. The runway fits its plane and stencil cells to the available width; banner planes use 1px to 4px cells. Waiting pegs use a dashed hairline; the outside-lane tag a dashed rule-ink line; the synthetic-data footer sits behind a dashed hairline.

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

### Runway banner and controls
The banner uses theme-derived cloud, tarmac, marking and stand inks. Clouds mix foreground at 34% over background; tarmac at 7%, its edge at 30%, markings at 42% and unlit stands at 52%. The tarmac is 52px high wide and 42px narrow. It stays flat behind text; trails stay in the sky.

One stand represents each lane in this project's lane limit, with extra stands for lanes over the limit and at least one stand when no limit is known. Stand zero is rightmost. Lit planes face right; free stands are dotted while any lane is on the Flying line. A spec plane is 16x9 cells, normally 64x36px wide or 48x27px narrow. A work item's plane is 11x7 cells at the same cell size, centred in a full-size stand. Lane kind determines its size, so a one-ticket spec still has a spec plane. Both sizes keep two contrails starting behind the main-wing engines, never one from the tail.

One layout places the stencil, stands, label and plane click targets. As space tightens, cells shrink and threshold bars can disappear. For 1–10 stands, this fitting geometry stays unchanged. Above ten, all stands remain on a longer runway with 2px plane cells and 26px gaps, keeping the padded buttons separate. When that content exceeds the viewport, a named keyboard-focusable region exposes native horizontal scrolling and a visible "Scroll the runway to see all N stands" hint. The canvas and DOM share the expanded width; the 164px/140px scene retains its flat tarmac and unobstructed stencil, with room below for the native scrollbar. No lane is capped or dropped. The normal-type capacity label, such as "2 of 3 lanes flying", moves to the controls row if it cannot fit clear of the stands. Over-limit counts keep the limit separately, such as "3 of 3 lanes flying (limit 2)". The label counts lanes that have not Landed; a landing plane stays visible through its glide. The first read supplies the lane count; no held loading animation is documented as delivered.

Lit takeoff, flying and holding planes have named keyboard buttons over their air positions, using the plane's size plus 10px padding. A beacon click scrolls to its Needs you row and focuses the first action; other plane clicks scroll to the lane. Reduced motion uses an immediate scroll. Every plane button has 2px corners and the same outward 2px sky-ink focus outline with a 2px offset, including beacon buttons. Landing, parked and empty stands have no plane button.

- **Project picker:** a 32px button naming the project, then its tracker kind and Ready/Flying counts in 11.5px muted text, then a pixel caret that flips when open. Its list has a minimum width of 330px; a 6px square marks the current project. Escape or an outside click closes it. With no project to show it stays open, asking.
- **Doctor status:** a 28px quiet button with an 8px square, "Doctor" and its verdict in muted ink. It expands Doctor's region. Before a verdict is available it says "Doctor" with a hollow square.
- **Controls:** 10px vertical and 14px horizontal gaps; action buttons have 8px gaps. Autopilot closes the group after a hairline and its runtime note sits below. At 560px and below the picker takes a full row and Doctor hides its verdict text.
- **Tracker line:** muted 12px type with a tracker-kind tag, source context and last-read or error text. It retains the existing tracker-specific messages.

### Path strip
Five stations, each an 11px UI-font label over a pixel path count on a 2px-on, 2px-off rule, joined by 6x10 pixel chevrons in rule ink at their bottom right. Zero counts are muted; Flying turns its count sky ink and its rule sky while anything flies. While the board can't show Ready, Shaping and Open issues, those counts read "–". Each station scrolls to its section.

### Chips and tags
- **Tag:** 11px at 600, 1px 6px padding, hairline border, 2px corners; issue labels, `accept:owner`, Doctor's Pass, Warning and Fix (Fix and Warning dashed amber), Present and Missing. The amber tag (solid amber, on-amber) marks "Synthetic data".
- **AI chip:** BB's own provider icon at 12px, then model and effort, 11px at 600 in muted ink. A Lead chip prefixes "Lead ·" and turns board ink on hover.
- **Work kind:** "Work item" for a standalone lane, or "Spec · N tickets" for a spec, with "25+" above 25. These tags use normal UI type in Ready, Shaping and lane headers.
- **Outside-lane tag:** "Started outside Squadron", 11px at 600, dashed rule-ink border.

### Needs-you row
Ground fill, 2px amber border plus a 1px amber outline offset 2px, with a heavier amber grain along the edges (10–14px deep) breathing on a 3.6s sine, so the text sits on a clean ground. Kind label (Setup, Failed, Blocked, Stopped, Question, Merge; amber ink, never a filled tag), the spec or ticket number in 2px pixel cells and amber ink, one line of text, then its actions. Rows stack 14px apart; with none, "Nothing needs you. Every lane is flying on its own."

### Doctor region
A flat region under the Needs-you rows: 12px padding, hairline border. A summary line, then one row per check (150px name, Pass/Warning/Fix tag, muted explanation) on hairlines, then "Configuration files" with a linked file name, Present or Missing tag and its mono path. Check again uses the plain button. In a narrow box explanations and paths move under their name and tag.

### Owner words
Every owner word the board shows as a label (section labels, path stations, lane and ticket states, Doctor's House rules) and the owner words in How Squadron works carry a 1px dotted underline in rule ink that turns to the text's own ink on hover or focus. Hover, or keyboard focus, shows its `lib/owner-words.ts` definition: a flat box in the top layer, so a scrolling rail or the side panel never clips it, with a hairline border on the ground, a 2px pixel rule along its top edge, square corners and no shadow, in Body small (12.5px, 1.4, 400, never uppercase) up to 34ch. It opens 6px under the word, or above it near the bottom of the window, and stays inside the window. Pointing at the box keeps it open; Escape, a scroll or moving away closes it. A word on its own takes one tab stop. A word inside a control (a station, a peg, a file link) adds none: the control's focus shows the definition and is described by it.

### How Squadron works
A plain "How it works" button in the header, before Doctor, opens a flat region under the header (12–16px padding, hairline border, no shadow); the button stays tinted while it is open. Close, Escape or the button again closes it, and focus returns to the button. It opens on its own section label, "How Squadron works", with Close at the right. The diagram is the path in the strip's voice: Plan, Spec, Ready, Lane and Landed as 14px names at 650 over 2px pixel rules joined by pixel chevrons. The Lane rule is sky (agents work there) and the Landed rule solid green; the others stay rule ink. Under each rule a muted 12.5px line says who does that part, and the three places the owner steps in (You plan it, You answer questions, You merge `accept:owner` work) carry Needs you's mark: a 6px amber square before 650 amber ink. Under a hairline sit at most five short lines (70ch). Owner words carry their definitions as everywhere else on the board (see Owner words below). In a narrow box the path runs down the page on a vertical pixel rule, with no chevrons.

### Tail card
The wide lane's plate. Band fill, 2px top edge in hairline that turns red (stopped), amber (merge waits) or green (landed), with 11px top, 12px side and 26px bottom padding to clear the contrail bar. Holds the pixel spec number, the title (opens the spec), the Lead chip and its live step (one button opens the Lead thread), the time, the PR link with its checks dot (green, red, pulsing amber while checks run, hollow when there are none or none are known), the outside-lane tag, the branch in mono, and the lane actions (Merge, Resume, Stop). Flying is said by the section, never repeated in the tail. Other lane states retain their word and 8px state square. An outside lane replaces the actions with a muted read-only line over a hairline: "Read-only: Squadron didn't start this lane, so it has no Stop, Resume or Merge."

### Compact lane row
At 900px and below, and always in the side panel, the compact row replaces the tail card. Work item lanes use it at every width, without a ticket rail or ticket disclosure. It keeps the band fill and state top edge, with 8px top, 10px side and 26px bottom padding and a 5px row gap. The top line pairs the 2px-cell spec number with a 13.5px title, clamped to two lines, and the tabular lane time. Below it, the Lead chip and live step share one line; the step ellipsizes first. The PR, lane state and actions follow, wrapping as needed. Flying stays in the section header; Stopped, In review and Merge waits on you retain their words. The raw branch is the row's hover title and appears inside All N tickets, rather than taking a line in the header.

### Contrail progress and shared wind
A 16px canvas strip sits 4px above the bottom of the compact row or wide tail, inset 10px or 12px respectively. Progress is the fraction of the lane's tickets In branch or Done. A small 16x10px plane faces right at its head; a 2px solid core and dithered wake fill behind it. A dotted guide marks the distance ahead. The normal-type "N/M in branch" count remains beside the Lead in compact lanes. A stopped lane's bar is red and still; a landed lane's wind is still. During landing the green burst replaces the bar.

Clouds, contrail bars and the wide dependency rail read the board's one working-agent count, summed across working agents in lanes that are neither stopped nor Landed. With no working agents the wind is still. Otherwise speed is 8px/s plus 6px/s per working agent, capped at six agents, all moving right to left. Wide rail text still reports that lane's own working threads. Every canvas follows hidden-page and reduced-motion handling.

### Live step
Flying lanes show the Lead's activity below its chip and each active ticket's activity below its title, in both the full page and side panel. The line uses muted ink, 11px type at 400 and a 1.45 line height. It stays on one line with an ellipsis; the title keeps its two-line allowance. Runtime problems include a word as well as ink: Error uses red ink and Waiting for machine uses amber ink. Elapsed minutes follow the step. With no activity the line says "No recent activity". The board displays a short label from typed work metadata, never tool arguments, output or file bodies. Assistant messages show "Agent message" and their time; their prose is never forwarded. Reads are limited to on-screen Flying lanes while the page is visible, once per 15 seconds per lane plus board-changed updates.

### Slim ticket rows
Narrow lanes show one flat row per Working, In review, Needs you or Stopped ticket. The top line pairs the mono id and a single-line 12.5px title with the 11px state word at the right. Long titles ellipsize and keep their full text on hover. The second line holds the shared live step and the ticket's tabular time. Rows use 6px vertical and 10px horizontal padding, a 2px line gap, an 8px column gap and a bottom hairline, aligned with the compact lane row's inset. Working and In review use sky ink, Needs you uses amber ink and Stopped uses red ink; each keeps its word. Pending owner interactions and failures come from the matched BB thread's current Needs you entry, in both slim rows and wide pegs, without changing the tracker's ticket state. A row with a thread is a native button with the board's focus outline and quiet hover tint. A ticket without a thread stays a plain row. The wide board keeps its sortie pegs.

### Progress strip
One segment per ticket in lane order, up to 40px wide (22px basis), 6px tall, 2px apart, then "N/M in branch" and, at the right, the pace ("2 working" with a sky square). Hollow (1px rule-ink outline) for waiting and ready; sky in 1px stripes for working and review; solid green for in branch and done; amber or red at double height for a question and a failure. The tall segment is the form cue that something on this line is stuck.

### Peg (signature component)
A ticket on the sortie line. Square, ground fill, 190px wide, 1px border at foreground 40%: the id in mono and the state on top, the title in two lines, and for full pegs the AI chip and time at the foot. State is ink plus form:
- **Waiting:** 168px, 6px 8px padding, dashed hairline, muted id and one-line title; the top line's state place reads "after SIZE-n" (its open blockers) in muted mono, or "Waiting" when none are open.
- **Held:** sized like Waiting, on a dotted hairline, muted id and one-line title; state "Held". A hold label keeps the ticket from agents.
- **Ready:** full size, foreground-40% border.
- **Working:** the border becomes a sky dashed line (2px, 6 on and 4 off) running round the edge at 12px/s over a slow sky grain (7% plus drift); state in sky ink.
- **Question:** amber border plus amber outline offset 2px, amber grain at 16%; state "Needs you" in amber ink.
- **In review:** solid sky border, still sky grain at 14%; state reads "Review · model" with the reviewer's chip.
- **In branch / Done:** compact (84px, id and state only), green border (70% for in branch, full for done), still green grain (17% and 24%), state in green ink.
- **Stopped:** 2px red border, red grain at 22%, state in red ink.
Pegs with a thread are buttons that open it beside the board.

### List rows
- **Ready:** plate, title, then "**N** tickets", "N can start" in sky ink when some wait or are held, the routes' AI chips and `accept:owner`; a disclosure "N wait on blockers" lists each waiting ticket and what it waits on, and "N held" lists the held tickets the Lead skips. Start (primary) at the right, with its disabled reason beside it.
- **Shaping:** plate, title, what's missing in amber ink at 600 and the ticket count; Plan tickets or Resume planning (primary).
- **Open issues:** mono id, title, then a meta line of the priority mark, labels and parent context; Plan (plain).
- **Landed:** plate with a still green edge stamp, clean centre and green-ink number, title, then "PR #n merged" for a confirmed merged PR, otherwise "Lane landed", when it landed and how long it flew.

### Linear connection settings
The settings page uses the same ground, ink, type and quiet controls. Workspace names use Title; connection state sits in an announced status region. BB owns the API key's secret input. Which Linear issues a board reads is the repo's Scope in `docs/agents/squadron.md`, not a control on the board.

### Lane moments and quiet hangar
The banner and lane rows read the same observed-state record on each board update. Lifecycle history stays unset until real lane data is known and resets when a different project awaits its first read. Existing lanes on the first read or reload do not replay a takeoff or landing; later real starts still take off. The canvas renderer shares one animation loop, paints visible targets at device-pixel density and stops the loop while the page is hidden. Reduced motion paints each target once at its still moment and disables CSS animation and transitions. These stills retain state; they do not imply live visual acceptance.

- **Takeoff:** a newly observed lane rolls off its stand, then lifts over 1.5s. The roll occupies the first 35% of the moment. Under reduced motion it shows the plane already in the air.
- **Beacon:** a plane with a matching Needs you row is amber with blinking corner brackets on a 2.4s cycle. Its named button goes to that row. Under reduced motion the amber plane and brackets stay lit. A stopped lane keeps its red plane and holding ring, adds the same amber brackets, and keeps its Needs you destination.
- **Holding:** a stopped lane circles in red inside a dotted ellipse, on a 4.5s circuit, while the lane offers Resume. Reduced motion freezes the red plane and ring at the still frame, with steady amber brackets while its Needs you row exists.
- **Landing:** an observed transition to Landed starts the banner's 1.6s glide and roll-back at the same time as the lane's green burst. The glide takes 70% of the moment, then the plane rolls onto its stand. About 110 green pixels sweep the lane; the wide tail number stamps from 1.18x over 520ms. The lane folds over the final 420ms, then arrives in Landed with a 700ms fade and 6px drop. Reduced motion shows the plane at its stand and the lane in green without the burst, scale, fold or arrival animation; the row still moves to Landed after its phase.
- **Landed digit flip:** when the path count changes, only changed digit faces drop in from above over 460ms using `cubic-bezier(0.16, 1, 0.3, 1)`. Digit windows have a 3px gap wide and 2px narrow. Each changed window supplies a 90ms delay per digit place, starting at the units; its animated child face explicitly inherits that delay. Source tests verify the delay on the animation target; live sequential timing remains unproven. The first display and reduced motion show the new number without a flip. The whole count has one screen-reader text copy.
- **Quiet hangar:** once no lane remains on the Flying line, including landing lanes, every stand holds a solid unlit parked plane. The Flying section says "Nothing is flying. Plan the next spec with New spec." and offers New spec; a startable Ready row also supplies a Start button. With no work there is no wind or bobbing. Reduced motion shows the same parked planes and sentence.
- **Fly-past:** after this view has observed Ready or Flying work, a newly observed landing with zero Ready rows and no lane left flying schedules one 3.4s pass as the landing ends. The whole formation crosses left to right in a long V, with twin main-wing contrails reaching 280px wide or 150px narrow, then parks. Unknown Ready data never counts as an empty queue. First reads, reloads and repeated empty reads never trigger a pass. New Ready or Flying work cancels a due or playing pass in the same update and rearms it for the next queue-clearing landing. A stale pass never takes precedence over a live plane or beacon. Reduced motion shows the completed pass with the formation parked, with no fly-past movement.

Working pegs retain their sky march and grain; Needs you retains its 3.6s breathing edge; Landed plates retain a still green stamp. PR checks pulse over 1.6s, switch knobs move over 140ms and hover transitions run 130–140ms. CSS draws no dither and uses no stepped animation.

## Do's and Don'ts

### Do:
- **Do** take every neutral from BB's theme tokens (`--background`, `--foreground`, `--muted-foreground`, `--border`) and derive the band (4.5%), hover (6%) and rule ink (30%) by mixing them.
- **Do** use the `-ink` variant of a state colour for any text or small mark, and the fixed state colour for fills, edges and dither.
- **Do** carry every state twice: ink plus form (march, doubled edge, tall segment, hollow outline, dashed border, size).
- **Do** draw every texture and every moving art through the dither renderer, only where something is happening, with a still frame under reduced motion.
- **Do** use pixel type for spec numbers, SQUADRON, section labels and path counts, with an accessible text copy. Keep other counts, times, actions and prose in UI type or mono.
- **Do** use 2px dots on an 8px pitch between sections, 2px-on/2px-off rules on the path and rails, and 1px hairlines for rows and cards.
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
