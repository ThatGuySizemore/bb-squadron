---
name: BB Squadron
description: A ready-room sortie board in dithered pixels, drawn on BB's own theme.
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
  peg-slim:
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
---

# Design System: BB Squadron

## Overview

**Creative North Star: "The Ready-Room Sortie Board"**

The board is a squadron ready room's sortie board drawn inside BB. Each lane is one ruled line; its tickets sit on that line as pegs in dependency order, left to right, with small pixel chevrons between columns. Status has to read from across the room: what waits on the owner sits pinned at the top in amber, and what is flying shows how far along it is by how many pegs have gone green.

The material is BB's own theme. The ground, ink, muted ink and hairlines are BB's theme tokens, so the board works on any BB theme, light or dark. The only texture is ordered dither: Bayer 4x4 halftone masks cut from 2px cells. The only display type is a 5x7 pixel cell font for spec numbers, used like tail numbers on an airframe. Four state inks sit on top of the theme, and each state is also carried by form (a marching border, a doubled edge, a tall segment, a hollow outline), never by colour alone.

Motion is stepped, never eased, except for one moment: the landing burst. Working pegs march their border and cycle their dither, the Needs-you strip pulses slowly, a stopped peg glitches once, and a landed tail number stamps green while pixels sweep down its line. Under reduced motion all of it becomes one still dither layer.

**Key Characteristics:**
- BB theme tokens for every neutral; four fixed state inks layered on top.
- Bayer 4x4 ordered dither (`--sq-d0` … `--sq-d16`, 8px tiles of 2px cells) is the only texture.
- A 5x7 pixel cell font for spec numbers only; BB's UI font for everything else.
- Square board marks, 1px hairlines, 2px pixel rules (2px on, 2px off); no shadows.
- Every state is ink plus form; every animation has a still pixel fallback.

## Colors

The theme supplies the neutrals; four state inks supply the meaning.

### Primary
- **Needs-You Amber** (needs-you-amber): the one colour that means "the owner". It fills the Needs-you count, kind tags and the Merge and Answer buttons, edges the Needs-you rows and question pegs with a doubled line, tops the tail card of a lane whose merge waits on the owner, and tints text selection at 38%. Text on solid amber is always **On-Amber** (on-amber), never white.

### Secondary
- **Working Sky** (working-sky): an agent is on it. Fills working and review progress segments through a 50% dither mask, marches around working pegs, edges review pegs, fills the formation mark's flying chevrons and the auto-start switch when on. Sky ink (sky-ink) is also the focus outline.

### Tertiary
- **Stopped Red** (stopped-red): failed or stopped. Doubles the failed peg's border to 2px, raises its progress segment to full height, tops a stopped lane's tail card, and colours the urgent-priority mark and failing-checks dot.
- **Landed Green** (landed-green): in the integration branch or merged. Fills branch and done segments solid, edges compact branch pegs, dithers behind landed spec numbers at level 3, and is the colour of the landing burst and stamp.

### Neutral
- **Board Ground** (board-ground): BB's `--background`. Page, pegs, buttons and Needs-you rows all sit on it.
- **Board Ink** (board-ink): BB's `--foreground`. Body text, spec numbers at rest, the primary button fill, and the base every `-ink` variant mixes toward.
- **Muted Ink** (muted-ink): BB's `--muted-foreground`. Section labels, counts, meta lines, branch names, waiting pegs.
- **Hairline** (hairline): BB's `--border`. Every 1px row rule, peg border and button border.
- **Band** (band): foreground at 4.5% over the ground. The one tonal step: the tail card behind each lane and the plate behind spec numbers in lists.
- **Rule Ink** (rule-ink): foreground at 30%. The 2px-on, 2px-off pixel rule under section labels and along each sortie line, and hollow progress segments.

### Named Rules

**The Theme-Owns-Neutrals Rule.** No neutral is ever a literal value. Ground, ink, muted ink and hairline are BB's tokens; the band and rule ink are mixes of them. The board must look right on any BB theme without a single override.

