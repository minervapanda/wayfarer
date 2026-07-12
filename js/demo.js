// demo.js — seed a sample trip, fully offline. OWNER: Builder 5.
// Four entries (Kyoto, Amalfi, Marrakech, Patagonia) with 2–4 canvas-painted
// abstract-postcard photos each: layered gradient skies/sea/mountain ridges,
// a sun or moon, stars, shimmer, and film grain — 800×600 JPEG blobs.
// Deterministic ids so re-running never duplicates. Contract: ARCHITECTURE.md §3.

import { bus } from './state.js';
import { toast } from './util.js';
import { saveEntry, putBlob, getEntry } from './store.js';

const W = 800, H = 600;
let busy = false;

/* ---------------- tiny seeded RNG so every load paints the same postcards ---------------- */

function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- painting primitives ---------------- */

function sky(ctx, stops) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Sun or moon: soft radial glow + solid disc. */
function celestial(ctx, x, y, r, color, glowColor) {
  const g = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 3.4);
  g.addColorStop(0, glowColor);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 3.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/** Bite a crescent out of the last-drawn disc using the sky color. */
function crescent(ctx, x, y, r, skyColor) {
  ctx.fillStyle = skyColor;
  ctx.beginPath(); ctx.arc(x + r * 0.45, y - r * 0.2, r * 0.92, 0, Math.PI * 2); ctx.fill();
}

/** One silhouetted ridge line across the frame. */
function ridge(ctx, rand, baseY, amp, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, baseY + (rand() - 0.5) * amp);
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const x = (i * W) / steps;
    const peak = baseY - rand() * amp + (rand() - 0.5) * amp * 0.6;
    ctx.lineTo(x - W / steps / 2, peak);
    ctx.lineTo(x, baseY + (rand() - 0.5) * amp * 0.5);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
}

/** Sea below a horizon, with horizontal light shimmer. */
function sea(ctx, rand, horizon, topColor, bottomColor, shimmer) {
  const g = ctx.createLinearGradient(0, horizon, 0, H);
  g.addColorStop(0, topColor);
  g.addColorStop(1, bottomColor);
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = shimmer || '#ffffff';
  for (let i = 0; i < 46; i++) {
    const y = horizon + rand() * (H - horizon) * 0.7;
    ctx.fillRect(rand() * W * 0.9, y, 24 + rand() * 130, 1 + rand());
  }
  ctx.globalAlpha = 1;
}

function stars(ctx, rand, belowY, n) {
  ctx.fillStyle = '#fff';
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.35 + rand() * 0.6;
    const r = rand() < 0.85 ? 0.9 : 1.6;
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * belowY, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Fine film grain over the whole postcard. */
function grain(ctx, rand) {
  for (let i = 0; i < 4200; i++) {
    ctx.globalAlpha = 0.02 + rand() * 0.05;
    ctx.fillStyle = rand() > 0.5 ? '#000' : '#fff';
    ctx.fillRect(rand() * W, rand() * H, 1.3, 1.3);
  }
  ctx.globalAlpha = 1;
}

/** Paint one scene and return a JPEG Blob. */
function paint(seed, painter) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Canvas 2D unsupported in this browser')); return; }
    const rand = rng(seed);
    painter(ctx, rand);
    grain(ctx, rand);
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('canvas.toBlob unsupported in this browser'));
      return;
    }
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encode failed'))),
      'image/jpeg', 0.85
    );
  });
}

/* ---------------- the scenes ---------------- */

