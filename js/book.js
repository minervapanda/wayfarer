// book.js — the page-flip scrapbook book. OWNER: Builder 1 (with css/book.css).
// Contract: ARCHITECTURE.md §3 — initBook(rootEl) + bookApi { goTo, next, prev }.
//
// Model: `faces` is a flat list [cover, toc, ...one per entry, closing],
// padded to an even count. Desktop pairs faces onto absolutely-stacked
// `sheets` (front = face 2i, back = face 2i+1) that rotate around the spine;
// `pos` = number of flipped sheets (0 = closed at cover, N = closed at back).
// Mobile (<720px) is a single-page flipper over the same faces (`faceIdx`).
// The turn is driven by a --flip-angle custom property (degrees 0…-180);
// css/book.css derives the moving shadow from the same property.

import { app, bus } from './state.js';
import { listEntries, getBlob, softDeleteEntry } from './store.js';
import { fmtDate, blobUrl, toast, confirmDialog, entryDisplayTitle } from './util.js';
import { renderVoicePlayer } from './voice.js';
import { loadDemo } from './demo.js';

const FLIP_MS = 620;         // one deliberate page turn
const FLIP_MS_QUICK = 190;   // staggered TOC jumps
const mqMobile = window.matchMedia('(max-width: 719px)');
const mqReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

let root = null;
let entries = [];
let faces = [];              // [{ el, type, entryId?, pageNo }]
let faceByEntry = new Map(); // entryId -> face index
let sheets = [];             // desktop sheet elements
let pos = 0;                 // desktop: sheets flipped
let faceIdx = 0;             // mobile: visible face
let isMobileLayout = false;
let animating = false;
let dirtyWhileHidden = false;
let renderToken = 0;
let bookEl = null, liveEl = null, navPrevEl = null, navNextEl = null;
let hotLeftEl = null, hotRightEl = null, indicatorEl = null;
let mPageEl = null, mSceneEl = null, mWrapEl = null;

/* ---------------- tiny DOM helpers (user text ONLY via textContent) ------ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function reduced() { return mqReduced.matches; }

// Orientation classes shared with the rest of the app (see ARCHITECTURE.md):
// aspect = w/h; portrait < 0.85, landscape > 1.18, else square.
// Frames follow the class (3/4, 4/3, 1/1) so cover-cropping is minimal.
function orientOf(w, h) {
  if (!w || !h) return 'square';
  const aspect = w / h;
  if (aspect < 0.85) return 'portrait';
  if (aspect > 1.18) return 'landscape';
  return 'square';
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function setAngle(node, deg) {
  node.style.setProperty('--flip-angle', String(deg));
}

function animateAngle(node, from, to, ms) {
  return new Promise((resolve) => {
    if (reduced() || ms <= 0) { setAngle(node, to); resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setAngle(node, to);
      resolve();
    };
    const t0 = performance.now();
    const step = (now) => {
      if (done) return;
      const t = Math.min(1, (now - t0) / ms);
      setAngle(node, from + (to - from) * easeInOut(t));
      if (t < 1) requestAnimationFrame(step); else finish();
    };
    requestAnimationFrame(step);
    // rAF pauses in occluded/minimized windows — never let a flip wedge the book
    setTimeout(finish, ms + 250);
  });
}

/* ---------------- face builders ---------------- */

function buildCoverFace() {
  const inner = el('div', 'bk-face-inner');
  inner.append(
    el('div', 'bk-cover-orn', '✦ ✦ ✦'),
    el('h2', 'bk-cover-title', 'Wayfarer'),
    el('p', 'bk-cover-sub', 'a travel diary'),
    el('div', 'bk-cover-year', spanOfYears())
  );
  return { el: inner, type: 'cover' };
}

function spanOfYears() {
  const years = entries.map((e) => (e.dateISO || '').slice(0, 4)).filter(Boolean).sort();
  if (!years.length) return '· · ·';
  const a = years[0], b = years[years.length - 1];
  return a === b ? `· ${a} ·` : `· ${a} — ${b} ·`;
}

