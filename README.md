# Wayfarer — Travel Diary

A private, offline-first travel diary that feels like a real book: photos with
their locations read straight from EXIF, stories you can dictate, voice notes,
three paper themes, and optional private cloud sync via Supabase.

- **Plain static site** — vanilla JS ES modules, no build step. Open `index.html`
  over any static server (`python3 -m http.server`) or deploy to GitHub Pages.
- **Local mode by default** — everything lives in your browser (IndexedDB).
  Works fully offline. Export/import as JSON or a self-contained HTML page.
- **Cloud sync (optional)** — fill in `config.js` after following `SETUP.md`;
  the diary then requires a magic-link sign-in and syncs privately.

## Layout

- `ARCHITECTURE.md` — module contracts and data model (**read first; it is law**)
- `index.html` + `css/` + `js/` — the app
- `config.js` — Supabase credentials (empty = local mode)
- `supabase/schema.sql`, `SETUP.md` — backend setup
- `legacy/wayfarer-v1.html` — the proven v1 single-file app being ported

Network use is limited to OpenStreetMap Nominatim (geocoding) and Supabase
(when configured). No other CDNs, fonts, or frameworks.
