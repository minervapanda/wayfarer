// storycard.js — pure canvas-2D renderer that turns a diary entry into a
// shareable social image (PNG). No DOM UI here: another module owns the share
// modal and calls renderStoryCard(). No external libs, no network.
//
// Contract (frozen — see ARCHITECTURE.md ground rules):
//   FORMATS = { story: {w,h,label}, square: {w,h,label} }
//   renderStoryCard(entry, format) -> { blob, width, height, filename }
//
// Design: replicates the book page's scrapbook DNA — cream paper with grain,
// vignette and deckled edge, white-bordered polaroids with washi tape, serif
// title, small-caps dateline with a pin glyph, story excerpt, script footer.
// All randomness is seeded from entry.id so re-renders are pixel-identical.
// This module never throws: bad photos are skipped, and any unexpected render
// failure falls back to a minimal typographic card.

import { getBlob } from './store.js';
import { blobUrl } from './util.js';

export const FORMATS = {
  story: { w: 1080, h: 1920, label: 'Story 9:16' },
  square: { w: 1080, h: 1080, label: 'Square 1:1' },
};

/* ---------------- constants ---------------- */

const SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif';
const SCRIPT = '"Snell Roundhand"';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const EXCERPT_MAX_CHARS = 260;
const GAP = 28;

// Per-format typography & layout metrics. `top`/`bottom` bound ALL content —
// for the story format that is the Instagram safe area (y 220–1700).
const METRICS = {
  story: {
    top: 220, bottom: 1700, mx: 96,
    date: 30, title: 64, titleLH: 78,
    excerpt: 36, excerptLH: 56, measure: 840,
    footer: 46, minPhoto: 620,
  },
  square: {
    top: 88, bottom: 992, mx: 84,
    date: 26, title: 54, titleLH: 66,
    excerpt: 31, excerptLH: 47, measure: 780,
    footer: 38, minPhoto: 440,
  },
};

// Fallbacks mirror the passport theme in css/base.css exactly, so the renderer
// still matches the app if it ever runs before styles resolve.
const FALLBACK_TOKENS = {
  paper: '#faf4e6',
  paperEdge: '#e8dcc0',
  ink: '#3b2f21',
  inkSoft: '#71614a',
  accent: '#a3402c',
  tape: 'rgba(214, 187, 128, 0.55)',
  line: '#d8c6a0',
  stamp: '#63755a',
};

// Orientation-aware prints. A photo's class comes from its own decoded
// pixels (aspect = w/h): 'portrait' < 0.85, 'landscape' > 1.18, else
// 'square' — the same thresholds every view uses. Each class gets a frame
// whose photo area matches (3:4 / 4:3 / 1:1), so the residual cover-crop
// only trims a sliver instead of cutting whole sides off.
const ORIENT_ASPECT = { portrait: 3 / 4, landscape: 4 / 3, square: 1 };

// Curated collage placements per photo count (fractions of the photo zone).
// cx/cy anchor the print center, s scales a print relative to its siblings,
// r = rotation range in degrees; flip = deterministic sign flip from the rng.
const LAYOUTS = {
  1: [{ cx: 0.5, cy: 0.5, s: 1, r: [2, 5], flip: true }],
  // 3: the FIRST photo is the entry's hero everywhere (journal hero band,
  // book anchor print), so it anchors large on the left while the two
  // smaller prints fan off to the right with only sliver overlaps.
  3: [
    { cx: 0.3, cy: 0.42, s: 1.06, r: [-7, -4] },
    { cx: 0.66, cy: 0.35, s: 0.88, r: [1, 4] },
    { cx: 0.58, cy: 0.68, s: 0.94, r: [3, 6] },
  ],
  4: [
    { cx: 0.3, cy: 0.28, s: 0.98, r: [-6, -3] },
    { cx: 0.7, cy: 0.3, s: 1, r: [2, 5] },
    { cx: 0.3, cy: 0.72, s: 1, r: [2, 6] },
    { cx: 0.71, cy: 0.7, s: 0.97, r: [-5, -2] },
  ],
};

// Two prints arrange by orientation pair: portraits sit side by side,
// landscapes stack with a sideways offset (side by side instead when the
// zone is too short for the stack to grow — see specsFor), anything mixed
// (or square) staggers on the diagonal with a slight overlap.
const LAYOUTS_2 = {
  portraits: [
    { cx: 0.3, cy: 0.47, s: 1, r: [-5, -2] },
    { cx: 0.7, cy: 0.53, s: 1, r: [2, 5] },
  ],
  landscapes: [
    { cx: 0.44, cy: 0.27, s: 1, r: [-4, -2] },
    { cx: 0.57, cy: 0.73, s: 1, r: [2, 4] },
  ],
  landscapesWide: [
    { cx: 0.3, cy: 0.46, s: 1, r: [-4, -2] },
    { cx: 0.7, cy: 0.55, s: 1, r: [2, 4] },
  ],
  mixed: [
    { cx: 0.38, cy: 0.39, s: 1, r: [-6, -3] },
    { cx: 0.63, cy: 0.62, s: 1, r: [3, 6] },
  ],
};

