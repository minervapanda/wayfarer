# Wayfarer — Architecture & Module Contracts

**This document is law.** Five builder agents work in parallel against these contracts.
Do not rename exports, change signatures, invent new element IDs in `index.html`, or edit
files you do not own. If you need something outside your files, write the request to
`worklog/<yourmodule>-needs.md` and code defensively in the meantime.

Repo: plain static site. **Vanilla JS ES modules. No build step, no bundler, no framework.**
Deployed at `https://minervapanda.github.io/wayfarer/` — a **subpath**, so absolute URLs
(`/css/x.css`) are forbidden. Every HTML link and JS import is a `./relative` path.

## Ground rules (apply to every module)

- **Network**: only (a) OpenStreetMap Nominatim for geocoding (polite: ≤1 req/sec, show
  attribution, custom `Accept` header only — browsers set User-Agent), (b) the Supabase
  JS client dynamically imported from `https://esm.sh/@supabase/supabase-js@2`, and only
  when `config.js` is filled in, and (c) **Google Drive import (Phase 5, `js/drive.js`)**,
  and only when `config.GOOGLE_CLIENT_ID` + `GOOGLE_API_KEY` are set — permitting
  `accounts.google.com/gsi/client` (GIS token client), `apis.google.com/js/api.js` +
  the Google Picker frame (`docs.google.com`), and `www.googleapis.com` (Drive
  `files.get?alt=media`). These load **lazily, only on an explicit "Import from Google
  Drive" click** — never at boot. No other CDNs, fonts, tiles, or frameworks. The app must
  work **fully offline in local mode**, and with Drive unconfigured it loads **zero** Google
  code.
- **No `alert()` / `confirm()` / `prompt()`** — ever. Use `toast()` and `confirmDialog()`
  from `./util.js`, or emit the `'toast'` bus event.
- **XSS**: user-generated strings must never reach `innerHTML` unescaped. Use
  `textContent`, DOM building, or `esc()` from `./util.js`.
- **States**: every state you introduce must be handled — empty, loading,
  permission-denied, unsupported-browser, error.
- **A11y**: WCAG AA contrast, visible `:focus-visible`, 44px minimum touch targets,
  `prefers-reduced-motion` respected, sensible `aria-*` on interactive widgets.
- **Aesthetic**: warm analog scrapbook on cream paper. Serif body, script accents,
  tasteful motion. Use the tokens in `css/base.css` — never hard-code colors.

---

## 1. Data model

### Entry (IndexedDB store `entries`, keyPath `id`)

```js
{
  id: string,            // uuid (util.uid())
  title: string,         // may be ''
  dateISO: string,       // 'YYYY-MM-DD' (date of the memory, not of creation)
  location: {
    name: string,        // '' when none
    lat: number|null,
    lon: number|null,
    source: 'exif' | 'manual' | 'none'
  },
  story: string,         // free text (dictated or typed); may be ''
  photoIds: string[],    // ids into the blobs store, display order; may be []
  voiceId: string|null,  // id of one audio blob, or null
  createdAt: string,     // ISO datetime
  updatedAt: string,     // ISO datetime — stamped by store.saveEntry()
  deleted: boolean       // soft delete; tombstone kept for sync
}
```

Validation rule (enforced by the compose controller): an entry needs **≥1 photo OR
non-empty story text** to be saved.

### BlobRec (IndexedDB store `blobs`, keyPath `id`)

```js
{
  id: string,            // uuid
  blob: Blob,            // the binary (JPEG for photos, audio for voice notes)
  kind: 'photo' | 'audio',
  w: number,             // pixels; 0 for audio
  h: number,             // pixels; 0 for audio
  mime: string           // e.g. 'image/jpeg', 'audio/webm'
}
```

Photos are downscaled at ingest to max 1600px on the long edge, JPEG quality 0.8
(see `ingest.js`). Blobs are content, entries are metadata — never store base64 in entries.

### Meta (IndexedDB store `meta`, keyPath `id`)

Internal to `store.js`. Used for dirty-tracking (`{ id: 'dirty:<entryId>', at: ISO }`)
and small settings. Other modules do not touch this store directly.

### DB

Database name `wayfarer`, version 1, stores: `entries`, `blobs`, `meta`.
If IndexedDB is unavailable (e.g. Safari private mode), `store.js` falls back to
in-memory Maps for the session and emits a `'toast'` warning — the app keeps working,
nothing throws.

---

## 2. Event bus

`js/state.js` exports `bus` — a thin EventTarget wrapper:

