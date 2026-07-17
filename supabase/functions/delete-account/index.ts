// supabase/functions/delete-account/index.ts
// Wayfarer account-deletion Edge Function (Deno). OWNER: Builder 4 (backend).
//
// WHAT IT DOES: permanently deletes the CALLER's account and all of their media.
//   1. Verifies the caller's JWT and derives their uid from it (never a body param).
//   2. Lists + removes every object under `<uid>/` in the wayfarer-media bucket
//      (Storage does NOT cascade on user delete, and auth.admin.deleteUser errors
//      if objects remain — so media must go first).
//   3. Calls auth.admin.deleteUser(uid); public.entries + public.profiles rows
//      then cascade away via their ON DELETE CASCADE foreign keys.
//
// SECURITY: the uid comes ONLY from the verified bearer token via auth.getUser().
// A client-supplied uid/body is ignored — otherwise any signed-in user could delete
// any other account (IDOR). The service_role key is required because the anon key
// cannot touch auth.users; it lives ONLY in the function's secrets, never the client.
//
// DEPLOY:
//   supabase functions deploy delete-account
// REQUIRED SECRETS (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected by
// the platform at runtime; set them explicitly only if you disable that):
//   supabase secrets set SUPABASE_URL=https://<ref>.supabase.co
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BUCKET = 'wayfarer-media';
const PAGE = 100; // storage.list page size

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // --- verify the caller ---
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Missing bearer token' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'Function not configured' }, 500);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Derive the uid from the VERIFIED token — never from the request body (IDOR guard).
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return json({ error: 'Invalid or expired session' }, 401);
  }
  const uid = userData.user.id;

  try {
    // --- 1. purge storage under <uid>/ (delete-as-we-go, so re-listing the first
    //        page keeps surfacing the next batch until the folder is empty) ---
    let removed = 0;
    for (;;) {
      const { data: list, error: listErr } = await admin.storage
        .from(BUCKET)
        .list(uid, { limit: PAGE });
      if (listErr) return json({ error: 'Storage list failed', detail: listErr.message }, 500);
      if (!list || list.length === 0) break;
      const paths = list.map((o) => `${uid}/${o.name}`);
      const { error: rmErr } = await admin.storage.from(BUCKET).remove(paths);
      if (rmErr) return json({ error: 'Storage remove failed', detail: rmErr.message }, 500);
      removed += paths.length;
      if (list.length < PAGE) break;
    }

    // --- 2. delete the auth user; entries + profile cascade via FK ---
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) return json({ error: 'Account deletion failed', detail: delErr.message }, 500);

    return json({ status: 'deleted', uid, objectsRemoved: removed }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error', detail: String(e) }, 500);
  }
});