// Ceiling on the photo-area unit (≈ √ of the visible photo area) per print
// count, as a fraction of the zone's short side. The fit pass in
// layoutCollage() may shrink further so rotated prints stay inside the zone.
const UNIT_CAP = { 1: 0.94, 2: 0.58, 3: 0.5, 4: 0.44 };

// The washi tape drawTape() lays across the LAST print's top edge overhangs
// above the frame: strip w = 0.42·pw, h = 0.26·w, centered 0.02·pw below the
// top edge, rotated up to 38° → rises (0.21·sin38 + 0.0546·cos38 − 0.02)·pw
// ≈ 0.153·pw. 0.16 adds slack for the print's own ≤9° rotation, so the
// containment/banding passes can reserve for the tape too.
const TAPE_PAD = 0.16;

/* ---------------- public API ---------------- */

/**
 * Render `entry` into a shareable PNG story card.
 * Never rejects for content reasons — missing photos, undecodable blobs and
 * empty fields all degrade gracefully.
 */
export async function renderStoryCard(entry, format = 'story') {
  const fmtKey = Object.prototype.hasOwnProperty.call(FORMATS, format) ? format : 'story';
  const e = entry && typeof entry === 'object' ? entry : {};
  try {
    return await render(e, fmtKey);
  } catch (err) {
    console.warn('storycard: full render failed, using minimal card', err);
    return renderMinimal(e, fmtKey);
  }
}

/* ---------------- main render ---------------- */

async function render(e, fmtKey) {
  const photos = await loadPhotos(e, 4);
  try {
    return await renderWithPhotos(e, fmtKey, photos);
  } finally {
    // Always release decoded bitmaps — even when the draw pipeline throws and
    // we fall back to renderMinimal() — so a failed render never leaks up to
    // four full-size ImageBitmap pixel buffers per attempt.
    for (const p of photos) {
      if (typeof p.close === 'function') { try { p.close(); } catch (err) { /* noop */ } }
    }
  }
}