function buildTocFace() {
  const inner = el('div', 'bk-face-inner');
  inner.append(el('p', 'script bk-eyebrow', 'contents'), el('hr', 'bk-rule'));
  const list = el('ol', 'bk-toc-list');
  list.setAttribute('aria-label', 'Table of contents');
  inner.appendChild(list);
  return { el: inner, type: 'toc', list };
}

function fillTocRows(tocFace) {
  // Called after faces[] is final so page numbers are known.
  for (const e of entries) {
    const fi = faceByEntry.get(e.id);
    const face = faces[fi];
    const li = el('li');
    const row = el('button', 'bk-toc-row');
    row.type = 'button';
    // Untitled (e.g. photo-only) entries fall back to place / date instead of blank.
    const title = entryDisplayTitle(e);
    row.setAttribute('aria-label', `Go to page ${face.pageNo}: ${title}`);
    const sub = [fmtDate(e.dateISO), e.location && e.location.name]
      .filter(Boolean)
      .filter((part) => part !== title) // untitled entries use date/place AS the title — don't repeat it
      .join(' · ');
    row.append(
      el('span', 'bk-toc-title', title),
      el('span', 'bk-toc-sub', sub),
      el('span', 'bk-toc-dots'),
      el('span', 'bk-toc-page', String(face.pageNo))
    );
    row.addEventListener('click', () => bookApi.goTo(e.id));
    li.appendChild(row);
    tocFace.list.appendChild(li);
  }
}

