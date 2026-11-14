---
version: 1
slug: "app-tsx"
primary_target: "app.tsx"
related_targets: ["board/Board.tsx", "board/board.css", "board/Doctor.tsx", "board/doctor.css", "board/ConnectionSettings.tsx", "board/connection.css"]
---

# Surface brief: Squadron board

Scope: the Squadron nav page in BB (`app.tsx`, route `/plugins/squadron/board`). Visitor mode: Operate.

Audience and job: the owner, glancing between other work. First answer: what needs me, then what is flying. Current live actions: connect Linear, open an issue or planning thread, Plan an open issue, retry a blocked write and check Doctor. Start stays disabled with its reason in Spec A. The demo retains simulated Start / Stop / Resume / Merge controls.

Content: the real open issues in the repo's Linear Scope (docs/agents/squadron.md) from the Linear mirror, grouped as Ready specs with their tickets' open blockers and Open issues with any parent context. Live is the default. The optional demo is synthetic and labelled "Synthetic data". The existing 3-10 tickets per spec, 0-3 flying lanes, 0-6 needs-you items and 0-30 open issues describe the demo, not live data limits.

Live states: disconnected, unscoped, catching up, current and failed. Setup and blocked writes join questions, stopped lanes and owner merges in Needs you. Linear status sits below the header; the scope is set in the repo, not on the board. Issue-title links and receipts follow DESIGN.md's live-board controls. Doctor stays in the header and expands into a flat region after Needs you. Connection settings use the same tokens, native disclosure and Mono callback URL.

States: ticket — waiting (blocked), ready, working, needs you, in review, merged into branch, done, failed. Lane — ready, flying, stopped, PR open, waiting on owner merge, merged.

Constraints: BB theme tokens only for neutrals (light and dark); state inks layered on top; no external fonts; reduced motion turns every animation into a still pixel pattern; state never by colour alone.

## Direction contract

THESIS: The board is the squadron ready-room's sortie board: one ruled line per lane, tickets as pegs moving along it, status that reads from across the room. It refuses the category default of status columns of flat cards (a kanban), because a lane's tickets move in dependency order, not between columns.

OWN-WORLD: BB's theme ground and ink as the board face. Low-vis grey bands with ordered-dither (Bayer 4x4) halftone fills as the only texture. Stencil-cut numerals for spec numbers (tail numbers) built on a 4px pixel grid. State inks: amber #F2A900 needs you, sky #3FA7D6 working, red #D7263D failed, green #2FA36B merged. Hairline rules, small chevrons as direction marks, a tiny formation mark of lane count. Square corners, 1px or 2px borders, no shadows, no gradients.

STORY: The owner sees in one glance what waits on him (amber row pinned on top), which lanes are flying and how far along (pegs filled left to right), and can jump to any thread, issue or PR from the peg. He believes the factory is moving because the pegs visibly move.

FIRST VIEWPORT: Top: page title "Squadron" with the formation mark and lane counts, and a Plan button. Then the NEEDS YOU strip: amber-edged rows, each one line with the item, its lane number and one action. Then FLYING: one sortie line per active lane: big stencil tail number left (e.g. SIZE-412), spec title and Lead chip, progress pegs across the middle in dependency order (each peg a small card: ticket id, short title, AI chip, state), PR chip with checks and time right. Below the fold: READY (specs waiting to start), then OPEN ISSUES with Plan buttons.

FORM: Ready-Room Sortie Board, my top-ranked grounded candidate (position 1), taken as Impeccable's pick. seed:11445e314baa87a5
Signature move: the working peg's border marches in dithered pixels and its fill shimmers through the dither ramp; a merge rolls a pixel burst along the sortie line and the tail number stamps green.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
