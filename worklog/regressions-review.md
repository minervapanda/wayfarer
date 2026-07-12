## 2026-07-12 — adversarial regression review: orientation-aware frames

Reviewed js/book.js, js/journal.js, js/storycard.js, css/book.css, css/journal.css
against previous behavior. Verified intact: flip pagination/faces math, inert+aria-hidden
spread sweep, renderStoryCard signature/return + FORMATS (sharecard.js consumer checked),
ImageBitmap close() in finally, deterministic seeding, lightbox open/close/focus-trap,
empty-state and photo-less stamp branches, node --check on all changed JS, diff confined
to assigned files + worklogs. Storycard layoutCollage fit/banding math checked by hand
(prints provably inside zone; excerpt last baseline stays above footer). book.css cqw
layouts checked for worst-case all-landscape widths — no face overflow.

Findings (both minor):
1. css/journal.css `.jr-strip { padding: 6px 2px; overflow-x: auto }` — 2px side padding
   clips the global :focus-visible ring (--focus-ring spreads 6px, base.css) on the
   first/last thumb at the scroll edges; previous wrapping grid never clipped it.
2. Untracked testdata/ (4 JPEG fixtures) left in the working tree — outside the five
   assigned files; should be removed or gitignored before commit.
