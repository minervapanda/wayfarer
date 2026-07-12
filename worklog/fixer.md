# Worklog — Fixer (round 1)

## 2026-07-12

- Applied fixes for all 22 unique confirmed review findings (correctness,
  security, UX, deploy lenses). Full details merged into the repo-root
  WORKLOG.md under "Review findings fixed (fixer, round 1)".
- Files touched: js/sync.js, js/store.js, js/main.js, js/voice.js,
  js/journal.js, js/book.js, js/exif.js, js/narratives.js, js/demo.js,
  js/util.js (confirmDialog okLabel param), css/base.css, css/app.css,
  css/book.css, css/journal.css, supabase/schema.sql, index.html (favicon
  only), WORKLOG.md.
- Cross-cutting contract additions (kept backward compatible):
  `createVoiceRecorder(rootEl, existingBlob?)` + `existingRemoved()` in its
  handle; `initDictation(...)` now returns `{ stop() }`; `confirmDialog`
  gained an optional third `okLabel` argument. schema.sql gained a
  server-side `updated_at` trigger; sync.js watermark is now `{ ts, id }`
  (legacy plain-timestamp watermarks still parse).
- Verified: `node --check` clean on all 10 changed JS files; EXIF-date,
  watermark-parse and demo-UUID logic exercised in Node; generated PNG
  favicon validated with sips + visual check.

## 2026-07-12 — Share + Cloudflare gate review fixes (fixer, round 1)

- Applied fixes for all 13 findings from the share-card/Cloudflare review
  (security, quality, deploy lenses). Full details merged into WORKLOG.md
  under "Share + Cloudflare gate: review fixes".
- Files touched: functions/_middleware.js (sanitizeTo control-char open
  redirect, POST-only /logout with GET confirm page, protocol-conditional
  Secure cookie), js/sharecard.js (post-await double-open guard),
  js/storycard.js (bitmap release in finally, dateline ellipsis, photo
  backfill), js/book.js + js/journal.js (titled share aria-labels),
  css/book.css (icon-button resting contrast), css/journal.css (hero pill
  scrim 0.62), wrangler.toml + SETUP-CLOUDFLARE.md (staged dist/ deploys,
  .dev.vars guidance), SETUP.md (Cloudflare URLs), .gitignore, WORKLOG.md.
- Verified: `node --check` clean on the 5 changed JS files; sanitizeTo
  exercised in Node against 13 attack/legit cases (all pass).

## 2026-07-12 — Orientation-aware frames: review fixes (fixer, round 1)

- Applied fixes for all 5 findings from the orientation-frame review (design +
  regression lenses). Full details merged into WORKLOG.md under
  "Orientation-aware frames: review fixes".
- Files touched: css/book.css (justify-items: center on the n=3/n=4 collage
  grids), js/storycard.js (TAPE_PAD tape-overhang reservation in
  layoutCollage's containment + banding via new extentTop(); drawTape 30px
  height floor removed so the reservation scales; LAYOUTS_2.landscapesWide
  side-by-side variant chosen by specsFor when zone aspect > 1.45; LAYOUTS[3]
  fan reworked so print 1 anchors large on the left), .gitignore (testdata/).
- Verified: `node --check js/storycard.js` clean; node harness (scratchpad
  fixcheck.mjs) ran 5 zones × 15 orientation mixes × 40 seeds asserting
  rotated prints AND the exact rotated tape strip stay inside the zone and
  the reported col.top/bottom band; 2-landscape short-zone k now reaches the
  0.58 cap exactly (prints 292px vs ~222 before); 3-photo hero occlusion
  down from ~82% to worst-case 17–36% across sss/ppp/lll/pls; layouts remain
  seed-deterministic.