```js
bus.on(evt, fn)      // fn receives the detail object directly (not the Event)
bus.off(evt, fn)
bus.emit(evt, detail)
```

### Events (complete list — do not invent others)

| Event             | detail                                                | Emitted by → consumed by |
|-------------------|--------------------------------------------------------|--------------------------|
| `entries-changed` | `{ reason?: 'save'\|'delete'\|'import'\|'sync'\|'demo' }` | anything that mutates entries → main.js (cache), book.js, journal.js, sync.js |
| `view-changed`    | `{ view: 'book'\|'journal' }`                          | main.js → book.js, journal.js |
| `auth-changed`    | `{ session: object\|null, mode: 'local'\|'cloud' }`    | auth.js → main.js, sync.js |
| `compose-open`    | `{ entryId?: string }` (absent ⇒ new entry)            | book.js, journal.js → main.js (compose controller) |
| `compose-close`   | `{ saved: boolean, entryId?: string }`                 | main.js → any |
| `toast`           | `{ message: string, kind?: 'info'\|'success'\|'error'\|'warning' }` | any module → main.js (renders via util.toast) |

**Convention:** any code that mutates entries calls `store.*` first, *then* emits
`entries-changed`. Listeners re-query `store.listEntries()` (async). `app.entries` is a
convenience snapshot cache maintained by `main.js`; treat it as read-only and possibly
one tick stale.

---

## 3. Module public APIs

All paths relative; import as `import { x } from './store.js'` (from within `js/`).

### js/state.js  (architect-owned, done)
```js
export const app = {
  entries: [],            // snapshot cache, maintained by main.js
  session: null,          // Supabase session or null (set by auth.js)
  view: 'book',           // 'book' | 'journal'
  settings: { theme: 'passport' }  // 'passport' | 'minimal' | 'scrapbook'
};
export const bus;          // { on, off, emit } as above
```

### js/store.js  (architect-owned, done)
```js
export async function initDB();                 // open DB; memory fallback + toast on failure
export async function listEntries();            // non-deleted, sorted by dateISO then createdAt
export async function getEntry(id);             // Entry | undefined
export async function saveEntry(entry);         // stamps createdAt (if new) + updatedAt, puts, marks dirty; returns entry
export async function softDeleteEntry(id);      // sets deleted=true, stamps updatedAt, marks dirty
export async function putBlob(rec);             // BlobRec in, returns rec
export async function getBlob(id);              // BlobRec | undefined
export async function deleteBlob(id);
export async function markDirty(id);            // entry id needing sync
export async function getDirty();               // string[] of dirty entry ids
export async function clearDirty(id);
export async function allForExport();           // { version: 1, exportedAt, entries: Entry[] (non-deleted), blobs: BlobRec[] (referenced only, live Blob objects) }
export async function importData(payload);      // accepts allForExport shape; blob recs may carry `dataUrl` instead of `blob`; returns { entries: n, blobs: n }. Does NOT emit events — caller emits 'entries-changed'.
```

### js/util.js  (architect-owned, done)
```js
export function esc(s);                          // HTML-escape a string
export function uid();                           // crypto.randomUUID() with fallback
export function fmtDate(dateISO, opts?);         // 'YYYY-MM-DD' → localized 'Mar 5, 2026'; '' on invalid
export function debounce(fn, ms);
export function blobUrl(id, blob);               // cached URL.createObjectURL keyed by id
export function releaseBlobUrl(id);              // revoke one cached URL
export function revokeAll();                     // revoke every cached object URL
export function toast(message, kind='info');     // renders into #toast-root; kinds: info|success|error|warning
export function confirmDialog(message, danger=false); // Promise<boolean>, uses #confirm-modal
```

### js/main.js  (architect-owned, done)
Boot orchestrator + the **complete compose-modal controller**. Exposes no API.
Boot order: `initDB()` → load entries → apply theme → `(await import('./auth.js')).initAuth()`
→ `initBook(#book-root)`, `initJournal(#journal-root)` → `initSync()`, `initExporter()` →
wire toolbar / view toggle / theme picker / compose. Listens for `compose-open`.

### js/book.js  (Builder 1) — with css/book.css
```js
export function initBook(rootEl);                // build the page-flip book inside rootEl; re-render on 'entries-changed'; respect 'view-changed'
export const bookApi = {
  goTo(entryId),                                 // flip to the spread containing this entry
  next(),
  prev()
};
```
Book renders inside `#book-root`. It owns everything inside that element. Empty state:
inviting "start your first entry" spread that emits `compose-open`. Edit affordance per
entry emits `compose-open` with `{ entryId }`.

