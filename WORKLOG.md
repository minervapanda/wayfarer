# Wayfarer — Work Log

Travel diary web app: offline-first scrapbook book with page-flip UX, voice-first entries,
EXIF location capture, Supabase sync (private, login-to-view), deployed on GitHub Pages.

## 2026-07-11 — Kickoff

**Decisions (user-approved):**
- Backend: Supabase free tier (Postgres + Storage + magic-link auth). Frontend stays offline-first (IndexedDB); sync when signed in.
- Privacy: private, login-to-view. Public URL shows a landing/login screen only.
- Frontend: upgrade the proven v1 single-file app (`legacy/wayfarer-v1.html`) into ES modules; add page-flip book view, voice dictation + voice notes, IndexedDB persistence.
- Deploy: GitHub Pages, public repo `minervapanda/wayfarer` → https://minervapanda.github.io/wayfarer/

**Plan:**
1. Scaffold agent: repo skeleton, ARCHITECTURE.md contracts, shell HTML/CSS, state + IndexedDB store.
2. Five parallel builders with exclusive file ownership: book engine, capture (EXIF/ingest/geocode), voice, auth+sync, journal view + exporter + demo seed.
3. Integrator: wiring, import/ID audit, syntax checks.
4. Adversarial review: correctness, security (XSS/RLS), UX/HIG, deploy-readiness — findings refuted/confirmed per-finding, then fixed and re-checked.
5. Deploy to Pages, live browser verification, UX demo.

Per-agent notes land in `worklog/*.md`; the fix agent merges highlights back here.

## 2026-07-12 — Build highlights (merged from worklog/*.md)

- **Architect**: ARCHITECTURE.md contracts (data model, bus events, module APIs, ID inventory, ownership map); frozen shell — index.html, base/app.css token system (3 paper themes × light/dark scene, grain, reduced-motion), state.js bus, store.js (IndexedDB `wayfarer` v1 + memory fallback), util.js (toast/confirmDialog/blobUrl cache), main.js boot chain + full compose controller.
- **Book (Builder 1)**: page-flip engine — stacked sheets rotating at the spine driven by a `--flip-angle` property (CSS derives the moving shadow), drag-to-flip hotspots with pointer capture, TOC with staggered jumps, arrow keys, mobile single-page flipper with swipe, curated collage layouts (1–4 photos, washi tape, photo corners, stamp for photo-less days), empty/error/loading/missing-photo states, rAF watchdog so occluded windows never wedge a turn.
- **Capture (Builder 2)**: dependency-free EXIF parser ported from v1 (both endiannesses, GPS DMS→decimal, DateTimeOriginal + fallback, orientation, 512 KB head scan, never throws); ingest downscales to 1600px JPEG q0.8 with orientation handling and EXIF read off original bytes; Nominatim geocode with ≥1100 ms serialized queue, two-level cache, offline short-circuit, attribution into #osm-attribution.
- **Voice (Builder 3)**: dictation with interim ghost text, smart insertion/capitalization, permission/unsupported/network states; MediaRecorder voice notes with live level meter (WebAudio, CSS fallback, reduced-motion still), mime negotiation incl. Safari mp4, 10-min guard; ticket-stub player handling Chrome's duration=Infinity quirk.
- **Backend (Builder 4)**: auth.js magic-link flow with local-mode fallback, "Continue offline" hatch, deduped auth-changed; sync.js LWW engine (paged pull with watermark, blob re-download, debounced push, status pill with retry); schema.sql — owner-only RLS on entries + storage, `<uid>/<blobId>` key convention.
- **Journal/Export/Demo (Builder 5)**: editorial chapter stack with inline-SVG world map, stats, drop-cap narratives from the 40-place library, photo strips + lightbox; JSON export/import and a self-contained HTML flipbook export (data embedded as escaped JSON, textContent-only renderer); offline demo trip with 12 seeded canvas-painted postcards.
- **Integrator**: import/ID/bus audits all green; fixed the critical `[hidden]` CSS guard (login gate stayed over the app in local mode) and stopped book.js revoking the shared blob-URL cache; static-serve check 22/22 assets.

## 2026-07-12 — Review findings fixed (fixer, round 1)

