// collage.js — the collage template engine for photo-only entries.
// OWNER: collage builder (js/collage.js + css/collage.css).
//
// Pure DOM + CSS: no imports from store.js / state.js / util.js. The engine
// renders into a container and does nothing else. Object URLs are created and
// revoked by the CALLER — this module only displays them.
//
// Public contract (frozen — js/journal.js integrates against it):
//   TEMPLATES                          [{ key, label }] for the style switcher
//   resolveTemplate(key, photoCount)   → concrete template key
//   renderCollage(rootEl, photos, templateKey, opts) → void
//     photos: [{ id, url, w, h, alt }]
//     opts:   { seed: string, onPhotoClick(index) }
//   Tolerated variants (the journal already calls these shapes):
//     resolveTemplate(key, photosArray)                → uses .length
//     renderCollage(rootEl, photos, { template, seed, onPhotoClick })
//
// 'auto' mapping — the documented decision:
//   0–4 photos → 'scatter'   (1 photo renders as a single matted print)
//   5–6 photos → 'mosaic'    (hero + enough satellites to feel dense)
//   7+  photos → 'grid'      (the contact sheet scales to 30+)
// Additionally an explicit 'scatter' falls back to 'grid' at 7+ photos:
// the hand-tuned scatter position tables top out at 6 prints.
//
// Determinism: every rotation, offset, z-order and decoration derives from
// hash(seed, photoId, index, salt) — the same entry lays out identically on
// every visit, in every browser, after every sync.
//
// Geometry notes (scatter / wall solver): prints are absolutely positioned
// with percentage lefts/widths. Vertical math runs in "width units" (1 unit =
// 1% of container width); once every print is placed the container's
// aspect-ratio is set from the deepest bottom edge, so nothing can overflow.
// A print's total height in width units, given width w and photo window
// aspect A (the app-wide orientation buckets 3/4, 1/1, 4/3):
//   polaroid (scatter): mat pad 4.5% + chin 16%  → h = w * (0.205 + 0.91/A)
//   pinned print (wall): mat pad 4% all around   → h = w * (0.08  + 0.92/A)
// These constants MUST match the .clg-mat padding in css/collage.css.
//
// Aspect fidelity: scatter/wall/mosaic use the shared orientation buckets
// (same barely-cropped treatment as the journal filmstrip); grid and
// filmstrip size frames from the TRUE w/h ratio.

export const TEMPLATES = [
  { key: 'auto',      label: 'Auto' },
  { key: 'scatter',   label: 'Scrapbook' },
  { key: 'mosaic',    label: 'Mosaic' },
  { key: 'grid',      label: 'Contact sheet' },
  { key: 'filmstrip', label: 'Filmstrip' },
  { key: 'wall',      label: 'Pinboard' },
];

const CONCRETE = new Set(TEMPLATES.map((t) => t.key).filter((k) => k !== 'auto'));

/** Resolve a stored template key + photo count to a concrete, renderable key.
    `photoCount` may be a number or the photos array itself. */
export function resolveTemplate(key, photoCount) {
  const n = Array.isArray(photoCount) ? photoCount.length
    : Number.isFinite(photoCount) ? Math.max(0, Math.floor(photoCount)) : 0;
  let k = CONCRETE.has(key) ? key : autoKey(n);
  if (k === 'scatter' && n >= 7) k = 'grid';
  return k;
}

function autoKey(n) {
  if (n <= 4) return 'scatter';
  if (n <= 6) return 'mosaic';
  return 'grid';
}

/** Clear rootEl and render `photos` as a collage. Returns void. */
export function renderCollage(rootEl, photos, templateKey, opts) {
  if (!rootEl) return;
  ensureStylesheet();
  // Tolerate the bundled-options call shape: (root, photos, { template, … }).
  if (templateKey && typeof templateKey === 'object') {
    opts = templateKey;
    templateKey = opts.template;
  }
  opts = opts || {};
  const seed = String(opts.seed != null ? opts.seed : '');
  const onClick = typeof opts.onPhotoClick === 'function' ? opts.onPhotoClick : null;
  const list = Array.isArray(photos) ? photos.filter(Boolean) : [];
  const n = list.length;
  const t = resolveTemplate(templateKey, n);

  const wrap = el('div', 'clg clg--' + t);
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', n === 1 ? 'Photo collage — 1 photo' : `Photo collage — ${n} photos`);

  if (n === 0) {
    wrap.appendChild(el('p', 'clg-empty', 'No photos yet.'));
  } else if (t === 'scatter') {
    renderScatter(wrap, list, seed, onClick);
  } else if (t === 'mosaic') {
    renderMosaic(wrap, list, onClick);
  } else if (t === 'grid') {
    renderGrid(wrap, list, onClick);
  } else if (t === 'filmstrip') {
    renderFilmstrip(wrap, list, onClick);
  } else {
    renderWall(wrap, list, seed, onClick);
  }
  rootEl.replaceChildren(wrap);
}