**The Ink-Toward-Foreground Rule.** State colours as fills stay fixed; state colours as text or marks use their `-ink` variant, mixed in OKLab toward the theme foreground (amber 46%, sky 50%, red 62%, green 52%), so labels stay legible on light and dark grounds.

**The Four-Inks Rule.** Amber means the owner, sky means an agent is working, red means stopped, green means in the branch or landed. No fifth hue, and no ink used for decoration.

## Typography

**Display Font:** a 5x7 pixel cell font drawn as SVG rects (lib/pixels.ts), with a screen-reader copy of the text.
**Body Font:** BB's inherited UI font; the board sets no family of its own.
**Label/Mono Font:** the system monospace stack, for ticket ids, branch names and issue ids.

**Character:** a crisp, built-from-cells display set against BB's plain UI type, so the spec numbers look painted on and everything else reads like the rest of BB.

### Hierarchy
- **Display** (pixel cells: 4px cells on a 5px pitch, 34px tall, in lane tails; 2px cells with no gap, 14px tall, in Needs-you, Ready and Landed lists): spec numbers only. Ink follows lane state: board ink, red ink when stopped, amber ink when the merge waits, green ink when landed.
- **Headline** (650, 22px, 1.15, -0.02em): the page title "Squadron", once.
- **Title** (620, 14px, 1.3, balanced wrap): the spec title in each tail card. Ready-row titles step down to 600 at 13.5px.
- **Body** (400, 13px, 1.45): Needs-you text, empty-state lines, Unplanned rows, header counts.
- **Body small** (400, 12.5px, 1.3, clamped to two lines): peg titles.
- **Label** (650, 12px, 0.08em, uppercase): the section headings Needs you, Flying, Ready, Unplanned, Landed, each sitting on a pixel rule. The Needs-you kind tag uses the same voice at 700, 11px, 0.04em on solid amber.
- **Meta** (600, 11px): button text (12px), peg state, tags, AI chips, counts.
- **Mono** (650, 11px, tabular figures): ticket ids on pegs; branch names and Unplanned ids at 400 in muted ink.

### Named Rules

**The Tail-Number Rule.** The pixel font is for spec numbers and nothing else. Prose, buttons and ticket ids stay in BB's UI font or mono; a second display face is never added.

**The Tabular Rule.** Every count, duration and id that can change while the owner watches uses tabular figures, so the line does not jitter as numbers tick.

## Layout

One centred column (max 1480px) with 22px top and 28px side padding, sections 30px apart, each opened by an uppercase label on a 2px pixel rule. Order is fixed by the product: header and Linear status line, Needs you, Flying, Ready, Unplanned, then Landed when any lane has landed. The synthetic demo adds its labelled footer behind a dashed hairline. Doctor is a header utility whose open checks sit in the page flow after Needs you, before Flying.

A sortie line is a two-column grid: a tail card (200–236px) and a track, 20px apart, 16px of vertical padding, closed by a 1px hairline. The track holds a progress strip (one segment per ticket, max 40px each, 2px apart, then a count) above a horizontally scrolling rail of dependency columns. The pixel rule runs through the rail's vertical centre and scrolls with the pegs; columns are joined by 6x10 pixel chevrons with 7px side margins, and pegs in one column stack 8px apart.

List rows (Ready, Unplanned, Landed) are grids on 1px hairlines with 11px, 7px and 9px vertical padding respectively; spec numbers in lists sit on a band plate (6px 8px padding).

The board is a container (`container-type: inline-size`) and responds to its own width, not the window. At 900px and below the header stacks, the sortie line becomes one column with the tail card laid out as a wrapping row, Ready rows wrap with routes and ticket counts hidden, and Needs-you rows drop the spec number and put actions on their own line.

## Elevation & Depth

