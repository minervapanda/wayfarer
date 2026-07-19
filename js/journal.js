// journal.js — the editorial "chapter stack" journal view. OWNER: Builder 5.
// Read-only view of entries: SVG world map overview, stats, chapters with a
// hero photo, drop-cap narrative (curated history via narrativeFor, else the
// traveler's own story), photo strip with a lightbox, voice-note playback.
// Editing happens through 'compose-open'. Contract: ARCHITECTURE.md §3.
//
// XSS: every user string reaches the DOM via textContent, or via esc() where
// SVG markup is assembled as a string.

import { app, bus } from './state.js';
import { listEntries, getEntry, saveEntry, getBlob } from './store.js';
import { esc, fmtDate, blobUrl } from './util.js';
import * as util from './util.js';
import { narrativeFor } from './narratives.js';
import { renderVoicePlayer } from './voice.js';
import { renderCollage, resolveTemplate, TEMPLATES } from './collage.js';
import { buildLightbox } from './lightbox.js';

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

/** Display title for an entry. Prefers util.entryDisplayTitle (shipped by the
    util owner in this round); falls back to the journal's historical rule so
    nothing breaks if this module lands first. */
function displayTitle(entry) {
  if (typeof util.entryDisplayTitle === 'function') {
    try {
      const t = util.entryDisplayTitle(entry);
      if (t) return t;
    } catch { /* fall through to the local rule */ }
  }
  return entry.title || placeOf(entry.location && entry.location.name) || 'Untitled memory';
}

/** Shared app-wide definition: photo-only = blank story + at least one photo.
    These entries render as collage chapters instead of editorial chapters. */
function isPhotoOnly(entry) {
  return (entry.story || '').trim() === '' && (entry.photoIds || []).length >= 1;
}

function fmtCoord(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/** Orientation class from stored pixel dims (BlobRec.w/h). Thresholds are
    shared app-wide so every view agrees: aspect = w/h; 'portrait' when
    aspect < 0.85, 'landscape' when aspect > 1.18, else 'square'. */
function orientOf(w, h) {
  const aspect = w > 0 && h > 0 ? w / h : 1;
  if (aspect < 0.85) return 'portrait';
  if (aspect > 1.18) return 'landscape';
  return 'square';
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
  if (isPhotoOnly(entry)) return collageChapterEl(entry, index);

  const art = el('article', 'jr-chapter paper');
  art.id = 'jr-entry-' + entry.id;

  const loc = entry.location || {};
  const photoIds = entry.photoIds || [];
  const headingText = displayTitle(entry);

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
  const shareBtn = el('button', 'jr-edit jr-share', '↗');
  shareBtn.type = 'button';
  shareBtn.title = 'Share this page';
  shareBtn.setAttribute('aria-label', `Share “${headingText}”`);
  shareBtn.addEventListener('click', () => bus.emit('share-entry', { entryId: entry.id }));
  // .jr-actions (css/share.css) clusters the pills where .jr-edit sat alone.
  const actions = el('div', 'jr-actions');
  actions.append(shareBtn, editBtn);
  hero.appendChild(actions);
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
      // One getBlob serves both the pixels and the frame shape: data-orient
      // drives the thumb's filmstrip aspect-ratio (css/journal.css), so
      // portrait/landscape prints keep their own proportions instead of a
      // square center-crop. Until the record loads (or if the blob is gone)
      // the square fallback frame applies.
      getBlob(pid).then((rec) => {
        if (rec && rec.blob) {
          btn.dataset.orient = orientOf(rec.w, rec.h);
          img.src = blobUrl(pid, rec.blob);
        } else {
          btn.classList.add('jr-photo-missing');
        }
      }).catch(() => btn.classList.add('jr-photo-missing'));
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

/* ---------------- collage chapters (photo-only entries) ----------------
   Same header treatment as an editorial chapter (eyebrow, display title,
   location line, share/edit pills, coords card) but the body is one
   full-width collage rendered by the collage engine (./collage.js). No
   narrative block, no "in your own words", no filmstrip. */

/** TEMPLATES normalized to an ordered [{ key, label }] list, whatever shape
    the engine exports (object map of key→{label}/key→string, or array). */
function templateList() {
  const capitalize = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1);
  try {
    if (Array.isArray(TEMPLATES)) {
      return TEMPLATES.map((t) => (typeof t === 'string'
        ? { key: t, label: capitalize(t) }
        : { key: t.key || t.id, label: t.label || capitalize(t.key || t.id) }
      )).filter((t) => t.key);
    }
    if (TEMPLATES && typeof TEMPLATES === 'object') {
      return Object.entries(TEMPLATES).map(([key, v]) => ({
        key,
        label: typeof v === 'string' ? v : (v && v.label) || capitalize(key)
      }));
    }
  } catch { /* engine not shaped as expected — chip degrades below */ }
  return [];
}

/** Chip label for the current template; 'auto' shows what auto resolved to. */
function styleLabelFor(templateKey, photos, seed) {
  const list = templateList();
  const capitalize = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1);
  const nameOf = (k) => (list.find((t) => t.key === k) || {}).label || capitalize(k);
  let label = nameOf(templateKey);
  if (templateKey === 'auto' && photos && photos.length) {
    try {
      const resolved = resolveTemplate(templateKey, photos, seed);
      if (resolved && resolved !== 'auto') label = `Auto · ${nameOf(resolved)}`;
    } catch { /* keep plain 'Auto' */ }
  }
  return label;
}