async function renderWithPhotos(e, fmtKey, photos) {
  const { w: W, h: H } = FORMATS[fmtKey];
  const L = METRICS[fmtKey];
  const T = readTokens();
  const rng = mulberry32(seedFrom(e.id || e.createdAt || 'wayfarer'));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  /* ---- ground: paper, grain, deckle, vignette ---- */
  drawPaper(ctx, W, H, T, rng);

  /* ---- header: dateline + title ---- */
  let y = L.top;
  const dl = datelineParts(e);
  if (dl.date || dl.loc) {
    y += L.date + 6;
    drawDateline(ctx, dl, W / 2, y, L.date, T, W - 2 * L.mx);
    y += 26;
  }

  const titleText = (str(e.title) || str(e.location && e.location.name) || 'A remembered day').trim();
  const titleSize = photos.length === 0 ? Math.round(L.title * 1.15) : L.title;
  const titleLH = photos.length === 0 ? Math.round(L.titleLH * 1.15) : L.titleLH;
  ctx.font = `700 ${titleSize}px ${SERIF}`;
  ctx.fillStyle = T.ink;
  ctx.textAlign = 'center';
  const titleLines = wrapLines(ctx, titleText, W - 2 * L.mx, 2);
  for (const line of titleLines) {
    y += titleLH;
    ctx.fillText(line, W / 2, y);
  }
  y += 18;

  /* ---- footer reservation ---- */
  const footerBaseline = L.bottom - 18;
  const footerTop = footerBaseline - L.footer - 12;

  /* ---- excerpt sizing (skipped entirely when story is empty) ---- */
  const excerpt = trimExcerpt(e.story);
  const blockW = Math.min(L.measure, W - 2 * L.mx);
  const zoneTop = y + 10;
  // Landscape-only collages run short, portrait-only ones tall — bias how
  // much vertical band the prints reserve before the excerpt gives up lines.
  let minPhoto = L.minPhoto;
  if (photos.length) {
    const cls = photos.map(orientationOf);
    if (cls.every((c) => c === 'landscape')) minPhoto = Math.round(minPhoto * 0.85);
    else if (cls.every((c) => c === 'portrait')) minPhoto = Math.round(minPhoto * 1.15);
  }
  let exLines = [];
  let zone = { x: L.mx, y: zoneTop, w: W - 2 * L.mx, h: 0 };
  let maxLines = 7;
  for (;;) {
    if (excerpt) {
      ctx.font = `400 ${L.excerpt}px ${SERIF}`;
      exLines = wrapLines(ctx, excerpt, blockW, maxLines);
    }
    const exH = exLines.length ? exLines.length * L.excerptLH + GAP : 0;
    zone.h = footerTop - GAP - exH - zoneTop;
    if (!photos.length || zone.h >= minPhoto || maxLines <= 3) break;
    maxLines--;
  }
  // Extreme squeeze (huge title + tiny format): give photos the room.
  if (photos.length && zone.h < 220 && exLines.length) {
    exLines = [];
    zone.h = footerTop - GAP - zoneTop;
  }

  /* ---- middle: polaroid collage or postcard motif ---- */
  let exFirstBaseline = zone.y + zone.h + GAP + L.excerpt;
  if (photos.length) {
    const col = layoutCollage(photos, zone, rng);
    // Band the content around the collage's REAL height: hug the excerpt to
    // the lowest rotated print edge and center the leftover air, so prints
    // and text never collide whatever the orientation mix.
    const exBlockH = exLines.length ? GAP + exLines.length * L.excerptLH : 0;
    const bandH = footerTop - GAP - zone.y;
    const colH = col.bottom - col.top;
    const dy = zone.y + Math.max(0, (bandH - colH - exBlockH) / 2) - col.top;
    for (let i = 0; i < col.prints.length; i++) {
      const p = col.prints[i];
      drawPolaroid(ctx, p.img, p.cx, p.cy + dy, p.pw, p.ph, p.rot, T, i === col.prints.length - 1, rng);
    }
    exFirstBaseline = col.bottom + dy + GAP + L.excerpt;
  } else if (zone.h > 130) {
    drawPostcard(ctx, zone, e, T, rng);
  }

  /* ---- excerpt ---- */
  if (exLines.length) {
    ctx.font = `400 ${L.excerpt}px ${SERIF}`;
    ctx.fillStyle = rgba(T.inkC, 0.95);
    ctx.textAlign = 'left';
    const bx = (W - blockW) / 2;
    let ey = exFirstBaseline;
    for (const line of exLines) {
      ctx.fillText(line, bx, ey);
      ey += L.excerptLH;
    }
  }

  /* ---- footer ---- */
  ctx.font = scriptFont(L.footer);
  ctx.fillStyle = rgba(T.accentC, 0.72);
  ctx.textAlign = 'center';
  ctx.fillText('— from my Wayfarer diary', W / 2, footerBaseline);

  /* ---- finishing pass: whisper of grain over everything ---- */
  overGrain(ctx, W, H, rng);

  const blob = await canvasToBlob(canvas);
  return { blob, width: W, height: H, filename: filenameFor(e) };
}

/* ---------------- minimal fallback card (last resort) ---------------- */

async function renderMinimal(e, fmtKey) {
  const { w: W, h: H } = FORMATS[fmtKey];
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = FALLBACK_TOKENS.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = FALLBACK_TOKENS.ink;
  ctx.textAlign = 'center';
  ctx.font = `700 56px ${SERIF}`;
  const title = (str(e.title) || str(e.location && e.location.name) || 'A remembered day').trim();
  const lines = wrapLines(ctx, title, W - 160, 2);
  let y = H / 2 - ((lines.length - 1) * 68) / 2;
  for (const line of lines) { ctx.fillText(line, W / 2, y); y += 68; }
  ctx.font = `italic 34px ${SERIF}`;
  ctx.fillStyle = FALLBACK_TOKENS.accent;
  ctx.fillText('— from my Wayfarer diary', W / 2, H - Math.max(90, H * 0.08));
  const blob = await canvasToBlob(canvas);
  return { blob, width: W, height: H, filename: filenameFor(e) };
}

/* ---------------- paper ground ---------------- */

