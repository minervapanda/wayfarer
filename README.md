# Wayfarer — Travel Diary

A private, offline-first travel diary that feels like a real book: photos with
their locations read straight from EXIF, stories you can dictate, voice notes,
three paper themes, and optional private cloud sync via Supabase.

- **Plain static site** — vanilla JS ES modules, no build step. Open `index.html`
  over any static server (`python3 -m http.server`) for local development.
- **Local mode by default** — everything lives in your browser (IndexedDB).
  Works fully offline. Export/import as JSON or a self-contained HTML page.
- **Cloud sync (optional)** — fill in `config.js` after following `SETUP.md`;
  the diary then requires a magic-link sign-in and syncs privately.

## Hosting

Wayfarer is deployed on **Cloudflare Pages** and is **private by default**: a
Pages Function (`functions/_middleware.js`) gates every request behind a site
password (`SITE_PASSWORD` secret), with a 30-day session cookie and `/logout`.
Follow the checklist in `SETUP-CLOUDFLARE.md` to log in, create the project,
set the password, and deploy with `npx wrangler@4 pages deploy .`.

The old GitHub Pages deployment is retired — all paths in the app are
`./relative`, so the move to the root of a `*.pages.dev` domain needed no code
changes; keep any new paths relative too.

## Layout

- `ARCHITECTURE.md` — module contracts and data model (**read first; it is law**)
- `index.html` + `css/` + `js/` — the app
- `config.js` — Supabase credentials (empty = local mode)
- `functions/_middleware.js`, `wrangler.toml`, `SETUP-CLOUDFLARE.md` — Cloudflare
  Pages hosting + password gate
- `supabase/schema.sql`, `SETUP.md` — backend setup
- `legacy/wayfarer-v1.html` — the proven v1 single-file app being ported

Network use is limited to OpenStreetMap Nominatim (geocoding) and Supabase
(when configured). No other CDNs, fonts, or frameworks.