function buildEntryFace(entry) {
  const inner = el('div', 'bk-face-inner');
  const art = el('article', 'bk-entry');
  // Display title never blank: title → short place → date → gentle fallback.
  const displayTitle = entryDisplayTitle(entry);
  art.setAttribute('aria-label', displayTitle);

  // — collage (skeleton now, photos hydrate async) —
  const n = entry.photoIds.length;
  if (n > 0) {
    const collage = el('div', 'bk-collage');
    collage.dataset.n = n <= 4 ? String(n) : 'many';
    const shown = n <= 4 ? entry.photoIds : entry.photoIds.slice(0, 5);
    // Frames default to square until hydrateFaces() reads the blob {w,h}.
    collage.dataset.mix = 's'.repeat(shown.length);
    shown.forEach((pid, i) => {
      const fig = el('figure', 'bk-snap');
      fig.dataset.orient = 'square';
      if (n === 1 || (n === 2 && i === 0)) fig.classList.add('bk-tape');
      if (n === 3 && i === 0) {
        fig.classList.add('bk-corners');
        fig.appendChild(el('span', 'bk-corner-b'));
      }
      if (n === 4 && i === 3) fig.classList.add('bk-tape');
      const img = document.createElement('img');
      img.alt = '';
      img.dataset.photoId = pid;
      img.draggable = false;
      fig.appendChild(img);
      collage.appendChild(fig);
    });
    if (n > 5) collage.appendChild(el('span', 'bk-more-count', `+${n - 5} more`));
    art.appendChild(collage);
  } else {
    art.appendChild(el('div', 'bk-stamp', 'a story'));
  }

  // — heading + meta —
  const head = el('header', 'bk-entry-head');
  head.appendChild(el('h3', 'bk-h', displayTitle));
  const meta = el('p', 'bk-meta');
  const dateStr = fmtDate(entry.dateISO);
  // When the heading itself fell back to the date (no title, no location),
  // don't echo the same date again on the meta line right beneath it.
  const titleIsDate = dateStr
    && displayTitle === fmtDate(entry.dateISO, { year: 'numeric', month: 'long', day: 'numeric' });
  if (dateStr && !titleIsDate) meta.appendChild(el('span', null, dateStr));
  if (entry.location && entry.location.name) {
    const pin = el('span', 'bk-pin', '⌖');
    pin.setAttribute('aria-hidden', 'true');
    meta.append(pin, el('span', null, entry.location.name));
  }
  if (meta.childNodes.length) head.appendChild(meta);
  art.appendChild(head);

  // — story (serif, drop cap, scrolls) —
  const story = el('div', 'bk-story');
  story.tabIndex = 0;
  story.setAttribute('aria-label', 'Story');
  const text = (entry.story || '').trim();
  if (text) {
    for (const para of text.split(/\n{2,}/)) {
      const p = el('p');
      const lines = para.split('\n');
      lines.forEach((line, i) => {
        if (i > 0) p.appendChild(document.createElement('br'));
        p.appendChild(document.createTextNode(line));
      });
      story.appendChild(p);
    }
  } else {
    story.appendChild(el('p', 'bk-story-empty', 'No story written for this day — the photos speak.'));
  }
  art.appendChild(story);

  // — voice chip mount (hydrated async when voiceId exists) —
  const voice = el('div', 'bk-voice');
  if (entry.voiceId) art.appendChild(voice);

  // — edit / delete affordances —
  const foot = el('footer', 'bk-entry-foot');
  const editBtn = el('button', 'bk-iconbtn', '✎');
  editBtn.type = 'button';
  editBtn.title = 'Edit entry';
  editBtn.setAttribute('aria-label', `Edit “${displayTitle}”`);
  editBtn.addEventListener('click', () => bus.emit('compose-open', { entryId: entry.id }));
  const shareBtn = el('button', 'bk-iconbtn', '↗');
  shareBtn.type = 'button';
  shareBtn.title = 'Share this page';
  shareBtn.setAttribute('aria-label', `Share “${displayTitle}”`);
  shareBtn.addEventListener('click', () => bus.emit('share-entry', { entryId: entry.id }));
  const delBtn = el('button', 'bk-iconbtn bk-iconbtn-delete', '🗑');
  delBtn.type = 'button';
  delBtn.title = 'Delete entry';
  delBtn.setAttribute('aria-label', `Delete “${displayTitle}”`);
  delBtn.addEventListener('click', async () => {
    const ok = await confirmDialog(
      `Tear this page out of your book? “${displayTitle}” will be removed.`, true);
    if (!ok) return;
    try {
      await softDeleteEntry(entry.id);
      bus.emit('entries-changed', { reason: 'delete' });
      toast('The page was gently torn out.', 'success');
    } catch (err) {
      console.error('Wayfarer book: delete failed', err);
      toast('Couldn’t delete that entry. Please try again.', 'error');
    }
  });
  // shareBtn sits on the same face footer, so syncDesktop()'s inert/aria-hidden
  // sweep covers it exactly like the edit/delete affordances.
  foot.append(editBtn, shareBtn, delBtn);
  art.appendChild(foot);

  inner.appendChild(art);
  return { el: inner, type: 'entry', entryId: entry.id, voiceEl: entry.voiceId ? voice : null };
}

function buildClosingFace() {
  const inner = el('div', 'bk-face-inner');
  const n = entries.length;
  inner.append(
    el('p', 'script bk-closing-script', 'fin.'),
    el('p', 'bk-closing-note',
      `${n} ${n === 1 ? 'memory' : 'memories'} pressed between these pages — until the next adventure.`),
    el('div', 'bk-closing-orn', '✦ ✦ ✦')
  );
  const wrap = { el: inner, type: 'closing' };
  return wrap;
}

function buildBlankFace() {
  return { el: el('div', 'bk-face-inner'), type: 'blank' };
}

/* ---------------- hydration: photos + voice (async, token-guarded) ------- */

