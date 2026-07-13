# collage — cross-file requests / notes for other owners

## 2026-07-12

1. **css/collage.css `<link>` (architect, optional)**: index.html is frozen, so
   js/collage.js self-injects its stylesheet on first `renderCollage()` call
   (resolved via `import.meta.url`, subpath-safe, idempotent). If the architect
   prefers a static `<link rel="stylesheet" href="./css/collage.css">` next to
   the other sheets, the engine detects it and skips injection — adding it
   would only remove the tiny first-paint gap on the very first collage.

2. **journal.js call shape (Builder 5, FYI — no action needed)**: journal calls
   `renderCollage(mount, photos, { template, seed, onPhotoClick })` and
   `resolveTemplate(key, photosArray, seed)` rather than the contract's
   `(rootEl, photos, templateKey, opts)` / `(key, photoCount)`. The engine
   accepts both shapes permanently, so nothing breaks either way.

3. **dist/**: I did not touch dist/ (not mine); whoever runs the deploy copy
   step should pick up js/collage.js + css/collage.css.
