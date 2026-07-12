// journal.js — the editorial "chapter stack" journal view. OWNER: Builder 5.
// Read-only view of entries: SVG world map overview, stats, chapters with a
// hero photo, drop-cap narrative (curated history via narrativeFor, else the
// traveler's own story), photo strip with a lightbox, voice-note playback.
// Editing happens through 'compose-open'. Contract: ARCHITECTURE.md §3.
//
// XSS: every user string reaches the DOM via textContent, or via esc() where
// SVG markup is assembled as a string.

import { app, bus } from './state.js';
import { listEntries, getBlob } from './store.js';
import { esc, fmtDate, blobUrl } from './util.js';
import { narrativeFor } from './narratives.js';
import { renderVoicePlayer } from './voice.js';

let root = null;
let renderSeq = 0;        // guards overlapping async renders
let needsRender = true;   // true when hidden view is stale
let lightbox = null;

export function initJournal(rootEl) {
  root = rootEl;
  bus.on('entries-changed', () => {
    needsRender = true;
    if (app.view === 'journal') render();
  });
  bus.on('view-changed', (detail) => {
    if (detail && detail.view === 'journal' && needsRender) render();
  });
  render();
}

/* ---------------- helpers ---------------- */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** 'Kyoto, Japan' → 'Kyoto' */
function placeOf(name) {
  return String(name || '').split(',')[0].trim();
}

/** 'Kyoto, Japan' → 'Japan'; '' when there is no comma part. */
function countryOf(name) {
  const parts = String(name || '').split(',');
  return parts.length > 1 ? parts[parts.length - 1].trim() : '';
}

function fmtCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/** Lazy-load a stored photo into an <img>, handling the missing-blob case. */
function attachPhoto(img, photoId) {
  getBlob(photoId).then((rec) => {
    if (rec && rec.blob) {
      img.src = blobUrl(photoId, rec.blob);
    } else {
      img.closest('.jr-thumb, .jr-hero')?.classList.add('jr-photo-missing');
    }
  }).catch(() => {
    img.closest('.jr-thumb, .jr-hero')?.classList.add('jr-photo-missing');
  });
}

/* ---------------- render ---------------- */

async function render() {
  if (!root) return;
  const seq = ++renderSeq;
  needsRender = false;

  // Loading state ONLY on first paint. Re-renders (saves, background sync
  // pulls) keep the old content on screen until the new tree is ready —
  // wiping first would flash the spinner and snap the reader back to the top
  // mid-chapter every time a cloud sync lands.
  const firstRender = !root.querySelector('.jr-wrap, .jr-empty');
  if (firstRender) {
    root.textContent = '';
    const loading = el('div', 'jr-state paper');
    loading.setAttribute('role', 'status');
    loading.append(el('span', 'jr-spinner'), el('p', 'jr-state-text', 'Leafing through your journal…'));
    root.appendChild(loading);
  }

  let entries;
  try {
    entries = await listEntries();
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error('Wayfarer journal: could not read entries', err);
    root.textContent = '';
    const errCard = el('div', 'jr-state paper');
    errCard.append(
      el('h2', 'jr-state-head', 'The journal wouldn’t open'),
      el('p', 'jr-state-text', 'Something went wrong reading your entries from this browser’s storage. Your data is untouched — try again.')
    );
    const retry = el('button', 'btn btn-primary', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => render());
    errCard.appendChild(retry);
    root.appendChild(errCard);
    return;
  }
  if (seq !== renderSeq) return;

  // Tear the previous lightbox down THROUGH close(): it owns a document-level
  // keydown listener and the body scroll lock — just discarding its DOM on
  // re-render would leak the listener and leave the page unscrollable.
  if (lightbox) {
    lightbox.close();
    lightbox = null;
  }

  const prevScrollY = window.scrollY; // keep the reader's place across the swap

  root.textContent = '';

  if (!entries.length) {
    root.appendChild(emptyState());
    return;
  }

  const wrap = el('div', 'jr-wrap');
  wrap.appendChild(heading());
  wrap.appendChild(statsRow(entries));
  const map = overviewMap(entries);
  if (map) wrap.appendChild(map);

  const stack = el('div', 'jr-chapters');
  entries.forEach((entry, i) => stack.appendChild(chapterEl(entry, i)));
  wrap.appendChild(stack);

  lightbox = buildLightbox();
  wrap.appendChild(lightbox.el);

  root.appendChild(wrap);
  if (!firstRender) window.scrollTo(0, prevScrollY);
}