async function hydrateFaces(token) {
  for (const face of faces) {
    if (token !== renderToken) return;
    if (face.type !== 'entry') continue;
    const imgs = [...face.el.querySelectorAll('img[data-photo-id]')];
    // Fetch this face's photo records together so every frame shape
    // (data-orient per snap + data-mix on the collage) lands in one pass,
    // before any src is assigned — no frame reshaping under a loaded photo.
    const recs = await Promise.all(
      imgs.map((img) => getBlob(img.dataset.photoId).catch(() => null))
    );
    if (token !== renderToken) return;
    imgs.forEach((img, i) => {
      const rec = recs[i];
      const fig = img.closest('.bk-snap');
      if (fig && rec && rec.w > 0 && rec.h > 0) {
        fig.dataset.orient = orientOf(rec.w, rec.h);
      }
    });
    const collage = face.el.querySelector('.bk-collage');
    if (collage) {
      collage.dataset.mix = Array.from(
        collage.querySelectorAll('.bk-snap'),
        (f) => (f.dataset.orient || 'square')[0]
      ).join('');
    }
    imgs.forEach((img, i) => {
      const rec = recs[i];
      if (rec && rec.blob) {
        img.src = blobUrl(img.dataset.photoId, rec.blob);
        img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
      } else {
        swapMissing(img);
      }
    });
    if (face.voiceEl) {
      const entry = entries.find((e) => e.id === face.entryId);
      if (!entry || !entry.voiceId) continue;
      try {
        const rec = await getBlob(entry.voiceId);
        if (token !== renderToken) return;
        if (rec && rec.blob) renderVoicePlayer(face.voiceEl, rec.blob);
      } catch (err) { /* voice chip stays empty — display: none via :empty */ }
    }
  }
}

function swapMissing(img) {
  const ph = el('span', 'bk-snap-missing', 'photo unavailable');
  img.replaceWith(ph);
}

/* ---------------- render orchestration ---------------- */

// NOTE (integration): blob object URLs come from the SHARED util.blobUrl cache
// (one URL per blob id, also used by journal.js). Never revoke them on
// re-render — the journal's already-rendered <img>s point at the same URLs.
// util.revokeAll() on pagehide is the cleanup path.

async function render() {
  if (!root) return;
  const token = ++renderToken;
  let list;
  try {
    list = await listEntries();
  } catch (err) {
    console.error('Wayfarer book: could not load entries', err);
    if (token !== renderToken) return;
    renderError();
    return;
  }
  if (token !== renderToken) return;
  entries = list;

  root.textContent = '';
  faces = [];
  faceByEntry = new Map();
  sheets = [];

  if (!entries.length) { renderEmpty(); return; }

  // Build faces: cover, toc, entries…, closing (padded even).
  faces.push(buildCoverFace());
  const toc = buildTocFace();
  faces.push(toc);
  for (const e of entries) {
    faceByEntry.set(e.id, faces.length);
    faces.push(buildEntryFace(e));
  }
  if ((faces.length + 1) % 2 !== 0) faces.push(buildBlankFace());
  faces.push(buildClosingFace());
  faces.forEach((f, i) => { f.pageNo = i; }); // cover = 0 (unnumbered), toc = 1, entries from 2
  fillTocRows(toc);

  isMobileLayout = mqMobile.matches;
  if (isMobileLayout) renderMobile(); else renderDesktop();
  hydrateFaces(token);
}

function renderError() {
  root.textContent = '';
  const card = el('div', 'paper bk-state-card');
  card.append(
    el('p', 'script bk-eyebrow', 'oh no'),
    el('h2', null, 'The book won’t open'),
    el('p', null, 'Something went wrong reading your diary from this browser. Your entries are still stored — try again.')
  );
  const retry = el('button', 'btn btn-primary', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => render());
  card.appendChild(retry);
  root.appendChild(card);
}