function drawPaper(ctx, W, H, T, rng) {
  ctx.fillStyle = T.paper;
  ctx.fillRect(0, 0, W, H);

  // Faint warm wash so the sheet doesn't read flat.
  const wash = ctx.createLinearGradient(0, 0, 0, H);
  wash.addColorStop(0, rgba(T.paperEdgeC, 0.14));
  wash.addColorStop(0.5, rgba(T.paperEdgeC, 0));
  wash.addColorStop(1, rgba(T.paperEdgeC, 0.18));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // Grain: a few thousand seeded 1px speckles — identical on every re-render.
  const speckles = 3400;
  for (let i = 0; i < speckles; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const a = 0.02 + rng() * 0.05;
    const dark = rng() > 0.42;
    ctx.fillStyle = dark ? rgba(T.inkC, a) : `rgba(255,255,255,${(a * 1.4).toFixed(3)})`;
    const s = rng() > 0.9 ? 2 : 1;
    ctx.fillRect(x, y, s, s);
  }

  // Slightly darker deckled edge: soft bands in from each side…
  const edge = Math.round(Math.min(W, H) * 0.035);
  const band = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, rgba(T.paperEdgeC, 0.55));
    g.addColorStop(1, rgba(T.paperEdgeC, 0));
    return g;
  };
  ctx.fillStyle = band(0, 0, edge, 0); ctx.fillRect(0, 0, edge, H);
  ctx.fillStyle = band(W, 0, W - edge, 0); ctx.fillRect(W - edge, 0, edge, H);
  ctx.fillStyle = band(0, 0, 0, edge); ctx.fillRect(0, 0, W, edge);
  ctx.fillStyle = band(0, H, 0, H - edge); ctx.fillRect(0, H - edge, W, edge);

  // …plus a hand-torn jittered hairline just inside the border.
  ctx.strokeStyle = rgba(T.paperEdgeC, 0.85);
  ctx.lineWidth = 2;
  ctx.beginPath();
  const inset = 12;
  const step = 26;
  const jit = () => (rng() - 0.5) * 5;
  ctx.moveTo(inset, inset + jit());
  for (let x = inset + step; x <= W - inset; x += step) ctx.lineTo(x, inset + jit());
  for (let y = inset + step; y <= H - inset; y += step) ctx.lineTo(W - inset + jit(), y);
  for (let x = W - inset - step; x >= inset; x -= step) ctx.lineTo(x, H - inset + jit());
  for (let y = H - inset - step; y >= inset; y -= step) ctx.lineTo(inset + jit(), y);
  ctx.closePath();
  ctx.stroke();

  // Gentle vignette.
  const r = Math.hypot(W, H) / 2;
  const vg = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
  vg.addColorStop(0, rgba(T.inkC, 0));
  vg.addColorStop(1, rgba(T.inkC, 0.1));
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function overGrain(ctx, W, H, rng) {
  for (let i = 0; i < 1100; i++) {
    const x = rng() * W;
    const y = rng() * H;
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(40,32,22,0.018)';
    ctx.fillRect(x, y, 1, 1);
  }
}

/* ---------------- dateline + pin glyph ---------------- */

function datelineParts(e) {
  let date = '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(e.dateISO));
  if (m) {
    const mo = MONTHS[+m[2] - 1];
    if (mo) date = `${mo} ${+m[3]}, ${m[1]}`;
  }
  const loc = str(e.location && e.location.name).trim().toUpperCase();
  return { date, loc };
}

function drawDateline(ctx, dl, cx, baseline, px, T, maxW) {
  ctx.font = `600 ${px}px ${SERIF}`;
  const track = px * 0.18;
  const pinW = dl.loc ? px * 0.78 : 0;
  const sep = dl.date && dl.loc ? ' · ' : '';
  const left = dl.date + sep;
  const wLeft = trackedWidth(ctx, left, track);
  // Location names are free text and can be arbitrarily long; ellipsize so the
  // whole tracked line stays inside maxW instead of clipping at the card edge.
  let loc = dl.loc;
  if (loc && maxW > 0) {
    const avail = maxW - wLeft - pinW;
    if (trackedWidth(ctx, loc, track) > avail) {
      const wDots = trackedWidth(ctx, '…', track);
      let t = loc;
      while (t.length > 1 && trackedWidth(ctx, t, track) + wDots > avail) t = t.slice(0, -1);
      loc = t.replace(/[\s.,;:·]+$/, '') + '…';
    }
  }
  const wLoc = trackedWidth(ctx, loc, track);
  const total = wLeft + pinW + wLoc;
  let x = cx - total / 2;
  ctx.fillStyle = rgba(T.inkSoftC, 0.98);
  x = drawTracked(ctx, left.toUpperCase(), x, baseline, track);
  if (loc) {
    drawPin(ctx, x + pinW * 0.12, baseline, px * 0.66, T.accent);
    x += pinW;
    drawTracked(ctx, loc, x, baseline, track);
  }
}