The board is flat: there are no shadows anywhere. Depth comes from three things only: the band (one 4.5% tonal step) behind tail cards and number plates, doubled edges (a 1px border plus a 1px outline offset 2px) on anything amber, and dither layers stacked inside a mark's own box. The one inset `box-shadow` in the code draws the 1px hollow outline of an empty progress segment; it is a stroke, not elevation.

### Named Rules

**The Flat-Board Rule.** Nothing floats. Emphasis comes from a doubled edge, a heavier border or a denser dither, never from a shadow or a lift on hover.

## Shapes

Board marks are square: pegs, tail cards, Needs-you rows, number plates, progress segments and state squares have no radius (0px). Controls are almost square: buttons and tags round to 2px, the switch track to 1px. Borders are 1px hairlines at rest and 2px for the failed peg and the tail card's top edge. Every pixel mark (chevrons, formation mark, burst bits, dither cells, pixel rule) is built on a 2px cell and rendered with crisp edges. Blocked pegs use a dashed border; the synthetic-data footer sits behind a dashed hairline.

## Components

### Buttons
Small, quiet, near-square; colour only when the owner is the one acting.
- **Shape:** near-square (2px), 28px tall, 0 11px padding, 12px at 600.
- **Plain:** ground fill, hairline border. Hover tints the fill to foreground 6%.
- **Primary** (Plan a spec, Start, Resume in a tail card): solid board ink with ground text. Hover mixes it 86% toward the ground.
- **Amber** (Merge, Answer in thread, Resume in Needs you): solid amber with on-amber text. Only for actions the owner alone can take.
- **Danger** (Cancel): transparent, red-ink text, border red at 45% over the hairline; set 14px apart from the other lane actions. Hover tints red at 9%.
- **Focus:** a 2px sky-ink outline, offset 2px, on every focusable element.
- **Disabled:** 42% opacity, not-allowed cursor; the reason sits beside the button as muted text.

### Chips
- **Tag:** 11px at 600, 1px 6px padding, hairline border, 2px corners; used for issue labels and `accept:owner`. The amber tag (solid amber, on-amber text) marks "Synthetic data".
- **AI chip:** the provider's own icon at 12px, then model name and effort in muted ink, 11px. A Lead chip prefixes "Lead ·". A review peg with a saved reviewer prefixes "Reviewer ·" and shows that reviewer's saved route.
- **Count:** solid amber, on-amber 11px, 0 6px padding, beside the Needs-you label only when something needs the owner.

### Cards / Containers
- **Tail card:** the lane's plate. Band fill, 2px top edge in hairline that turns red (stopped), amber (merge waits) or green (landed); 11px 12px 10px padding. Holds the pixel spec number, title, Lead chip, lane state with an 8px state square, time, PR link with checks dot, branch name in mono and the lane actions.
- **Needs-you row:** ground fill, 1px amber border plus a 1px amber outline offset 2px, a three-layer amber dither (levels 3, 6, 3) at 18–20% pulsing on a 3.6s step cycle. Kind tag, pixel spec number, one line of text, one or two actions. Rows stack 12px apart.

### Navigation
The board is a single BB nav page; it adds no navigation of its own. Every peg, Lead chip and PR link opens where the thing lives (thread beside the board, Linear issue or GitHub PR).

### Live board controls

The live Linear board is the default. The demo switch opts into the existing simulation and shows the amber "Synthetic data" tag. Live Start opens a routed Lead in its integration worktree; the Ready row moves to Flying. The existing lane controls keep their recorded forms as the remaining lane actions are connected.

