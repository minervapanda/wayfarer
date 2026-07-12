# Integration pass — making the app work end-to-end

## 2026-07-12 — Integrator

### Audits run (all clean unless noted)

- `node --check` on all 15 `js/*.js` + `config.js` — no syntax errors.
- Import graph: every relative import resolves to a real file, and every named
  import matches a real export (verified mechanically). The auth.js ⇄ sync.js
  circular import is safe — only function bindings, no top-level calls.
- Every `getElementById` / `$()` target used in JS exists in `index.html`
  (compose-*, login-*, btn-*, sync-status, osm-attribution, toast-root,
  confirm-*, view-toggle, theme-picker, book-root, journal-root, import-json-input).
  No missing IDs; nothing had to be added.
- Bus events are consistent and confined to the ARCHITECTURE.md list:
  `entries-changed` (emit ×6 / on ×4), `view-changed` (1/2), `auth-changed`
  (1/1), `compose-open` (4/1), `compose-close` (1/0 — contract allows),
  `toast` (3/1). No invented event names, no spelling drift.
- No `alert()`/`confirm()`/`prompt()`, no absolute (`/...`) URLs anywhere,
  the only network hosts referenced are Nominatim and esm.sh (Supabase,
  config-gated). The one `innerHTML` use (journal SVG map) passes all user
  strings through `esc()`.
- CSS braces balanced in all five sheets; JS-generated class names
  cross-checked against css — remaining gaps are unstyled cosmetic wrappers
  only (`jr-main`, `vr-player`, `vp-sep`, …), all functional.
- Static-serve check: `python3 -m http.server 8123`, curled `index.html` +
  all 5 css + all 15 js paths — **22/22 → HTTP 200**, no 404 assets.

### Fixes applied

1. **css/base.css — `[hidden] { display: none !important; }` guard (CRITICAL).**
   Author display rules (`#login-gate { display:flex }`, `.btn { display:inline-flex }`)
   override the UA stylesheet's `[hidden]` rule, so in local mode the login
   gate stayed fullscreen over the app forever, and `#btn-signout`,
   `#compose-delete`, and the journal lightbox nav ignored `hidden`.
   This resolves the request in `worklog/book-needs.md` (2026-07-12) globally
   rather than per-element. Boot flow (a) — empty config → gate hidden →
   book empty state — now works.

2. **js/book.js — stop revoking shared blob object URLs on re-render.**
   `blobUrl()` in util.js is a shared one-URL-per-blob-id cache also used by
   journal.js. Book's `releaseUsedBlobs()` on every render revoked URLs that
   the (hidden, already-rendered) journal was still pointing at → switching
   book → journal after an edit showed broken photos. Removed the
   `usedBlobIds` / `releaseUsedBlobs` machinery; `util.revokeAll()` on
   pagehide remains the cleanup path (cache is bounded: one URL per blob).

3. **js/main.js — compose photo removal vs. shared URLs.**
   `removePhoto()` revoked the cached URL even for already-persisted photos;
   cancelling the edit then left the book/journal behind the modal pointing
   at a dead URL. Now: unsaved previews are revoked on remove; persisted
   photos defer revocation to `saveCompose()`, right after their blobs are
   actually deleted (`deleteBlob` + `releaseBlobUrl`), and
   `removedPersistedIds` is cleared after processing.

### Flow traces (read end-to-end, post-fix)

- **(a) Local boot:** initDB → cache → initAuth (empty config → local mode,
  gate hidden, `auth-changed {mode:'local'}`) → initBook/initJournal →
  initSync ('Local' pill) → initExporter → splash removed, `#app` shown,
  `view-changed {book}` → book renders empty-state spread with
  "Start your first memory" (emits `compose-open`) + demo button. ✓
- **(b) Compose:** drop/pick → `ingestFiles` (EXIF off original bytes,
  1600px/q0.8 downscale, orientation handled) → date + GPS prefill →
  `reverseGeocode` (rate-limited, cached, offline→null, never blocks save) →
  dictation via `initDictation` (unsupported/denied states in status line) →
  voice via `createVoiceRecorder` → save validates ≥1 photo or story →
  `putBlob`s → `saveEntry` → `entries-changed {save}` → book/journal re-render. ✓
- **(c) Demo:** header button (main.js, dynamic import) and both empty-state
  buttons → `loadDemo()` paints 12 canvas postcards offline, deterministic
  ids guard re-runs → `entries-changed {demo}` → 4 entries in book (cover,
  TOC, 4 entry faces, closing) and journal (stats, SVG map with 4 pins,
  4 chapters — Kyoto & Marrakech hit curated narratives). ✓
- **(d) Export:** JSON → `allForExport` with blobs as dataURLs, downloads;
  empty diary → info toast. HTML → self-contained flipbook (photos/audio
  baked in, textContent-only renderer, `<` escaped in embedded JSON).
  Import → hidden input → validate → confirmDialog → `importData` →
  `entries-changed {import}`. ✓

### Left as-is (deliberate)

- `worklog/backend-needs.md` item 1 (store.js meta accessors): sync.js's
  own-connection watermark workaround is correct and safe; no change needed
  for the app to work.
- Sync pill per-state tinting (backend-needs item 3): cosmetic, functional
  unstyled.
- Journal voice-player object URLs are per-render (not the shared cache);
  small bounded churn, not worth touching.