function renderEmpty() {
  const spread = el('div', 'paper bk-empty-spread');
  const left = el('div', 'bk-empty-half');
  left.append(
    el('p', 'script bk-empty-script', 'Every journey deserves a book.'),
    el('p', 'bk-empty-note', 'Photos, places, stories, even your own voice — kept like a real keepsake.')
  );
  const right = el('div', 'bk-empty-half');
  const start = el('button', 'btn btn-primary', 'Start your first memory');
  start.type = 'button';
  start.addEventListener('click', () => bus.emit('compose-open', {}));
  const demo = el('button', 'btn btn-ghost', 'Or load a sample trip');
  demo.type = 'button';
  demo.addEventListener('click', async () => {
    demo.disabled = true;
    try { await loadDemo(); }
    catch (err) {
      console.error('Wayfarer book: demo failed', err);
      toast('Couldn’t load the sample trip.', 'error');
    }
    finally { demo.disabled = false; }
  });
  right.append(
    el('p', 'bk-empty-note', 'This one is blank and waiting for you.'),
    start, demo
  );
  spread.append(left, right);
  root.appendChild(spread);
}

/* ---------------- desktop: two-page spread ---------------- */

function renderDesktop() {
  const scene = el('div', 'bk-scene');
  scene.setAttribute('role', 'region');
  scene.setAttribute('aria-roledescription', 'book');
  scene.setAttribute('aria-label', 'Your travel diary');

  bookEl = el('div', 'bk-book');
  bookEl.appendChild(el('div', 'bk-shadow'));

  const N = faces.length / 2;
  for (let i = 0; i < N; i++) {
    const sheet = el('div', 'bk-sheet');
    const front = el('div', 'bk-face bk-face-front');
    const back = el('div', 'bk-face bk-face-back');
    decorateFace(front, faces[2 * i]);
    decorateFace(back, faces[2 * i + 1]);
    sheet.append(front, back);
    bookEl.appendChild(sheet);
    sheets.push(sheet);
  }

  hotLeftEl = makeHotspot('left');
  hotRightEl = makeHotspot('right');
  bookEl.append(hotLeftEl, hotRightEl);

  navPrevEl = el('button', 'bk-nav bk-nav-prev', '‹');
  navPrevEl.type = 'button';
  navPrevEl.setAttribute('aria-label', 'Previous pages');
  navPrevEl.addEventListener('click', () => bookApi.prev());
  navNextEl = el('button', 'bk-nav bk-nav-next', '›');
  navNextEl.type = 'button';
  navNextEl.setAttribute('aria-label', 'Next pages');
  navNextEl.addEventListener('click', () => bookApi.next());

  liveEl = el('p', 'visually-hidden');
  liveEl.setAttribute('aria-live', 'polite');

  indicatorEl = el('p', 'bk-indicator');

  scene.append(bookEl, navPrevEl, navNextEl);
  root.append(scene, indicatorEl, liveEl);

  pos = Math.max(0, Math.min(pos, N));
  syncDesktop();
}

function decorateFace(faceEl, face) {
  faceEl.appendChild(face.el);
  if (face.type === 'cover') faceEl.classList.add('bk-face-cover');
  if (face.type === 'closing') faceEl.classList.add('bk-closing');
  if (face.pageNo >= 1 && face.type !== 'cover') {
    faceEl.appendChild(el('span', 'bk-pageno', String(face.pageNo)));
  }
}

