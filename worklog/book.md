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