/* ---------------- empty state ---------------- */

function emptyState() {
  const card = el('div', 'jr-state jr-empty paper');
  card.append(
    el('p', 'script jr-empty-eyebrow', 'page one, still blank'),
    el('h2', 'jr-state-head', 'Your journal is waiting'),
    el('p', 'jr-state-text', 'Every trip becomes a chapter here — photos, places on a map, and the story of where you were. Start with a memory of your own, or take a look with a sample trip.')
  );
  const row = el('div', 'jr-empty-actions');
  const startBtn = el('button', 'btn btn-primary', '＋ Write your first entry');
  startBtn.type = 'button';
  startBtn.addEventListener('click', () => bus.emit('compose-open', {}));
  const demoBtn = el('button', 'btn', 'Load a sample trip');
  demoBtn.type = 'button';
  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    try {
      const demo = await import('./demo.js');
      await demo.loadDemo();
    } catch (err) {
      console.error('Wayfarer journal: demo failed', err);
      bus.emit('toast', { message: 'Couldn’t load the sample trip.', kind: 'error' });
    } finally {
      demoBtn.disabled = false;
    }
  });
  row.append(startBtn, demoBtn);
  card.appendChild(row);
  return card;
}

/* ---------------- heading + stats ---------------- */

function heading() {
  const head = el('header', 'jr-head');
  head.append(
    el('p', 'script jr-head-eyebrow', 'the story so far'),
    el('h2', 'jr-head-title', 'Your Journal')
  );
  return head;
}

function statsRow(entries) {
  const places = new Set();
  const countries = new Set();
  let photos = 0;
  for (const e of entries) {
    const name = e.location && e.location.name;
    if (name) places.add(placeOf(name).toLowerCase());
    const c = countryOf(name);
    if (c) countries.add(c.toLowerCase());
    photos += (e.photoIds || []).length;
  }
  const row = el('div', 'jr-stats');
  row.setAttribute('role', 'list');
  const stat = (value, label) => {
    const s = el('div', 'jr-stat');
    s.setAttribute('role', 'listitem');
    s.append(el('b', null, String(value)), el('span', null, label));
    return s;
  };
  row.append(
    stat(entries.length, entries.length === 1 ? 'Entry' : 'Entries'),
    stat(places.size, places.size === 1 ? 'Place' : 'Places'),
    stat(countries.size, countries.size === 1 ? 'Country' : 'Countries'),
    stat(photos, photos === 1 ? 'Photo' : 'Photos')
  );
  return row;
}

/* ---------------- SVG overview map (ported from legacy v1) ---------------- */
// Equirectangular projection drawn as inline SVG — zero network dependency,
// renders identically offline.

