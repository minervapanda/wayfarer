// config.js — Wayfarer backend configuration.
//
// Leave everything empty to run in LOCAL MODE: the app works fully offline,
// stores everything in this browser (IndexedDB), and never touches the network.
//
// To enable private cloud sync, create a free Supabase project (see SETUP.md),
// then fill in the two values below and redeploy. The anon key is safe to ship
// in a public repo — row-level security in supabase/schema.sql does the guarding.
export const config = {
  SUPABASE_URL: '',        // e.g. 'https://abcdefghijkl.supabase.co'
  SUPABASE_ANON_KEY: '',   // Project Settings → API → anon public key
  BUCKET: 'wayfarer-media' // Storage bucket for photos & voice notes
};