const SCENES = {
  /* Kyoto — temple morning: mist, dawn light, layered hills */
  'kyoto-1': (ctx, rand) => {
    sky(ctx, [[0, '#f6d7c3'], [0.45, '#f3b8a0'], [0.8, '#e69a86']]);
    celestial(ctx, 560, 240, 44, '#fff3e0', 'rgba(255,236,205,0.9)');
    ridge(ctx, rand, 400, 60, '#a8776f');
    ridge(ctx, rand, 460, 55, '#7d5257');
    ridge(ctx, rand, 530, 45, '#54373f');
  },
  'kyoto-2': (ctx, rand) => {
    sky(ctx, [[0, '#dfe8dd'], [0.5, '#cfd9c8'], [1, '#b9c4ad']]);
    celestial(ctx, 210, 150, 36, '#fdfbf2', 'rgba(250,248,235,0.85)');
    ridge(ctx, rand, 380, 40, '#93a58c');
    ridge(ctx, rand, 450, 55, '#6d8069');
    ridge(ctx, rand, 525, 50, '#49584a');
  },
  'kyoto-3': (ctx, rand) => {
    sky(ctx, [[0, '#c9556a'], [0.5, '#e8896d'], [0.85, '#f4b984']]);
    celestial(ctx, 400, 330, 52, '#ffd9a0', 'rgba(255,190,130,0.9)');
    ridge(ctx, rand, 440, 50, '#7c3f52');
    ridge(ctx, rand, 520, 45, '#54293c');
  },

  /* Amalfi — coast drive: blue sky over glittering sea */
  'amalfi-1': (ctx, rand) => {
    sky(ctx, [[0, '#7db8e8'], [0.55, '#a9d3ef'], [0.72, '#d3e9f4']]);
    celestial(ctx, 640, 130, 40, '#fffdf2', 'rgba(255,252,235,0.9)');
    sea(ctx, rand, 340, '#3f8fae', '#1d5f83');
    ridge(ctx, rand, 330, 130, 'rgba(74,90,84,0.9)');
  },
  'amalfi-2': (ctx, rand) => {
    sky(ctx, [[0, '#f2a65e'], [0.5, '#ef8a5f'], [0.8, '#e06d5e']]);
    celestial(ctx, 400, 330, 56, '#ffe9b8', 'rgba(255,205,140,0.95)');
    sea(ctx, rand, 360, '#c96a52', '#7c3a3f', '#ffd9a8');
    ridge(ctx, rand, 350, 90, 'rgba(84,48,52,0.92)');
  },
  'amalfi-3': (ctx, rand) => {
    sky(ctx, [[0, '#b9a6d8'], [0.5, '#d3b2cc'], [0.85, '#ecc2b6']]);
    celestial(ctx, 180, 210, 34, '#fef7ea', 'rgba(250,238,220,0.8)');
    sea(ctx, rand, 380, '#8a7fae', '#4c4a77', '#f2ddd2');
    ridge(ctx, rand, 372, 70, 'rgba(64,58,88,0.9)');
  },

  /* Marrakech — souk day and desert dusk */
  'marrakech-1': (ctx, rand) => {
    sky(ctx, [[0, '#f3c977'], [0.5, '#eda75c'], [0.9, '#dd8348']]);
    celestial(ctx, 590, 170, 50, '#fff2cf', 'rgba(255,232,180,0.95)');
    ridge(ctx, rand, 470, 35, '#b26a3c');
    ridge(ctx, rand, 530, 30, '#8a4a2c');
  },
  'marrakech-2': (ctx, rand) => {
    sky(ctx, [[0, '#3d2a52'], [0.5, '#7c3b57'], [0.85, '#c25e4a']]);
    stars(ctx, rand, 300, 70);
    celestial(ctx, 230, 170, 40, '#f7ead0', 'rgba(240,225,195,0.7)');
    crescent(ctx, 230, 170, 40, '#4a3158');
    ridge(ctx, rand, 480, 35, '#4f2436');
    ridge(ctx, rand, 540, 28, '#331523');
  },

  /* Patagonia — trail: jagged towers, cold light, night sky */
  'patagonia-1': (ctx, rand) => {
    sky(ctx, [[0, '#9fc4d8'], [0.55, '#c8dde5'], [0.85, '#e6eef0']]);
    celestial(ctx, 660, 120, 34, '#ffffff', 'rgba(255,255,255,0.85)');
    ridge(ctx, rand, 300, 190, '#6f7f8c');
    ridge(ctx, rand, 420, 120, '#4c5a66');
    ridge(ctx, rand, 520, 60, '#333d47');
  },
  'patagonia-2': (ctx, rand) => {
    sky(ctx, [[0, '#e9a1a6'], [0.45, '#d3899b'], [0.85, '#9d7a9a']]);
    celestial(ctx, 170, 260, 42, '#ffe4d0', 'rgba(255,205,175,0.85)');
    ridge(ctx, rand, 290, 200, '#8a5f77');
    ridge(ctx, rand, 430, 110, '#5d3f58');
    ridge(ctx, rand, 525, 55, '#3a2740');
  },
  'patagonia-3': (ctx, rand) => {
    sky(ctx, [[0, '#57616e'], [0.55, '#77808a'], [0.9, '#9aa1a6']]);
    celestial(ctx, 430, 140, 30, '#e8ecef', 'rgba(230,235,240,0.5)');
    ridge(ctx, rand, 310, 180, '#454d59');
    ridge(ctx, rand, 450, 100, '#30363f');
    sea(ctx, rand, 520, '#5c6a72', '#39444b', '#c9d4d8');
  },
  'patagonia-4': (ctx, rand) => {
    sky(ctx, [[0, '#101c30'], [0.6, '#1c2c48'], [1, '#2c3d5c']]);
    stars(ctx, rand, 420, 160);
    celestial(ctx, 600, 130, 36, '#f2f0e4', 'rgba(235,233,220,0.6)');
    ridge(ctx, rand, 330, 170, '#141c2b');
    ridge(ctx, rand, 470, 90, '#0b111c');
  }
};

