# SIZE-948 comp: the live dithered board

A working HTML comp of the redesigned Squadron board, proposed for the owner's approval on SIZE-948. It has no build step and no dependencies.

Open it from this checkout:

```sh
open comps/live-board/index.html
```

Or open `comps/live-board/index.html` in any browser as a file. The bar at the top is the comp's, not the board's. Use it to switch:

- **Project:** BB Squadron (Linear), bb-bot (local markdown, an outside lane flying) and bb Bot (empty, Set up).
- **Moment** (BB Squadron only): three real points on SIZE-947's path, from Shaping to Ready to Flying.
- **Layout:** full page, side panel, or both side by side (about 1500px wide).
- **Theme**, and **Motion** (Live, or Reduced to see the still frames).
- **Replay SIZE-939's landing** plays the one-time landing burst.

The URL keeps your choices, for example `index.html?project=bb-bot&layout=both&motion=reduced`. "Where the comp's data comes from", under the board, names the source of every value.