function syncDesktop() {
  const N = sheets.length;
  sheets.forEach((sheet, i) => {
    const flipped = i < pos;
    sheet.classList.toggle('is-flipped', flipped);
    setAngle(sheet, flipped ? -180 : 0);
    sheet.style.zIndex = String(flipped ? i + 1 : N - i + 1);
    // Only the two faces of the OPEN spread may hold focus or receive clicks:
    // everything stacked behind / backface-hidden goes inert, so Tab never
    // walks through invisible TOC rows, edit/delete buttons and voice players
    // on pages the user cannot see.
    const front = sheet.children[0]; // right-hand page when i === pos
    const back = sheet.children[1];  // left-hand page when i === pos - 1
    const frontVisible = i === pos;
    const backVisible = i === pos - 1;
    if (front) {
      front.toggleAttribute('inert', !frontVisible);
      front.setAttribute('aria-hidden', String(!frontVisible));
    }
    if (back) {
      back.toggleAttribute('inert', !backVisible);
      back.setAttribute('aria-hidden', String(!backVisible));
    }
  });
  bookEl.dataset.closed = pos === 0 ? 'start' : (pos === N ? 'end' : '');
  bookEl.style.setProperty('--stack-left', String(pos));
  bookEl.style.setProperty('--stack-right', String(N - pos));
  navPrevEl.disabled = pos === 0;
  navNextEl.disabled = pos === N;
  hotLeftEl.disabled = pos === 0;
  hotRightEl.disabled = pos === N;
  const label = spreadLabel();
  indicatorEl.textContent = label;
  liveEl.textContent = label;
}

function spreadLabel() {
  const N = sheets.length;
  const last = faces.length - 1;
  if (pos === 0) return 'Front cover — Wayfarer';
  if (pos === N) return 'Back of the book';
  const l = 2 * pos - 1, r = 2 * pos;
  const name = (f) =>
    f.type === 'toc' ? 'Contents'
      : f.type === 'entry' ? entryDisplayTitle(entries.find((e) => e.id === f.entryId))
      : f.type === 'closing' ? 'The end' : '';
  const parts = [name(faces[l]), name(faces[r])].filter(Boolean).join(' · ');
  return `Pages ${l}–${r} of ${last}${parts ? ' — ' + parts : ''}`;
}

async function flipForward(ms = FLIP_MS) {
  const N = sheets.length;
  if (animating || pos >= N) return;
  animating = true;
  const sheet = sheets[pos];
  sheet.classList.add('is-turning');
  sheet.style.zIndex = String(N + 3);
  await animateAngle(sheet, 0, -180, ms);
  pos++;
  sheet.classList.remove('is-turning');
  syncDesktop();
  animating = false;
}

async function flipBackward(ms = FLIP_MS) {
  if (animating || pos <= 0) return;
  animating = true;
  const N = sheets.length;
  const sheet = sheets[pos - 1];
  sheet.classList.add('is-turning');
  sheet.style.zIndex = String(N + 3);
  await animateAngle(sheet, -180, 0, ms);
  pos--;
  sheet.classList.remove('is-turning');
  syncDesktop();
  animating = false;
}

async function goToPos(target) {
  const N = sheets.length;
  target = Math.max(0, Math.min(target, N));
  if (reduced()) { pos = target; syncDesktop(); return; }
  // staggered quick flips
  let guard = N + 2;
  while (pos !== target && guard-- > 0) {
    if (pos < target) await flipForward(FLIP_MS_QUICK);
    else await flipBackward(FLIP_MS_QUICK);
  }
}

/* --- drag-to-flip (desktop hotspots) --- */

