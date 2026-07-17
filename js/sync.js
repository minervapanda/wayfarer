// sync.js — owner-scoped last-write-wins sync with Supabase. OWNER: Builder 4 (backend).
// Contract: ARCHITECTURE.md §3.
//
// Local mode: a quiet 'Local' pill, nothing else.
// Cloud mode (session arrives via 'auth-changed' from auth.js):
//   PULL — keyset-paginated over (updated_at, id) past the watermark, which
//          lives in the idb `meta` store under 'sync:watermark:<uid>' (with
//          localStorage and in-memory fallbacks). `updated_at` is stamped by
//          the SERVER (schema.sql trigger), so the watermark is monotonic in
//          insertion order and a device pushing an old offline edit can never
//          slip behind another device's watermark. Merge is last-write-wins
//          on the CLIENT edit time (data.updatedAt): remote newer wins, dirty
//          local wins ties and small clock skew, deleted:true tombstones are
//          respected both ways. Blobs referenced by local entries but missing
//          on this device are downloaded from Storage.
//   PUSH — dirty entries (store.getDirty) upserted as
//          { id, user_id, data (full entry json), deleted } — updated_at is
//          left to the server trigger. Photo/voice blobs are uploaded to
//          bucket config.BUCKET at <user_id>/<blobId> with upsert: true.
//          clearDirty per synced id.
// Never lose local data on conflict: a dirty local copy is only replaced by a
// remote one that is newer by more than CLOCK_SKEW_MS; a clean local copy is
// only replaced by a strictly newer remote one.
//
// #sync-status pill states: Local · Syncing… · Synced · Offline (queued) ·
// Sync error (+ Retry button).

import { app, bus } from './state.js';
import { config } from '../config.js';
import { debounce, confirmDialog } from './util.js';
import {
  listEntries, getEntry, getBlob, putBlob,
  getDirty, clearDirty, importData,
  setActiveOwner, adoptLocalEntries
} from './store.js';
import { getClient } from './auth.js';

const PAGE_SIZE = 500;          // pull page size
const PUSH_DEBOUNCE_MS = 2500;  // settle time after 'entries-changed'
const FOCUS_SYNC_MIN_MS = 60000; // don't re-sync on focus more than once a minute
const CLOCK_SKEW_MS = 5 * 60 * 1000; // LWW tolerance: dirty local edits survive this much clock drift

let started = false;
let engineActive = false;
let userId = null;
let pill = null;
let syncing = false;
let runAgain = false;
let lastFullSyncAt = 0;
const uploadedBlobIds = new Set(); // per-session cache; Storage upsert makes re-runs safe

/* =========================================================================
   MEDIA STORAGE ADAPTER — dispatch on config.MEDIA_BACKEND ('supabase' | 'r2')
   =========================================================================
   The seam that makes the Phase 4 R2 cutover a config flip, not a rewrite.
   Both adapters return the SAME shapes the Supabase Storage client returns, so
   the sync call sites are unchanged:
     uploadBlob   → { error }            (error null on success)
     downloadBlob → { data: Blob|null, error }
   For 'supabase' the behavior is byte-for-byte what sync.js did before. For 'r2'
   we ask a Pages Function for a short-TTL presigned URL then PUT/GET it directly.
   Defensive: if MEDIA_BACKEND is 'r2' but R2_MEDIA_ENDPOINT isn't configured,
   we silently fall back to the Supabase path so a half-set config never breaks
   sync. Object key stays `<userId>/<blobId>` in every backend. */

function useR2() {
  return config.MEDIA_BACKEND === 'r2' && !!config.R2_MEDIA_ENDPOINT;
}

/** Ask the R2 Pages Function for a presigned URL (op: 'put' | 'get'). Carries the
    Supabase JWT so the function can verify the caller and scope the URL to <uid>/. */
async function r2Presign(userId, blobId, op) {
  const client = getClient();
  let token = '';
  try {
    const { data } = await client.auth.getSession();
    token = data && data.session ? data.session.access_token : '';
  } catch (e) { /* no token — the function will reject if it requires one */ }
  const base = String(config.R2_MEDIA_ENDPOINT).replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(userId)}/${encodeURIComponent(blobId)}?op=${op}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error(`R2 presign ${op} failed: ${res.status}`);
  const body = await res.json();
  if (!body || !body.url) throw new Error('R2 presign response missing url');
  return body.url;
}

