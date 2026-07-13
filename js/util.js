// util.js — shared helpers. Architect-owned. Contracts in ARCHITECTURE.md §3.

/** HTML-escape a string. Use before any user text goes near innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** UUID with fallback for older engines / non-secure contexts. */
export function uid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122-ish fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 'YYYY-MM-DD' -> localized 'Mar 5, 2026'. Returns '' for missing/invalid input. */
export function fmtDate(dateISO, opts) {
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return '';
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, opts || { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Human display title for an entry — never blank, so untitled (e.g.
 * photo-only) entries still read well in the book, TOC, share cards and
 * aria-labels. Falls back through: trimmed title → short location name
 * (text before the first comma, 'Kyoto, Japan' → 'Kyoto') → the entry's
 * date ('April 3, 2026') → 'A day worth keeping'.
 * Returns a PLAIN string — escape nothing here; callers use textContent
 * or esc() as appropriate.
 */
export function entryDisplayTitle(entry) {
  const e = entry || {};
  const title = String(e.title ?? '').trim();
  if (title) return title;
  const loc = String((e.location && e.location.name) ?? '').trim();
  if (loc) {
    const short = loc.split(',')[0].trim();
    if (short) return short;
  }
  const date = fmtDate(e.dateISO, { year: 'numeric', month: 'long', day: 'numeric' });
  if (date) return date;
  return 'A day worth keeping';
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/* ---------------- object-URL cache ---------------- */

const urlCache = new Map(); // blob id -> object URL

/** Cached URL.createObjectURL keyed by blob id. */
export function blobUrl(id, blob) {
  if (urlCache.has(id)) return urlCache.get(id);
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

export function releaseBlobUrl(id) {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
}

export function revokeAll() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/* ---------------- toasts ---------------- */

/** Show a toast in #toast-root. kind: 'info' | 'success' | 'error' | 'warning'. */
export function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = { info: '✦', success: '✓', error: '✕', warning: '!' }[kind] || '✦';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = String(message); // textContent — never innerHTML
  el.append(icon, text);
  root.appendChild(el);
  const ttl = kind === 'error' ? 7000 : 4200;
  setTimeout(() => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 400);
  }, ttl);
}

/* ---------------- confirm dialog ---------------- */

let confirmBusy = false;

/**
 * Ask the user to confirm. Uses the #confirm-modal <dialog>.
 * @param {string} message
 * @param {boolean} [danger] styles the OK button destructively.
 * @param {string} [okLabel] custom OK-button label (defaults: 'Delete' when
 *   danger, else 'OK') — e.g. 'Discard' for closing unsaved work.
 * @returns {Promise<boolean>} true if confirmed.
 */
export function confirmDialog(message, danger = false, okLabel = '') {
  const dlg = document.getElementById('confirm-modal');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  if (!dlg || !msgEl || !okBtn || !cancelBtn || confirmBusy || typeof dlg.showModal !== 'function') {
    // Unsupported <dialog> or dialog already open: fail safe, never block, never alert().
    return Promise.resolve(false);
  }
  confirmBusy = true;
  msgEl.textContent = String(message);
  okBtn.classList.toggle('btn-danger', !!danger);
  okBtn.textContent = okLabel || (danger ? 'Delete' : 'OK');
  return new Promise((resolve) => {
    const done = (value) => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      confirmBusy = false;
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => done(false); // Esc / programmatic close
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    (danger ? cancelBtn : okBtn).focus();
  });
}