function makeHotspot(side) {
  const hot = el('button', `bk-hot bk-hot-${side}`);
  hot.type = 'button';
  hot.setAttribute('aria-label', side === 'right' ? 'Turn the page forward' : 'Turn the page back');
  let drag = null;

  hot.addEventListener('pointerdown', (ev) => {
    if (animating) return;
    const forward = side === 'right';
    if (forward && pos >= sheets.length) return;
    if (!forward && pos <= 0) return;
    const sheet = forward ? sheets[pos] : sheets[pos - 1];
    const rect = bookEl.getBoundingClientRect();
    drag = {
      sheet, forward,
      spineX: rect.left + rect.width / 2,
      halfW: rect.width / 2,
      startX: ev.clientX,
      moved: false,
      angle: forward ? 0 : -180
    };
    animating = true;
    sheet.classList.add('is-turning');
    sheet.style.zIndex = String(sheets.length + 3);
    hot.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  hot.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.startX) > 6) drag.moved = true;
    if (!drag.moved) return;
    const v = Math.max(-1, Math.min(1, (ev.clientX - drag.spineX) / drag.halfW));
    drag.angle = (v - 1) * 90; // right edge 0deg … left edge -180deg
    setAngle(drag.sheet, drag.angle);
  });

  const finish = async (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (hot.hasPointerCapture && hot.hasPointerCapture(ev.pointerId)) {
      hot.releasePointerCapture(ev.pointerId);
    }
    if (!d.moved) {
      // treated as a click on the corner: full animated flip
      await animateAngle(d.sheet, d.angle, d.forward ? -180 : 0, FLIP_MS);
      pos += d.forward ? 1 : -1;
    } else if (d.angle <= -90) {
      await animateAngle(d.sheet, d.angle, -180, springMs(d.angle, -180));
      if (d.forward) pos++;
    } else {
      await animateAngle(d.sheet, d.angle, 0, springMs(d.angle, 0));
      if (!d.forward) pos--;
    }
    d.sheet.classList.remove('is-turning');
    syncDesktop();
    animating = false;
  };
  hot.addEventListener('pointerup', finish);
  hot.addEventListener('pointercancel', finish);
  return hot;
}

function springMs(from, to) {
  return Math.max(140, Math.abs(to - from) / 180 * FLIP_MS * 0.7);
}

/* ---------------- mobile: single-page flipper ---------------- */

function renderMobile() {
  mSceneEl = el('div', 'bk-mscene');
  mSceneEl.setAttribute('role', 'region');
  mSceneEl.setAttribute('aria-roledescription', 'book');
  mSceneEl.setAttribute('aria-label', 'Your travel diary');

  mWrapEl = el('div', 'bk-mwrap');
  mPageEl = el('div', 'bk-mpage');
  mWrapEl.appendChild(mPageEl);

  navPrevEl = el('button', 'bk-nav', '‹');
  navPrevEl.type = 'button';
  navPrevEl.setAttribute('aria-label', 'Previous page');
  navPrevEl.addEventListener('click', () => bookApi.prev());
  navNextEl = el('button', 'bk-nav', '›');
  navNextEl.type = 'button';
  navNextEl.setAttribute('aria-label', 'Next page');
  navNextEl.addEventListener('click', () => bookApi.next());

  indicatorEl = el('p', 'bk-indicator');
  liveEl = el('p', 'visually-hidden');
  liveEl.setAttribute('aria-live', 'polite');

  const bar = el('div', 'bk-mbar');
  bar.append(navPrevEl, indicatorEl, navNextEl);
  mSceneEl.append(mWrapEl, bar, liveEl);
  root.appendChild(mSceneEl);

  // swipe
  let swipe = null;
  mPageEl.addEventListener('pointerdown', (ev) => { swipe = { x: ev.clientX, y: ev.clientY }; });
  mPageEl.addEventListener('pointerup', (ev) => {
    if (!swipe) return;
    const dx = ev.clientX - swipe.x, dy = ev.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) bookApi.next(); else bookApi.prev();
    }
  });
  mPageEl.addEventListener('pointercancel', () => { swipe = null; });

  faceIdx = Math.max(0, Math.min(faceIdx, faces.length - 1));
  setMobileFace(faceIdx);
}

function setMobileFace(idx) {
  faceIdx = idx;
  const face = faces[idx];
  mPageEl.textContent = '';
  mPageEl.classList.toggle('bk-mcover', face.type === 'cover');
  mPageEl.appendChild(face.el);
  if (face.pageNo >= 1 && face.type !== 'cover') {
    mPageEl.appendChild(el('span', 'bk-pageno', String(face.pageNo)));
  }
  navPrevEl.disabled = idx === 0;
  navNextEl.disabled = idx === faces.length - 1;
  const label = idx === 0 ? 'Cover' : `Page ${idx} of ${faces.length - 1}`;
  indicatorEl.textContent = label;
  liveEl.textContent = label + (face.type === 'entry'
    ? ' — ' + entryDisplayTitle(entries.find((e) => e.id === face.entryId)) : '');
}

