# Builder 4 (backend) — requests for other owners

## 2026-07-11

1. **store.js: meta accessors for the sync watermark (architect).**
   ARCHITECTURE.md marks the `meta` store as internal to store.js, but the sync
   spec keeps its pull watermark in idb meta. Interim solution: sync.js opens
   its own connection to the `wayfarer` DB (same version, byte-identical
   upgrade routine, key `sync:watermark:<uid>` — no collision with `dirty:*`),
   with localStorage/in-memory fallbacks. Losing the watermark is always safe
   (full re-pull, LWW converges). Cleaner long-term:
   `export async function getMeta(id)` / `setMeta(id, value)` in store.js —
   sync.js will switch over as soon as they exist.

2. **index.html / css/app.css: 'Continue offline' gate button (architect, optional).**
   The spec's escape hatch isn't in the frozen gate markup, so auth.js injects
   it at runtime (`.gate-offline` wrapper + `.btn.btn-ghost`, minimal inline
   layout styles using `--line` token). Works fine; a static button +
   `.gate-offline` rules in app.css would be tidier if index.html ever reopens.

3. **css/app.css: sync pill state styling (architect, optional).**
   sync.js sets `data-state="local|syncing|synced|offline|error"` on
   `#sync-status` and appends a small `.sync-retry` button in the error state.
   Everything is functional unstyled; tinting per state (e.g. `--stamp` for
   synced, warm warning tone for offline/error) would be a nice polish pass.