- **Live Start:** the existing primary button becomes available when the current mirror has an unblocked spec with a frontier and a lane slot. A held Start stays disabled with its reason beside it. During its request the button reads "Starting…" and stays disabled. The server rechecks Doctor, blockers and capacity; a refusal appears in a toast and refreshes the board. A successful response opens the Lead beside the board. A response that is still provisioning opens that Lead and explains that its slot stays reserved.
- **Auto-start:** the header's existing square switch also appears on the live board, labelled "Auto-start ready specs". It defaults off and shows the saved setting for the current BB project. The switch keeps its sky fill, stepped knob and reduced-motion fallback. While saving it stays disabled with an announced "Saving auto-start" message; it also stays disabled until the board loads. The saved value comes from a fresh board read. A save refusal appears in a toast and refreshes the board. Turning it off stops future automatic launches; current lanes continue.
- **Flying Lead:** the existing Lead chip opens the confirmed thread beside the board, with the integration branch in Mono below it. While BB prepares the worktree, that line reads "Preparing integration branch". An ambiguous spawn remains visible as a stopped lane and in Needs you, with "Lead not confirmed" as plain muted text in place of the Lead control. It has no invented thread link; its reason tells the owner to check BB threads while the slot remains reserved.
- **Lane write refusal:** if the branch is ready but the Helper cannot queue its status or signed comment, the Lead stays active. A Write row in Needs you names the refused operation and opens the Lead. It does not claim delivery or offer a receipt retry for a write that was never queued. Queued writes continue to use the outbox's receipt and pending-count controls below.

- **Linear status line:** a wrapping line under the header in 12px muted ink. The bound "Team · Project" uses board ink at 600; a failed read uses red ink. It shows connection, binding, catch-up or current state and the time of the last read. Pending-write counts use tabular figures.
- **Setup and blocked-write rows:** the existing amber Needs-you row and kind tag. Setup offers connection or binding controls. A blocked write names its issue in the Mono token, explains the safe reason, shows "Receipt" with the stable ID in Mono, and offers Retry and a link to its originating thread when present. A capped list says when more writes await recovery. A write's issue can be a ticket, so it never uses pixel type.
- **Issue-title links:** Ready and Unplanned titles are plain text at rest, underlined on hover with a 3px underline offset and a 1px rule-ink underline. They retain the global 2px sky focus outline. Ready titles are 13.5px at 600; Unplanned titles are 13px. Unplanned parent context wraps beside the title in 12px muted ink and leaves the Linear parent unchanged.
- **Binding picker:** native team and project selects, 28px high, 2px corners, ground fill and hairline border, 12px at 600, maximum width 220px. Controls wrap with 6px gaps. Disabled controls use 42% opacity. Progress is muted text; errors wrap on their own line in red ink. The global sky focus outline applies.
- **Ticket route:** before work starts, Ready and Waiting pegs offer a native model/effort select in their foot. It reuses the binding picker's 28px height, ground fill, hairline, 2px corners, 600 weight and sky focus outline, with 11px text and 4px inline padding to fit the peg. Saving disables the select and inserts "Saving route…" in a persistent status region; an empty status region remains in the accessibility tree while visually clipped. Errors appear in a toast and refresh the board. Once a worker is reserved, the select is replaced by its fixed route chip and the card opens the linked worker.
- **Doctor:** a quiet header button with `aria-expanded` and `aria-controls`. Open checks occupy a full-width, flat region after Needs you, with 12px padding and a hairline border. Each row shows the check name, a Pass or Fix tag and a plain explanation. Fix tags have dashed borders; their text uses board ink. At 650px the explanation moves below the name and tag. Loading and error text and Check again use the existing body and button styles. No popover, shadow or header restyling.

### Linear connection settings

The settings page uses the same ground, ink, type and quiet controls. Workspace names use Title; connection state sits in an announced status region. Actions wrap with 8px gaps. OAuth setup is a native disclosure with a wrapping callback URL in Mono, including its 650 weight and tabular figures. BB owns the secret-setting inputs; the page receives only public identity and setup readiness.

