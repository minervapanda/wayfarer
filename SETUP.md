# Wayfarer — Cloud Sync Setup (Supabase)

Wayfarer runs happily with **no backend at all**: in local mode everything
lives in your browser (IndexedDB) and the app works fully offline. Follow this
checklist only if you want private cloud sync and magic-link sign-in across
devices. It takes about ten minutes and the free tier is plenty.

## Checklist

1. **Create a free Supabase project.**
   Sign in at <https://supabase.com>, click **New project**, pick any name and
   region, and wait for it to finish provisioning.

2. **Run the schema.**
   Open **SQL Editor**, paste the entire contents of
   [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates the
   `entries` table (one owner-scoped jsonb row per diary entry), enables
   row-level security with owner-only policies, and adds the sync index.
   The file is idempotent — re-running it is safe.

3. **Verify the private media bucket.**
   The schema also creates a **private** Storage bucket named
   `wayfarer-media` with owner-only policies (each file lives under
   `<your-user-id>/<blob-id>`, and the policies check that first path
   segment against `auth.uid()`). Check **Storage** in the dashboard: if the
   bucket isn't there, create it by hand — name `wayfarer-media`, **Public
   bucket OFF** — then re-run just the four `storage.objects` policies at the
   bottom of `schema.sql`.

4. **Enable email magic links.**
   - **Authentication → Sign In / Providers → Email**: make sure Email is
     enabled. Magic links are on by default; no password settings needed.
   - **Authentication → URL Configuration**: set **Site URL** to
     `https://minervapanda.github.io/wayfarer/` and add the same URL to the
     **Redirect URLs** allow-list. The emailed link must land back on the app
     so it can pick the session out of the URL.
   - Testing locally too? Also add your dev URL (e.g.
     `http://localhost:8000/`) to the redirect list.

5. **Copy the keys into `config.js`.**
   In **Project Settings → API**, copy the **Project URL** and the
   **anon public** key, then fill in [`config.js`](./config.js):

   ```js
   export const config = {
     SUPABASE_URL: 'https://<your-ref>.supabase.co',
     SUPABASE_ANON_KEY: '<anon public key>',
     BUCKET: 'wayfarer-media'
   };
   ```

6. **Redeploy.**
   Commit and push; once GitHub Pages redeploys, the site greets you with the
   sign-in landing instead of opening the diary straight away (there's a
   "Continue offline" option if you ever just want the local diary).

## Verify it works

- Visit the site → you see the Wayfarer landing with the email form.
- Enter your email → "Check your inbox" → open the link **on the same
  device/browser** → the diary opens and the header pill flips from
  **Syncing…** to **Synced**.
- Add an entry, then sign in from another browser or device → the entry (and
  its photos and voice note) appears there after a moment.
- Sign out from the ⋯ menu → you're back at the landing; your data stays put.

## Good to know

- **The anon key is public by design.** It ships in the repo and in every
  visitor's browser; that's how Supabase works. Row-level security is the
  actual boundary — every query and every stored file is restricted to
  `auth.uid() = user_id`, so a signed-out visitor (or another user) can never
  read your entries or media.
- **Free projects pause after ~1 week of inactivity.** Supabase pauses idle
  free-tier projects; the app then behaves as offline ("Offline (queued)" /
  "Sync error" pill) but keeps everything locally. One click on **Restore**
  in the Supabase dashboard brings sync back; queued changes push on the next
  sync.
- **Local mode is always a full product.** Without `config.js` filled in, the
  app never loads the Supabase client and never touches the network for sync.
  You can adopt sync later — existing local entries are pushed up on first
  sign-in.
- **Conflict rule** (if you edit on two devices): newest `updatedAt` wins per
  entry; deletions travel as tombstones. Unsynced local changes are never
  discarded in favor of older remote data.
