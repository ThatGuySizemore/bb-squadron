# Board preview

Renders the live `BoardView` outside BB, for visual checks against the approved comp (`comps/live-board/index.html`). It uses the same fixtures, the comp's real snapshots as live board models, at both widths and in both emulated themes, so the full page and the side panel are checked the same way.

Build it into a folder outside the checkout and serve that folder:

```sh
out="$BB_THREAD_STORAGE/board-preview"
mkdir -p "$out" && cp scripts/board-preview/index.html "$out/"
npx --yes esbuild@0.25 scripts/board-preview/preview.tsx --bundle --format=esm --jsx=automatic \
  --outfile="$out/preview.js" --loader:.css=css
python3 -m http.server 4178 --directory "$out"
```

Then open `http://localhost:4178/?fixture=squadron&theme=dark&width=wide`.

- `fixture`: `squadron` (SIZE-947 flying as an outside lane), `squadron-ready`, `squadron-published`, `bb-bot` (local markdown, outside lane), `empty` (no tracker, Set up), `states` (synthetic live states the comp doesn't show).
- `theme`: `dark` or `light`. `width`: `wide` (the full page) or `narrow` (a 400px side panel, rendered with `placement="panel"` as the thread tab renders it).
- `picker=open` opens the project picker. `land=SIZE-947` lands that lane after two seconds, to show the burst and the row arriving in Landed.

Reduced motion follows the browser's `prefers-reduced-motion` setting.
