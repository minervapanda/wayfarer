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

drop policy if exists "wayfarer-media owner insert" on storage.objects;
create policy "wayfarer-media owner insert" on storage.objects
  for insert with check (
    bucket_id = 'wayfarer-media'
    and (storage.foldername(name))[1] = auth.uid()::text
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