// A small map-pin: round head, tapered point, paper-colored keyhole.
function drawPin(ctx, x, baseline, size, color) {
  const cy = baseline - size * 0.58;
  const cxp = x + size * 0.32;
  const r = size * 0.32;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cxp, cy, r, Math.PI * 0.98, Math.PI * 0.02);
  ctx.quadraticCurveTo(cxp + r * 0.85, cy + r * 0.9, cxp, baseline);
  ctx.quadraticCurveTo(cxp - r * 0.85, cy + r * 0.9, cxp - r, cy + r * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cxp, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ---------------- polaroid collage ---------------- */

// Classify a decoded bitmap by its own aspect ratio (w/h).
function orientationOf(img) {
  const w = img.width || img.naturalWidth || 1;
  const h = img.height || img.naturalHeight || 1;
  const aspect = w / Math.max(1, h);
  if (aspect < 0.85) return 'portrait';
  if (aspect > 1.18) return 'landscape';
  return 'square';
}

// Frame dims for a photo area of unit size u (visible photo area ≈ u²,
// shaped by the class aspect). The polaroid chrome is untouched:
// drawPolaroid still derives the 5% pad and 18% chin from the frame width,
// so with ph = ih + 0.23·pw the photo window is exactly the class aspect.
function printDims(u, cls) {
  const A = ORIENT_ASPECT[cls] || 1;
  const iw = u * Math.sqrt(A);
  const pw = iw / 0.9; //           iw = pw − 2·pad = 0.9·pw
  const ph = iw / A + 0.23 * pw; // ih + pad + chin
  return { pw, ph };
}

function specsFor(n, classes, zone) {
  if (n === 2) {
    if (classes[0] === 'portrait' && classes[1] === 'portrait') return LAYOUTS_2.portraits;
    if (classes[0] === 'landscape' && classes[1] === 'landscape') {
      // Stacking needs vertical room: in short zones the 0.27/0.73 anchors
      // bind the shared scale far below UNIT_CAP (tiny prints in a sea of
      // paper), so twin landscapes sit side by side there instead.
      const shortZone = zone.w / Math.max(1, zone.h) > 1.45;
      return shortZone ? LAYOUTS_2.landscapesWide : LAYOUTS_2.landscapes;
    }
    return LAYOUTS_2.mixed;
  }
  return LAYOUTS[n];
}

// Place up to four prints inside `zone`, each frame shaped to its own photo.
// Deterministic (seeded rng), and every rotated print is kept fully inside
// the zone, so prints can never wander into the title, excerpt or footer
// bands or out of the format's safe area. Returns { prints, top, bottom } —
// top/bottom are the collage's true vertical extent for banding.
function layoutCollage(photos, zone, rng) {
  const n = Math.min(photos.length, 4);
  const classes = photos.slice(0, n).map(orientationOf);
  const specs = specsFor(n, classes, zone);
  const aspect = zone.w / Math.max(1, zone.h);
  const spread = Math.min(1.3, Math.max(1, aspect / 1.25));

  // Anchors, jitter and rotations first, with unit-sized frames…
  const prints = [];
  for (let i = 0; i < n; i++) {
    const s = specs[i];
    const jx = (rng() - 0.5) * zone.w * 0.03;
    const jy = (rng() - 0.5) * zone.h * 0.03;
    let deg = s.r[0] + (s.r[1] - s.r[0]) * rng();
    if (s.flip && rng() < 0.5) deg = -deg;
    const d = printDims(s.s || 1, classes[i]);
    prints.push({
      img: photos[i],
      cx: zone.x + zone.w * (0.5 + (s.cx - 0.5) * spread) + jx,
      cy: zone.y + zone.h * s.cy + jy,
      pw: d.pw,
      ph: d.ph,
      rot: (deg * Math.PI) / 180,
    });
  }

  // …then one shared scale: the largest photo-area unit that keeps every
  // rotated frame inside the zone, capped per count so collages keep air.
  // The last print carries the washi tape, whose overhang above the frame
  // counts toward its top extent — tape must clear the title band too.
  let k = UNIT_CAP[n] * Math.min(zone.w, zone.h);
  for (let i = 0; i < prints.length; i++) {
    const p = prints[i];
    const ex = extentX(p);
    const ey = extentY(p);
    k = Math.min(
      k,
      (p.cx - zone.x) / ex,
      (zone.x + zone.w - p.cx) / ex,
      (p.cy - zone.y) / extentTop(p, i === prints.length - 1),
      (zone.y + zone.h - p.cy) / ey
    );
  }
  k = Math.max(40, k); // degenerate zones: draw tiny rather than vanish

  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < prints.length; i++) {
    const p = prints[i];
    p.pw *= k;
    p.ph *= k;
    top = Math.min(top, p.cy - extentTop(p, i === prints.length - 1));
    bottom = Math.max(bottom, p.cy + extentY(p));
  }
  return { prints, top, bottom };
}