function collageChapterEl(entry, index) {
  const art = el('article', 'jr-chapter jr-co paper');
  art.id = 'jr-entry-' + entry.id;

  const loc = entry.location || {};
  const photoIds = (entry.photoIds || []).slice();
  const headingText = displayTitle(entry);
  const template = (entry.collage && entry.collage.template) || 'auto';

  /* ----- header: same treatment as the editorial chapter, on paper ----- */
  const head = el('header', 'jr-co-head');
  head.append(
    el('p', 'jr-co-eyebrow', `Chapter ${index + 1} · ${fmtDate(entry.dateISO) || 'Undated'}`),
    el('h3', 'jr-co-title', headingText)
  );
  const subParts = [];
  if (loc.name) subParts.push(loc.name);
  subParts.push(`${photoIds.length} photo${photoIds.length !== 1 ? 's' : ''}`);
  if (entry.voiceId) subParts.push('voice note');
  head.appendChild(el('p', 'jr-co-sub', subParts.join(' · ')));

  const editBtn = el('button', 'jr-edit', 'Edit');
  editBtn.type = 'button';
  editBtn.setAttribute('aria-label', `Edit “${headingText}”`);
  editBtn.addEventListener('click', () => bus.emit('compose-open', { entryId: entry.id }));
  const shareBtn = el('button', 'jr-edit jr-share', '↗');
  shareBtn.type = 'button';
  shareBtn.title = 'Share this page';
  shareBtn.setAttribute('aria-label', `Share “${headingText}”`);
  shareBtn.addEventListener('click', () => bus.emit('share-entry', { entryId: entry.id }));
  const actions = el('div', 'jr-actions');
  actions.append(shareBtn, editBtn);
  head.appendChild(actions);
  art.appendChild(head);

  /* ----- full-width collage area ----- */
  const area = el('div', 'jr-co-area');
  const loading = el('p', 'jr-co-state', 'Arranging the collage…');
  loading.setAttribute('role', 'status');
  area.appendChild(loading);
  art.appendChild(area);

  /* ----- footer: style switcher chip + coords card ----- */
  const foot = el('div', 'jr-co-foot');
  const chip = buildStyleChip(entry, template);
  foot.appendChild(chip.el);
  if (typeof loc.lat === 'number' && typeof loc.lon === 'number' &&
      Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const mini = el('div', 'jr-minimap');
    mini.append(el('span', 'jr-minimap-pin'), el('span', 'jr-minimap-coords', fmtCoord(loc.lat, loc.lon)));
    foot.appendChild(mini);
  }
  art.appendChild(foot);

  /* ----- voice note (photo-only entries can still carry one) ----- */
  if (entry.voiceId) {
    const voiceWrap = el('div', 'jr-co-voice');
    voiceWrap.appendChild(el('p', 'script jr-note-label', 'a voice from the road'));
    const mount = el('div', 'jr-voice-mount');
    voiceWrap.appendChild(mount);
    getBlob(entry.voiceId).then((rec) => {
      if (rec && rec.blob) {
        try { renderVoicePlayer(mount, rec.blob); } catch { voiceWrap.remove(); }
      } else {
        voiceWrap.remove();
      }
    }).catch(() => voiceWrap.remove());
    art.appendChild(voiceWrap);
  }

  hydrateCollage(entry, { area, chip, headingText, photoIds, template });
  return art;
}