function overviewMap(entries) {
  // one pin per distinct rounded coordinate; first entry at that spot is the
  // scroll target
  const pinsByKey = new Map();
  let order = 0;
  for (const e of entries) {
    const loc = e.location || {};
    if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') continue;
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) continue;
    const key = `${loc.lat.toFixed(1)},${loc.lon.toFixed(1)}`;
    if (!pinsByKey.has(key)) {
      pinsByKey.set(key, {
        lat: loc.lat, lon: loc.lon,
        label: placeOf(loc.name) || 'Somewhere',
        entryId: e.id,
        n: ++order
      });
    }
  }
  const pinned = [...pinsByKey.values()];
  if (!pinned.length) return null;

  const W = 1000, H = 500, PAD = 24;
  const project = (lat, lon) => ({
    x: PAD + (lon + 180) / 360 * (W - PAD * 2),
    y: PAD + (90 - lat) / 180 * (H - PAD * 2)
  });

  let gridLines = '';
  for (let lon = -180; lon <= 180; lon += 30) {
    const p = project(0, lon);
    gridLines += `<line class="wm-grid" x1="${p.x}" y1="${PAD}" x2="${p.x}" y2="${H - PAD}"/>`;
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const p = project(lat, 0);
    gridLines += `<line class="wm-grid" x1="${PAD}" y1="${p.y}" x2="${W - PAD}" y2="${p.y}"/>`;
  }
  const eq = project(0, 0);
  gridLines += `<line class="wm-equator" x1="${PAD}" y1="${eq.y}" x2="${W - PAD}" y2="${eq.y}"/>`;

  let pins = '';
  for (const c of pinned) {
    const p = project(c.lat, c.lon);
    const labelAbove = p.y > 64;
    // The invisible r=32 circle is the real hit target: the visible r=8 dot
    // renders ~5px wide on a phone (the whole 1000-unit map scales down),
    // far below the 44px touch minimum. With the CSS min-width on small
    // screens, 64 viewBox units ≈ a 45px tappable disc.
    pins += `
      <g class="wm-pin" data-entry="${esc(c.entryId)}" tabindex="0" role="button"
         aria-label="Go to the ${esc(c.label)} chapter">
        <circle class="wm-hit" cx="${p.x}" cy="${p.y}" r="32"/>
        <text class="wm-label" x="${p.x}" y="${labelAbove ? p.y - 13 : p.y + 25}" text-anchor="middle">${esc(c.label)}</text>
        <circle cx="${p.x}" cy="${p.y}" r="8"/>
        <text class="wm-num" x="${p.x}" y="${p.y + 3.5}" text-anchor="middle">${c.n}</text>
      </g>`;
  }

  const fig = el('figure', 'jr-map paper');
  // Static markup: grid/pin coordinates are numbers, all names pass esc().
  fig.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img"
         aria-label="A simplified world map with a pin for each place in your journal">
      <rect x="${PAD}" y="${PAD}" width="${W - PAD * 2}" height="${H - PAD * 2}" fill="none" class="wm-frame"/>
      ${gridLines}
      ${pins}
    </svg>`;
  const cap = el('figcaption', 'jr-map-caption',
    'A simplified map of everywhere you’ve been — select a pin to jump to that chapter.');
  fig.appendChild(cap);

  const jump = (g) => {
    const target = document.getElementById('jr-entry-' + g.dataset.entry);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  fig.querySelectorAll('.wm-pin').forEach((g) => {
    g.addEventListener('click', () => jump(g));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(g); }
    });
  });
  return fig;
}

/* ---------------- chapters ---------------- */

function chapterEl(entry, index) {
  const art = el('article', 'jr-chapter paper');
  art.id = 'jr-entry-' + entry.id;

  const loc = entry.location || {};
  const photoIds = entry.photoIds || [];
  const headingText = entry.title || placeOf(loc.name) || 'Untitled memory';

  /* ----- hero band ----- */
  const hero = el('div', 'jr-hero');
  const heroId = photoIds[0];
  if (heroId) {
    const img = el('img', 'jr-hero-img');
    img.alt = '';
    img.loading = index > 1 ? 'lazy' : 'eager';
    attachPhoto(img, heroId);
    hero.appendChild(img);
  } else {
    hero.classList.add('jr-no-photo');
  }

  const overlay = el('div', 'jr-hero-overlay');
  overlay.append(
    el('p', 'jr-hero-eyebrow', `Chapter ${index + 1} · ${fmtDate(entry.dateISO) || 'Undated'}`),
    el('h3', 'jr-hero-place', headingText)
  );
  const subParts = [];
  if (entry.title && loc.name) subParts.push(loc.name);
  subParts.push(`${photoIds.length} photo${photoIds.length !== 1 ? 's' : ''}`);
  if (entry.voiceId) subParts.push('voice note');
  overlay.appendChild(el('p', 'jr-hero-sub', subParts.join(' · ')));
  hero.appendChild(overlay);

  const editBtn = el('button', 'jr-edit', 'Edit');
  editBtn.type = 'button';
  editBtn.setAttribute('aria-label', `Edit “${headingText}”`);
  editBtn.addEventListener('click', () => bus.emit('compose-open', { entryId: entry.id }));
  hero.appendChild(editBtn);
  art.appendChild(hero);

  /* ----- body: narrative + side column ----- */
  const body = el('div', 'jr-body');
  const main = el('div', 'jr-main');

  const found = narrativeFor(loc.name || '');
  const story = (entry.story || '').trim();

  if (found.sourced) {
    const nar = el('div', 'jr-narrative jr-dropcap');
    nar.appendChild(el('p', null, found.text));
    main.appendChild(nar);
    main.appendChild(el('p', 'jr-source',
      'History drafted from general reference facts — worth a quick check before you publish or print.'));
    if (story) {
      const note = el('div', 'jr-note');
      note.append(el('p', 'script jr-note-label', 'in your own words'), storyBlock(story));
      main.appendChild(note);
    }
  } else if (story) {
    const nar = el('div', 'jr-narrative jr-dropcap');
    for (const para of story.split(/\n{2,}/)) nar.appendChild(el('p', null, para));
    main.appendChild(nar);
  } else {
    main.appendChild(el('p', 'jr-narrative jr-unwritten',
      'No story written yet — open this entry and add a few lines while you still remember the details.'));
  }

  if (entry.voiceId) {
    const voiceWrap = el('div', 'jr-voice');
    voiceWrap.appendChild(el('p', 'script jr-note-label', 'a voice from the road'));
    const mount = el('div', 'jr-voice-mount');
    voiceWrap.appendChild(mount);
    getBlob(entry.voiceId).then((rec) => {
      if (rec && rec.blob) {
        try { renderVoicePlayer(mount, rec.blob); } catch (err) { voiceWrap.remove(); }
      } else {
        voiceWrap.remove();
      }
    }).catch(() => voiceWrap.remove());
    main.appendChild(voiceWrap);
  }
  body.appendChild(main);

  const side = el('aside', 'jr-side');
  if (typeof loc.lat === 'number' && typeof loc.lon === 'number' &&
      Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const mini = el('div', 'jr-minimap');
    mini.append(el('span', 'jr-minimap-pin'), el('span', 'jr-minimap-coords', fmtCoord(loc.lat, loc.lon)));
    side.appendChild(mini);
  }
  if (photoIds.length) {
    const strip = el('div', 'jr-strip');
    strip.setAttribute('role', 'list');
    photoIds.forEach((pid, idx) => {
      const btn = el('button', 'jr-thumb');
      btn.type = 'button';
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('aria-label', `View photo ${idx + 1} of ${photoIds.length} from ${headingText}`);
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      attachPhoto(img, pid);
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        lightbox?.open(photoIds, idx, captionFor(entry, headingText));
      });
      strip.appendChild(btn);
    });
    side.appendChild(strip);
  }
  body.appendChild(side);
  art.appendChild(body);
  return art;
}

function storyBlock(story) {
  const div = el('div', 'jr-story');
  for (const para of story.split(/\n{2,}/)) div.appendChild(el('p', null, para));
  return div;
}

function captionFor(entry, headingText) {
  const bits = [headingText];
  const date = fmtDate(entry.dateISO);
  if (date) bits.push(date);
  return bits.join(' — ');
}

/* ---------------- lightbox (minimal, esc-closable, lives in our root) ---------------- */

function buildLightbox() {
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
