// drive.js — Google Drive bulk photo import (Phase 5). Runtime-injected UI.
// OWNER: Phase 5 slice. Contract: ROADMAP-MULTIUSER.md Phase 5 + ARCHITECTURE.md.
//
// OFFLINE-FIRST CONTRACT: this module loads NO Google code at boot. When
// config.GOOGLE_CLIENT_ID / GOOGLE_API_KEY are empty the trigger button is never
// injected and nothing here touches the network — the app behaves exactly as it
// does today. The Google Identity Services (GIS) and Picker scripts are fetched
// LAZILY, only the first time the user actually clicks "Import from Google Drive".
//
// index.html is FROZEN, so — like the 'Continue offline' button in auth.js — this
// module injects its own trigger into the header "⋯" menu at runtime and self-
// initialises on load. main.js does not wire it. It also exports initDrive() for
// an explicit caller / a custom mount.
//
// Flow (all client-side): GIS initTokenClient({ scope:'.../drive.file' }) →
// Picker (image DocsView, multi-select) → for each fileId GET
// .../drive/v3/files/{id}?alt=media with the bearer token → wrap the Blob into a
// File → ingestFiles() (1600px/q0.8 downscale + EXIF) in batches ≤24 → group into
// Entries by EXIF capture day (one entry per day; fall back to today) →
// store.putBlob + store.saveEntry → emit 'entries-changed' { reason:'import' }.
// The shipped sync.js pushes the small downscaled JPEGs and surfaces any quota
// error — nothing quota-specific happens client-side here.
//
// CORS caveat: browsers may block the files.get media fetch. If it does, we fail
// gracefully with a clear message that Drive import needs the optional server
// proxy (NOT built here) — we never silently drop the whole batch.

import { config } from '../config.js';
import { bus } from './state.js';
import { toast } from './util.js';
import { ingestFiles } from './ingest.js';
import { putBlob, saveEntry } from './store.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MEDIA_BASE = 'https://www.googleapis.com/drive/v3/files';
const BATCH_SIZE = 24; // matches ingest.js MAX_FILES — never trips its "big batch" toast

let injected = false;   // trigger button is in the DOM
let importing = false;  // an import run is in flight
let cancelled = false;  // user hit Cancel on the progress dialog
let triggerBtn = null;

/* =========================================================================
   Feature gate
   ========================================================================= */

// The whole feature is OFF unless both an OAuth client id and an API key exist.
// (appId is optional.) Empty config ⇒ button hidden ⇒ no Google code ever loads.
function isConfigured() {
  return !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_API_KEY);
}

/* =========================================================================
   Lazy script loading — only ever runs on an explicit import click
   ========================================================================= */

const scriptPromises = Object.create(null);

function loadScript(src) {
  if (scriptPromises[src]) return scriptPromises[src];
  scriptPromises[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing && existing.dataset.wfLoaded === '1') { resolve(); return; }
    const s = existing || document.createElement('script');
    s.src = src;
    s.async = true;
    s.defer = true;
    s.addEventListener('load', () => { s.dataset.wfLoaded = '1'; resolve(); });
    s.addEventListener('error', () => {
      delete scriptPromises[src]; // let a later retry re-attempt
      reject(new Error(`Failed to load ${src}`));
    });
    if (!existing) document.head.appendChild(s);
  });
  return scriptPromises[src];
}

async function ensureGis() {
  await loadScript(GIS_SRC);
  if (!(window.google && window.google.accounts && window.google.accounts.oauth2)) {
    throw new Error('Google Identity Services unavailable');
  }
}

async function ensurePicker() {
  await loadScript(GAPI_SRC);
  if (!window.gapi) throw new Error('gapi unavailable');
  await new Promise((resolve, reject) => {
    try {
      window.gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => reject(new Error('Picker API failed to load')),
        timeout: 15000,
        ontimeout: () => reject(new Error('Picker API load timed out'))
      });
    } catch (err) {
      reject(err);
    }
  });
  if (!(window.google && window.google.picker)) throw new Error('Picker API unavailable');
}

