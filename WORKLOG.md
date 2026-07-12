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

## 2026-07-12 — Share cards + Cloudflare gate (merged from worklog/*.md)

- **Story-card renderer** (`js/storycard.js`, new): pure canvas-2D, no DOM UI/libs; frozen contract `FORMATS` (1080×1920 story / 1080×1080 square) + `renderStoryCard(entry, fmt) -> { blob, width, height, filename }`, never throws (minimal typographic fallback card). Samples live CSS tokens per render; mulberry32 PRNG seeded from entry.id makes re-renders pixel-identical; curated 1–4-photo polaroid collages with washi tape, postcard motif for photo-less days, Instagram story safe-area honored.
- **Share UI** (`js/sharecard.js` + `css/share.css`, new; surgical touches to book/journal/main/index.html): bus `'share-entry' { entryId }` from the book's `↗` face button and the journal's hero pill opens the native `#share-modal` dialog; lazy-imports the renderer, caches both formats per session, Web Share Level 2 (`canShare({files})`) with download fallback, aria-live status, textContent-only user strings.
- **Cloudflare gate** (`functions/_middleware.js` + `wrangler.toml` + `SETUP-CLOUDFLARE.md`, new): standalone Pages Function fronting every request; HMAC-signed 30-day session cookie keyed off SHA-256(SITE_PASSWORD+salt) so rotating the password logs everyone out; constant-time password compare, no-store auth responses, inline cream-paper login page matching the app's tokens; missing-secret 500 setup page.
- **Integration pass 2**: bus/ID/contract audits green; fixed `refineSkeleton()` reading `FORMATS[fmt].width/.height` where the contract ships `{w, h}`; ARCHITECTURE.md §7 addendum records the sanctioned share-entry event, share-modal IDs, and the Cloudflare hosting files.

## 2026-07-12 — Share + Cloudflare gate: review fixes

**Gate security (`functions/_middleware.js`)**
- `sanitizeTo()` now also rejects any embedded control character (or backslash) — `/login?to=/%09/evil.com` decoded to `/<TAB>/evil.com`, slipped past the `//` prefix check, and the browser's Location parsing stripped the tab into a protocol-relative `//evil.com` open redirect on successful login. Verified against a 13-case node harness (tab/newline/CR/NUL/DEL/backslash/`//` attacks all return `/`; legit paths pass through).
- `/logout` is no longer state-changing over GET: a bare GET now renders a small "Close the diary on this device?" confirmation page and only its same-origin POST clears the cookie, so a cross-site link/navigation can't force-logout a victim.
- The session cookie's `Secure` flag is now derived from the request protocol: always set in production (Pages is https-only), omitted over the plain-http `wrangler pages dev` preview where Safari refuses to store Secure cookies and looped users back to /login forever. Doc note added.

**Share flow quality**
- `js/sharecard.js`: `openShare()` re-checks the open guard after its `await getEntry()` — a double-click raced both handlers past the pre-await guard, and the loser's second `showModal()` threw, wedging the modal on the skeleton.
- `js/storycard.js`: decoded ImageBitmaps are released in a `finally` around the draw pipeline (previously only on the success path, so every failed render leaked up to 4 full-size bitmaps per retry); the dateline ellipsizes the free-text location so the tracked `DATE · LOCATION` line can no longer overflow the 1080px canvas; `loadPhotos()` walks all photoIds and stops at 4 *decoded* photos instead of slicing first, so a missing blob early in the list is backfilled by later valid photos.

**A11y / contrast**
- `css/book.css`: dropped the `.bk-iconbtn` resting `opacity: 0.6` (≈2.4:1 on paper — invisible-by-design never resolved on touch devices); glyphs now sit at full-opacity `--ink-soft` (≈5.4:1, AA) with a hover/focus shift to `--ink`.
- `css/journal.css`: the hero pill scrim darkened from `rgba(20,12,4,0.44)` to `0.62` so the near-white Share/Edit labels stay ≥4.5:1 even composited over a pure-white photo (hover 0.78).
- `js/book.js` / `js/journal.js`: share buttons' accessible names now interpolate the entry title (`Share "Kyoto"`) like their Edit/Delete siblings, instead of N identical "Share this page" entries in screen-reader element lists.