/** Upload one blob. @returns {Promise<{error: any}>} (error null on success). */
async function uploadBlob(userId, blobId, blob, contentType) {
  const type = contentType || (blob && blob.type) || 'application/octet-stream';
  if (useR2()) {
    try {
      const signed = await r2Presign(userId, blobId, 'put');
      const res = await fetch(signed, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
      if (!res.ok) return { error: new Error(`R2 PUT failed: ${res.status}`) };
      return { error: null };
    } catch (err) {
      return { error: err };
    }
  }
  // Supabase backend — EXACT prior behavior.
  return getClient().storage
    .from(config.BUCKET)
    .upload(`${userId}/${blobId}`, blob, { upsert: true, contentType: type });
}

/** Download one blob. @returns {Promise<{data: Blob|null, error: any}>}. */
async function downloadBlob(userId, blobId) {
  if (useR2()) {
    try {
      const signed = await r2Presign(userId, blobId, 'get');
      const res = await fetch(signed, { method: 'GET' });
      if (!res.ok) return { data: null, error: new Error(`R2 GET failed: ${res.status}`) };
      return { data: await res.blob(), error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  }
  // Supabase backend — EXACT prior behavior.
  return getClient().storage.from(config.BUCKET).download(`${userId}/${blobId}`);
}

/* =========================================================================
   STATUS PILL — Local · Syncing… · Synced · Offline (queued) · Error+Retry
   ========================================================================= */

const PILL = {
  local:   { label: 'Local',            title: 'Local mode — your diary lives only in this browser.' },
  syncing: { label: 'Syncing…',         title: 'Talking to your private cloud…' },
  synced:  { label: 'Synced',           title: 'Everything is safely in your private cloud.' },
  offline: { label: 'Offline (queued)', title: 'No connection — changes are queued and will sync when you’re back online.' },
  error:   { label: 'Sync error',       title: 'Something went wrong while syncing. Your changes are kept locally.' }
};

function setPill(state) {
  if (!pill) return;
  const def = PILL[state] || PILL.local;
  pill.textContent = def.label; // textContent only — never innerHTML
  pill.title = def.title;
  pill.dataset.state = state;
  if (state === 'error') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-ghost sync-retry';
    // 44px minimum touch target — this button appears exactly when the user
    // is worried about their data; it must not be the hardest thing to tap.
    // Negative vertical margins keep the little pill visually compact while
    // the full 44px box remains hit-testable.
    retry.style.cssText = 'margin:-10px 0 -10px 6px;min-height:44px;min-width:44px;padding:4px 12px;font-size:12px;';
    retry.textContent = 'Retry';
    retry.setAttribute('aria-label', 'Retry sync now');
    retry.addEventListener('click', () => fullSync());
    pill.appendChild(retry);
  }
}

/* =========================================================================
   WATERMARK — idb meta ('sync:watermark:<uid>') → localStorage → memory
   =========================================================================
   Note: ARCHITECTURE.md marks the meta store as store.js-internal; a
   store-level accessor has been requested in worklog/backend-needs.md.
   Until then sync.js opens its own connection to the same DB, using the
   identical upgrade routine so it can never leave the DB half-created.
   Losing the watermark is always safe — it only means a full re-pull. */

const memWatermarks = new Map();
let metaDbPromise = null;

function openMetaDb() {
  if (metaDbPromise) return metaDbPromise;
  metaDbPromise = new Promise((resolve) => {
    if (!('indexedDB' in globalThis)) { resolve(null); return; }
    let req;
    try {
      req = indexedDB.open('wayfarer', 1);
    } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      // Mirrors store.js exactly — safe if sync somehow opens the DB first.
      const d = req.result;
      for (const name of ['entries', 'blobs', 'meta']) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { try { d.close(); } catch (e) { /* noop */ } };
      resolve(d);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return metaDbPromise;
}

const watermarkKey = (uid) => `sync:watermark:${uid}`;

/** Watermark shape: { ts: '<server updated_at>', id: '<last row id>' }.
    The id is the keyset tiebreaker so rows sharing one timestamp can never be
    skipped across a page boundary. Legacy plain-timestamp watermarks (from
    earlier builds) parse to { ts, id: null } and are handled with an
    overlapping gte query (idempotent — LWW skips already-applied rows). */
function parseWatermark(v) {
  if (!v) return null;
  if (typeof v === 'object') return v.ts ? { ts: v.ts, id: v.id || null } : null;
  try {
    const o = JSON.parse(v);
    if (o && typeof o === 'object') return o.ts ? { ts: o.ts, id: o.id || null } : null;
  } catch (e) { /* legacy plain ISO string */ }
  return { ts: v, id: null };
}

async function getWatermark() {
  const key = watermarkKey(userId);
  const d = await openMetaDb();
  if (d) {
    try {
      const rec = await new Promise((resolve, reject) => {
        const r = d.transaction('meta', 'readonly').objectStore('meta').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return parseWatermark(rec && rec.value);
    } catch (e) { /* fall through */ }
  }
  try { return parseWatermark(localStorage.getItem(`wayfarer-${key}`)); } catch (e) { /* noop */ }
  return parseWatermark(memWatermarks.get(key));
}

async function setWatermark(mark) {
  const key = watermarkKey(userId);
  memWatermarks.set(key, mark);
  const d = await openMetaDb();
  if (d) {
    try {
      await new Promise((resolve, reject) => {
        const r = d.transaction('meta', 'readwrite').objectStore('meta').put({ id: key, value: mark });
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
      return;
    } catch (e) { /* fall through */ }
  }
  try { localStorage.setItem(`wayfarer-${key}`, JSON.stringify(mark)); } catch (e) { /* memory only */ }
}

/* =========================================================================
   PULL — remote → local, LWW merge, tombstones both ways
   ========================================================================= */

async function applyRemoteRow(row, dirtyBefore) {
  if (!row || !row.id) return false;
  const remote = row.data && typeof row.data === 'object' ? { ...row.data } : null;
  if (!remote) return false;
  remote.id = row.id;
  remote.deleted = !!(row.deleted || remote.deleted);
  if (!remote.updatedAt) remote.updatedAt = row.updated_at;
  remote.owner = userId; // pulled rows belong to the signed-in user (device isolation)

  const local = await getEntry(row.id);
  if (local) {
    const tLocal = Date.parse(local.updatedAt || '') || 0;
    const tRemote = Date.parse(remote.updatedAt || row.updated_at || '') || 0;
    // A dirty local copy survives ties AND small clock drift: raw client
    // clocks are not comparable, and losing a real local edit to a device
    // with a fast clock is worse than re-pushing one. (It will be pushed.)
    if (dirtyBefore.has(row.id) && tLocal + CLOCK_SKEW_MS >= tRemote) return false;
    if (tLocal >= tRemote) return false;                            // clean copy already current
  }

  // importData puts the entry verbatim (updatedAt preserved) but marks it
  // dirty — a pulled entry is clean by definition, so clear the mark…
  await importData({ version: 1, entries: [remote], blobs: [] });

  // …UNLESS the user hit Save on this entry while the pull was in flight.
  // If the stored copy is no longer the row we just wrote, their save won the
  // race — keep its dirty mark so the edit is pushed, never silently dropped.
  const after = await getEntry(row.id);
  if (!after || after.updatedAt === remote.updatedAt) {
    await clearDirty(row.id);
  }
  return true;
}

async function pullRemote(client) {
  const dirtyBefore = new Set(await getDirty());
  let mark = await getWatermark();
  let changed = false;

  for (;;) {
    let q = client.from('entries')
      .select('id, data, updated_at, deleted')
      .eq('user_id', userId)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })            // stable tiebreaker for keyset paging
      .limit(PAGE_SIZE);
    if (mark && mark.ts) {
      if (mark.id) {
        // Keyset cursor over (updated_at, id): rows that share the boundary
        // timestamp but sort after the last-seen id are still included.
        q = q.or(`updated_at.gt."${mark.ts}",and(updated_at.eq."${mark.ts}",id.gt.${mark.id})`);
      } else {
        // Legacy timestamp-only watermark: overlap on equality instead of
        // skipping — re-applying already-seen rows is a no-op under LWW.
        q = q.gte('updated_at', mark.ts);
      }
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    if (!rows || !rows.length) break;

    for (const row of rows) {
      if (await applyRemoteRow(row, dirtyBefore)) changed = true;
      mark = { ts: row.updated_at, id: row.id };
    }
    await setWatermark(mark); // advance only after the page fully applied

    if (rows.length < PAGE_SIZE) break;
  }
  return changed;
}

/** Download blobs referenced by local entries that this device is missing.
    Runs every sync, so a blob that failed once is retried next time. */
async function downloadMissingBlobs(client) {
  const wanted = new Map(); // blobId -> 'photo' | 'audio'
  for (const e of await listEntries()) {
    for (const pid of e.photoIds || []) wanted.set(pid, 'photo');
    if (e.voiceId) wanted.set(e.voiceId, 'audio');
  }

  let changed = false;
  for (const [id, kind] of wanted) {
    if (!engineActive) break;
    if (await getBlob(id)) continue;
    const { data: blob, error } = await downloadBlob(userId, id);
    if (error || !blob) {
      console.warn(`Wayfarer sync: blob ${id} not downloadable yet`, error);
      continue; // entry still renders (minus this blob); retried next sync
    }
    let w = 0, h = 0;
    if (kind === 'photo' && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        w = bmp.width; h = bmp.height;
        bmp.close();
      } catch (e) { /* dimensions stay 0 — cosmetic only */ }
    }
    await putBlob({
      id, blob, kind, w, h,
      mime: blob.type || (kind === 'photo' ? 'image/jpeg' : 'audio/webm')
    });
    uploadedBlobIds.add(id); // it exists remotely — no need to re-upload
    changed = true;
  }
  return changed;
}

/* =========================================================================
   PUSH — dirty local entries + their blobs → remote
   ========================================================================= */

async function pushDirty(client) {
  const ids = await getDirty();
  let allOk = true;

  for (const id of ids) {
    if (!engineActive) return false;
    const entry = await getEntry(id);
    if (!entry) { await clearDirty(id); continue; } // stale dirty mark

    // Device isolation (push half): only the active user's own entries go up.
    // An unclaimed or foreign-owned entry stays dirty and local — it must never
    // leak into whoever happens to be signed in. (Adoption stamps owner=userId.)
    if ((entry.owner != null ? entry.owner : null) !== userId) continue;

    // Blobs first — the entry row must never reference media that isn't there.
    let blobsOk = true;
    if (!entry.deleted) {
      const blobIds = [...(entry.photoIds || [])];
      if (entry.voiceId) blobIds.push(entry.voiceId);
      for (const bid of blobIds) {
        if (uploadedBlobIds.has(bid)) continue;
        const rec = await getBlob(bid);
        if (!rec || !rec.blob) continue; // referenced but absent locally — nothing to send
        const { error } = await uploadBlob(
          userId, bid, rec.blob,
          rec.mime || rec.blob.type || 'application/octet-stream'
        );
        if (error) {
          console.warn(`Wayfarer sync: blob upload failed for ${bid}`, error);
          blobsOk = false;
          break;
        }
        uploadedBlobIds.add(bid);
      }
    }
    if (!blobsOk) { allOk = false; continue; } // stays dirty, retried next sync

    // updated_at is intentionally NOT sent: the schema.sql trigger stamps it
    // with the server clock, keeping every device's pull watermark monotonic.
    // (If we sent the client edit time, a row pushed after another device's
    // watermark had already advanced past that time would never be pulled.)
    // The client edit time still travels inside data.updatedAt for LWW.
    const { error } = await client.from('entries').upsert({
      id: entry.id,
      user_id: userId,
      data: entry, // full entry JSON — the client model is the source of truth
      deleted: !!entry.deleted
    });
    if (error) {
      console.warn(`Wayfarer sync: entry upsert failed for ${id}`, error);
      allOk = false;
      continue;
    }
    await clearDirty(id);
  }
  return allOk;
}

/* =========================================================================
   ENGINE
   ========================================================================= */

async function fullSync() {
  if (!engineActive || !userId) return;
  const client = getClient();
  if (!client) return;
  if (!navigator.onLine) { setPill('offline'); return; }
  if (syncing) { runAgain = true; return; }

  syncing = true;
  setPill('syncing');
  try {
    let changed = await pullRemote(client);
    if (await downloadMissingBlobs(client)) changed = true;
    const pushedOk = await pushDirty(client);
    if (changed) bus.emit('entries-changed', { reason: 'sync' });
    if (!engineActive) return; // signed out mid-flight; onAuth already set the pill
    setPill(pushedOk ? 'synced' : 'error');
    lastFullSyncAt = Date.now();
  } catch (err) {
    console.warn('Wayfarer sync: cycle failed', err);
    if (engineActive) setPill(navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
    if (runAgain) {
      runAgain = false;
      fullSync();
    }
  }
}

const schedulePush = debounce(() => { fullSync(); }, PUSH_DEBOUNCE_MS);

function startEngine(session) {
  const uid = session && session.user ? session.user.id : null;
  if (!uid) { stopEngine(); return; }
  if (engineActive && uid === userId) return; // token refresh etc.
  userId = uid;
  engineActive = true;
  uploadedBlobIds.clear();
  // Scope local reads/writes to this user BEFORE the first sync (device
  // isolation) and announce it so views drop any other user's local entries.
  setActiveOwner(uid);
  bus.emit('entries-changed', { reason: 'sync' });
  bootstrapUser(uid);
}

/** First-sign-in bootstrap: offer to adopt unclaimed local entries, then sync. */
async function bootstrapUser(uid) {
  try {
    await maybeAdoptLocalEntries(uid);
  } catch (err) {
    console.warn('Wayfarer sync: adopt check failed', err);
  }
  if (!engineActive || userId !== uid) return; // signed out / switched mid-prompt
  if (navigator.onLine) fullSync();
  else setPill('offline');
}

/** On first cloud sign-in, if unclaimed dirty entries exist on this device,
    offer (default No) to move them into this account. Only on Yes do we adopt. */
async function maybeAdoptLocalEntries(uid) {
  const dirtyIds = await getDirty();
  let n = 0;
  for (const id of dirtyIds) {
    const e = await getEntry(id);
    if (e && (e.owner == null)) n++;
  }
  if (n === 0) return;
  const ok = await confirmDialog(
    `Add the ${n} ${n === 1 ? 'entry' : 'entries'} on this device to this account?`,
    false
  );
  if (!ok || !engineActive || userId !== uid) return;
  const adopted = await adoptLocalEntries(uid);
  if (adopted > 0) bus.emit('entries-changed', { reason: 'sync' }); // views refresh
}

function stopEngine() {
  engineActive = false;
  userId = null;
  runAgain = false;
  schedulePush.cancel();
  // Back to local mode: unclaimed entries become visible again, the signed-in
  // user's entries drop out of view (they stay on disk for next sign-in).
  setActiveOwner(null);
  bus.emit('entries-changed', { reason: 'sync' });
  setPill('local');
}

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function initSync() {
  if (started) return; // idempotent — main.js boots it, auth.js may call it again
  started = true;
  pill = document.getElementById('sync-status');

  setPill('local');

  bus.on('auth-changed', (d) => {
    if (d && d.session) startEngine(d.session);
    else stopEngine();
  });

  bus.on('entries-changed', (d) => {
    if (!engineActive) return;
    if (d && d.reason === 'sync') return; // our own event — no feedback loop
    if (d && d.reason === 'cache-refreshed') return; // main.js re-announce, nothing new to push
    schedulePush();
  });

  window.addEventListener('online', () => {
    if (engineActive) fullSync();
  });
  window.addEventListener('offline', () => {
    if (engineActive) setPill('offline');
  });

  // Coming back to the tab? Pick up what other devices wrote (gently throttled).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (engineActive && !syncing && Date.now() - lastFullSyncAt > FOCUS_SYNC_MIN_MS) {
      fullSync();
    }
  });

  // auth.js may have emitted 'auth-changed' before initSync ran (boot order:
  // initAuth → initSync) — catch up from the shared app state.
  if (app.session) startEngine(app.session);
}