// Half extents of a rotated pw×ph rectangle along the canvas axes.
function extentX(p) {
  return (p.pw / 2) * Math.abs(Math.cos(p.rot)) + (p.ph / 2) * Math.abs(Math.sin(p.rot));
}
function extentY(p) {
  return (p.pw / 2) * Math.abs(Math.sin(p.rot)) + (p.ph / 2) * Math.abs(Math.cos(p.rot));
}
// Top half-extent including the tape overhang (the extent of the frame
// enlarged by TAPE_PAD·pw on the vertical axis, which contains the rotated
// strip), so tape can never paint above the zone — i.e. over the title.
function extentTop(p, withTape) {
  return extentY(p) + (withTape ? TAPE_PAD * p.pw * Math.abs(Math.cos(p.rot)) : 0);
}

function drawPolaroid(ctx, img, cx, cy, pw, ph, rot, T, withTape, rng) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);

  // Soft drop shadow under the white frame.
  ctx.shadowColor = rgba(T.inkC, 0.32);
  ctx.shadowBlur = pw * 0.085;
  ctx.shadowOffsetY = pw * 0.032;
  ctx.fillStyle = '#fdfdfa';
  ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  const pad = pw * 0.05;
  const chin = pw * 0.18;
  const iw = pw - 2 * pad;
  const ih = ph - pad - chin;
  const ix = -pw / 2 + pad;
  const iy = -ph / 2 + pad;
  try {
    const c = coverCrop(img, iw, ih);
    ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, ix, iy, iw, ih);
  } catch (err) {
    // Undrawable bitmap: quiet blank photo slot in the line color.
    ctx.fillStyle = T.line;
    ctx.fillRect(ix, iy, iw, ih);
  }
  ctx.strokeStyle = rgba(T.inkC, 0.12);
  ctx.lineWidth = 1;
  ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);

  if (withTape) {
    drawTape(ctx, T, rng, -pw / 2 + pw * 0.16, -ph / 2 + pw * 0.02, pw * 0.42);
  }
  ctx.restore();
}

// Semi-transparent striped washi tape across a photo corner. Height scales
// strictly with width (no pixel floor) so the layout's TAPE_PAD reservation
// bounds the overhang at every print size.
function drawTape(ctx, T, rng, x, y, w) {
  const h = w * 0.26;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(((-38 + rng() * 16) * Math.PI) / 180);
  ctx.globalAlpha = 0.82;
  const pat = ctx.createPattern(tapePatternCanvas(T), 'repeat');
  ctx.fillStyle = pat || T.tape;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  // Slightly lighter long edges make it read as translucent tape.
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillRect(-w / 2, -h / 2, w, 2.5);
  ctx.fillRect(-w / 2, h / 2 - 2.5, w, 2.5);
  ctx.restore();
}

let tapeCanvas = null;
let tapeCanvasKey = '';
function tapePatternCanvas(T) {
  if (tapeCanvas && tapeCanvasKey === T.tape) return tapeCanvas;
  const c = document.createElement('canvas');
  c.width = c.height = 28;
  const g = c.getContext('2d');
  g.fillStyle = T.tape;
  g.fillRect(0, 0, 28, 28);
  tapeCanvasKey = T.tape;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 5;
  for (let d = -28; d <= 56; d += 14) {
    g.beginPath();
    g.moveTo(d, 28);
    g.lineTo(d + 28, 0);
    g.stroke();
  }
  tapeCanvas = c;
  return c;
}

function coverCrop(img, dw, dh) {
  const iw = img.width || img.naturalWidth || 1;
  const ih = img.height || img.naturalHeight || 1;
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale;
  const sh = dh / scale;
  return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh };
}

/* ---------------- zero-photo postcard motif ---------------- */

