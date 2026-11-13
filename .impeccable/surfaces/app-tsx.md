---
version: 1
slug: "app-tsx"
primary_target: "app.tsx"
related_targets: []
---

# Surface brief: Squadron board

Scope: the Squadron nav page in BB (`app.tsx`, route `/plugins/squadron/board`). Visitor mode: Operate.

Audience and job: the owner, glancing between other work. First answer: what needs me, then what is flying. Primary actions: open a thread, issue or PR; Start / Stop / Resume / Merge a lane; Plan an unplanned issue.

Content: specs (Linear parent issues) with 3-10 tickets each; 0-3 lanes flying; 0-6 needs-you items; 0-30 unplanned issues. Prototype data is synthetic and labelled so.

States: ticket — waiting (blocked), ready, working, needs you, in review, merged into branch, done, failed. Lane — ready, flying, stopped, PR open, waiting on owner merge, merged.

Constraints: BB theme tokens only for neutrals (light and dark); state inks layered on top; no external fonts; reduced motion turns every animation into a still pixel pattern; state never by colour alone.

## Direction contract

THESIS: The board is the squadron ready-room's sortie board: one ruled line per lane, tickets as pegs moving along it, status that reads from across the room. It refuses the category default of status columns of flat cards (a kanban), because a lane's tickets move in dependency order, not between columns.

OWN-WORLD: BB's theme ground and ink as the board face. Low-vis grey bands with ordered-dither (Bayer 4x4) halftone fills as the only texture. Stencil-cut numerals for spec numbers (tail numbers) built on a 4px pixel grid. State inks: amber #F2A900 needs you, sky #3FA7D6 working, red #D7263D failed, green #2FA36B merged. Hairline rules, small chevrons as direction marks, a tiny formation mark of lane count. Square corners, 1px or 2px borders, no shadows, no gradients.

STORY: The owner sees in one glance what waits on him (amber row pinned on top), which lanes are flying and how far along (pegs filled left to right), and can jump to any thread, issue or PR from the peg. He believes the factory is moving because the pegs visibly move.

FIRST VIEWPORT: Top: page title "Squadron" with the formation mark and lane counts, and a Plan button. Then the NEEDS YOU strip: amber-edged rows, each one line with the item, its lane number and one action. Then FLYING: one sortie line per active lane: big stencil tail number left (e.g. SIZE-412), spec title and Lead chip, progress pegs across the middle in dependency order (each peg a small card: ticket id, short title, AI chip, state), PR chip with checks and time right. Below the fold: READY (specs waiting to start), then UNPLANNED with Plan buttons.

FORM: Ready-Room Sortie Board, my top-ranked grounded candidate (position 1), taken as Impeccable's pick. seed:11445e314baa87a5
Signature move: the working peg's border marches in dithered pixels and its fill shimmers through the dither ramp; a merge rolls a pixel burst along the sortie line and the tail number stamps green.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
