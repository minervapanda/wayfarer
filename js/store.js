// store.js — IndexedDB persistence with in-memory fallback. Architect-owned.
// Contracts in ARCHITECTURE.md §1 and §3. Mutating callers emit
// 'entries-changed' themselves.

import { uid, toast } from './util.js';

const DB_NAME = 'wayfarer';
const DB_VERSION = 1;
const STORES = ['entries', 'blobs', 'meta'];

let db = null;
let memory = null; // { entries: Map, blobs: Map, meta: Map } when IndexedDB is unavailable

// The uid whose entries this device is currently acting for. null in local mode
// (unclaimed entries). Set by sync.js on sign-in via setActiveOwner(). Device
// isolation: writes are stamped with it, reads are scoped to it.
let activeOwner = null;

/** Set the active owner uid (or null for local mode). */
export function setActiveOwner(uid) { activeOwner = uid || null; }

/** @returns {string|null} the active owner uid, or null in local mode. */
export function getActiveOwner() { return activeOwner; }

// Treat missing/undefined owner as null (unclaimed) for comparisons.
const ownerOf = (e) => (e && e.owner != null ? e.owner : null);

function useMemoryFallback(reason) {
  if (memory) return;
  memory = { entries: new Map(), blobs: new Map(), meta: new Map() };
  console.warn('Wayfarer: IndexedDB unavailable, using in-memory storage.', reason);
  // Call util.toast() directly: initDB() runs during boot, BEFORE main.js has
  // registered its 'toast' bus listener — a bus.emit here would be dropped
  // silently and the user would never learn their diary won't persist.
  toast(
    'This browser can’t save locally (private browsing?). Your diary will work but won’t persist — export it before you leave.',
    'warning'
  );
}

export async function initDB() {
  if (db || memory) return;
  if (!('indexedDB' in globalThis)) {
    useMemoryFallback('no indexedDB');
    return;
  }
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const name of STORES) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    db.onversionchange = () => { try { db.close(); } catch (e) { /* noop */ } };
  } catch (err) {
    useMemoryFallback(err);
  }
}

/* ---------------- low-level ops (branch on memory fallback) ---------------- */

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(store, id) {
  if (memory) return memory[store].get(id);
  return req(db.transaction(store, 'readonly').objectStore(store).get(id));
}

async function idbPut(store, rec) {
  if (memory) { memory[store].set(rec.id, rec); return rec; }
  await req(db.transaction(store, 'readwrite').objectStore(store).put(rec));
  return rec;
}

async function idbDelete(store, id) {
  if (memory) { memory[store].delete(id); return; }
  await req(db.transaction(store, 'readwrite').objectStore(store).delete(id));
}

async function idbAll(store) {
  if (memory) return [...memory[store].values()];
  return req(db.transaction(store, 'readonly').objectStore(store).getAll());
}

async function idbClear(store) {
  if (memory) { memory[store].clear(); return; }
  await req(db.transaction(store, 'readwrite').objectStore(store).clear());
}

/* ---------------- entries ---------------- */

/** Non-deleted entries owned by the active owner, sorted by dateISO then createdAt.
    In local mode (activeOwner null) only unclaimed entries (owner null/undefined)
    are visible — this is the read half of the device-isolation fix. */