**Sync correctness (critical + minors)**
- `updated_at` is now stamped by the server (new schema.sql trigger; push no longer sends it), so pull watermarks are monotonic in insertion order — a device pushing an old offline edit can no longer be permanently skipped by other devices' watermarks. Client edit time still travels in `data.updatedAt` for merging.
- Pull pagination is keyset over `(updated_at, id)` with the id stored in the watermark — rows sharing one timestamp across a 500-row page boundary are never dropped. Legacy timestamp-only watermarks are handled with an overlapping `gte` (idempotent under LWW).
- LWW merge gives dirty local copies a 5-minute clock-skew tolerance, and `clearDirty` after a pull is conditional: if the user saved mid-pull and their write won, the dirty mark (and thus the push) survives.
- Demo entries use fixed v4 UUIDs instead of `wf-demo-*` slugs — Postgres `uuid` PK no longer rejects them, so the pill can't stick on "Sync error" after loading the demo in cloud mode.
- schema.sql now **forces** `wayfarer-media` private (`on conflict … do update set public = false`) so re-running the file downgrades a bucket that was created or flipped public.

**Compose / data-entry**
- EXIF capture-date prefill actually fires: the date field tracks whether it still holds the automatic "today" default (`compose.dateAuto`), so photo-driven entries get the memory's date, not the creation date; exif.js keeps capture-local wall time instead of shifting through UTC (Tokyo-morning photos no longer date to "yesterday").
- Editing an entry with a voice note now shows it as a playable "Saved voice note" with Re-record / Remove; save deletes the note when removed and never silently resurrects or overwrites it.
- Cancel / Esc / backdrop-close of compose asks "Discard this entry?" (custom Discard button) whenever there's unsaved work; dictation is force-stopped on close (and its pagehide failsafe now listens on window, where the event actually fires).
- store.js importData only decodes `data:` URIs — a crafted diary JSON can no longer make the app fetch attacker/intranet URLs; the IndexedDB-unavailable warning calls util.toast() directly so private-browsing users actually see the data-loss warning (the bus listener didn't exist yet at initDB time).

**Views & a11y**
- Desktop book: only the two faces of the open spread are focusable — everything behind/backface-hidden is `inert` + `aria-hidden`, so Tab can't reach invisible edit/delete buttons.
- Page-flip hotspots shrunk to a 12px edge strip (folded-corner remains the generous target) — clicking the story pane's scrollbar scrolls instead of turning the page.
- Journal re-renders build the new tree before swapping, keep scroll position, and skip the loading flash; an open lightbox is closed through its teardown (no leaked document keydown listener). The lightbox now traps Tab, locks background scroll, and restores focus safely.
- World-map pins carry an invisible r=32 hit circle and the map pans in its own container at a 700px minimum on phones — tappable pins, readable labels, no page-level horizontal scroll.
- `.btn-primary:hover` darkens instead of lightening (white-on-#f0a04b was ~2.1:1); view toggle, Dictate and sync-Retry hit 44px; the compose photo-remove button is a real 28px visual with a 44px hit-test pad (the old `scale(0.64)` shrank the hit area too).
- Voice recorder: after Stop, focus lands on the new play button instead of falling to `<body>`; renderVoicePlayer sweeps players whose mounts left the DOM, revoking their object URLs (previously one URL + pinned blob leaked per voice note per re-render).
- Header ⋯ menu closes after choosing an action, on Esc (focus returns to the trigger), and on click-outside.
- Favicon: tiny 32×32 PNG data URI added ahead of the SVG one — Safari shows the book icon and stops 404ing `/favicon.ico`; `narrativeFor` uses own-property lookup so a place named "Constructor" can't render `Object.prototype` members as history.

## 2026-07-12 — Live browser verification + deploy

- Live-tested at localhost in Chrome: boot, demo trip, cover, TOC, page flips (keyboard), entry collages, compose sheet, journal view — no console errors.
- Found + fixed one integration race the reviewers missed: `main.js` refreshed `app.entries` asynchronously on 'entries-changed' while views re-rendered synchronously from the stale cache, so demo-load/import/sync-pull never appeared until reload. The catch-all listener now awaits the refresh and re-announces once (`reason: 'cache-refreshed'`, ignored by itself and by sync's push scheduler).
- Deployed to GitHub Pages: public repo minervapanda/wayfarer, site https://minervapanda.github.io/wayfarer/ (runs in local mode until Supabase credentials land in config.js per SETUP.md).