function drawPostcard(ctx, zone, e, T, rng) {
  const inset = Math.min(zone.w, zone.h) * 0.045;
  const pw = zone.w - inset * 2;
  const ph = zone.h - inset * 2;
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(((-1.2 + rng() * 1.2) * Math.PI) / 180);

  // The card itself: a lighter sheet on the paper.
  ctx.shadowColor = rgba(T.inkC, 0.25);
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = rgba(T.inkC, 0.18);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-pw / 2, -ph / 2, pw, ph);

  const pad = Math.min(pw, ph) * 0.07;

  // Center divider.
  const divX = pw * 0.03;
  ctx.strokeStyle = rgba(T.inkSoftC, 0.5);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(divX, -ph / 2 + pad);
  ctx.lineTo(divX, ph / 2 - pad);
  ctx.stroke();

  // Ruled address lines, right half.
  const lineX0 = divX + pad;
  const lineX1 = pw / 2 - pad;
  const nLines = 4;
  const lineTop = -ph / 2 + ph * 0.42;
  const lineGap = (ph / 2 - pad - lineTop) / (nLines - 0.5);
  ctx.strokeStyle = T.line;
  ctx.lineWidth = 2.5;
  for (let i = 0; i < nLines; i++) {
    const ly = lineTop + i * lineGap;
    ctx.beginPath();
    ctx.moveTo(lineX0, ly);
    ctx.lineTo(lineX1, ly);
    ctx.stroke();
  }

  // Postage stamp, top-right, with punched perforations.
  const sw = Math.min(pw * 0.17, ph * 0.3);
  const sh = sw * 1.22;
  const sx = pw / 2 - pad - sw;
  const sy = -ph / 2 + pad;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(sx, sy, sw, sh);
  // Perforations: paper-colored punches along the stamp perimeter.
  ctx.fillStyle = T.paper;
  const holeR = Math.max(2.6, sw * 0.045);
  const holeStep = holeR * 2.6;
  for (let x = sx; x <= sx + sw + 1; x += holeStep) {
    circle(ctx, x, sy, holeR);
    circle(ctx, x, sy + sh, holeR);
  }
  for (let y = sy; y <= sy + sh + 1; y += holeStep) {
    circle(ctx, sx, y, holeR);
    circle(ctx, sx + sw, y, holeR);
  }
  // Double inner border + the location initial.
  const bi = sw * 0.09;
  ctx.strokeStyle = T.stamp;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + bi, sy + bi, sw - 2 * bi, sh - 2 * bi);
  ctx.strokeRect(sx + bi * 1.7, sy + bi * 1.7, sw - 3.4 * bi, sh - 3.4 * bi);
  const initial = (str(e.location && e.location.name).trim() || str(e.title).trim() || 'W')
    .charAt(0).toUpperCase();
  ctx.fillStyle = T.stamp;
  ctx.textAlign = 'center';
  ctx.font = `700 ${Math.round(sh * 0.46)}px ${SERIF}`;
  ctx.fillText(initial, sx + sw / 2, sy + sh * 0.62);

  // Postmark: circle + wavy cancellation lines over the stamp's corner.
  ctx.strokeStyle = rgba(T.inkSoftC, 0.5);
  ctx.lineWidth = 2;
  const pmR = sw * 0.42;
  const pmX = sx - pmR * 0.42;
  const pmY = sy + sh * 0.82;
  ctx.beginPath();
  ctx.arc(pmX, pmY, pmR, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const wy = pmY - pmR * 0.4 + i * pmR * 0.4;
    ctx.beginPath();
    ctx.moveTo(pmX - pmR * 2.4, wy);
    ctx.bezierCurveTo(pmX - pmR * 1.9, wy - 7, pmX - pmR * 1.5, wy + 7, pmX - pmR * 1.05, wy);
    ctx.stroke();
  }

  // Left half: script greeting (location, or a wish).
  const greet = str(e.location && e.location.name).trim() || 'wish you were here…';
  const gMax = pw / 2 + divX - pad * 2;
  let gSize = Math.min(Math.round(ph * 0.17), 64);
  ctx.textAlign = 'center';
  ctx.fillStyle = rgba(T.accentC, 0.9);
  for (; gSize >= 22; gSize -= 4) {
    ctx.font = scriptFont(gSize);
    if (ctx.measureText(greet).width <= gMax) break;
  }
  ctx.font = scriptFont(gSize);
  ctx.fillText(ellipsize(ctx, greet, gMax), (-pw / 2 + divX) / 2, ph * 0.06);

  ctx.restore();
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/* ---------------- photo loading (never throws) ---------------- */

async function loadPhotos(e, max) {
  const out = [];
  // Walk ALL photo ids and stop once `max` have decoded, so a missing or
  // undecodable blob early in the list is backfilled by later valid photos.
  const ids = Array.isArray(e.photoIds) ? e.photoIds : [];
  for (const id of ids) {
    if (out.length >= max) break;
    try {
      const rec = await getBlob(id);
      if (!rec || !rec.blob) continue;
      const img = await decodeBlob(id, rec.blob);
      if (img && (img.width || img.naturalWidth)) out.push(img);
    } catch (err) {
      // Skip undecodable photos (HEIC in non-Safari, corrupt blobs, …).
    }
  }
  return out;
}

async function decodeBlob(id, blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch (err) { /* fall through to <img> decode */ }
  }
  try {
    // Reuse the app-wide cached object URL (util.blobUrl) — do NOT revoke it,
    // other views may be displaying the same photo.
    const url = blobUrl(id, blob);
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });
  } catch (err) {
    return null;
  }
}

