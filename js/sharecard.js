// sharecard.js — the share-a-page modal. OWNER: share-ui builder (with css/share.css).
// Listens for the bus event 'share-entry' { entryId }, renders the entry into a
// PNG card via ./storycard.js — contract: async renderStoryCard(entry,
// 'story'|'square') -> { blob, width, height, filename } — and offers native
// sharing (Web Share Level 2, files) with a download fallback.
//
// The modal is the native <dialog> #share-modal, same pattern as
// #compose-modal: showModal() renders the rest of the page inert (that is the
// focus trap), Esc funnels through the native 'cancel'→'close' path, a click
// on the backdrop closes, and focus is restored to the opener afterwards.
//
// storycard.js (built in parallel) is dynamically imported on first use: the
// renderer is canvas-heavy and lazy loading keeps boot fast and resilient.
//
// XSS: every user string reaches the DOM via textContent / property
// assignment — never innerHTML.

import { bus } from './state.js';
import { getEntry } from './store.js';
import { fmtDate, toast } from './util.js';

const FORMAT_LABELS = { story: 'Story 9:16', square: 'Square 1:1' };

const $ = (id) => document.getElementById(id);

let dlg = null;
let previewEl = null, statusEl = null, hintEl = null, entryLineEl = null;
let toggleEl = null, btnShare = null, btnDownload = null, btnClose = null;

let isOpen = false;
let session = 0;          // bumped on every open/close; stale async work checks it
let entry = null;         // the entry being shared this session
let format = 'story';     // currently selected format
let cache = new Map();    // format -> { blob, width, height, filename, url }
let pending = new Set();  // formats with a render already in flight
let openerEl = null;      // element to restore focus to on close
let shareCapable = null;  // null until probed with a real File; then boolean
let rendererPromise = null;

/* ---------------- tiny DOM helper (user text ONLY via textContent) ------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ---------------- renderer loading ---------------- */

function loadRenderer() {
  if (!rendererPromise) {
    rendererPromise = import('./storycard.js');
    // a failed load (module still landing / offline cache miss) may be retried
    rendererPromise.catch(() => { rendererPromise = null; });
  }
  return rendererPromise;
}

/* ---------------- preview states ---------------- */

function showSkeleton() {
  previewEl.textContent = '';
  previewEl.setAttribute('aria-busy', 'true');
  const sk = el('div', 'share-skeleton paper');
  sk.append(
    el('span', 'share-skel-orn', '✦ ✦ ✦'),
    el('p', 'script share-skel-word', 'Pressing your page…')
  );
  previewEl.appendChild(sk);
  statusEl.textContent = 'Pressing your page…';
  btnShare.disabled = true;
  btnDownload.disabled = true;
}

/** If the renderer exports pixel dimensions, let the skeleton match them. */
function refineSkeleton(FORMATS, fmt, mySession) {
  if (mySession !== session) return;
  const f = FORMATS && FORMATS[fmt];
  const sk = previewEl.querySelector('.share-skeleton');
  if (!sk || !f) return;
  // storycard.js's frozen contract spells these { w, h }; accept both.
  const w = Number(f.w ?? f.width);
  const h = Number(f.h ?? f.height);
  if (w > 0 && h > 0) sk.style.aspectRatio = `${w} / ${h}`;
}

function showPreview(item) {
  previewEl.textContent = '';
  previewEl.removeAttribute('aria-busy');
  const img = document.createElement('img');
  img.className = 'share-preview-img';
  img.src = item.url; // object URL — revoked when the modal closes
  if (Number(item.width) > 0) img.width = item.width;
  if (Number(item.height) > 0) img.height = item.height;
  img.alt = `${FORMAT_LABELS[format] || format} card preview for “${(entry && entry.title) || 'Untitled day'}”`;
  img.draggable = false;
  previewEl.appendChild(img);
  statusEl.textContent = 'Your card is ready.';
  probeShareSupport(item);
  btnDownload.disabled = false;
  btnShare.disabled = !shareCapable;
}

function showRenderError() {
  previewEl.textContent = '';
  previewEl.removeAttribute('aria-busy');
  const box = el('div', 'share-error');
  box.appendChild(el('p', 'share-error-text',
    'The card wouldn’t print this time. Your entry is safe — try again.'));
  const retry = el('button', 'btn', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => renderFormat(format));
  box.appendChild(retry);
  previewEl.appendChild(box);
  statusEl.textContent = 'The card couldn’t be made.';
  btnShare.disabled = true;
  btnDownload.disabled = true;
}

/* ---------------- rendering ---------------- */

function syncToggle() {
  for (const b of toggleEl.querySelectorAll('[data-format]')) {
    b.setAttribute('aria-pressed', String(b.dataset.format === format));
  }
}

