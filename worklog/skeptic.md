- 2026-07-12 — Skeptic verification of a11y finding: CONFIRMED. journal.js:348 (and book.js:210) use generic aria-label "Share this page"; journal renders all chapters simultaneously (journal.js:137) with no inert sweep (unlike book.js:452-465), so N identically-named share buttons are in the tab order at once while adjacent Edit buttons interpolate the entry title (journal.js:343). Read-only pass; no code changed.

## 2026-07-12 — Skeptic verdict: SETUP.md stale Supabase redirect URL (deploy finding)
- Verified against actual files: SETUP.md line 34 (step 4) instructs setting Supabase Site URL / Redirect URLs to `https://minervapanda.github.io/wayfarer/`; SETUP-CLOUDFLARE.md step 5 (lines 40-44) explicitly says to point them at `https://<project>.pages.dev` instead. Contradiction is real.
- Failure mode confirmed via js/auth.js:120 — the app requests magic links with `emailRedirectTo: location.origin + location.pathname`. From pages.dev that redirect is NOT in the allow-list a SETUP.md-follower configured, so Supabase falls back to the Site URL (github.io). Tokens land on the retired/stale origin; sign-in on pages.dev never completes.
- Also noted (same file, corroborating staleness): SETUP.md step 6 still says "once GitHub Pages redeploys".
- Verdict: real=true (minor, docs-only; fix is to update SETUP.md step 4 and step 6 to the pages.dev deployment).