**Deploy hygiene**
- `wrangler.toml` + `SETUP-CLOUDFLARE.md`: deploys now upload a staged `dist/` (index.html, config.js, css/, js/ — functions/ auto-bundled from the repo root) instead of the repo root. Wrangler Pages has no user-configurable ignore, so root deploys would have served ARCHITECTURE.md, worklog/, supabase/schema.sql, legacy/ — and, fatally, a local `.dev.vars` holding SITE_PASSWORD at `/.dev.vars`. The doc names the `.dev.vars` mechanism for the local gate preview and warns explicitly; `.gitignore` gains `.dev.vars`, `.wrangler/`, `dist/`.
- `SETUP.md`: the Supabase Site URL / Redirect URLs step now points at the Cloudflare Pages address (the retired `minervapanda.github.io/wayfarer/` instruction sent magic links to a dead origin), and step 6 redeploys via SETUP-CLOUDFLARE.md instead of GitHub Pages.

## 2026-07-12 — Orientation-aware frames: review fixes

Round goal: photos stop being visibly "cut" — every frame follows its photo's own aspect. Shared thresholds everywhere (aspect = w/h from the stored blob {w,h} or decoded pixels): portrait < 0.85, landscape > 1.18, else square; photo-area frames 3/4, 4/3, 1/1; cover-crop stays for sliver trims only, never stretch/letterbox. Merged from worklog/book.md, journal.md, storycard.md, skeptic-orientation.md, regressions-review.md and fixer.md.

**Book** (`js/book.js` + `css/book.css`): `hydrateFaces` stamps `data-orient` per `.bk-snap` and `data-mix` (orient initials, e.g. "pl", "lls") per collage from the blob records before any `img.src` is assigned, so frames never reshape under a visible photo. The collage is an inline-size container; each print is sized by a `--snap-h` height in cqw with `aspect-ratio: var(--frame)` on the img, so every layout's total height is deterministic and can't push title/story off the face. Curated per-count layouts: shape-following n=1 hero, twin/stacked/overlapping n=2 by pair, corner-mounted n=3 anchor grid, loose 2×2 n=4, shared-height masonry rows for 5+ with the "+n more" chip. Verified live across 9 seeded mixes on desktop and a 390px iframe; flip pagination, TOC, inert/aria spread logic regression-checked.

**Journal** (`js/journal.js` + `css/journal.css`): chapter photo strip converted from a square grid to a 108px filmstrip (`overflow-x: auto`, page never scrolls sideways) with per-orientation `aspect-ratio` on `.jr-thumb` via `data-orient` (square pre-load fallback). Hero backdrop and lightbox (already uncropped) untouched; 44px targets and reduced motion preserved.

**Share cards** (`js/storycard.js`): every polaroid's photo window is exactly its class aspect (`ORIENT_ASPECT` + `printDims`; chrome unchanged — 5% pad, 18% chin). New `layoutCollage()` anchors prints from curated fraction specs, sizes all prints by one shared photo-area unit capped per count (`UNIT_CAP`), shrinks it until every rotated frame stays inside the photo zone, then re-centers the collage + excerpt around the collage's true rotated bbox. 2-photo layouts pick by orientation pair; the excerpt-line loop biases the photo band by mix (all-landscape ×0.85, all-portrait ×1.15). Contract, fallback card, postcard branch and determinism untouched.

