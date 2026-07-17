-- supabase/schema.sql — Wayfarer backend schema. OWNER: Builder 4 (backend).
-- Run this whole file once in the Supabase SQL editor (it is idempotent —
-- safe to re-run). Principle: every row and every stored file belongs to
-- exactly one auth.users id, and row-level security enforces owner-only access.
--
-- The whole client-side Entry object lives in the `data` jsonb column, so the
-- backend never has to chase the client data model. `updated_at` and `deleted`
-- are mirrored as real columns because sync filters and indexes on them.

-- ===== entries =============================================================

create table if not exists public.entries (
  id          uuid primary key,
  user_id     uuid not null default auth.uid()
              references auth.users (id) on delete cascade,
  data        jsonb not null,                       -- full Entry JSON (ARCHITECTURE.md §1)
  updated_at  timestamptz not null default now(),   -- SERVER-stamped (trigger below); sync watermark key
  deleted     boolean not null default false        -- tombstone for sync
);

create index if not exists entries_user_updated
  on public.entries (user_id, updated_at, id);

-- updated_at is stamped by the SERVER on every write, so each device's pull
-- watermark is monotonic in real insertion order. If clients stamped it, a
-- row pushed late (offline edit, lagging clock) would sort BEHIND watermarks
-- other devices had already advanced past — and would never be pulled.
-- The client's own edit time lives untouched inside data->>'updatedAt' and is
-- what last-write-wins merging compares.
create or replace function public.wayfarer_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists entries_touch_updated_at on public.entries;
create trigger entries_touch_updated_at
  before insert or update on public.entries
  for each row execute function public.wayfarer_touch_updated_at();

alter table public.entries enable row level security;

-- Owner-only policies (drop-then-create keeps the file re-runnable).
drop policy if exists "entries owner select" on public.entries;
create policy "entries owner select" on public.entries
  for select using (auth.uid() = user_id);

drop policy if exists "entries owner insert" on public.entries;
create policy "entries owner insert" on public.entries
  for insert with check (auth.uid() = user_id);

drop policy if exists "entries owner update" on public.entries;
create policy "entries owner update" on public.entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "entries owner delete" on public.entries;
create policy "entries owner delete" on public.entries
  for delete using (auth.uid() = user_id);

-- ===== profiles: per-user account row + storage quota ======================
-- One row per auth.users id, auto-provisioned on signup (trigger below). Holds
-- a display name and the two quota numbers. storage_bytes is a DERIVED cache of
-- the user's total bytes in the bucket, kept current by SECURITY DEFINER triggers
-- on storage.objects (further down). quota_bytes defaults to 250 MB.
--
-- SECURITY: clients may read their own row and edit ONLY display_name. They must
-- never write storage_bytes/quota_bytes — those are the billing guardrail, so a
-- client that could raise its own quota_bytes could upload without limit. We deny
-- that with COLUMN-LEVEL grants (revoke all, then grant update on display_name
-- only); the SECURITY DEFINER accounting functions run as the table owner and so
-- bypass these grants to keep storage_bytes accurate.

create table if not exists public.profiles (
  user_id       uuid primary key
                references auth.users (id) on delete cascade,
  display_name  text,
  storage_bytes bigint not null default 0,               -- derived cache; DEFINER-maintained
  quota_bytes   bigint not null default 262144000        -- 250 MB (250 * 1024 * 1024)
);

alter table public.profiles enable row level security;

-- Column-level privileges: the app roles get SELECT and may UPDATE display_name
-- ONLY. storage_bytes/quota_bytes are untouchable from the client — the accounting
-- functions (SECURITY DEFINER) are the only writers. (Re-runnable: revoke/grant
-- are idempotent.)
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Owner-only read.
drop policy if exists "profiles owner select" on public.profiles;
create policy "profiles owner select" on public.profiles
  for select using (auth.uid() = user_id);

-- Owner-only update (column grants above already forbid the quota columns; this
-- policy just scopes the row to its owner).
drop policy if exists "profiles owner update" on public.profiles;
create policy "profiles owner update" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auto-provision a profile the moment an auth.users row is created. SECURITY
-- DEFINER so it can insert past the profiles RLS/grants; the insert is idempotent
-- (on conflict do nothing) so re-runs and retries never fail.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id)
    values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== storage: private 'wayfarer-media' bucket ============================
-- Matches config.BUCKET. Object key convention: <user_id>/<blob_id> — the
-- FIRST path segment is the owner's uid, which is what every policy checks
-- via (storage.foldername(name))[1] = auth.uid()::text.
--
-- (If your project rejects direct inserts into storage.buckets, create a
-- bucket named wayfarer-media in Dashboard → Storage instead — it MUST be
-- marked Private — then re-run this whole file; the upsert below will force
-- public=false either way.)
--
-- SECURITY: the bucket must be PRIVATE. A public bucket serves every object
-- at a guessable unauthenticated URL and the owner-only policies below become
-- irrelevant. `do update set public = false` (not `do nothing`) means
-- re-running this file also DOWNGRADES a bucket that was created or later
-- flipped to public — the documented fix ("re-run the file") really closes
-- the hole.

