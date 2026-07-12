// geocode.js — OpenStreetMap Nominatim geocoding. OWNER: Builder 2.
//
// Ported from legacy/wayfarer-v1.html and upgraded:
//   - polite serialized queue: ≥1100 ms between request starts (Nominatim policy)
//   - in-memory + localStorage cache, reverse lookups keyed by coords rounded
//     to 4 decimal places (~11 m); in-flight de-duplication
//   - English results via the `accept-language=en` query parameter (equivalent
//     to the Accept-Language header, but keeps our custom headers to `Accept`
//     only per ARCHITECTURE.md ground rules)
//   - attribution rendered into #osm-attribution after the first success
//   - NEVER throws: offline / HTTP error / timeout / malformed JSON → null,
//     so the app keeps working fully offline in local mode.
// Contract: ARCHITECTURE.md §3.

/** HTML-safe attribution line — set via textContent, shown once Nominatim is used. */
export const ATTRIBUTION = '© OpenStreetMap contributors · Nominatim';

const BASE = 'https://nominatim.openstreetmap.org';
const MIN_GAP_MS = 1100;      // ≥1.1 s between request starts
const TIMEOUT_MS = 10000;
const LS_KEY = 'wayfarer-geocache-v1';
const CACHE_MAX = 300;        // persisted entries, oldest evicted first

/* ---------------- cache (memory + localStorage) ---------------- */

let mem = null; // Map<key, string|{lat,lon,name}> — '' means "looked up, no name"

function cache() {
  if (mem) return mem;
  mem = new Map();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) mem.set(k, v);
      }
    }
  } catch (e) { /* private mode / disabled storage — memory cache still works */ }
  return mem;
}

function cacheSet(key, value) {
  const m = cache();
  m.delete(key); // refresh insertion order
  m.set(key, value);
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch (e) { /* quota / private mode — non-fatal */ }
}

/* ---------------- attribution ---------------- */

let attributionShown = false;

function showAttribution() {
  if (attributionShown) return;
  const el = document.getElementById('osm-attribution');
  if (el) {
    el.textContent = ATTRIBUTION; // textContent — never innerHTML
    attributionShown = true;
  }
}

/* ---------------- polite request queue ---------------- */

let queueTail = Promise.resolve();
let lastRequestAt = 0;

function enqueue(task) {
  const run = queueTail.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queueTail = run.then(() => {}, () => {}); // keep the chain alive on failure
  return run;
}

/**
 * Rate-limited Nominatim GET. Resolves to parsed JSON or null. Never rejects.
 */
function nominatim(path, params) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.resolve(null); // offline — don't even queue
  }
  return enqueue(async () => {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('accept-language', 'en');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!res.ok) return null;
      const data = await res.json();
      showAttribution();
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }).catch(() => null);
}

/* ---------------- name shaping ---------------- */

/** Pick the most human, most local settlement-ish name from a Nominatim address. */
function placeFrom(addr) {
  return addr.city || addr.town || addr.village || addr.suburb || addr.hamlet ||
         addr.municipality || addr.city_district || addr.county || addr.state || '';
}

function joinName(place, country) {
  return [place, country].filter(Boolean).join(', ');
}

/* ---------------- public API ---------------- */

const inflight = new Map(); // key -> Promise, de-dupes concurrent identical lookups

/**
 * Coordinates → short human place name.
 * @returns {Promise<string|null>} e.g. 'Kyoto, Japan' — null offline/on error. Never throws.
 */
export async function reverseGeocode(lat, lon) {
  try {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const key = `r:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const hit = cache().get(key);
    if (typeof hit === 'string') return hit || null; // '' = known no-name
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const data = await nominatim('reverse', {
        format: 'jsonv2', lat, lon, zoom: 10, addressdetails: 1
      });
      if (!data || data.error) return null;
      const addr = data.address || {};
      const name = joinName(placeFrom(addr) || data.name || '', addr.country || '');
      cacheSet(key, name); // cache '' too — a definitive "nothing here" answer
      return name || null;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  } catch (e) {
    return null;
  }
}

/**
 * Free-text place query → best match.
 * @returns {Promise<{lat:number, lon:number, name:string}|null>} Never throws.
 */
export async function forwardGeocode(q) {
  try {
    const query = String(q || '').trim();
    if (!query) return null;

    const key = `f:${query.toLowerCase()}`;
    const hit = cache().get(key);
    if (hit && typeof hit === 'object' && Number.isFinite(hit.lat)) return hit;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const data = await nominatim('search', {
        format: 'jsonv2', q: query, limit: 1, addressdetails: 1
      });
      const best = Array.isArray(data) && data[0];
      if (!best) return null;
      const lat = parseFloat(best.lat);
      const lon = parseFloat(best.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const addr = best.address || {};
      const name = joinName(best.name || placeFrom(addr), addr.country || '') ||
                   String(best.display_name || query).split(',')[0].trim();
      const result = { lat, lon, name };
      cacheSet(key, result);
      return result;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  } catch (e) {
    return null;
  }
}
