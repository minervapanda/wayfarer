# Drive import (Phase 5) — 2026-07-17

Added `js/drive.js` (runtime-injected UI; index.html frozen). Google Drive bulk
photo import on the `drive.file` scope.

- Feature gate: injects nothing and loads ZERO Google code unless
  `config.GOOGLE_CLIENT_ID` && `GOOGLE_API_KEY` are set. Offline-first preserved.
- GIS (`accounts.google.com/gsi/client`) + Picker (`apis.google.com/js/api.js`)
  load LAZILY only on the first "Import from Google Drive" click.
- Flow: `initTokenClient({scope:'.../drive.file'})` → image-DocsView multi-select
  Picker → `files.get?alt=media` (bearer) → wrap Blob in File → `ingestFiles()`
  in batches ≤24 → group by EXIF capture day (fallback today) → `putBlob` +
  `saveEntry` → emit `entries-changed {reason:'import'}`. Sync pushes them.
- Progress: runtime `<dialog>` "Importing X/Y…", cancellable, resilient
  (skip a bad file, keep going). Escape maps to Cancel.
- CORS: files.get media fetch failing as a TypeError surfaces a clear
  "needs the optional server proxy" toast and stops gracefully — proxy NOT built.
- Trigger self-injected into `.header-more-menu` before `#btn-signout`.
- Also `export function initDrive(mountFinder)` for an explicit caller/mount.
- config.js: added GOOGLE_CLIENT_ID / GOOGLE_API_KEY / GOOGLE_APP_ID (empty).
- ARCHITECTURE.md network allowlist note updated.

WIRING GAP (architect): nothing imports drive.js yet, so its self-init never
runs. Add `import './drive.js';` to a boot-loaded module (main.js) or a
`<script type="module" src="./js/drive.js">` to index.html — both frozen for
this slice.