async function mobileFlip(dir) {
  const target = faceIdx + dir;
  if (animating || target < 0 || target > faces.length - 1) return;
  if (reduced()) { setMobileFace(target); return; }
  animating = true;
  const current = faces[faceIdx];
  const incoming = faces[target];

  if (dir > 0) {
    // reveal next beneath; peel the current page off to the left
    setMobileFace(target);
    const leaf = buildLeaf(current);
    mWrapEl.appendChild(leaf);
    await animateAngle(leaf, 0, -180, FLIP_MS * 0.85);
    leaf.remove();
  } else {
    // previous page swings in from the left, over the current one
    const leaf = buildLeaf(incoming);
    setAngle(leaf, -180);
    mWrapEl.appendChild(leaf);
    await animateAngle(leaf, -180, 0, FLIP_MS * 0.85);
    setMobileFace(target);
    leaf.remove();
  }
  animating = false;
}

function buildLeaf(face) {
  // temporary front/back flip element; the visual clone is inert on purpose
  const leaf = el('div', 'bk-mflip');
  const front = el('div', 'bk-face bk-face-front');
  if (face.type === 'cover') front.classList.add('bk-face-cover');
  front.appendChild(face.el.cloneNode(true));
  const back = el('div', 'bk-face bk-face-back'); // blank paper reverse
  leaf.append(front, back);
  return leaf;
}

/* ---------------- public API ---------------- */

export const bookApi = {
  goTo(entryId) {
    const fi = faceByEntry.get(entryId);
    if (fi == null) return;
    if (isMobileLayout) {
      if (reduced()) setMobileFace(fi);
      else mobileGoTo(fi);
    } else {
      // even face = a front (right page) → pos = fi/2; odd = a back (left) → pos = (fi+1)/2
      goToPos(fi % 2 === 0 ? fi / 2 : (fi + 1) / 2);
    }
  },
  next() {
    if (isMobileLayout) mobileFlip(1); else flipForward();
  },
  prev() {
    if (isMobileLayout) mobileFlip(-1); else flipBackward();
  }
};

async function mobileGoTo(targetIdx) {
  let guard = faces.length + 2;
  while (faceIdx !== targetIdx && guard-- > 0) {
    const dir = faceIdx < targetIdx ? 1 : -1;
    // near jumps flip, far jumps snap the middle
    if (Math.abs(targetIdx - faceIdx) > 2) setMobileFace(targetIdx - dir);
    await mobileFlip(dir);
    if (animating) break;
  }
}

/* ---------------- wiring ---------------- */

function bookVisible() {
  return app.view === 'book' && root && !root.hidden && root.isConnected;
}

function onKeydown(ev) {
  if (!bookVisible()) return;
  if (ev.defaultPrevented) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.querySelector('dialog[open]')) return;
  if (ev.key === 'ArrowRight') { ev.preventDefault(); bookApi.next(); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); bookApi.prev(); }
}

export function initBook(rootEl) {
  root = rootEl;
  render();

  bus.on('entries-changed', () => {
    if (bookVisible()) render();
    else dirtyWhileHidden = true;
  });

  bus.on('view-changed', ({ view }) => {
    if (view === 'book' && dirtyWhileHidden) {
      dirtyWhileHidden = false;
      render();
    }
  });

  document.addEventListener('keydown', onKeydown);

  const onLayoutChange = () => {
    if (!root) return;
    if (entries.length && mqMobile.matches !== isMobileLayout) render();
  };
  if (typeof mqMobile.addEventListener === 'function') {
    mqMobile.addEventListener('change', onLayoutChange);
  } else if (typeof mqMobile.addListener === 'function') {
    mqMobile.addListener(onLayoutChange); // older Safari
  }
}