async function renderFormat(fmt) {
  format = fmt;
  previewEl.dataset.format = fmt;
  syncToggle();

  const cached = cache.get(fmt);
  if (cached) { showPreview(cached); return; } // both formats cached once rendered

  showSkeleton();
  if (pending.has(fmt)) return; // in-flight render will display when it lands
  pending.add(fmt);
  const mySession = session;
  const myEntry = entry;
  try {
    const { renderStoryCard, FORMATS } = await loadRenderer();
    refineSkeleton(FORMATS, fmt, mySession);
    const res = await renderStoryCard(myEntry, fmt);
    if (mySession !== session) return; // modal closed (or reopened) meanwhile
    if (!res || !res.blob) throw new Error('storycard returned no image');
    const item = {
      blob: res.blob,
      width: res.width,
      height: res.height,
      filename: res.filename || 'wayfarer-page.png',
      url: URL.createObjectURL(res.blob)
    };
    cache.set(fmt, item);
    if (isOpen && fmt === format) showPreview(item);
  } catch (err) {
    console.error('Wayfarer share: card render failed', err);
    if (mySession === session && isOpen && fmt === format) showRenderError();
  } finally {
    if (mySession === session) pending.delete(fmt);
  }
}

/* ---------------- share / download actions ---------------- */

function probeShareSupport(item) {
  if (shareCapable === null) {
    try {
      const f = new File([item.blob], item.filename, { type: 'image/png' });
      shareCapable = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (err) {
      shareCapable = false; // no File constructor / canShare threw
    }
  }
  btnShare.hidden = !shareCapable;
  hintEl.hidden = !!shareCapable; // quiet hint for non-sharing desktops
}

function doDownload() {
  const item = cache.get(format);
  if (!item) return;
  const a = document.createElement('a');
  a.href = item.url;
  a.download = item.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Card saved — check your downloads.', 'success');
}

async function doShare() {
  const item = cache.get(format);
  if (!item) return;
  let file = null;
  try {
    file = new File([item.blob], item.filename, { type: 'image/png' });
  } catch (err) { /* fall through to download */ }
  if (!file || !navigator.canShare || !navigator.canShare({ files: [file] })) {
    doDownload();
    return;
  }
  try {
    await navigator.share({
      files: [file],
      title: (entry && entry.title) || 'A page from my travel diary'
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user changed their mind — silent
    console.warn('Wayfarer share: navigator.share failed', err);
    toast('Sharing didn’t work here — downloading the card instead.', 'warning');
    doDownload();
  }
}

/* ---------------- open / close ---------------- */

async function openShare(entryId) {
  if (!dlg) return;
  if (typeof dlg.showModal !== 'function') {
    toast('This browser can’t open the share view (no dialog support). Please use a current browser.', 'error');
    return;
  }
  if (isOpen || dlg.open) return; // one share session at a time

  let e = null;
  try {
    e = await getEntry(entryId);
  } catch (err) {
    console.error('Wayfarer share: could not load entry', err);
  }
  if (!e || e.deleted) {
    toast('That entry can’t be found any more.', 'error');
    return;
  }
  // Re-check after the await: a concurrent openShare() (double-click — two
  // handlers pass the guard above before either getEntry resolves) may have
  // opened the dialog meanwhile; a second showModal() would throw.
  if (isOpen || dlg.open) return;

  openerEl = document.activeElement;
  session++;
  isOpen = true;
  entry = e;
  format = 'story';
  cache = new Map();
  pending = new Set();

  entryLineEl.textContent = [e.title || 'Untitled day', fmtDate(e.dateISO)]
    .filter(Boolean).join(' — ');
  // capability is per-browser: if a previous session already proved it, apply now
  btnShare.hidden = shareCapable === false;
  hintEl.hidden = shareCapable !== false;
  statusEl.textContent = '';

  dlg.showModal();
  btnClose.focus();
  renderFormat('story'); // story format renders immediately
}

function closeShare() {
  if (!isOpen) return;
  isOpen = false;
  session++;
  for (const item of cache.values()) URL.revokeObjectURL(item.url);
  cache = new Map();
  pending = new Set();
  entry = null;
  previewEl.textContent = '';
  statusEl.textContent = '';
  if (dlg.open) dlg.close();
  if (openerEl && openerEl.isConnected && typeof openerEl.focus === 'function') {
    openerEl.focus();
  }
  openerEl = null;
}

/* ---------------- init ---------------- */

export function initShareCard() {
  dlg = $('share-modal');
  previewEl = $('share-preview');
  statusEl = $('share-status');
  hintEl = $('share-hint');
  entryLineEl = $('share-entry-line');
  toggleEl = $('share-format');
  btnShare = $('share-native');
  btnDownload = $('share-download');
  btnClose = $('share-close');
  if (!dlg || !previewEl || !statusEl || !hintEl || !entryLineEl ||
      !toggleEl || !btnShare || !btnDownload || !btnClose) {
    console.warn('Wayfarer share: #share-modal markup missing — share disabled');
    dlg = null;
    return;
  }

  toggleEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-format]');
    if (btn && btn.dataset.format !== format) renderFormat(btn.dataset.format);
  });
  btnShare.addEventListener('click', doShare);
  btnDownload.addEventListener('click', doDownload);
  btnClose.addEventListener('click', closeShare);

  // backdrop click (the dialog's own padding) closes
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) closeShare();
  });
  // Esc / any native close path funnels through here for cleanup + focus restore
  dlg.addEventListener('close', () => { if (isOpen) closeShare(); });

  bus.on('share-entry', (d) => {
    if (d && d.entryId) openShare(d.entryId);
  });
}