/* ---------------- the sample entries ---------------- */

// Entry ids are FIXED (so re-running loadDemo never duplicates) and are valid
// v4-shaped UUIDs: supabase/schema.sql declares entries.id as `uuid primary
// key`, so a slug like 'wf-demo-kyoto' would be rejected by Postgres on every
// sync push and pin the pill on "Sync error" forever.

const DEMO_ENTRIES = [
  {
    id: 'c5a1e7f0-6b3d-4e2a-9c41-0d8e2f6a1b01', // kyoto
    title: 'Temple bells before breakfast',
    dateISO: '2026-04-03',
    location: { name: 'Kyoto, Japan', lat: 35.0037, lon: 135.7788, source: 'manual' },
    story: 'Up before six, and the lanes of Higashiyama were completely empty — just me, the smell of cedar, and a monk sweeping the steps of Kiyomizu-dera. The bell rang while I was halfway up the hill and I felt it in my chest more than heard it.\n\nBreakfast after: matcha and a warm yatsuhashi from a shop that has apparently been making them since before my country existed.',
    scenes: ['kyoto-1', 'kyoto-2', 'kyoto-3']
  },
  {
    id: 'c5a1e7f0-6b3d-4e2a-9c41-0d8e2f6a1b02', // amalfi
    title: 'The road that never runs straight',
    dateISO: '2026-05-19',
    location: { name: 'Amalfi, Italy', lat: 40.634, lon: 14.6027, source: 'manual' },
    story: 'Forty hairpins between Positano and Amalfi and our bus driver took every one of them like he was late for his own wedding. Lemons the size of my fist for sale at every bend, and the sea below so bright it looked lit from underneath.\n\nWe stopped where the road widened and just stood there a while. Nobody said much.',
    scenes: ['amalfi-1', 'amalfi-2', 'amalfi-3']
  },
  {
    id: 'c5a1e7f0-6b3d-4e2a-9c41-0d8e2f6a1b03', // marrakech
    title: 'Lost (happily) in the souk',
    dateISO: '2026-02-14',
    location: { name: 'Marrakech, Morocco', lat: 31.6258, lon: -7.9891, source: 'manual' },
    story: 'Gave up on the map inside ten minutes. Followed the dye vats by smell, drank three glasses of mint tea I never ordered, and haggled twenty minutes for a lamp I absolutely did not need. It is a beautiful lamp.\n\nAt dusk the square filled with smoke and drums, and the whole city seemed to exhale at once.',
    scenes: ['marrakech-1', 'marrakech-2']
  },
  {
    id: 'c5a1e7f0-6b3d-4e2a-9c41-0d8e2f6a1b04', // patagonia
    title: 'Wind with a view',
    dateISO: '2026-01-08',
    location: { name: 'Torres del Paine, Chile', lat: -50.942, lon: -73.407, source: 'manual' },
    story: 'The guidebook said "windy." The guidebook lied — it was airborne-gravel windy, lean-at-45-degrees windy. Then the clouds tore open above the towers exactly at dawn and everyone on the trail went quiet at the same moment.\n\nA condor rode the gusts overhead for a full minute, not flapping once. Best cold I have ever been.',
    scenes: ['patagonia-1', 'patagonia-2', 'patagonia-3', 'patagonia-4']
  }
];

/* ---------------- loader ---------------- */

export async function loadDemo() {
  if (busy) return;
  busy = true;
  try {
    // Guard against double-loading: fixed ids, so just look for a live copy.
    const existing = await Promise.all(DEMO_ENTRIES.map((e) => getEntry(e.id)));
    if (existing.some((e) => e && !e.deleted)) {
      toast('The sample trip is already in your diary.', 'info');
      return;
    }

    let seed = 20260711;
    for (const spec of DEMO_ENTRIES) {
      const photoIds = [];
      for (const sceneKey of spec.scenes) {
        const blob = await paint(seed++, SCENES[sceneKey]);
        const photoId = `${spec.id}-${sceneKey}`;
        await putBlob({ id: photoId, blob, kind: 'photo', w: W, h: H, mime: 'image/jpeg' });
        photoIds.push(photoId);
      }
      await saveEntry({
        id: spec.id,
        title: spec.title,
        dateISO: spec.dateISO,
        location: spec.location,
        story: spec.story,
        photoIds,
        voiceId: null,
        deleted: false
      });
    }

    bus.emit('entries-changed', { reason: 'demo' });
    toast('Sample trip loaded', 'success');
  } catch (err) {
    console.error('Wayfarer demo failed', err);
    toast('Couldn’t paint the sample trip in this browser.', 'error');
  } finally {
    busy = false;
  }
}
