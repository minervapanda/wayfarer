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