export async function listEntries() {
  const all = await idbAll('entries');
  return all
    .filter((e) => !e.deleted && ownerOf(e) === activeOwner)
    .sort((a, b) =>
      (a.dateISO || '').localeCompare(b.dateISO || '') ||
      (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export async function getEntry(id) {
  return idbGet('entries', id);
}

/** Stamps createdAt (if missing) and updatedAt, persists, marks dirty. Returns the entry. */
export async function saveEntry(entry) {
  const now = new Date().toISOString();
  if (!entry.id) entry.id = uid();
  if (!entry.createdAt) entry.createdAt = now;
  entry.updatedAt = now;
  if (typeof entry.deleted !== 'boolean') entry.deleted = false;
  // Stamp the active owner on first write only — never overwrite an existing
  // owner (the push half of the device-isolation fix). May be null in local mode.
  if (entry.owner == null) entry.owner = activeOwner;
  await idbPut('entries', entry);
  await markDirty(entry.id);
  return entry;
}

/** Soft delete: keeps a tombstone so sync can propagate the deletion. */
export async function softDeleteEntry(id) {
  const entry = await idbGet('entries', id);
  if (!entry) return;
  entry.deleted = true;
  entry.updatedAt = new Date().toISOString();
  await idbPut('entries', entry);
  await markDirty(id);
}

/** Claim every unclaimed (owner null/undefined) entry for `uid`, marking each
    dirty so sync pushes it. Used by the first-sign-in adopt flow. Returns the
    number of entries adopted. */
export async function adoptLocalEntries(uid) {
  if (!uid) return 0;
  const all = await idbAll('entries');
  let count = 0;
  for (const e of all) {
    if (ownerOf(e) !== null) continue;
    e.owner = uid;
    await idbPut('entries', e);
    await markDirty(e.id);
    count++;
  }
  return count;
}

/** Wipe ALL local data (entries + blobs + meta) on this device. This is the
    explicit "sign out and clear this device" action — never called by a normal
    sign-out, which must preserve offline-first local data. */
export async function clearLocalData() {
  for (const store of STORES) await idbClear(store);
}

/* ---------------- blobs ---------------- */

export async function putBlob(rec) {
  return idbPut('blobs', rec);
}

export async function getBlob(id) {
  return idbGet('blobs', id);
}

export async function deleteBlob(id) {
  return idbDelete('blobs', id);
}

/* ---------------- dirty tracking (for sync) ---------------- */

const dirtyKey = (id) => `dirty:${id}`;

export async function markDirty(id) {
  await idbPut('meta', { id: dirtyKey(id), entryId: id, at: new Date().toISOString() });
}

/** @returns {Promise<string[]>} entry ids awaiting sync */
export async function getDirty() {
  const all = await idbAll('meta');
  return all.filter((m) => m.id.startsWith('dirty:')).map((m) => m.entryId);
}

export async function clearDirty(id) {
  await idbDelete('meta', dirtyKey(id));
}

/* ---------------- export / import ---------------- */

/**
 * Everything needed to reconstruct the diary.
 * Blobs are live Blob objects — the exporter serializes them (e.g. to data URLs).
 */
export async function allForExport() {
  const entries = await listEntries();
  const wanted = new Set();
  for (const e of entries) {
    for (const pid of e.photoIds || []) wanted.add(pid);
    if (e.voiceId) wanted.add(e.voiceId);
  }
  const blobs = [];
  for (const id of wanted) {
    const rec = await idbGet('blobs', id);
    if (rec) blobs.push(rec);
  }
  return { version: 1, exportedAt: new Date().toISOString(), entries, blobs };
}

/**
 * Import an allForExport-shaped payload. Blob records may carry a `dataUrl`
 * string instead of a `blob`. Existing records with the same ids are replaced.
 * Does NOT emit events — the caller emits 'entries-changed'.
 * @returns {Promise<{entries:number, blobs:number}>}
 */
export async function importData(payload) {
  if (!payload || !Array.isArray(payload.entries)) {
    throw new Error('Not a Wayfarer export: missing entries.');
  }
  let blobCount = 0;
  for (const raw of payload.blobs || []) {
    if (!raw || !raw.id) continue;
    let blob = raw.blob;
    if (!(blob instanceof Blob) && typeof raw.dataUrl === 'string') {
      // Security: only ever decode data: URIs. A crafted import file could
      // otherwise make us fetch() arbitrary http(s)/intranet URLs (beacon /
      // SSRF / DoS) — the app must stay fully offline in local mode.
      const dataUrl = raw.dataUrl.trim();
      if (!/^data:/i.test(dataUrl)) continue;
      try {
        blob = await (await fetch(dataUrl)).blob();
      } catch (e) {
        continue; // malformed data URI — skip this blob, keep importing
      }
    }
    if (!(blob instanceof Blob)) continue;
    await idbPut('blobs', {
      id: raw.id, blob, kind: raw.kind || 'photo',
      w: raw.w || 0, h: raw.h || 0, mime: raw.mime || blob.type || ''
    });
    blobCount++;
  }
  let entryCount = 0;
  for (const e of payload.entries) {
    if (!e || !e.id) continue;
    // Put verbatim — an incoming `owner` (e.g. a remote row stamped by sync.js)
    // is preserved as-is; a plain JSON import stays unclaimed (owner absent)
    // until the sign-in adopt flow claims it.
    await idbPut('entries', e);
    await markDirty(e.id);
    entryCount++;
  }
  return { entries: entryCount, blobs: blobCount };
}