### js/exif.js  (Builder 2)
```js
export async function extractExif(file);         // → { lat: number|null, lon: number|null, takenAt: string|null (ISO) } — never throws, nulls when absent
```
Port the proven dependency-free JPEG APP1 parser from `legacy/wayfarer-v1.html`.

### js/ingest.js  (Builder 2)
```js
export async function ingestFiles(fileListOrArray);
// → Array<{ blobRec: BlobRec (kind 'photo', NOT yet persisted), exif: {lat,lon,takenAt} }>
// Filters to image/*; canvas-downscales to max 1600px long edge, JPEG q0.8; fills w/h/mime.
// Skips unreadable files silently (never throws); returns [] for no valid images.
```
Ingest does **not** call `putBlob` — the compose controller persists on save.

### js/geocode.js  (Builder 2)
```js
export async function reverseGeocode(lat, lon);  // → 'City, Country' string | null (never throws)
export async function forwardGeocode(q);         // → { lat, lon, name } | null (never throws)
export const ATTRIBUTION;                        // string with © OpenStreetMap contributors (HTML-safe)
```
Cache results, rate-limit ≥1100ms between requests, `zoom=10`. Offline / error ⇒ `null`.

### js/voice.js  (Builder 3) — with css/voice.css
```js
export function initDictation({ textarea, button, statusEl });
// Web Speech API dictation into `textarea`, toggled by `button`, state text in `statusEl`.
// Must handle: unsupported browser (disable button, explain in statusEl), permission
// denied, listening, interim results. Never an alert.

export function createVoiceRecorder(rootEl);
// Renders a record/stop/play/discard voice-note widget into rootEl (MediaRecorder).
// → { getResult(): { blob, duration, mime } | null, reset(): void }

export function renderVoicePlayer(rootEl, blob); // read-only playback widget (used by book/journal)
```

### js/auth.js  (Builder 4)
```js
export async function initAuth();
// If config.SUPABASE_URL/ANON_KEY are empty: LOCAL MODE — hide #login-gate, hide
// #btn-signout, emit 'auth-changed' { session: null, mode: 'local' }. Never load Supabase.
// If configured: dynamic-import supabase from esm.sh, restore session, wire the
// magic-link form inside #login-gate, show/hide gate based on session, emit 'auth-changed'.
export function getClient();                     // Supabase client | null (local mode)
export async function signOut();
```

### js/sync.js  (Builder 4)
```js
export function initSync();
// Local mode: set #sync-status to a quiet 'Local' pill and stop.
// Cloud mode: push dirty entries + blobs to Supabase (bucket config.BUCKET), pull remote,
// last-write-wins on updatedAt, tombstones via deleted=true, update #sync-status
// (idle/syncing/offline/error), listen to 'entries-changed' + 'auth-changed' + online/offline.
```

### js/journal.js  (Builder 5) — with css/journal.css
```js
export function initJournal(rootEl);             // chronological journal/timeline view in #journal-root; re-render on 'entries-changed'; edit via 'compose-open' { entryId }
```

### js/narratives.js  (Builder 5)
```js
export function narrativeFor(placeName);         // → { text: string, sourced: boolean } — curated history library ported from legacy v1 (NARRATIVES + normalizeKey); sourced=false with '' text when unknown
```

### js/exporter.js  (Builder 5)
```js
export function initExporter();
// Wires #btn-export-json (download JSON of allForExport with blobs as dataURLs),
// #btn-import-json (via hidden #import-json-input → store.importData → emit 'entries-changed'),
// #btn-export-html (self-contained shareable HTML page, photos embedded — port v1 approach).
```

### js/demo.js  (Builder 5)
```js
export async function loadDemo();                // seed a small demo diary (generated placeholder images drawn on canvas — no network), save via store, emit 'entries-changed' { reason: 'demo' }
```

### config.js  (architect-owned; user fills in)
```js
export const config = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', BUCKET: 'wayfarer-media' };
```

---

## 4. index.html — complete element ID inventory

`index.html` is **frozen** — architect-owned, no builder edits it. All IDs below exist.

