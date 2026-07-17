// config.js — Wayfarer backend configuration.
//
// Leave everything empty to run in LOCAL MODE: the app works fully offline,
// stores everything in this browser (IndexedDB), and never touches the network.
//
// To enable private cloud sync, create a free Supabase project (see SETUP.md),
// then fill in the two values below and redeploy. The anon key is safe to ship
// in a public repo — row-level security in supabase/schema.sql does the guarding.
export const config = {
  SUPABASE_URL: 'https://ylqufwdiozpmezjubobb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_VhVQ1SVMblszI-yPoRTHwg_qSzleT7x', // publishable key — safe to ship (RLS guards it)
  BUCKET: 'wayfarer-media', // Storage bucket for photos & voice notes

  // Media storage backend — where photo/voice blobs live.
  //   'supabase' (default): upload/download blobs directly through the Supabase
  //              Storage client. Zero extra setup.
  //   'r2'      : route blob bytes through a Cloudflare Pages Function that mints
  //              short-TTL presigned URLs against a private R2 bucket (Phase 4
  //              egress cutover). Only takes effect when R2_MEDIA_ENDPOINT is also
  //              set — otherwise sync transparently falls back to 'supabase'.
  MEDIA_BACKEND: 'supabase', // 'supabase' | 'r2'

  // R2 presign endpoint (Phase 4 only; leave empty until the Pages Function ships).
  // A base path whose `<base>/<uid>/<blobId>?op=put|get` returns { url } to PUT/GET.
  R2_MEDIA_ENDPOINT: '', // e.g. './media'

  // Google Drive bulk import (Phase 5 — js/drive.js). Leave all three empty to
  // keep the feature completely OFF: no Google code ever loads, no import button
  // appears, and the app stays fully offline-first. The button shows only when
  // BOTH GOOGLE_CLIENT_ID and GOOGLE_API_KEY are set. See ROADMAP-MULTIUSER.md
  // Phase 5 for the Google Cloud console setup (Drive API + Picker API, an OAuth
  // 2.0 Web client on the `drive.file` scope, and a browser API key).
  //
  // OAuth JS origin cannot be a wildcard — register the EXACT production origin,
  // so Drive import works on production only, not on preview subdomains.
  GOOGLE_CLIENT_ID: '', // OAuth 2.0 Web client id, e.g. '1234-abc.apps.googleusercontent.com'
  GOOGLE_API_KEY: '',   // Browser API key (referrer-restricted to your origin)
  GOOGLE_APP_ID: ''     // GCP project number (the Picker appId); optional but recommended
};