/* =========================================================================
   OAuth token (GIS) — drive.file scope, requested on demand
   ========================================================================= */

function requestAccessToken() {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: config.GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (settled) return;
          settled = true;
          if (resp && resp.access_token) resolve(resp.access_token);
          else reject(new Error(resp && resp.error ? resp.error : 'No access token granted'));
        },
        error_callback: (err) => {
          if (settled) return;
          settled = true;
          reject(err || new Error('Authorization was cancelled'));
        }
      });
      tokenClient.requestAccessToken();
    } catch (err) {
      if (!settled) { settled = true; reject(err); }
    }
  });
}

/* =========================================================================
   Picker — image DocsView, multi-select. Folders are NOT offered: under the
   drive.file scope picking a folder does not cascade access to its children.
   ========================================================================= */

function openPicker(token) {
  return new Promise((resolve) => {
    const picker = window.google.picker;
    const view = new picker.DocsView(picker.ViewId.DOCS_IMAGES);
    if (typeof view.setIncludeFolders === 'function') view.setIncludeFolders(false);
    if (typeof view.setSelectFolderEnabled === 'function') view.setSelectFolderEnabled(false);
    if (typeof view.setMimeTypes === 'function') view.setMimeTypes('image/png,image/jpeg,image/webp,image/heic,image/heif,image/gif');

    const builder = new picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(config.GOOGLE_API_KEY)
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const raw = data[picker.Response.DOCUMENTS] || [];
          const docs = raw.map((d) => ({
            id: d[picker.Document.ID],
            name: d[picker.Document.NAME],
            mimeType: d[picker.Document.MIME_TYPE]
          })).filter((d) => d.id);
          resolve(docs);
        } else if (action === picker.Action.CANCEL) {
          resolve([]);
        }
      });
    if (config.GOOGLE_APP_ID) builder.setAppId(config.GOOGLE_APP_ID);
    builder.build().setVisible(true);
  });
}

/* =========================================================================
   Downloading picked files — files.get alt=media, bearer token
   ========================================================================= */

// A network/CORS failure surfaces as a TypeError from fetch(); an HTTP error
// (401/403/404/…) is a per-file problem we skip and continue past.
function isCorsOrNetworkError(err) {
  return err instanceof TypeError;
}

class DriveHttpError extends Error {
  constructor(status) { super(`Drive files.get HTTP ${status}`); this.status = status; }
}

