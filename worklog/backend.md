# Worklog — Builder 4 (backend: auth + sync)

## 2026-07-11

- **js/auth.js** — replaced stub. Local mode (empty config): gate + sign-out
  hidden, `auth-changed { session: null, mode: 'local' }`, one-time
  "Running locally — set up sync in SETUP.md" toast (localStorage-flagged).
  Cloud mode: dynamic `import('https://esm.sh/@supabase/supabase-js@2')`
  (import failure → graceful local-mode fallback + warning toast),
  `createClient` with `detectSessionInUrl` so the magic link lands back on the
  Pages subpath (`emailRedirectTo: location.origin + location.pathname`).
  Wires the #login-gate form (validation, sending/sent/error states in
  #login-status, button disabled while sending), injects a 44px
  "Continue offline" escape hatch at runtime (sessionStorage choice, cleared on
  sign-in), `onAuthStateChange` with deduped `auth-changed` emissions (token
  refreshes stay silent), `getClient()`, `signOut()` back to the gate. On
  session: hides gate, shows #btn-signout, emits `auth-changed`
  `{ session, mode: 'cloud' }`, kicks `initSync()`.
- **js/sync.js** — replaced stub with the owner-scoped LWW engine. Pull:
  paged `updated_at > watermark` (watermark in idb meta under
  `sync:watermark:<uid>`, localStorage/memory fallbacks; only advanced after a
  page fully applies), merge = remote newer wins, dirty local ≥ remote wins,
  tombstones respected both ways; applied via `store.importData` +
  `clearDirty` so pulled entries land clean with `updatedAt` intact. Every
  cycle also re-downloads any blobs referenced by local entries but missing on
  device (photo dimensions recovered via `createImageBitmap`). Push: dirty ids
  → blob uploads to `config.BUCKET` at `<uid>/<blobId>` (`upsert: true`,
  session-level uploaded cache) then entry upsert
  `{ id, user_id, data, updated_at, deleted }`, `clearDirty` per success;
  failures keep entries dirty for retry. Debounced (2.5s) full sync on
  `entries-changed` (own `reason:'sync'` events ignored — no feedback loop),
  online/offline listeners, throttled re-sync on tab focus, single-flight with
  re-run flag. #sync-status pill: Local · Syncing… · Synced ·
  Offline (queued) · Sync error + Retry button.
- **supabase/schema.sql** — finalized: `public.entries (id uuid pk, user_id
  uuid not null default auth.uid() refs auth.users on delete cascade, data
  jsonb not null, updated_at timestamptz default now(), deleted boolean
  default false)`, index `(user_id, updated_at)`, RLS + four owner-only
  policies; private `wayfarer-media` bucket insert + four `storage.objects`
  policies scoped to `(storage.foldername(name))[1] = auth.uid()::text`.
  Whole file idempotent (drop-policy-then-create).
- **SETUP.md** — finalized as a 6-step checklist (project → schema.sql →
  verify private bucket → magic links + Site/Redirect URL
  `https://minervapanda.github.io/wayfarer/` → keys into config.js →
  redeploy), verification walkthrough, notes on the anon key being public by
  design (RLS is the boundary), free-tier idle pausing (~1 week, one-click
  restore), and the LWW conflict rule.
- Checks: `node --check` clean on both JS files; Node ESM smoke test confirms
  the auth ↔ sync circular import resolves, local-mode `initAuth()` emits and
  `getClient()` returns null, `initSync()` is idempotent.
- Cross-file asks recorded in `worklog/backend-needs.md` (store-level meta
  accessor for the watermark; optional static gate button + pill CSS polish).