/** Load the entry's photo blobs, then hand them to the collage engine. */
async function hydrateCollage(entry, { area, chip, headingText, photoIds, template }) {
  const seq = renderSeq; // bail if the journal re-rendered while we loaded

  let recs;
  try {
    recs = await Promise.all(photoIds.map((id) => getBlob(id).catch(() => undefined)));
  } catch {
    recs = [];
  }
  if (seq !== renderSeq) return;

  const photos = [];
  const ids = [];
  recs.forEach((rec, i) => {
    if (rec && rec.blob) {
      ids.push(photoIds[i]);
      photos.push({
        id: photoIds[i],
        url: blobUrl(photoIds[i], rec.blob),
        w: rec.w || 0,
        h: rec.h || 0,
        orient: orientOf(rec.w, rec.h),
        alt: ''
      });
    }
  });
  photos.forEach((p, i) => { p.alt = `${headingText} — photo ${i + 1} of ${photos.length}`; });

  area.textContent = '';
  if (!photos.length) {
    const gone = el('p', 'jr-co-state', 'These photos are no longer in this browser’s storage.');
    area.appendChild(gone);
    chip.disable();
    return;
  }

  chip.ready(photos);

  const mount = el('div', 'jr-co-mount');
  area.appendChild(mount);
  const onPhotoClick = (idx) => {
    lightbox?.open(ids, idx, captionFor(entry, headingText));
  };
  try {
    const out = renderCollage(mount, photos, { template, seed: entry.id, onPhotoClick });
    const node = out && typeof out.then === 'function' ? await out : out;
    if (seq !== renderSeq) return;
    if (node instanceof Node && node !== mount && !mount.contains(node)) mount.appendChild(node);
    if (!mount.childNodes.length) throw new Error('collage engine rendered nothing');
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error('Wayfarer journal: collage engine failed, using plain grid', err);
    mount.textContent = '';
    fallbackCollage(mount, photos, onPhotoClick);
  }
}

/** Last-resort layout when the engine throws: an honest, even photo grid that
    still opens the lightbox — the chapter never renders broken. */
function fallbackCollage(mount, photos, onPhotoClick) {
  const grid = el('div', 'jr-co-fallback');
  grid.setAttribute('role', 'list');
  photos.forEach((p, idx) => {
    const btn = el('button', 'jr-thumb');
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', p.alt || `View photo ${idx + 1}`);
    btn.dataset.orient = p.orient;
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = p.url;
    btn.appendChild(img);
    btn.addEventListener('click', () => onPhotoClick(idx));
    grid.appendChild(btn);
  });
  mount.appendChild(grid);
}

/** The quiet style-switcher chip. Cycles through TEMPLATES; the choice is
    persisted on the entry via saveEntry, and the 'entries-changed' re-render
    (which keeps scroll) repaints the collage in the new style. */
function buildStyleChip(entry, template) {
  const chipEl = el('button', 'jr-co-style');
  chipEl.type = 'button';
  chipEl.disabled = true; // enabled once photos are loaded
  const mark = el('span', 'jr-co-style-mark', '✦');
  mark.setAttribute('aria-hidden', 'true');
  const labelEl = el('span', 'jr-co-style-label');
  labelEl.append('Style: ', el('b', null, '…'));
  chipEl.append(mark, labelEl);
  chipEl.setAttribute('aria-label', 'Change collage style');

  const setLabel = (text) => {
    labelEl.textContent = '';
    labelEl.append('Style: ', el('b', null, text));
    chipEl.setAttribute('aria-label', `Change collage style — currently ${text}`);
  };

  chipEl.addEventListener('click', async () => {
    const keys = templateList().map((t) => t.key);
    if (!keys.length) return;
    const next = keys[(keys.indexOf(template) + 1) % keys.length];
    chipEl.disabled = true;
    try {
      // Re-read the entry so a concurrent edit/sync isn't clobbered by our
      // stale render-time snapshot.
      const fresh = await getEntry(entry.id);
      if (!fresh) throw new Error('entry disappeared');
      fresh.collage = { template: next };
      await saveEntry(fresh); // stamps updatedAt + dirty — style syncs for free
      bus.emit('entries-changed', { reason: 'save' });
    } catch (err) {
      console.error('Wayfarer journal: could not save collage style', err);
      chipEl.disabled = false;
      bus.emit('toast', { message: 'Couldn’t change the collage style.', kind: 'error' });
    }
  });

  return {
    el: chipEl,
    ready(photos) {
      if (!templateList().length) { chipEl.hidden = true; return; }
      setLabel(styleLabelFor(template, photos, entry.id));
      chipEl.disabled = false;
    },
    disable() {
      chipEl.disabled = true;
    }
  };
}

function storyBlock(story) {
  const div = el('div', 'jr-story');
  for (const para of story.split(/\n{2,}/)) div.appendChild(el('p', null, para));
  return div;
}

function captionFor(entry, headingText) {
  const bits = [headingText];
  const date = fmtDate(entry.dateISO);
  // Untitled entries use the date as their display title — don't say it twice.
  if (date && date !== headingText) bits.push(date);
  return bits.join(' — ');
}

/* Lightbox lives in ./lightbox.js now (shared with book.js). */