| ID | What it is | Behavior owned by |
|----|------------|-------------------|
| `#app` | main app wrapper (everything except gate/modals/toasts) | main.js |
| `#boot-splash` | initial "Opening your diary…" state, removed by main.js after boot | main.js |
| `#login-gate` | full-screen landing/login overlay (`hidden` by default) | auth.js |
| `#login-email` | email input inside gate | auth.js |
| `#login-send` | "Send magic link" button | auth.js |
| `#login-status` | status line inside gate (sending / sent / error) | auth.js |
| `#book-root` | book view container | book.js |
| `#journal-root` | journal view container (`hidden` when view is book) | journal.js |
| `#view-toggle` | segmented control; two `<button data-view="book|journal">` | main.js |
| `#theme-picker` | three `<button data-app-theme="passport|minimal|scrapbook">` swatches | main.js |
| `#sync-status` | small status pill in the header | sync.js |
| `#btn-new-entry` | primary "New entry" button | main.js |
| `#btn-export-json` / `#btn-import-json` / `#btn-export-html` | toolbar export/import | exporter.js |
| `#import-json-input` | hidden `<input type=file accept=application/json>` | exporter.js |
| `#btn-load-demo` | "Load demo trip" (shown in empty states too) | main.js → demo.loadDemo() |
| `#btn-signout` | sign out (hidden in local mode) | auth.js |
| `#compose-modal` | `<dialog>` — the writing-desk sheet | main.js |
| `#compose-heading` | dialog h2 ("New entry" / "Edit entry") | main.js |
| `#compose-photos-drop` | photo dropzone (click or drag) | main.js |
| `#compose-photo-input` | hidden `<input type=file accept=image/* multiple>` | main.js |
| `#compose-photo-list` | thumbnail strip with remove buttons | main.js |
| `#compose-title` | title text input | main.js |
| `#compose-date` | `<input type=date>` | main.js |
| `#compose-location` | location text input | main.js |
| `#compose-location-status` | status line under location ('Location from photo' / 'Add location') | main.js |
| `#compose-story` | story `<textarea>` | main.js |
| `#compose-mic-btn` | dictation toggle button | voice.js (via initDictation) |
| `#compose-dictation-status` | dictation status line | voice.js |
| `#compose-voice-root` | voice-note recorder mount point | voice.js (via createVoiceRecorder) |
| `#compose-save` | save button | main.js |
| `#compose-cancel` | cancel button | main.js |
| `#compose-delete` | delete button (hidden for new entries) | main.js |
| `#confirm-modal` | `<dialog>` for confirmations | util.confirmDialog |
| `#confirm-message` | message paragraph | util.confirmDialog |
| `#confirm-ok` / `#confirm-cancel` | dialog buttons | util.confirmDialog |
| `#toast-root` | fixed toast stack container | util.toast |
| `#osm-attribution` | footer attribution slot (geocode.js sets its content once used) | geocode.js |

Views: `main.js` toggles `hidden` on `#book-root` / `#journal-root` on view change —
views render their content but do not manage their own visibility.

---

## 5. Theming & CSS tokens (css/base.css)

Two independent axes on `<html>`:

- `data-app-theme="passport" | "minimal" | "scrapbook"` — the **paper** look
  (set by main.js from `#theme-picker`, persisted in `localStorage['wayfarer-theme']`).
  Paper surfaces stay cream/light in all cases.
- `data-theme="light" | "dark"` — the **scene around the book** (desk/backdrop).
  Defaults follow `prefers-color-scheme`; explicit `:root[data-theme="…"]` overrides win.

Core custom properties (use these, never raw colors):
`--paper`, `--paper-edge`, `--ink`, `--ink-soft`, `--accent`, `--accent-soft`,
`--tape`, `--line`, `--shadow`, `--stamp`, `--scene-bg`, `--scene-ink`,
`--font-body` (serif), `--font-script` (script accent), `--font-ui` (system-ui),
`--radius`, `--radius-sm`, `--focus-ring`, `--grain` (paper-grain background-image),
`--dur-1`/`--dur-2` (motion durations, zeroed under reduced motion).

Class helpers provided by base.css: `.paper` (cream sheet + grain + edge), `.btn`,
`.btn-primary`, `.btn-ghost`, `.script` (script accent type), `.visually-hidden`.

---

## 6. File ownership map

| Owner | Files (exclusive write access) |
|-------|-------------------------------|
| **Architect** (done — frozen) | `ARCHITECTURE.md`, `index.html`, `config.js`, `js/state.js`, `js/store.js`, `js/util.js`, `js/main.js`, `css/base.css`, `css/app.css`, `README.md`, `.gitignore` |
| **Builder 1 — Book** | `js/book.js`, `css/book.css` |
| **Builder 2 — Capture** | `js/exif.js`, `js/ingest.js`, `js/geocode.js` |
| **Builder 3 — Voice** | `js/voice.js`, `css/voice.css` |
| **Builder 4 — Auth + Sync** | `js/auth.js`, `js/sync.js`, `supabase/schema.sql`, `SETUP.md` |
| **Builder 5 — Journal + Export + Demo** | `js/journal.js`, `js/narratives.js`, `js/exporter.js`, `js/demo.js`, `css/journal.css` |