/* ---------------- stylesheet self-injection ----------------
   index.html is frozen and carries no <link> for collage.css, so the engine
   loads its own stylesheet once, resolved against this module's URL (safe on
   any subpath). Idempotent; a manual <link href="…collage.css"> also counts. */
let cssInjected = false;
function ensureStylesheet() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .some((l) => /(^|\/)collage\.css(\?|$)/.test(l.getAttribute('href') || ''));
  if (already) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/collage.css', import.meta.url).href;
  document.head.appendChild(link);
}

/* ---------------- shared helpers ---------------- */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** App-wide orientation buckets: aspect = w/h; portrait < 0.85,
    landscape > 1.18, else square. Missing dims fall back to square. */
function orientOf(p) {
  const w = Number(p && p.w) || 0;
  const h = Number(p && p.h) || 0;
  if (!w || !h) return 'square';
  const a = w / h;
  if (a < 0.85) return 'portrait';
  if (a > 1.18) return 'landscape';
  return 'square';
}

const BUCKET_AR = { portrait: 3 / 4, landscape: 4 / 3, square: 1 };

/** True aspect for grid/filmstrip frames, clamped so one extreme pano can't
    wreck a row; 1 when dims are unknown. */
function trueAR(p) {
  const w = Number(p && p.w) || 0;
  const h = Number(p && p.h) || 0;
  if (!w || !h) return 1;
  return Math.min(2.4, Math.max(0.5, w / h));
}

