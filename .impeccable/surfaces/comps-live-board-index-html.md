---
version: 1
slug: "comps-live-board-index-html"
primary_target: "comps/live-board/index.html"
related_targets: ["comps/live-board/board.js","comps/live-board/dither.js","comps/live-board/comp.css","comps/live-board/data.js"]
---

# Surface brief: SIZE-948 comp, the live dithered board

Scope: a standalone HTML comp of the redesigned Squadron board (`comps/live-board/index.html`), proposed for the owner's approval on SIZE-948. Visitor mode: Operate. It is the look SIZE-956, 958 and 959 build to once approved; until then `app.tsx` keeps DESIGN.md's in-force system.

Audience and job: the owner, glancing between threads, in a full page or a thread's side panel. First answer: what needs me, what is moving, and where every spec sits on the path.

Content: real snapshots of BB Squadron (Linear; three moments of SIZE-947's own path), bb-bot (local markdown; its outside lane flying, ticket states from integration-branch merges) and bb Bot (empty; Set up). Comp-only controls sit outside the board in a labelled bar.

Constraints: BB theme tokens for neutrals (emulated light and dark); four state inks; no web fonts; canvas dither at device-pixel density; reduced motion draws still frames; state never by colour or motion alone.

## Direction contract

THESIS: The sortie board, now live: every spec sits on one path (Open issues, Shaping, Ready, Flying, Landed) and each Flying lane is a sortie line with air moving along it. It refuses the kanban of state columns and the dashboard of count tiles; the path reads as a route, not a grid.

OWN-WORLD: BB's ground and ink. Ordered Bayer 8x8 dither drawn per device pixel on canvas as the only texture, so fills read as fine halftone grain, not blocks. Four inks: amber #F2A900 owner, sky #3FA7D6 working, red #D7263D stopped, green #2FA36B landed. 5x7 pixel-cell tail numbers; BB's UI font; mono ids; 1px hairlines, 2px pixel rules, square marks, 2px controls, no shadows.

STORY: The owner sees the whole path in one strip, then what waits on him, then each lane flowing at the pace of its working threads, and presses the one button that moves a row on.

FIRST VIEWPORT: Header: formation mark (the fleet across projects), "Squadron", project picker with tracker and counts, Doctor status, New spec. Under it the path strip of five stations with counts. Then Needs you, then Flying sortie lines with the airstream behind the pegs.

FORM: The Ready-Room Sortie Board, made live; the incumbent world (position 1 of the earlier round), extended by the spec's pinned look. seed: none (unavailable)
Signature move: the sortie line's dithered airstream, its speed and density set by how many threads are working; the landing burst sweeps it green once.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
