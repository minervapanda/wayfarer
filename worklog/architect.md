# Architect — Work Log

## 2026-07-11 — Scaffold complete

- Wrote **ARCHITECTURE.md** (the law): Entry/BlobRec/meta data model, the six bus
  events with payload shapes, full public API for all 13 modules, complete
  index.html element-ID inventory with behavior ownership, theming axes
  (`data-app-theme` paper themes × `data-theme` light/dark scene), and the
  exclusive file-ownership map for the five builders.
- Core modules (architect-owned, frozen): `js/state.js` (app snapshot + EventTarget
  bus with per-event off()), `js/store.js` (IndexedDB `wayfarer` v1 — entries/blobs/meta,
  dirty tracking for sync, allForExport/importData, in-memory fallback + toast for
  Safari private mode), `js/util.js` (esc, uid, fmtDate, debounce, cached blobUrl/
  revokeAll, toast into #toast-root, confirmDialog on #confirm-modal — no native dialogs).
- **index.html** shell: all contracted IDs present, 📖 inline-SVG favicon, native
  `<dialog>` compose + confirm modals, login gate, header with view toggle /
  theme swatches / sync pill / overflow menu, noscript + boot-splash states.
  All links strictly `./relative` (GitHub Pages subpath safe).
- **css/base.css**: full token set (--paper/--ink/--accent/--tape/--shadow/--grain…),
  three v1 themes ported as `[data-app-theme]` overrides, serif/script/system font
  stacks, warm-linen/deep-walnut scene via prefers-color-scheme + `[data-theme]`
  overrides (paper stays cream), feTurbulence paper grain, focus-visible ring,
  reduced-motion zeroes durations. **css/app.css**: header, gate, writing-desk
  compose sheet, confirm, toasts, responsive down to 360px, 44px targets.
- **js/main.js**: boot chain (initDB → entries → theme → dynamic auth → views →
  sync/exporter → wiring) plus the complete compose controller: drop/pick →
  ingestFiles thumbnails with remove, EXIF date + reverseGeocode location prefill
  ('Location from photo' / 'Add location', never an error), dictation + voice
  recorder mounts, ≥1-photo-or-story validation, save/edit/soft-delete with
  confirmDialog, blob lifecycle (persist on save, delete removed, replace voice).
- Stubs with exact contract signatures as graceful no-ops: book, exif, ingest
  (pass-through so photos work pre-builder), geocode, voice (disabled states),
  auth (local mode: hides gate, emits auth-changed), sync (Local pill), journal,
  narratives, exporter (friendly toasts), demo + minimal css/book|voice|journal.css.
- Drafted `supabase/schema.sql` (entries table + private wayfarer-media bucket,
  owner-only RLS, `<uid>/<blobId>` key convention) and `SETUP.md` for Builder 4;
  `config.js` (empty = local mode), `README.md`, `.gitignore`.
- Verified: `node --check` passes on all 16 JS files (as ES modules); ID audit —
  every contracted ID exists; zero absolute URLs; zero alert/confirm/prompt.