### Peg (signature component)
A ticket on the sortie line. Square, ground fill, 1px hairline, 190px wide with id and state on top, title (two lines), and AI chip and time at the foot. State is ink plus form:
- **Waiting:** slim (168px, one-line title, no foot unless the ticket still offers its route select), dashed border, muted id and title, "after SQD-n" in mono.
- **Ready:** full size, border at foreground 40%, state in board ink.
- **Working:** border replaced by a sky 2px-dash march (6px period) that steps round the edge every 600ms; inside, sky dither at levels 2, 3, 5 cycles every 2.4s.
- **Needs you:** amber border plus amber outline offset 2px (the doubled edge), amber dither 2, 4, 6, 4 cycling.
- **In review:** solid 1px sky border, still sky dither at level 2 (32%). A saved reviewer sets the state label to "Starting review", "In review", "Second look", "Fixes requested", "Awaiting second look", "Approved" or "Review unconfirmed" and supplies the reviewer's AI chip. The peg opens the saved reviewer thread when present; without that thread it has no navigation button. Its accessible name includes the saved family, model and effort. Before a saved reviewer exists, a worker's done report uses "Reported done", the worker's chip and its worker-thread link when present, with the same review border and dither. Never infer a reviewer from the worker's route.
- **In branch / Done:** compact (84px, id and state only), green border (70% for in branch, full for done), still green dither at 22%.
- **Stopped:** 2px red border, red dither at level 4 (26%), and one 460ms stepped glitch (horizontal shifts and slice clips) when it fails.

### Progress strip
One segment per ticket in lane order, 6px tall. Hollow (1px rule-ink outline) for waiting and ready; sky through a 50% dither for working and review; solid green for in branch and done; amber or red at double height (12px) for needs you and stopped. The tall segment is the form cue that something on this line is stuck.

### Formation mark
Three pixel chevrons in a V beside the page title, one per lane slot; flying slots fill sky, empty slots fill hairline. It carries an accessible label ("2 of 3 lanes flying").

### Motion
All motion is stepped except the burst: border march 600ms `steps(3)`, dither cycle 2.4s `steps(1)`, Needs-you pulse 3.6s, PR-checks-pending blink 1s `steps(1)`, failed glitch 460ms `steps(1)` once, landed stamp 420ms `steps(3)` from 1.3x scale, switch knob 160ms `steps(3)`, and the landing burst: 28 green pixels (2px and 4px) sweeping 120–880px along the line over 950ms `cubic-bezier(0.16, 1, 0.3, 1)`, staggered by 35ms. Hover transitions are 120–140ms. Under `prefers-reduced-motion` every animation and transition is removed, only the first dither layer shows (at 40%), and the burst and the Ready-row hover dither are hidden.

## Do's and Don'ts

### Do:
- **Do** take every neutral from BB's theme tokens (`--background`, `--foreground`, `--muted-foreground`, `--border`) and derive the band (4.5%) and rule ink (30%) by mixing them.
- **Do** use the `-ink` variant of a state colour for any text or small mark, and the fixed state colour for fills, edges and dither.
- **Do** carry every state twice: ink plus form (march, doubled edge, tall segment, hollow outline, dashed border, size).
- **Do** cut every texture from the Bayer 4x4 masks `--sq-d0` … `--sq-d16` on an 8px tile of 2px cells.
- **Do** set spec numbers in the 5x7 pixel cell font (cell 4 in lane tails, cell 2 in lists), always with a screen-reader copy.
- **Do** use 2px-on, 2px-off pixel rules for section rules and sortie lines, and 1px hairlines for rows and cards.
- **Do** step animations (`steps()`), and give each one a still dither fallback under reduced motion.
- **Do** keep amber for what waits on the owner and the actions only he can take.

### Don't:
- **Don't** add a shadow or lift to any surface; the board is flat.
- **Don't** round board marks; pegs, cards, rows and segments stay at 0px, controls at 2px.
- **Don't** show a state by colour alone, or by motion alone.
- **Don't** introduce a neutral as a literal hex or a fifth state hue.
- **Don't** use the pixel font for prose, buttons or ticket ids, and don't load a web font.
- **Don't** put white text on amber; use on-amber.