insert into storage.buckets (id, name, public)
  values ('wayfarer-media', 'wayfarer-media', false)
  on conflict (id) do update set public = false;

drop policy if exists "wayfarer-media owner read" on storage.objects;
create policy "wayfarer-media owner read" on storage.objects
  for select using (
    bucket_id = 'wayfarer-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owner-only insert, PLUS a quota gate: reject a new object when the owner is
-- already at or over quota_bytes. This only guards NEW objects — sync.js re-uploads
-- existing blobs with upsert:true, which is an UPDATE (not an INSERT) and so never
-- trips the quota; only genuinely new media counts against it. If a profile row is
-- somehow missing, coalesce(...) → true keeps writes working (fail-open, since the
-- accounting triggers still track usage).
drop policy if exists "wayfarer-media owner insert" on storage.objects;
create policy "wayfarer-media owner insert" on storage.objects
  for insert with check (
    bucket_id = 'wayfarer-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and coalesce(
      (select p.storage_bytes < p.quota_bytes
         from public.profiles p
        where p.user_id = auth.uid()),
      true
    )
  );

drop policy if exists "wayfarer-media owner update" on storage.objects;
create policy "wayfarer-media owner update" on storage.objects
  for update using (
    bucket_id = 'wayfarer-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'wayfarer-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "wayfarer-media owner delete" on storage.objects;
create policy "wayfarer-media owner delete" on storage.objects
  for delete using (
    bucket_id = 'wayfarer-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ===== IDEMPOTENT storage accounting =======================================
-- Why not just add bytes on INSERT? sync.js re-uploads every blob with
-- upsert:true on each device/re-sync, so an additive AFTER INSERT counter would
-- DOUBLE-COUNT the same object across devices. Instead we keep one size row PER
-- OBJECT NAME (the object key is <uid>/<blobId>, globally unique), upsert it on
-- insert/update, delete it on delete, and recompute profiles.storage_bytes as the
-- SUM of that user's rows. Re-uploading the same name just overwrites its size
-- row — the SUM is always correct, never drifting.
--
-- We also don't trust metadata->>'size' to be populated at INSERT time: Storage
-- may fill it in a follow-up UPDATE once the upload finalizes. Triggering on BOTH
-- insert and update means the size row self-corrects when the real size lands.
-- All functions are SECURITY DEFINER so they can write profiles/size rows that
-- the client itself is forbidden to touch.

-- Per-object size ledger, keyed by the storage object name (the full key).
create table if not exists public.storage_object_sizes (
  name    text primary key,          -- storage.objects.name == '<uid>/<blobId>'
  user_id uuid not null,             -- first path segment, for the SUM grouping
  bytes   bigint not null default 0
);
create index if not exists storage_object_sizes_user
  on public.storage_object_sizes (user_id);

-- No client access at all — this ledger is internal accounting.
alter table public.storage_object_sizes enable row level security;
revoke all on public.storage_object_sizes from anon, authenticated;

-- Recompute one user's cached total from the ledger.
create or replace function public.wayfarer_recompute_storage(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_uid is null then
    return;
  end if;
  update public.profiles
     set storage_bytes = coalesce(
           (select sum(bytes) from public.storage_object_sizes where user_id = p_uid),
           0)
   where user_id = p_uid;
end;
$$;

-- INSERT/UPDATE of an object → upsert its size row, then recompute the owner total.
create or replace function public.wayfarer_account_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_uid   uuid;
  v_bytes bigint;
begin
  if new.bucket_id <> 'wayfarer-media' then
    return new;
  end if;
  -- First path segment is the owner uid; skip non-conforming keys defensively.
  begin
    v_uid := ((storage.foldername(new.name))[1])::uuid;
  exception when others then
    return new;
  end;
  v_bytes := coalesce((new.metadata->>'size')::bigint, 0);
  insert into public.storage_object_sizes (name, user_id, bytes)
    values (new.name, v_uid, v_bytes)
    on conflict (name)
      do update set bytes = excluded.bytes, user_id = excluded.user_id;
  perform public.wayfarer_recompute_storage(v_uid);
  return new;
end;
$$;

-- DELETE of an object → drop its size row, then recompute the owner total.
create or replace function public.wayfarer_deaccount_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_uid uuid;
begin
  if old.bucket_id <> 'wayfarer-media' then
    return old;
  end if;
  delete from public.storage_object_sizes where name = old.name;
  begin
    v_uid := ((storage.foldername(old.name))[1])::uuid;
  exception when others then
    return old;
  end;
  perform public.wayfarer_recompute_storage(v_uid);
  return old;
end;
$$;

drop trigger if exists wayfarer_obj_accounting_ins on storage.objects;
create trigger wayfarer_obj_accounting_ins
  after insert or update on storage.objects
  for each row execute function public.wayfarer_account_object();

drop trigger if exists wayfarer_obj_accounting_del on storage.objects;
create trigger wayfarer_obj_accounting_del
  after delete on storage.objects
  for each row execute function public.wayfarer_deaccount_object();