Everyone: append a dated summary to `worklog/<yourmodule>.md`; cross-file requests go to
`worklog/<yourmodule>-needs.md`. Run `node --check` on every JS file you write.

Stub files for all builder modules already exist and export the exact contract
signatures as graceful no-ops — replace the bodies, keep the signatures.

---

## 7. Addendum — 2026-07-12 share cards + Cloudflare Pages

Sanctioned extensions to the contracts above (integrated and verified):

- **New bus event** (addition to the §2 table):

  | Event         | detail                 | Emitted by → consumed by |
  |---------------|------------------------|--------------------------|
  | `share-entry` | `{ entryId: string }`  | book.js, journal.js → sharecard.js (share modal) |

- **js/storycard.js** — pure canvas renderer, no DOM UI:
  `FORMATS = { story: {w:1080,h:1920,label}, square: {w:1080,h:1080,label} }`;
  `async renderStoryCard(entry, 'story'|'square') -> { blob, width, height, filename }`
  (never throws; falls back to a minimal typographic card).
- **js/sharecard.js** + **css/share.css** — `initShareCard()` (called by main.js at
  boot); listens for `share-entry`, drives the `#share-modal` dialog, lazily
  imports storycard.js, Web Share Level 2 with download fallback.
- **index.html new IDs** (share modal): `#share-modal`, `#share-close`,
  `#share-heading`, `#share-entry-line`, `#share-format`, `#share-preview`,
  `#share-status`, `#share-hint`, `#share-download`, `#share-native`.
- **Hosting** — now Cloudflare Pages at the ROOT of a `*.pages.dev` domain
  (GitHub Pages retired; keep every path `./relative` anyway).
  `functions/_middleware.js` is a standalone Pages Function (password gate —
  it must never import app modules); `wrangler.toml` + `SETUP-CLOUDFLARE.md`
  cover deploys.

## 8. Addendum — Phase 1A: password auth + device isolation

Sanctioned additive extensions (no frozen contract changed):

- **Entry `owner` field** (additive to the §1 Entry model): `owner: string|null` —
  the uid that owns the entry, or `null`/absent for an *unclaimed* local entry.
  Stamped once by `store.saveEntry()` from the active owner and never overwritten;
  `store.importData()` preserves an incoming `owner` verbatim. This is the device-
  isolation key — it closes both the push leak and the read leak on shared devices.
- **New `store.js` exports** (additive; existing signatures unchanged):
  - `setActiveOwner(uid)` / `getActiveOwner()` — the uid this device is acting for
    (`null` in local mode). `listEntries()` now returns only entries whose owner
    equals the active owner (unclaimed entries in local mode, own entries when
    signed in). `saveEntry()` stamps unstamped entries with the active owner.
  - `adoptLocalEntries(uid)` → number — claims every unclaimed entry for `uid`
    (marks each dirty), used by the first-sign-in adopt flow.
  - `clearLocalData()` — wipes `entries` + `blobs` + `meta`; only the explicit
    "Sign out & clear this device" action calls it, never a normal sign-out.
- **`sync.js` owner plumbing**: `startEngine()` calls `setActiveOwner(uid)` before
  the first sync and `stopEngine()` calls `setActiveOwner(null)` (each emits
  `entries-changed {reason:'sync'}` so views re-scope). `pushDirty()` skips any
  entry whose `owner !== userId` (kept dirty, never leaked). `applyRemoteRow()`
  stamps `owner = userId` on pulled rows. On first cloud sign-in, unclaimed dirty
  entries trigger a default-No `confirmDialog` adopt prompt.
- **`auth.js` multi-view gate**: the runtime-injected `#login-gate` is now a state
  machine — SIGN IN / CREATE ACCOUNT / FORGOT PASSWORD / SET NEW PASSWORD — wiring
  `signInWithPassword`, `signUp`, `resetPasswordForEmail`, `updateUser` (on the
  `PASSWORD_RECOVERY` event), with `signInWithOtp` (magic link) and
  `signInWithOAuth({provider:'google'})` as secondary actions. Password fields are
  injected before first paint (autocomplete `current-password`/`new-password` per
  view). A runtime-injected "Sign out & clear this device" button sits beside
  `#btn-signout`. Local mode (empty config) is unchanged — Supabase never loads.
