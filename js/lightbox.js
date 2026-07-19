// lightbox.js — shared minimal photo viewer, extracted from journal.js so the
// book view can reuse it (previously the book had no way to enlarge photos and
// its "+N more" tile was a dead label). The overlay is position:fixed and styled
// by .jr-lightbox / .jr-lb-* in css/journal.css, which loads app-wide, so it
// works from any view. Contract:
//   buildLightbox() -> { el, open(photoIds, startIdx, caption), close }

import { blobUrl } from './util.js';
import { getBlob } from './store.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function buildLightbox() {
  const box = el('div', 'jr-lightbox');
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Photo viewer');

  const closeBtn = el('button', 'jr-lb-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close photo viewer');

  const prevBtn = el('button', 'jr-lb-nav jr-lb-prev', '‹');
  prevBtn.type = 'button';
  prevBtn.setAttribute('aria-label', 'Previous photo');
  const nextBtn = el('button', 'jr-lb-nav jr-lb-next', '›');
  nextBtn.type = 'button';
  nextBtn.setAttribute('aria-label', 'Next photo');

  const fig = el('figure', 'jr-lb-fig');
  const img = el('img', 'jr-lb-img');
  img.alt = '';
  const cap = el('figcaption', 'jr-lb-cap');
  fig.append(img, cap);
  box.append(closeBtn, prevBtn, fig, nextBtn);

  let ids = [];
  let idx = 0;
  let caption = '';
  let lastFocus = null;

  function show() {
    img.removeAttribute('src');
    const myIdx = idx;
    getBlob(ids[myIdx]).then((rec) => {
      if (myIdx === idx && rec && rec.blob) img.src = blobUrl(ids[myIdx], rec.blob);
    }).catch(() => { /* leave empty frame */ });
    cap.textContent = ids.length > 1
      ? `${caption} — photo ${idx + 1} of ${ids.length}`
      : caption;
    const many = ids.length > 1;
    prevBtn.hidden = !many;
    nextBtn.hidden = !many;
  }

  function focusables() {
    return [closeBtn, prevBtn, nextBtn].filter((b) => !b.hidden);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft' && ids.length > 1) { idx = (idx - 1 + ids.length) % ids.length; show(); }
    else if (e.key === 'ArrowRight' && ids.length > 1) { idx = (idx + 1) % ids.length; show(); }
    else if (e.key === 'Tab') {
      // aria-modal promises a modal: trap Tab inside the viewer instead of
      // letting focus wander into the invisible page behind the backdrop.
      const f = focusables();
      if (!f.length) return;
      e.preventDefault();
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey
        ? (i <= 0 ? f[f.length - 1] : f[i - 1])
        : (i === -1 || i === f.length - 1 ? f[0] : f[i + 1]);
      next.focus();
    }
  }

  function open(photoIds, startIdx, capText) {
    ids = photoIds.slice();
    idx = Math.max(0, Math.min(startIdx || 0, ids.length - 1));
    caption = capText || '';
    lastFocus = document.activeElement;
    box.hidden = false;
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden'; // scroll-lock the page behind the overlay
    show();
    closeBtn.focus();
  }

  function close() {
    const wasOpen = !box.hidden;
    box.hidden = true;
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    if (wasOpen && lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
  }

  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', () => { idx = (idx - 1 + ids.length) % ids.length; show(); });
  nextBtn.addEventListener('click', () => { idx = (idx + 1) % ids.length; show(); });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });

  return { el: box, open, close };
}