**Review findings fixed** (fixer, from the skeptic-orientation + regression reviews):
- `css/book.css` — the n=3/n=4 collage grids left `justify-items` at its default (stretch), so whenever a column mixed orientations the narrower polaroid stretched to the column's max-content width, pinning the photo left inside up to ~12cqw of one-sided white chrome. Both grids now `justify-items: center`.
- `js/storycard.js` — `layoutCollage` bounded only the print rectangles, but the washi tape on the topmost print overhangs the frame; when the vertical fit bound (e.g. 1 portrait + story), the strip painted ~42px into the title's glyphs. The tape overhang is now reserved by a new `extentTop()` (TAPE_PAD = 0.16·pw, covering the worst −38° strip plus print rotation) in both the containment pass and `col.top` banding, and `drawTape`'s 30px height floor was removed so the reservation bounds every print size. Node harness: exact rotated tape stays inside the zone across 5 zones × 15 mixes × 40 seeds.
- `js/storycard.js` — two-landscape collages in short zones (square format + long story) bound the shared scale at the stack's cy=0.27 top anchor, leaving ~2/3 of the band empty around ~222px prints. `specsFor` now picks a new `landscapesWide` side-by-side arrangement when zone aspect > 1.45; the reviewer's scenario now reaches the 0.58 cap exactly (292px prints).
- `js/storycard.js` — the 3-photo fan placed print 2 near-identical in size just 0.06·zone from print 1, occluding ~82% of the user's hero photo. `LAYOUTS[3]` reworked: print 1 anchors large (s 1.06) on the left, prints 2/3 fan smaller to the right — worst-case hero occlusion measured at 17–36% across all orientation mixes, matching the book's hero-first n=3 story.
- Repo hygiene — untracked `testdata/` JPEG fixtures (outside every module's assigned files) can no longer ride a `git add -A` into the deployed site: `testdata/` added to `.gitignore`.

Verified: `node --check` clean on js/storycard.js (only JS changed by the fixer); numeric harness green on containment, tape extents, cap utilization, occlusion and seed-determinism. Not fixed this round (minor, out of assigned findings): imported legacy blobs with `w:0` stay `data-orient="square"` in book/journal while storycard classifies from pixels; `.jr-strip` 2px side padding clips the focus ring on edge thumbs.

## 2026-07-12 — Full E2E test pass (local, wrangler pages dev + Chrome)

Fixtures: 4 generated JPEGs with real EXIF (GPS + DateTimeOriginal) in testdata/ — portrait 3:4, landscape 3:2, square, panorama 3:1.

| Feature | Result |
|---|---|
| Password gate: wrong pw 401, correct pw signed cookie, //evil.com redirect neutralized | PASS (curl + browser) |
| Gate session survives browser restart; GET /logout shows confirm page; POST signs out; re-login works | PASS |
| Photo upload (4 mixed-aspect files at once) | PASS |
| EXIF date prefill (04/03/2026 from DateTimeOriginal) | PASS |
| EXIF GPS → reverse geocode → "Kyoto, Japan" auto-filled | PASS |
| Save entry; validation blocks photo-less+text-less save | PASS |
| Orientation-aware book collage: portrait/landscape/square/panorama each keep their shape | PASS |
| **Hard refresh: all entries + photo blobs persist (IndexedDB)** | **PASS — core requirement** |
| Journal: chapter hero, auto narrative (Kyoto), coords card, filmstrip with true aspect widths | PASS |
| Share card story 9:16 + square 1:1 with mixed orientations; PNG download | PASS |
| Edit flow (compose reopens with entry) + Delete flow (custom confirm, entry removed) | PASS |
| Export JSON (5 entries + 16 blobs verified by parsing the download) | PASS |
| Theme switch (minimal/passport) re-skins book + chrome coherently | PASS |
| Desktop two-page spread + mobile single-page both render | PASS |
| Voice dictation/recording | NOT auto-tested (OS mic permission needs a human) — manual test recommended |

Outstanding to go live: user must complete `npx wrangler@4 login` and `npx supabase login`; then deploy, provision Supabase (schema.sql + bucket), fill config.js, flip GitHub repo private.