/* Deterministic pseudo-randomness: FNV-1a over seed + salts, avalanched,
   mapped to [0, 1). Same inputs → same layout, forever. */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822519);
  h ^= h >>> 13; h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return h >>> 0;
}
function rnd(seed, ...salts) {
  return hash32(seed + '§' + salts.join('§')) / 4294967296;
}
function saltFor(p, i) {
  return (p && p.id != null ? String(p.id) : 'p') + '#' + i;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** The focusable print: a real <button> (keyboard + 44px targets via CSS)
    whose accessible name is the photo's alt text carried on the <img>. */
function photoButton(p, index, orient, onClick) {
  const btn = el('button', 'clg-ph ' + orient);
  btn.type = 'button';
  const img = el('img');
  img.src = String((p && p.url) || '');
  img.alt = p && p.alt ? String(p.alt) : 'Photo ' + (index + 1);
  img.decoding = 'async';
  img.loading = 'lazy';
  img.draggable = false;
  if (onClick) btn.addEventListener('click', () => onClick(index));
  return { btn, img };
}

/* ---------------- scatter (Scrapbook) ----------------
   Overlapping polaroids on hand-tuned anchors (1–6 prints; 7+ resolved to
   grid). ~1/3 of prints wear a washi-tape strip, the rest get photo-corner
   details. Tilt ±2–7°, seeded jitter, seeded depth. */

const SCATTER = {
  1: { w: 46, slots: [[50, 8]] },
  2: { w: 40, slots: [[31, 5], [66, 30]] },
  3: { w: 36, slots: [[29, 4], [71, 12], [47, 44]] },
  4: { w: 34, slots: [[28, 4], [72, 9], [29, 49], [71, 54]] },
  5: { w: 31, slots: [[25, 4], [66, 7], [45, 33], [26, 60], [69, 63]] },
  6: { w: 30, slots: [[22, 4], [52, 9], [82, 4], [24, 52], [55, 57], [84, 50]] },
};
/* Width multipliers per orientation keep print heights near-uniform
   (portrait polaroids run tall, so they get narrower). */
const SCATTER_MULT = { portrait: 0.78, square: 0.92, landscape: 1 };

function renderScatter(wrap, photos, seed, onClick) {
  const spec = SCATTER[photos.length];
  const placed = [];
  let maxBottom = 0;

  photos.forEach((p, i) => {
    const o = orientOf(p);
    const id = saltFor(p, i);
    const w = spec.w * SCATTER_MULT[o];
    const cx = spec.slots[i][0] + (rnd(seed, id, 'x') - 0.5) * 6;
    const left = clamp(cx - w / 2, 2.5, 97.5 - w);
    const top = Math.max(2.8, spec.slots[i][1] + (rnd(seed, id, 'y') - 0.5) * 6);
    const h = w * (0.205 + 0.91 / BUCKET_AR[o]); // matches .clg-mat chrome
    maxBottom = Math.max(maxBottom, top + h);

    const { btn, img } = photoButton(p, i, o, onClick);
    btn.classList.add('clg-print');
    const mat = el('span', 'clg-mat');
    const win = el('span', 'clg-win');
    win.appendChild(img);
    if (rnd(seed, id, 'deco') < 0.34) {
      const tape = el('span', 'clg-tape');
      tape.setAttribute('aria-hidden', 'true');
      tape.style.setProperty('--tape-tilt', ((rnd(seed, id, 'tt') - 0.5) * 10).toFixed(1) + 'deg');
      mat.appendChild(win);
      btn.append(mat, tape);
    } else {
      win.appendChild(cornerOverlay());
      mat.appendChild(win);
      btn.appendChild(mat);
    }

    const mag = 2 + rnd(seed, id, 'tilt') * 5; // 2–7°
    const flip = rnd(seed, id, 'flip') < 0.22;
    const sign = (i % 2 === 0) !== flip ? -1 : 1;
    btn.style.setProperty('--tilt', (sign * mag).toFixed(2) + 'deg');
    // depth via custom property so the CSS hover/focus raise still wins
    btn.style.setProperty('--z', String(1 + Math.floor(rnd(seed, id, 'z') * 8)));
    placed.push({ btn, left, top, w });
  });

  positionPrints(wrap, placed, maxBottom + 3.5);
}

/** Second pass: with the container's height known, convert width-unit tops
    into height percentages and set the container's aspect-ratio. */
function positionPrints(wrap, placed, heightUnits) {
  wrap.style.aspectRatio = '100 / ' + heightUnits.toFixed(2);
  placed.forEach(({ btn, left, top, w }) => {
    btn.style.left = left.toFixed(2) + '%';
    btn.style.top = ((top / heightUnits) * 100).toFixed(2) + '%';
    btn.style.width = w.toFixed(2) + '%';
    wrap.appendChild(btn);
  });
}

/** Four kraft photo-corner triangles painted by css/collage.css. */
function cornerOverlay() {
  const c = el('span', 'clg-cornerlay');
  c.setAttribute('aria-hidden', 'true');
  return c;
}

/* ---------------- mosaic ----------------
   One hero print (first portrait, else first photo) beside a dense satellite
   grid; landscape satellites span both columns (grid-auto-flow: dense packs
   the rest). Original photo indices are preserved for onPhotoClick. */

function renderMosaic(wrap, photos, onClick) {
  let hi = photos.findIndex((p) => orientOf(p) === 'portrait');
  if (hi < 0) hi = 0;
  const heroO = orientOf(photos[hi]);
  wrap.dataset.hero = heroO;

  const hero = photoButton(photos[hi], hi, heroO, onClick);
  hero.btn.classList.add('clg-hero', 'clg-framed');
  hero.btn.appendChild(hero.img);
  wrap.appendChild(hero.btn);

  const rest = photos.map((p, i) => ({ p, i })).filter((x) => x.i !== hi);
  if (!rest.length) {
    wrap.dataset.solo = '1';
    return;
  }
  const sats = el('div', 'clg-sats');
  rest.forEach(({ p, i }) => {
    const o = orientOf(p);
    const { btn, img } = photoButton(p, i, o, onClick);
    btn.classList.add('clg-sat', 'clg-framed');
    btn.appendChild(img);
    sats.appendChild(btn);
  });
  wrap.appendChild(sats);
}

/* ---------------- grid (Contact sheet) ----------------
   Justified rows: fixed row height, each frame's width follows its TRUE
   aspect, flex-grow (∝ aspect) lets rows stretch flush. The trailing spacer
   soaks up the last row so it never inflates. Handles 30+ photos. */

function renderGrid(wrap, photos, onClick) {
  photos.forEach((p, i) => {
    const { btn, img } = photoButton(p, i, orientOf(p), onClick);
    btn.classList.add('clg-cell', 'clg-framed');
    btn.style.setProperty('--ar', trueAR(p).toFixed(3));
    btn.appendChild(img);
    wrap.appendChild(btn);
  });
  const spacer = el('span', 'clg-rowspacer');
  spacer.setAttribute('aria-hidden', 'true');
  wrap.appendChild(spacer);
}

/* ---------------- filmstrip ----------------
   Rows of ≤4 frames balanced across strips (5 → 3+2, 7 → 4+3). Each strip is
   a film band with sprocket holes top + bottom (CSS gradients, background-
   attachment: local so the holes travel with the film when a strip scrolls
   sideways inside its own container). Frames keep TRUE aspect at a fixed
   strip height; edge numerals in film-amber. */

function renderFilmstrip(wrap, photos, onClick) {
  const rows = Math.max(1, Math.ceil(photos.length / 4));
  const per = Math.ceil(photos.length / rows);
  let strip = null;
  photos.forEach((p, i) => {
    if (i % per === 0) {
      strip = el('div', 'clg-strip');
      wrap.appendChild(strip);
    }
    const { btn, img } = photoButton(p, i, orientOf(p), onClick);
    btn.classList.add('clg-frame');
    btn.style.setProperty('--ar', trueAR(p).toFixed(3));
    const no = el('span', 'clg-frameno', String(i + 1).padStart(2, '0'));
    no.setAttribute('aria-hidden', 'true');
    btn.append(img, no);
    strip.appendChild(btn);
  });
}

/* ---------------- wall (Pinboard) ----------------
   A cork-tinted panel (derived from theme tokens) with prints at two sizes,
   pin dots, occasional photo corners, gentle seeded scatter in rows of three.
   The same width-unit solver as scatter guarantees no overflow at any count. */

const WALL_MULT = { portrait: 0.8, square: 0.95, landscape: 1.1 };
const WALL_CX = { 1: [50], 2: [32, 68], 3: [19, 50, 81] };

function renderWall(wrap, photos, seed, onClick) {
  const n = photos.length;
  // Two print sizes, seeded — force a mix so the board never looks uniform.
  const tiers = photos.map((p, i) => (rnd(seed, saltFor(p, i), 'tier') < 0.42 ? 22 : 30));
  if (n >= 2 && tiers.every((t) => t === tiers[0])) tiers[n - 1] = tiers[0] === 30 ? 22 : 30;

  const placed = [];
  let maxBottom = 0;
  photos.forEach((p, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const inRow = Math.min(3, n - row * 3);
    const o = orientOf(p);
    const id = saltFor(p, i);
    const w = tiers[i] * WALL_MULT[o];
    const cx = WALL_CX[inRow][col] + (rnd(seed, id, 'x') - 0.5) * 7;
    const left = clamp(cx - w / 2, 2, 98 - w);
    const top = Math.max(2.4, 4.5 + row * 30 + (rnd(seed, id, 'y') - 0.5) * 6);
    const h = w * (0.08 + 0.92 / BUCKET_AR[o]); // matches wall .clg-mat chrome
    maxBottom = Math.max(maxBottom, top + h);

    const { btn, img } = photoButton(p, i, o, onClick);
    btn.classList.add('clg-print');
    const mat = el('span', 'clg-mat');
    const win = el('span', 'clg-win');
    win.appendChild(img);
    if (rnd(seed, id, 'deco') < 0.4) win.appendChild(cornerOverlay());
    mat.appendChild(win);
    const pin = el('span', 'clg-pin');
    pin.setAttribute('aria-hidden', 'true');
    btn.append(mat, pin);

    const mag = 1.2 + rnd(seed, id, 'tilt') * 2; // 1.2–3.2°
    const flip = rnd(seed, id, 'flip') < 0.3;
    const sign = (i % 2 === 0) !== flip ? -1 : 1;
    btn.style.setProperty('--tilt', (sign * mag).toFixed(2) + 'deg');
    btn.style.setProperty('--z', String(1 + Math.floor(rnd(seed, id, 'z') * 8)));
    placed.push({ btn, left, top, w });
  });

  positionPrints(wrap, placed, maxBottom + 4);
}
