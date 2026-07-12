# worklog — book (Builder 1)

## 2026-07-12

- Replaced the `js/book.js` / `css/book.css` stubs with the full page-flip book engine.
- Faces model: [clothbound cover, table of contents, one face per entry, closing "fin." page],
  padded to an even count and paired onto absolutely-stacked sheets (front = face 2i,
  back = face 2i+1). `pos` = flipped-sheet count; cover/back closed states translate the
  book ±25% so the closed book sits centered.
- 3D flip: `transform-origin` at the spine, `rotateY(calc(var(--flip-angle) * 1deg))`,
  `preserve-3d` + hidden backfaces, z-index management (unflipped N−i, flipped i, elevated
  while turning), and a moving shadow gradient on both faces of the turning page derived
  in CSS from the same `--flip-angle` property.
- Interactions: edge/corner hotspots (click or drag-to-flip with pointer capture — angle
  follows the pointer, release past 90° completes, otherwise springs back), ← → arrow keys
  (suppressed while typing or while any dialog is open), side nav arrows, TOC rows jump via
  `bookApi.goTo` with staggered quick flips. rAF animation has a watchdog timeout so flips
  can never wedge when the window is occluded/minimized (rAF paused).
- Mobile <720px: single-page flipper — temporary front/back leaf element in a perspective
  wrapper (so the page's overflow clipping can't cut the turn), swipe left/right, prev/next
  bar with a "Page x of y" indicator; layout switches live on media-query change.
- Entry faces: curated collage layouts for 1/2/3/4 photos (rotated polaroids, washi-tape
  strips, CSS photo corners), uniform mini-grid + "+n more" for 5+, perforated postage
  stamp for photo-less entries; title, date + ⌖ location line, serif story with script
  drop cap scrolling in-face with a thin scrollbar; voice chip via `renderVoicePlayer`
  (blob from `store.getBlob`) when `entry.voiceId` exists; quiet ✎ edit (emits
  `compose-open` with `entryId`) and 🗑 delete (confirmDialog → `softDeleteEntry` →
  `entries-changed`) affordances.
- States: empty book (inviting spread with "Start your first memory" → `compose-open`
  and a quieter "Load a sample trip" → `demo.loadDemo()`), photo loading shimmer,
  photo-unavailable placeholder, store-error card with retry. Reduced motion = instant
  page swaps everywhere. Page numbers + deckled page-edge stacks whose thickness tracks
  how far through the book you are.
- Rerenders on `entries-changed` (deferred while the journal view is active, flushed on
  `view-changed`); object URLs from `util.blobUrl` are released on every rerender.
- Verified in Chrome against a seeded 6-entry diary: cover → spread flip, TOC jump with
  staggered flips, arrow keys, drag-to-flip completion, closed-at-end centering, mobile
  iframe (400px) flipper, delete flow end-to-end, zero console errors. Test DB cleaned up.
  `node --check js/book.js` passes.

## 2026-07-12 — orientation-aware collage frames

- **Goal**: photos stop being visibly "cut" — every collage frame now follows its photo's
  own orientation instead of a fixed center-cropped shape.
- **js/book.js** (surgical): added `orientOf(w, h)` using the app-wide thresholds
  (aspect = w/h; portrait < 0.85, landscape > 1.18, else square — same as journal.js).
  `buildEntryFace` stamps `data-orient="square"` on each `.bk-snap` and a provisional
  `data-mix` on the collage at build time; `hydrateFaces` now fetches each face's blob
  records with a single `Promise.all`, stamps the real `data-orient` per snap from the
  stored `{w, h}` and `data-mix` on the collage (orient initials in display order, e.g.
  "pl", "lls", "plsl"), all **before** any `img.src` is assigned — so frames never reshape
  under an already-visible photo. Missing/failed blobs keep the square default and the
  existing `.bk-snap-missing` swap. Token guards, shared blobUrl cache, voice hydration,
  inert/aria sweep, flip hotspots and stamp state untouched.
- **css/book.css**: photo AREA (not the polaroid chrome) takes the class frame —
  portrait 3/4, landscape 4/3, square 1/1 — via `--frame` per `data-orient` +
  `aspect-ratio` on the img (`object-fit: cover` retained: tiny in-frame trims only,
  never stretch/letterbox). The collage is now an inline-size container and every print
  is sized by a `--snap-h` HEIGHT in cqw (1cqw = 1% of collage width), so each layout's
  total height is deterministic and can never push title/story off the face — no internal
  scrolling anywhere. Layouts:
  - n=1: hero matches the photo — landscape wider + lower (35cqw tall), portrait narrower
    + taller (46cqw), square between (40cqw); tape kept.
  - n=2: side-by-side flex for like pairs (pp/ss); `data-mix="ll"` stacks the two
    landscapes with a slipped diagonal offset; any mixed pair overlaps at different
    heights (second print margin 6cqw down, −6cqw left) via
    `:not([data-mix="pp"], [data-mix="ss"], [data-mix="ll"])`.
  - n=3: auto-track grid — corner-mounted anchor print (33cqw) spans two rows, two 19cqw
    prints on the right; rotations/tape/corners preserved.
  - n=4: loose 2×2 auto grid, all prints one height (20cqw), natural widths per orient.
  - many (5+): switched the uniform square grid to a masonry-ish centered flex-wrap of
    mini prints at one shared height (15cqw) with natural widths — chose shared-height
    rows over square cells because equal-height strips read like real photo-booth rows,
    wrap into at most two rows for 5+count at worst-case all-landscape widths, and keep
    the "+n more" chip (now 17.8cqw, matching a square mini print) aligned.
  - Mobile (<720px): same rules apply (cqw is per-collage, not per-viewport); only the
    n=1 hero heights get bumped (46/52/40cqw) for the taller 3/4.1 single page.
  - cqw/container-type support (Chrome 105+/Safari 16+/FF 110+) is already implied by the
    file's existing `color-mix()` usage, so no new browser floor.
- **Verified live** (python http.server + Chrome, seeded 9 controlled entries covering
  1p/1l/1s, pp, ll, pl, lps, plsl, and 7-photo many): every desktop spread measured —
  collage 26–38% of face height, zero snap overflow past the face, footer + story always
  on-face; mobile audited in a 390px same-origin iframe for pp/ll/pl/lps/plsl/many with
  identical results (collage ≤ 34% of page, no overflow). Screenshots confirmed the
  scrapbook character: taped heroes, twin portrait prints, slipped landscape stack,
  overlapping mixed pair, corner-mounted n=3 anchor. data-mix values matched expectations
  on every face. Flip pagination, TOC jumps, inert/aria spread logic and empty state
  regression-checked along the way; zero console errors. `node --check js/book.js` passes.
