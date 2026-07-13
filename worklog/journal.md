# Worklog — Builder 5 (Journal / Export / Demo)

## 2026-07-11

- **js/narratives.js**: ported the full 40-place NARRATIVES library, `normalizeKey`, and legacy `lookupNarrative` verbatim from `legacy/wayfarer-v1.html`; added contract-shaped `narrativeFor(placeName)` that tries the full name then the pre-comma city ("Kyoto, Japan" → "kyoto") and returns `{ text: '', sourced: false }` for unknown places.
- **js/journal.js**: replaced the stub with the editorial chapter-stack view — inline-SVG world map (equirectangular projection ported from v1, deduped pins, click/Enter jumps to a chapter), stats row (entries/places/countries/photos), chapters sorted by date with hero photo + title overlay, drop-cap narrative (curated history when sourced, else the traveler's story split into paragraphs), "in your own words" note when both exist, voice-note playback via `renderVoicePlayer`, coords mini-map, photo strip, and a minimal lightbox inside `#journal-root` (Esc/backdrop close, arrow-key prev/next, focus restore). States handled: loading, error (with retry), empty (compose-open + demo buttons). Lazy re-render: skips work while the book view is active, catches up on `view-changed`. All user strings go through `textContent` / `esc()`.
- **js/exporter.js**: JSON export (blobs → base64 dataURLs, size toast), JSON import (validation → `confirmDialog` about merging → `store.importData` → `entries-changed { reason: 'import' }`), and the self-contained HTML flipbook export — cover page + one page per entry, prev/next + arrow keys, cream book styling, photos and voice notes baked in as data URLs, zero network/module dependencies; diary data embedded as `<`-escaped JSON and rendered with `textContent` only (XSS-safe). Inline flipbook script extracted and `node --check`-verified separately.
- **js/demo.js**: `loadDemo()` seeds 4 entries (Kyoto temple morning, Amalfi coast drive, Marrakech souk, Patagonia trail) with 12 seeded-deterministic canvas postcards (800×600 JPEG q0.85 — layered gradient skies, ridge silhouettes, sea shimmer, sun/crescent moon, stars, film grain), plausible coords, short stories. Fixed `wf-demo-*` ids guard against double-loading (re-load allowed after the user deletes them); emits `entries-changed { reason: 'demo' }`, toasts "Sample trip loaded". Handles missing canvas/`toBlob` with an error toast.
- **css/journal.css**: full styling for the view using base.css tokens only — paper chapters, hero gradient overlay (AA contrast), drop caps, dashed-coord card, scrapbook-theme tilted thumbs, 44px+ targets, `:focus-visible` rings incl. SVG pins, reduced-motion-safe spinner, responsive single-column under 760px.
- Verified: `node --check` on all four JS files, module smoke test of narratives exports, no edits outside owned files, no cross-file needs.

## 2026-07-12 — Orientation-aware filmstrip for the chapter photo strip

Round goal: stop visible cropping — frames follow each photo's own aspect ratio.

- js/journal.js: added `orientOf(w, h)` using the shared thresholds (aspect = w/h;
  portrait < 0.85, landscape > 1.18, else square). Thumb build now does one
  `getBlob(pid)` that sets both `img.src` and `data-orient` on the `.jr-thumb`
  button from the stored BlobRec w/h (missing blob still gets `.jr-photo-missing`).
  Hero image path (`attachPhoto`) untouched — it stays a full-bleed cover backdrop.
- css/journal.css: `.jr-strip` converted from a square grid to a filmstrip —
  `display: flex`, fixed 108px row height, `overflow-x: auto` (existing overflow
  pattern; page never scrolls sideways), vertical padding so the hover lift and
  scrapbook tilt aren't clipped by the scroll container. `.jr-thumb` gets
  per-orientation `aspect-ratio` via `[data-orient]`: portrait 3/4, landscape 4/3,
  square 1/1, with 1/1 as the pre-load fallback. `object-fit: cover` retained for
  sub-pixel tidiness; photos are never stretched or letterboxed.
- Unchanged by design: lightbox (already shows the uncropped photo — verified),
  hover lift, scrapbook rotations, 44px minimum targets (108px row), reduced
  motion (transitions ride --dur-1, zeroed by base.css).
- Out of scope respected: compose-modal thumbs (css/app.css) not touched.
- Verified: `node --check js/journal.js` passes; `.jr-strip`/`.jr-thumb` are
  referenced nowhere outside my two files.

## 2026-07-12 — collage chapters for photo-only entries

- **js/journal.js**: entries with a blank story and ≥1 photo now render as COLLAGE
  chapters instead of editorial ones. New `isPhotoOnly()` gate at the top of
  `chapterEl`; `collageChapterEl()` keeps the full header treatment (CHAPTER N · date
  eyebrow, display title, location/photo-count/voice sub line, share ↗ + Edit pills,
  coords card) but drops the narrative/"in your own words"/filmstrip in favor of one
  full-width collage. `hydrateCollage()` loads the photo blobs (missing blobs filtered;
  all-missing → quiet state), builds `{id, url, w, h, orient, alt}` photo objects
  (shared orientation thresholds 0.85/1.18, urls via `util.blobUrl`), and calls
  `renderCollage(mount, photos, { template, seed: entry.id, onPhotoClick })` from the
  new `./collage.js` engine; `onPhotoClick` opens the existing lightbox at that index.
  Engine throw / rejection / empty render falls back to an even `.jr-co-fallback` grid
  so the chapter never breaks. Stale async renders guarded with the existing `renderSeq`.
- **Style switcher**: quiet dashed chip ("✦ Style: <name>", `aria-label` "Change collage
  style — currently <name>", 44px target) cycles through `TEMPLATES` (shape-normalized
  defensively); 'auto' captions as "Auto · <resolved>" via `resolveTemplate` (try/caught).
  On change it re-reads the entry with `getEntry` (no clobbering of concurrent edits),
  sets `entry.collage = { template }`, `await saveEntry(entry)` (stamps updatedAt +
  dirty — syncs for free), then emits `entries-changed { reason: 'save' }`; the existing
  smooth-swap re-render keeps scroll. Save failure re-enables the chip + error toast.
- Chapter headings (both kinds) now prefer `util.entryDisplayTitle(entry)` via a
  namespace import with the historical `title || place || 'Untitled memory'` fallback,
  so this module works whether or not the util helper has landed.
- **css/journal.css**: new collage-chapter section — paper header with dashed rule and
  title clearance for the pill cluster (pills restyled for paper, share.css absolute
  cluster kept via specificity, static-flow under 560px), full-bleed-ish collage area
  with loading/missing states, footer row (style chip + compact coords card), voice
  block, fallback grid reusing `.jr-thumb` frames. Tokens only; hover/label transitions
  ride `--dur-1` (zeroed under reduced motion); base `:focus-visible` ring applies;
  responsive 320–1440px (clamped paddings, wrapping footer).
- Cross-file: `worklog/journal-needs.md` records the exact collage.js call shape coded
  against and the entryDisplayTitle fallback. NOTE: journal.js (and thus main.js) imports
  `./collage.js` statically per spec — the app will not boot until the engine file exists.
- Verified: `node --check js/journal.js` OK; css brace balance OK; no files outside
  js/journal.js + css/journal.css touched (worklog excepted).
