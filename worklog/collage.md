# worklog — collage (js/collage.js + css/collage.css)

## 2026-07-12 — collage template engine, first drop

New files only (my two owned files):

- **js/collage.js** — pure DOM+CSS engine, zero app imports. Exports the exact
  frozen contract: `TEMPLATES` (auto/scatter/mosaic/grid/filmstrip/wall),
  `resolveTemplate(key, photoCount)`, `renderCollage(rootEl, photos,
  templateKey, opts)`.
- **css/collage.css** — all five template looks, base.css tokens only, themed
  for all 3 paper themes and both scenes.

Decisions of record:

- **'auto' mapping**: 0–4 → scatter (1 renders as a single matted print),
  5–6 → mosaic, 7+ → grid. Explicit 'scatter' at 7+ photos also resolves to
  grid (the hand-tuned scatter tables top out at 6 prints). Documented in the
  module header.
- **Determinism**: all rotation/offset/z-depth/decoration randomness derives
  from FNV-1a(seed, photo id, index, salt) — same entry renders identically
  everywhere, every time. No Math.random anywhere.
- **Containment math**: scatter and wall use a small width-unit solver — the
  container's aspect-ratio is computed from the deepest placed print, so
  nothing can overflow at any width (tested 320–1100 assumptions). The mat
  padding constants in CSS (4.5%/16% scatter, 4% wall) are a documented
  geometry contract with the JS.
- **Aspect fidelity**: scatter/wall/mosaic use the shared orientation buckets
  (portrait <0.85, landscape >1.18, else square — same barely-cropped
  treatment as the journal filmstrip); grid and filmstrip frames use TRUE w/h
  (clamped 0.5–2.4).
- **Integrator tolerance**: journal.js (already landed) calls
  `renderCollage(mount, photos, { template, seed, onPhotoClick })` and
  `resolveTemplate(key, photosArray, seed)` — both variants are accepted on
  top of the contract signatures.
- **Stylesheet loading**: index.html is frozen and has no collage.css link, so
  the module self-injects `<link rel=stylesheet>` once, resolved via
  `import.meta.url` (subpath-safe). A pre-existing link to collage.css is
  detected and respected. See collage-needs.md.
- **A11y**: every print is a real `<button>` (min 44px targets), alt text
  passes through to the `<img>` (button's accessible name), decorations are
  aria-hidden, wrapper is a labelled `role=group`, focus-visible ring +
  z-raise, hover lift is disabled (and tilt transitions off) under
  prefers-reduced-motion. AA-checked literal colors annotated in the CSS.

Verification:

- `node --check js/collage.js` clean.
- Stub-DOM harness (scratchpad) exercised the real module: exact TEMPLATES
  shape, resolveTemplate truth table, containment for scatter n=1–6 and wall
  n=1–9 across all-portrait/all-landscape/all-square/mixed × 3 seeds (0
  overflows, tape/pin headroom kept), determinism (same seed → identical
  render, different seed → different), journal's 3-arg call shape, mosaic
  hero = first portrait with original click indices preserved, grid 30-photo
  row structure + spacer, filmstrip row balancing (5→3+2, 7→4+3, 9→3+3+3),
  empty-photos state, missing w/h + missing opts defensive paths.
  ALL CHECKS PASSED.

Fix during review: seeded print depth moved from inline `z-index` to a
`--z` custom property so the CSS hover(50)/focus(60) raise actually wins.
