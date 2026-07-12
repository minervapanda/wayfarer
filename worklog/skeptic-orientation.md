# worklog — skeptic-orientation (adversarial design review, read-only)

## 2026-07-12

Reviewed the orientation-aware frame round: css/book.css + js/book.js collage layouts,
js/storycard.js layoutCollage/printDims/drawTape math, js/journal.js + css/journal.css
filmstrip, plus ingest.js / store.importData for the {w,h} provenance. No files under
review were modified. Geometry claims were checked numerically (node harness).

Findings reported to the orchestrator (5, ranked):

1. MAJOR css/book.css — n=3/n=4 collages are grids with default `justify-items: normal`
   (= stretch for the non-replaced `.bk-snap` figures). When a column mixes orientations
   (e.g. "pllp", "lps") the narrower print stretches to the column's max-content width:
   up to ~12cqw (~47px at a 406px collage) of blank white chrome appears to the RIGHT of
   the photo (img is left-aligned in the figure), destroying the uniform polaroid border.
2. MAJOR js/storycard.js — layoutCollage constrains only the print RECTANGLES; the washi
   tape drawn on the topmost print overhangs ~0.13–0.15·pw above the frame. On 1-photo
   cards with story text the vertical fit binds (colH == zone.h, band slack M == 0), the
   print top lands exactly at zone.y, and the tape rises ~70px into the 28px gap below
   the title — painting striped tape across the title's lower glyphs (verified: 42px of
   glyph overlap, story format, 1 portrait + excerpt).
3. MINOR — legacy/imported blobs (store.importData keeps `w: raw.w || 0`): book/journal
   stamp data-orient="square" forever (correct no-NaN fallback) but never upgrade from
   img.naturalWidth/Height once pixels load, while storycard classifies from decoded
   pixels — the three views disagree and imported panoramas stay heavily cropped.
4. MINOR js/storycard.js — LAYOUTS_2.landscapes top anchor cy=0.27 binds k in short
   zones: square format + long story → zone.h ≈ 393, prints ~222px wide on a 1080px
   card (photo window 200×150), ~2/3 of the photo band empty paper.
5. MINOR js/storycard.js — LAYOUTS[3] fan: print 2 (same class, near-equal size, center
   offset only 0.06·zone) occludes ~82% of print 1 — the user's first/hero photo is
   reduced to slivers on 3-photo share cards.

Verified clean: thresholds (0.85/1.18) identical across the three views incl. boundary
values; {w,h} missing/zero/NaN → 'square' everywhere, no NaN; book collage heights are
deterministic in cqw and fit every face/mobile page across all n and mixes I could
construct; storycard band math (zone/excerpt/footer) is internally consistent — prints
(rectangles) provably cannot cross title/footer/safe areas; journal filmstrip caps
panoramas (3+) and tall crops (0.3) at the class frames with height 108px, min-width
44px respected; reduced-motion and inert/flip/lightbox/share paths untouched.

No JS changed → no node --check needed (harness scripts ran under node directly).