/* ---------------- text helpers ---------------- */

function str(v) {
  return v == null ? '' : String(v);
}

function trimExcerpt(story) {
  const t = str(story).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= EXCERPT_MAX_CHARS) return t;
  let cut = t.slice(0, EXCERPT_MAX_CHARS + 1);
  const sp = cut.lastIndexOf(' ');
  cut = sp > EXCERPT_MAX_CHARS * 0.6 ? cut.slice(0, sp) : t.slice(0, EXCERPT_MAX_CHARS);
  return cut.replace(/[\s,;:.!?…]+$/, '') + '…';
}

// Word-wrap with a hard max-line count; the last line is ellipsized if the
// text overflows. Uses the ctx's CURRENT font.
function wrapLines(ctx, text, maxW, maxLines) {
  const words = str(text).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const test = cur ? cur + ' ' + words[i] : words[i];
    if (!cur || ctx.measureText(test).width <= maxW) {
      cur = test;
    } else {
      lines.push(cur);
      cur = words[i];
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines + 1) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = ellipsize(ctx, kept[maxLines - 1] + '…', maxW);
    return kept;
  }
  // A single unbroken over-long word still must fit.
  return lines.map((l) => (ctx.measureText(l).width > maxW ? ellipsize(ctx, l, maxW) : l));
}

function ellipsize(ctx, s, maxW) {
  const orig = str(s);
  if (ctx.measureText(orig).width <= maxW) return orig;
  let t = orig.replace(/…+$/, '');
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.replace(/\s+$/, '') + '…';
}

function trackedWidth(ctx, text, track) {
  let w = 0;
  for (const ch of str(text)) w += ctx.measureText(ch).width + track;
  return w;
}

function drawTracked(ctx, text, x, baseline, track) {
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of str(text)) {
    ctx.fillText(ch, x, baseline);
    x += ctx.measureText(ch).width + track;
  }
  ctx.textAlign = prevAlign;
  return x;
}

// Script accent — only if the face is actually installed, else italic serif.
function scriptFont(px) {
  try {
    if (typeof document !== 'undefined' && document.fonts && document.fonts.check(`16px ${SCRIPT}`)) {
      return `${px}px ${SCRIPT}, cursive`;
    }
  } catch (err) { /* noop */ }
  return `italic ${px}px ${SERIF}`;
}

/* ---------------- color helpers ---------------- */

// Read fresh on every render — the user can switch app themes between shares.
function readTokens() {
  const get = (name, fallback) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (err) {
      return fallback;
    }
  };
  const T = {
    paper: get('--paper', FALLBACK_TOKENS.paper),
    paperEdge: get('--paper-edge', FALLBACK_TOKENS.paperEdge),
    ink: get('--ink', FALLBACK_TOKENS.ink),
    inkSoft: get('--ink-soft', FALLBACK_TOKENS.inkSoft),
    accent: get('--accent', FALLBACK_TOKENS.accent),
    tape: get('--tape', FALLBACK_TOKENS.tape),
    line: get('--line', FALLBACK_TOKENS.line),
    stamp: get('--stamp', FALLBACK_TOKENS.stamp),
  };
  T.inkC = parseColor(T.ink, { r: 59, g: 47, b: 33 });
  T.inkSoftC = parseColor(T.inkSoft, { r: 113, g: 97, b: 74 });
  T.accentC = parseColor(T.accent, { r: 163, g: 64, b: 44 });
  T.paperEdgeC = parseColor(T.paperEdge, { r: 232, g: 220, b: 192 });
  return T;
}

function parseColor(input, fallback) {
  const s = str(input).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    return {
      r: parseInt(m[1][0] + m[1][0], 16),
      g: parseInt(m[1][1] + m[1][1], 16),
      b: parseInt(m[1][2] + m[1][2], 16),
    };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return fallback;
}

function rgba(c, a) {
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
}

/* ---------------- prng, filename, blob export ---------------- */

function seedFrom(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  const t = str(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function filenameFor(e) {
  const src = str(e.location && e.location.name).trim() || str(e.title).trim() || 'entry';
  let slug = src
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  if (!slug) slug = 'entry';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(e.dateISO))
    ? e.dateISO
    : (str(e.createdAt).slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/) || ['undated'])[0];
  return `wayfarer-${slug}-${date}.png`;
}

async function canvasToBlob(canvas) {
  const blob = await new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/png');
    } catch (err) {
      resolve(null);
    }
  });
  if (blob) return blob;
  // Rare toBlob failure: rebuild from a data URL, still fully offline.
  const dataUrl = canvas.toDataURL('image/png');
  const b64 = dataUrl.split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}