async function downloadDriveFile(doc, token) {
  const url = `${MEDIA_BASE}/${encodeURIComponent(doc.id)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new DriveHttpError(res.status); // skip-and-continue, not a CORS abort
  const blob = await res.blob();
  const type = (doc.mimeType && /^image\//i.test(doc.mimeType))
    ? doc.mimeType
    : (blob.type && /^image\//i.test(blob.type) ? blob.type : 'image/jpeg');
  const name = doc.name || `${doc.id}.jpg`;
  // Wrap the Blob in a File so ingestFiles()' image/* filter + EXIF read apply.
  return new File([blob], name, { type });
}

/* =========================================================================
   Grouping — one Entry per EXIF capture day (fall back to today)
   ========================================================================= */

function pad2(n) { return String(n).padStart(2, '0'); }

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayFromTakenAt(takenAt) {
  if (typeof takenAt === 'string') {
    const m = takenAt.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return localToday();
}

// Persist each downscaled blob immediately and accumulate photo ids per day.
// Blobs are persisted here (not entries) so memory stays flat across hundreds
// of photos; the day groups (tiny metadata) are committed to entries at the end.
async function flushBatch(files, dayGroups) {
  const results = await ingestFiles(files); // ≤ BATCH_SIZE, so no ingest warning toast
  for (const r of results) {
    if (!r || !r.blobRec) continue;
    await putBlob(r.blobRec);
    const day = dayFromTakenAt(r.exif && r.exif.takenAt);
    let g = dayGroups.get(day);
    if (!g) { g = { photoIds: [], lat: null, lon: null, source: 'none' }; dayGroups.set(day, g); }
    g.photoIds.push(r.blobRec.id);
    if (g.lat == null && r.exif && r.exif.lat != null && r.exif.lon != null) {
      g.lat = r.exif.lat;
      g.lon = r.exif.lon;
      g.source = 'exif';
    }
  }
  return results.length;
}

// Commit accumulated day groups as Entries. saveEntry() stamps id/createdAt/
// updatedAt/owner and marks each dirty; sync.js pushes them. One emit for the lot.
async function commitGroups(dayGroups) {
  let n = 0;
  for (const [day, g] of dayGroups) {
    if (!g.photoIds.length) continue;
    await saveEntry({
      title: '',
      dateISO: day,
      location: { name: '', lat: g.lat, lon: g.lon, source: g.source },
      story: '',
      photoIds: g.photoIds,
      voiceId: null
    });
    n++;
  }
  if (n > 0) bus.emit('entries-changed', { reason: 'import' });
  return n;
}

/* =========================================================================
   Import run — resilient (skip a bad file, keep going), cancellable
   ========================================================================= */

async function runImport(docs, token) {
  const total = docs.length;
  if (!total) return;

  const dayGroups = new Map();
  let attempted = 0;
  let skipped = 0;
  let corsAborted = false;
  let batch = [];

  cancelled = false;
  showProgress(total);

  try {
    for (const doc of docs) {
      if (cancelled) break;
      updateProgress(attempted, total, skipped);
      let file = null;
      try {
        file = await downloadDriveFile(doc, token);
      } catch (err) {
        if (isCorsOrNetworkError(err)) { corsAborted = true; break; }
        console.warn('Wayfarer Drive: skipping a file', doc && doc.id, err);
        skipped++;
        attempted++;
        continue;
      }
      attempted++;
      if (file) batch.push(file);
      else skipped++;

      if (batch.length >= BATCH_SIZE) {
        const got = await flushBatch(batch, dayGroups);
        skipped += batch.length - got;
        batch = [];
        updateProgress(attempted, total, skipped);
      }
    }

    // Always process whatever we already downloaded — even on cancel/CORS abort —
    // so downloaded work (and any persisted blob) is never orphaned.
    if (batch.length) {
      const got = await flushBatch(batch, dayGroups);
      skipped += batch.length - got;
    }

    const saved = await commitGroups(dayGroups);
    hideProgress();

    if (corsAborted) {
      toast(
        'Your browser blocked downloading photo files from Google Drive (CORS). ' +
        'Drive import needs the optional server proxy — until it’s set up, add photos ' +
        'directly with “New entry”.',
        'error'
      );
    } else if (cancelled) {
      toast(
        saved > 0
          ? `Import stopped — kept ${saved} ${saved === 1 ? 'entry' : 'entries'} from the photos already fetched.`
          : 'Import cancelled — nothing was added.',
        'info'
      );
    } else if (saved > 0) {
      const skipNote = skipped > 0 ? ` (${skipped} skipped)` : '';
      toast(`Imported ${total - skipped} ${total - skipped === 1 ? 'photo' : 'photos'} into ${saved} ${saved === 1 ? 'entry' : 'entries'}${skipNote}.`, 'success');
    } else {
      toast('No photos could be imported from that selection.', 'warning');
    }
  } catch (err) {
    console.warn('Wayfarer Drive: import run failed', err);
    hideProgress();
    // Salvage anything already grouped so a mid-run failure doesn't lose work.
    try {
      const saved = await commitGroups(dayGroups);
      if (saved > 0) {
        toast(`Import hit a snag — kept ${saved} ${saved === 1 ? 'entry' : 'entries'} that were ready.`, 'warning');
      } else {
        toast('Something went wrong importing from Google Drive. Please try again.', 'error');
      }
    } catch (err2) {
      toast('Something went wrong importing from Google Drive. Please try again.', 'error');
    }
  }
}

/* =========================================================================
   Progress dialog — runtime-injected <dialog>, cancellable, a11y-aware
   ========================================================================= */

let dlg = null;
let statusEl = null;
let barFill = null;
let cancelBtn = null;

function injectProgressStyle() {
  if (document.getElementById('wf-drive-style')) return;
  const st = document.createElement('style');
  st.id = 'wf-drive-style';
  st.textContent =
    '.wf-drive-dialog{border:1px solid var(--paper-edge);border-radius:var(--radius);' +
    'box-shadow:var(--shadow);padding:22px;max-width:min(92vw,420px);color:var(--ink);' +
    'font-family:var(--font-body);}' +
    '.wf-drive-dialog::backdrop{background:rgba(20,14,8,0.45);}' +
    '.wf-drive-eyebrow{font-family:var(--font-script);color:var(--accent);margin:0 0 2px;font-size:18px;}' +
    '.wf-drive-h2{font-family:var(--font-head);margin:0 0 12px;font-size:20px;}' +
    '.wf-drive-status{margin:0 0 12px;color:var(--ink-soft);font-size:15px;}' +
    '.wf-drive-track{height:10px;border-radius:999px;background:var(--line);overflow:hidden;}' +
    '.wf-drive-fill{height:100%;width:0%;background:var(--accent);border-radius:999px;' +
    'transition:width var(--dur-1) linear;}' +
    '.wf-drive-actions{display:flex;justify-content:flex-end;margin-top:16px;}' +
    '.wf-drive-cancel{min-height:44px;min-width:44px;}' +
    '@media (prefers-reduced-motion: reduce){.wf-drive-fill{transition:none;}}';
  document.head.appendChild(st);
}

function buildProgressDialog() {
  if (dlg) return;
  injectProgressStyle();
  dlg = document.createElement('dialog');
  dlg.className = 'wf-drive-dialog paper';
  dlg.setAttribute('aria-labelledby', 'wf-drive-heading');

  const eyebrow = document.createElement('p');
  eyebrow.className = 'script wf-drive-eyebrow';
  eyebrow.textContent = 'gathering your photos';

  const h2 = document.createElement('h2');
  h2.className = 'wf-drive-h2';
  h2.id = 'wf-drive-heading';
  h2.textContent = 'Importing from Google Drive';

  statusEl = document.createElement('p');
  statusEl.className = 'wf-drive-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.textContent = 'Preparing…';

  const track = document.createElement('div');
  track.className = 'wf-drive-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', '0');
  barFill = document.createElement('div');
  barFill.className = 'wf-drive-fill';
  track.appendChild(barFill);
  dlg._track = track;

  const actions = document.createElement('div');
  actions.className = 'wf-drive-actions';
  cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn wf-drive-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    cancelBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Finishing the photos already fetched…';
  });
  actions.appendChild(cancelBtn);

  dlg.append(eyebrow, h2, statusEl, track, actions);
  // Escape / dialog cancel maps to our Cancel action, never an abrupt close.
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    cancelled = true;
    cancelBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Finishing the photos already fetched…';
  });
  document.body.appendChild(dlg);
}

function showProgress(total) {
  buildProgressDialog();
  cancelBtn.disabled = false;
  if (barFill) barFill.style.width = '0%';
  if (dlg._track) dlg._track.setAttribute('aria-valuenow', '0');
  if (statusEl) statusEl.textContent = total ? `Preparing ${total} ${total === 1 ? 'photo' : 'photos'}…` : 'Preparing…';
  try { if (!dlg.open) dlg.showModal(); } catch (e) { /* dialog unsupported — progress is cosmetic */ }
  try { cancelBtn.focus(); } catch (e) { /* noop */ }
}

function updateProgress(done, total, skipped) {
  if (!dlg) return;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  if (barFill) barFill.style.width = `${pct}%`;
  if (dlg._track) dlg._track.setAttribute('aria-valuenow', String(pct));
  if (statusEl) {
    const skipNote = skipped > 0 ? ` · ${skipped} skipped` : '';
    statusEl.textContent = `Importing ${Math.min(done, total)}/${total}…${skipNote}`;
  }
}

function hideProgress() {
  if (dlg && dlg.open) { try { dlg.close(); } catch (e) { /* noop */ } }
}

/* =========================================================================
   Trigger click → the whole flow
   ========================================================================= */

function setTriggerBusy(on) {
  if (!triggerBtn) return;
  triggerBtn.disabled = on;
  triggerBtn.textContent = on ? 'Connecting to Google…' : 'Import from Google Drive…';
}

async function startImport() {
  if (importing) return;
  if (!isConfigured()) { toast('Google Drive import isn’t configured for this site.', 'warning'); return; }
  importing = true;
  setTriggerBusy(true);
  try {
    try {
      await ensureGis();
      await ensurePicker();
    } catch (err) {
      console.warn('Wayfarer Drive: could not load Google libraries', err);
      toast('Couldn’t reach Google just now — check your connection and try again.', 'error');
      return;
    }

    let token;
    try {
      token = await requestAccessToken();
    } catch (err) {
      console.warn('Wayfarer Drive: authorization not granted', err);
      toast('Google authorization was cancelled — no photos imported.', 'info');
      return;
    }

    let docs;
    try {
      docs = await openPicker(token);
    } catch (err) {
      console.warn('Wayfarer Drive: picker failed', err);
      toast('The Google Drive picker couldn’t open. Please try again.', 'error');
      return;
    }
    if (!docs || !docs.length) return; // cancelled at the picker — silent

    await runImport(docs, token);
  } finally {
    importing = false;
    setTriggerBusy(false);
  }
}

/* =========================================================================
   Trigger injection (header "⋯" menu) + public API + self-init
   ========================================================================= */

function resolveMount(mountFinder) {
  try {
    if (typeof mountFinder === 'function') return mountFinder();
    if (mountFinder && mountFinder.nodeType === 1) return mountFinder;
    if (typeof mountFinder === 'string') return document.querySelector(mountFinder);
  } catch (e) { /* fall through to default */ }
  return document.querySelector('.header-more-menu');
}

function injectTrigger(mount) {
  // Feature gate: with no client id / API key we inject nothing and load no
  // Google code — the app stays exactly as it is today.
  if (!isConfigured()) return;
  const menu = resolveMount(mount);
  if (!menu) return;
  if (menu.querySelector('.btn-drive-import')) { injected = true; return; }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost btn-drive-import';
  btn.style.minHeight = '44px';
  btn.textContent = 'Import from Google Drive…'; // textContent only — no innerHTML
  btn.addEventListener('click', () => {
    const details = menu.closest('details');
    if (details) details.open = false; // close the ⋯ menu so the picker has focus
    startImport();
  });

  const signout = menu.querySelector('#btn-signout');
  if (signout) menu.insertBefore(btn, signout);
  else menu.appendChild(btn);

  triggerBtn = btn;
  injected = true;
}

/**
 * Inject the "Import from Google Drive" trigger (idempotent). Called
 * automatically on module load; also callable explicitly with a custom mount
 * (an element, a selector string, or a function returning an element).
 * No-op — and no Google code loads — when Drive isn't configured.
 * @param {Element|string|Function} [mountFinder]
 */
export function initDrive(mountFinder) {
  if (injected && triggerBtn && triggerBtn.isConnected) return;
  injectTrigger(mountFinder);
}

// Self-init defensively: index.html is frozen and main.js does not wire us, so
// the module wires its own button once the DOM is ready. Guarded on config, so
// an unconfigured deploy still loads nothing from Google.
function autoInit() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initDrive(), { once: true });
  } else {
    initDrive();
  }
}

autoInit();
