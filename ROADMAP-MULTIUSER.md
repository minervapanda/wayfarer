# Wayfarer — Public Multi-User Roadmap

_Plan drafted 2026-07-17. Turns Wayfarer from a single-owner private diary into a
multi-user app: public sign-ups, password ("passport") login, backend infra for
everyone's data, and Google Drive bulk photo import. All external facts below were
fact-checked against July 2026 sources; corrections are flagged inline._

## Executive summary

**The expensive part is already built and correct.** `supabase/schema.sql` and the
`wayfarer-media` bucket are genuinely multi-tenant — owner-only RLS isolates every user
by `auth.uid()`, the anon key is safe to ship (RLS guards it), and there is no IDOR on the
`<user_id>/<blob_id>` object-key convention. `js/sync.js` (LWW keyset sync + blob upload)
and `js/auth.js` (magic-link + offline fallback) are shipped. So this is a **controlled
activation, not a rewrite.**

The real remaining work is four things, in this order:
1. **Turn on password sign-up auth** (activate the shipped Supabase backend).
2. **Close two data-isolation bugs** that only matter once strangers share the app.
3. **Protect the storage/egress economics** (per-user quota now, Cloudflare R2 later).
4. **Add Google Drive import** (last — it carries the most setup).

Ship auth first, Drive last. Stay behind an invite wall until the isolation + privacy +
observability pieces are verified, then flip to open sign-ups.

## Build log — what actually shipped (activated 2026-07-17, updated 2026-07-18)

The plan below was executed. Current state of the deployed app:

- **Live** at `https://minervapanda.github.io/wayfarer/` (GitHub Pages), backed by Supabase
  project `ylqufwdiozpmezjubobb`. Runs in cloud mode.
- **Code shipped & deployed**: password 4-view auth gate, device-isolation owner model
  (Phase 1A); `profiles` + 250 MB quota + idempotent storage accounting, the R2 media-adapter
  seam (dormant), `PRIVACY.md`/`TERMS.md` (Phase 1B); `js/drive.js` Google Drive import
  (dormant until `config.GOOGLE_*` is set, Phase 5). The `delete-account` Edge Function is
  **deployed and E2E-verified** (2026-07-18).
- **Supabase configured**: schema run (3 tables, private `wayfarer-media` bucket verified
  `public=false`, 10 RLS policies, 4 triggers); email signups on; Site + redirect URLs set.
- **Google login is LIVE** (OAuth consent "Wayfarer", External/Production, non-sensitive
  scopes; Web client → the Supabase callback; provider enabled in Supabase).
- **E2E-verified against the live backend**: password signup + login, adopt flow, photo
  sync to Storage, exact quota accounting, two-user isolation, live production login, and
  the Google OAuth flow reaching Google's consent screen.
- **Policy change 2026-07-17 (commit f953ba4)**: **sign-in is now REQUIRED.** The
  "continue offline" bypass and the "Sign out & clear this device" button were removed, and
  the auth-unavailable failure paths keep the gate locked rather than opening a local diary.
  This intentionally reverses the offline-first *entry* stance in the plan below: a brand-new
  user now needs a connection for their first sign-in (returning users still work offline
  from cache), and there is no in-app button to wipe a shared device's local cache (per-user
  read-scoping still hides one user's cached entries from the next).
- **Known tradeoff currently in effect**: **confirm-email is OFF** so public signups work
  without custom SMTP — re-enabling it is gated on the SMTP follow-up below.

## What's already done vs. what's new

| Already built & correct | Net-new work |
|---|---|
| `public.entries` + owner-only RLS (`auth.uid() = user_id`) | Email+password sign-up / login / reset UI (injected into `#login-gate`) |
| Private `wayfarer-media` bucket, folder-RLS by `auth.uid()` | Retire the single shared-password gate (`functions/_middleware.js`) |
| `js/sync.js` LWW keyset sync + blob upload/download | **Fix device-isolation bugs** (push leak **and** read leak) |
| `js/auth.js` magic-link + "Continue offline" fallback | `public.profiles` + per-user storage quota (idempotent accounting) |
| `js/ingest.js` 1600px/q0.8 downscale + EXIF parse | Account-delete Edge Function (purges Storage, JWT-scoped) |
| `config.js` local-mode short-circuit when empty | `js/drive.js` — Picker import on the `drive.file` scope |
| Anon key is safe to expose (RLS enforces access) | Custom SMTP, `PRIVACY.md`/`TERMS.md`, anti-pause pinger, R2 cutover |

Multi-tenancy — the hard part — is done. Everything new is **additive** edits to files that
already exist, plus some owner-side console setup.

---

## Phased plan

Effort key: **S** ≈ an afternoon · **M** ≈ a few days · **L** ≈ a week+.

### Phase 0 — Activate the backend behind the existing beta wall — **S**
Get the shipped Supabase backend live with zero public exposure.
- **Owner console (Supabase):** finish `supabase login`; create the project; run
  `supabase/schema.sql` in the SQL editor; confirm `wayfarer-media` is **Private**; set a
  per-file size cap (5 MB — photos are <1 MB after downscale) and an image-only MIME
  allowlist. Enable the Email provider with **Confirm email ON**, password min length ≥8,
  and add the production `*.pages.dev` URL under Auth → URL Configuration (Site URL +
  Redirect URLs).
- **Code:** fill `SUPABASE_URL` + `SUPABASE_ANON_KEY` in `config.js` (this alone flips the
  app from local mode to cloud mode). **Keep `functions/_middleware.js` for now** — just
  reword its copy to "Wayfarer beta — enter access code."
- **Result:** you + invited testers sign up behind the shared beta password. Nothing public.

### Phase 1A — Password ("passport") login + device isolation — **M** _(the critical phase)_
Real sign-up/login, and no way for two people's data to bleed together on a shared device.

**Password auth in `js/auth.js`.** Today it only does `signInWithOtp`. Treat the frozen
`#login-gate` as a small **multi-view state machine** injected at runtime (same pattern as
the existing "Continue offline" button — `index.html` stays frozen), with four views:
_sign in_ · _create account_ · _forgot password_ · _set new password_. Wire:
- `signUp({ email, password, options:{ emailRedirectTo } })`
- `signInWithPassword({ email, password })`
- `resetPasswordForEmail(email, { redirectTo })`
- keep `signInWithOtp` as an "email me a link instead" fallback
- handle the `PASSWORD_RECOVERY` event in `onAuthStateChange` → inject the set-new-password
  form calling `updateUser({ password })`.

Email confirmation and recovery tokens land on the **same** redirect URL that
`detectSessionInUrl` already handles, so branch on the auth event, not the field alone. Set
`autocomplete` per view (`new-password` vs `current-password`) and inject before first paint
so password managers see the field. _(All six supabase-js v2 methods confirmed present.)_

**Device-isolation fix — this is the #1 must-fix and it has two halves:**
- _Push leak:_ today `pushDirty()` uploads **all** dirty local entries to whoever signs in
  next, so Person A's offline entries land in Person B's cloud account. → Stamp an
  **`owner`** field on each entry (and its dirty record) at write time in `store.js`, set
  from the active uid while signed in. This is a real `store.js` change, **not** a
  meta one-liner — `saveEntry()`/`importData()` must plumb the uid through. `pushDirty()`
  then auto-pushes only entries whose `owner` matches the active uid.
- _Read leak (caught in review):_ `store.listEntries()` reads one shared IndexedDB, and
  `pullRemote()` merges the signed-in user's rows into it — so on a family device Person B
  can still **see and open** Person A's local entries. → Scope local reads by active
  `owner` too, **or** wipe the local DB on account switch. Guarding only the push is not
  enough.
- _Adopt flow:_ on first cloud sign-in, if unowned local dirty entries exist, show a
  `confirmDialog()` ("Add the N notebook entries on this device to **this** account?",
  **default No**); only on Yes stamp them with the uid.
- Add a **"Sign out and clear this device"** control beside `#btn-signout`. Normal sign-out
  must **not** wipe local data (offline-first) — clearing is the explicit, separate action.

### Phase 1B — Quotas, account deletion, storage adapter seam — **M**
The economics and compliance guardrails. Separated from 1A so the login milestone ships
without waiting on triggers and Edge Functions.

- **Quota schema (`supabase/schema.sql`, additive).** Add
  `public.profiles (user_id uuid PK REFERENCES auth.users ON DELETE CASCADE,
  display_name text, storage_bytes bigint DEFAULT 0, quota_bytes bigint DEFAULT 262144000
  /*250 MB*/)` with owner-only RLS, and **deny client writes** to `storage_bytes`/
  `quota_bytes` (only a `SECURITY DEFINER` function touches them). Auto-provision a profile
  on every signup via an `AFTER INSERT ON auth.users` trigger (`handle_new_user`,
  SECURITY DEFINER). Gate the bucket insert policy's `WITH CHECK` on remaining quota.
- **Idempotent accounting (caught in review).** `sync.js` re-uploads blobs with
  `upsert:true` on every device/re-sync, so an additive `AFTER INSERT ON storage.objects`
  trigger would **double-count**. Account **per object `name`** instead — upsert a
  per-object size row keyed by name and `SUM` that — and reconcile periodically. Don't rely
  on `metadata->>'size'` being populated at trigger time.
- **Account deletion (`supabase/functions/delete-account/`).** A `service_role` Edge
  Function — the anon key **cannot** delete `auth.users` (confirmed). It must **derive the
  uid from the verified caller JWT's `sub`, never a client-supplied parameter** (else any
  authed user deletes any account — caught in review). It lists+removes all
  `storage.objects` under `<uid>/` **first** (Storage does **not** cascade on user delete,
  and deletion errors if objects remain — both confirmed), then calls
  `auth.admin.deleteUser(uid)`; entries rows cascade via FK. Note: this is the owner's first
  Deno Edge Function deploy (`supabase functions deploy` + a service_role secret) — real
  ops. Wire a "Delete my account and data" button.
- **Storage adapter seam (`js/sync.js`).** Extract the Supabase upload/download into
  `uploadBlob(userId, blobId, bytes)` / `downloadBlob(...)` dispatched on
  `config.MEDIA_BACKEND` (`'supabase' | 'r2'`). No behavior change — this is the seam that
  makes the Phase 4 R2 cutover a config flip rather than a rewrite.
- **Legal/privacy.** Publish `PRIVACY.md` + `TERMS.md`, linked from the login gate: reserve
  the right to remove content/accounts, list a takedown/abuse email, document a
  disable-and-purge procedure. _(Non-negotiable once strangers upload: US providers aware of
  apparent CSAM have a mandatory NCMEC reporting duty under 18 U.S.C. §2258A.)_

### Phase 2 — Custom SMTP + anti-abuse — **S** _(mostly owner console)_
Emails actually deliver, and bots can't burn your quota.
- **Custom SMTP is a hard prerequisite for public signup.** The built-in mailer sends
  **exactly 2 emails/hour and only to project-team addresses** — everyone else gets "Email
  address not authorized." Configure custom SMTP (Resend free tier, native Supabase
  integration) under Auth → Emails; that raises the starting cap to **exactly 30/hour**
  (adjustable). Customize the confirm/magic-link/reset templates to the app redirect URL.
  **Test the full confirm + reset flow with a non-team email before opening up.**
- **Enable Cloudflare Turnstile** (Auth → Bot and Abuse Protection; natively supported) and
  pass `captchaToken` in the auth calls. Note (caught in review): this means loading the
  external `challenges.cloudflare.com/turnstile` script and rendering a widget into the
  gate before first paint — add that host to the `ARCHITECTURE.md` network allowlist/CSP.
  It's the one sanctioned external script; scope it to the login gate only.
- **Don't trust the numeric rate-limit setting alone.** As of ~Jan 2026 the configurable
  per-IP sign-up/sign-in limit is reportedly under-enforced (~30–50 attempts slip through
  before 429 — confirmed). Turnstile + confirm-email are your real throttle; monitor Auth
  logs.
- **Leaked-password protection (HIBP) is Pro-plan only** — not on Free (confirmed;
  corrected from an earlier "may be gated" hedge). Treat it as a later add-on;
  Turnstile + confirm-email + min-length carry launch.

### Phase 3 — Open sign-ups — **S**
Remove the wall.
- **Delete `functions/_middleware.js`** (and drop the `SITE_PASSWORD` Cloudflare secret +
  `wayfarer_s` cookie) — but only in the **same change** that has Phase 2 verified, so the
  origin is never half-configured and open. Softer ramp: replace it with an `allowed_emails`
  invite-code check instead of full deletion.
- Turn on Supabase usage/billing alerts + spend cap. Add an admin SQL view of bytes/rows per
  user to spot runaway storage.
- **Anti-pause pinger** to beat the 7-day free-tier auto-pause. **Do not use a GitHub
  Actions `schedule` cron** — scheduled Actions auto-disable after ~60 days without repo
  commits, exactly the quiet window when you need it (caught in review). Use an external
  uptime pinger or a Cloudflare Cron Trigger you operate.
- Add a client-side **"Export my data"** button (injected) that zips IndexedDB + blobs
  locally — data portability at zero server cost, and a de-facto backup (Free tier has no
  backups).

### Phase 4 — Media to Cloudflare R2 — **M** _(triggered, not scheduled)_
Kill the egress variable before it bites. **Don't build until a threshold hits: ~800 MB
storage OR ~4 GB/mo egress OR ~15 active users.**
- **Why R2:** every full-library device re-sync re-downloads a user's photos, and egress is
  the one cost that scales unpredictably. R2 is **$0 egress** with **10 GB free storage**
  (10× Supabase's 1 GB), then $0.015/GB-mo (all confirmed, July 2026). Don't jump to
  Supabase Pro ($25/mo) just for storage headroom — Pro's value is backups + no auto-pause,
  not media capacity.
- **Owner:** create a **private** R2 bucket (R2 has no per-user JWT RLS — a public bucket
  would expose everyone's photos).
- **Code:** add `functions/media/[[path]].js` (Cloudflare Pages Function) that **verifies
  the caller's Supabase JWT via JWKS / asymmetric verification** (or an `auth.getUser`
  round-trip) — decide this explicitly; do **not** ship the project's HS256 secret into
  Cloudflare (caught in review). It checks `profiles.storage_bytes < quota_bytes`, then mints
  a short-TTL S3-presigned PUT/GET URL scoped to `<user_id>/<blobId>`. Use **`aws4fetch`**,
  not AWS SDK v3 (the SDK needs `DOMParser`, absent in the Workers runtime). Never expose
  `r2.dev`. Then set `config.MEDIA_BACKEND='r2'`, flip the `sync.js` adapter, and run a
  one-off copy (keys already match `<user_id>/<blobId>`).

### Phase 5 — Google Drive bulk import — **M–L**
Paste-and-import without a compliance burden. New runtime-injected `js/drive.js`.
- **Scope decision is load-bearing: use `drive.file`, not `drive.readonly`.** `drive.file`
  is **non-sensitive** — it skips the restricted-scope verification review **and** the
  recurring CASA security assessment (~$500+/yr). `drive.readonly` triggers both (confirmed).
  Nuance: a **published** app still needs basic OAuth brand verification; `drive.file` just
  skips the expensive review. Testing mode caps at 100 users, so publish to Production.
- **Owner console (Google Cloud):** create a project; enable Drive API + Picker API (Picker
  is free); create an OAuth 2.0 Web Client and an API key; OAuth consent screen = External,
  add **only** `.../auth/drive.file`, publish to Production.
  - **OAuth JS origin cannot be a wildcard (caught in review).** Google rejects `*.pages.dev`
    and broad `.dev` origins for the OAuth **client** — register the **exact production
    origin**. (The **API key**'s HTTP-referrer restriction _does_ allow `*.pages.dev/*` — the
    two are different knobs.) Consequence: **Drive import won't work on Cloudflare preview
    deploys** (each gets a fresh subdomain); it's production-only.
- **Flow (all client-side, reuses everything):** GIS
  `initTokenClient({ scope:'.../drive.file' })` → Picker (image DocsView, multi-select) → for
  each fileId `GET .../drive/v3/files/{id}?alt=media` with the bearer token → wrap Blob →
  `ingestFiles()` (1600px/q0.8, EXIF) in batches ≤24 → group into Entries by capture day →
  `saveEntry()`. Shipped `sync.js` pushes the small JPEGs automatically, so only ~200–400 KB
  downscaled images ever hit storage. **Route imports through the same
  `profiles.storage_bytes` quota gate** — bulk import is the single largest storage driver.
- **CORS caveat:** browser fetch of Drive bytes has historically hit CORS blocks. **Verify
  empirically first** (a 10-line fetch against one picked file). If blocked, add a thin
  `functions/drive-proxy.js` byte-proxy (fallback only — downscale still runs client-side, so
  the no-build ethos holds).
- **Folder caveat:** under `drive.file`, picking a folder does **not** cascade access to its
  children — default the UX to multi-selecting **photos**, not folders.
- **`config.js`:** add `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID` (empty by
  default → button hidden). Update the `ARCHITECTURE.md` network allowlist to permit
  `apis.google.com`, `accounts.google.com/gsi/client`, `www.googleapis.com`, and the Picker
  frame origin. Disclose Drive use in `PRIVACY.md` per Google's Limited Use terms.

### Owner data migration — trivial, after Phase 1A
Sign up for your own email+password account, open the app, import your latest JSON export
via the existing import UI. Entries land local+dirty, the adopt flow stamps them with your
uid, sync pushes them up. No bulk migration tooling needed.

---

## Decisions for you to make

| Decision | Recommended default |
|---|---|
| Google OAuth as a secondary login? | **Yes, add it** — OAuth users trigger zero confirm/reset emails, sidestepping the free-tier email bottleneck |
| Password UI given frozen `index.html`? | **Runtime-inject** into `#login-gate` (matches "Continue offline"); unfreeze only if autofill misbehaves |
| The Cloudflare shared-password gate? | **Keep as beta wall through Phases 0–2, delete in Phase 3** |
| Require email confirmation? | **On** (needs custom SMTP first) |
| Public sign-ups vs. invite-code first? | **Invite-code / beta wall** until isolation + privacy + observability verified, then flip |
| Supabase-only storage first, or R2 from day one? | **Phase it** — reuse the built sync path; defer presigned-URL complexity to Phase 4 |
| Per-user storage quota? | **250 MB** (~500 photos; caps a maxed abuser at ~$0.004/mo on R2) |
| Anti-pause: external pinger vs. Supabase Pro? | **External pinger** on Free; revisit Pro only when you also want managed backups |
| Drive import UX? | **Picker + `drive.file`** — private files work, no CASA/verification burden |
| Imported photos → entries? | **One entry per capture day** (offer a single-entry toggle) |

## Costs & limits reality check

- **The binding constraint on Supabase Free is media, not database or users.** DB size
  (500 MB) is irrelevant — Entry JSONB is tiny text (~10k entries ≈ 50 MB). MAU (50,000,
  confirmed) is irrelevant. The wall is **1 GB file storage + 5 GB/mo egress** (both
  confirmed).
- At ~0.5 MB/photo, 1 GB ≈ ~2,000 photos ≈ only **~10–20 real users**, and 5 GB egress is
  spent by ~20 full-library device re-syncs/month. That's why R2 (Phase 4) exists.
- **When money starts:** ~$0/mo through low-double-digit users on Free. First real spend is
  either R2 (~$0–5/mo for hundreds of users — mostly $0.015/GB over the 10 GB free tier;
  egress stays $0) **or** Supabase Pro ($25/mo, confirmed) only if you want managed daily
  backups / to kill auto-pause without the pinger. Leaked-password protection also needs Pro.
- Custom SMTP (Resend) is free at low volume — a prerequisite, not a cost driver.

## Top risks & mitigations

1. **Device data-bleed (#1 must-fix).** Push leak _and_ read leak on shared devices. →
   `owner`-tag entries at write time, scope both push and local reads by uid, default-No
   adopt prompt, explicit "sign out and clear." Must land before any public exposure.
2. **Emails silently fail without custom SMTP** (default = 2/hr, team-only). → Custom SMTP is
   a hard Phase-2 prerequisite; test with a non-team address first.
3. **Weakly-enforced auth rate limit.** → Turnstile + confirm-email + Auth-log monitoring;
   don't trust the numeric setting.
4. **Incomplete account deletion** — FK cascades rows but not Storage objects (GDPR-erasure
   failure; delete also errors if objects remain). → JWT-scoped service_role Edge Function
   purges `<uid>/*` first; verify the folder is empty on a test account.
5. **Delete/presign functions are IDOR-prone.** → Always derive uid from the verified JWT
   `sub`, never a client parameter.
6. **Removing the middleware exposes a half-configured origin.** → Delete only in the same
   change as verified Phase 2; keep an invite-code option as the softer path.
7. **R2 has no per-user RLS.** → Private bucket, serve/upload only via a JWT-verifying Pages
   Function with short-TTL prefix-scoped presigned URLs; never expose `r2.dev`.
8. **Quota accounting drift** under `upsert:true` re-uploads / out-of-band deletes. →
   Idempotent per-object-name accounting + periodic reconciliation; soft 250 / hard 300 MB.
9. **Drive download CORS** may block the client fetch. → Empirical 10-line test first; thin
   `drive-proxy.js` fallback (downscale stays client-side).
10. **Hosting strangers' photos = abuse/CSAM liability.** → TERMS/AUP, monitored abuse
    contact, disable-and-purge procedure, US NCMEC reporting. Non-negotiable once strangers
    upload.

---

## Open follow-ups (as of 2026-07-18)

Concrete items still outstanding, roughly in priority order. Each needs owner action that
couldn't be done autonomously (a CLI deploy, a third-party signup, or a judgment call).

1. ~~Deploy the account-delete function.~~ **DONE 2026-07-18** — deployed with
   `supabase functions deploy delete-account --no-verify-jwt` (authenticated via a
   Personal Access Token, no interactive login needed; the service-role key is
   auto-injected at runtime, so no secret was set). E2E-verified: a throwaway account with
   an uploaded object was deleted — the function returned `objectsRemoved:1`, the storage
   folder emptied, and re-sign-in failed. `--no-verify-jwt` is intentional (the function
   verifies the caller's token internally; keeps the browser CORS preflight unblocked).
2. **Custom SMTP + re-enable email confirmation — before promoting widely.**
   *(Deferred 2026-07-18 — decision: keep confirm-email OFF for now.)* The built-in mailer
   only delivers to the project's own team address. **Prerequisite the original plan missed:
   a verified sending domain.** Resend's free `onboarding@resend.dev` sender can only reach
   *your own* inbox; to email arbitrary signups you must verify a domain by adding SPF/DKIM
   DNS records — and `github.io` gives you no domain you can verify. So this needs: (a) a
   domain you own or buy (~$10–12/yr), (b) your own Resend account (created by you), (c) the
   DNS records added at the registrar. Once the domain is verified: paste Resend's SMTP
   creds into Supabase Auth → SMTP, flip Confirm-email ON, and test with an outside address.
   Until then signups work without email verification (acceptable pre-launch).
3. **Point the Google consent screen's Privacy/Terms at your own docs.** They currently show
   Supabase defaults; set them to `./PRIVACY.md` / `./TERMS.md` (or hosted copies) in the
   Google Auth Platform → Branding screen, and disclose Google/Drive usage per Google's
   Limited Use terms.
4. **Replace the `abuse@wayfarer.example` placeholder** in `TERMS.md`/`PRIVACY.md` with a
   real monitored contact before public launch.
5. **Anti-abuse for open signups (Phase 2/3):** enable Cloudflare Turnstile on the auth
   endpoints (needs loading `challenges.cloudflare.com` + a CSP/allowlist entry), and turn on
   Supabase billing alerts + spend cap before removing any invite wall.
6. **R2 media cutover (Phase 4), triggered not scheduled:** build `functions/media/[[path]].js`
   (JWT-verified presign) and flip `config.MEDIA_BACKEND='r2'` once storage ≈800 MB, egress
   ≈4 GB/mo, or ≈15 active users.
7. **Leaked-password protection (HIBP)** is Pro-plan only — enable it if/when you move to
   Supabase Pro.

**Operational note for any future Google Cloud work:** the console in the owner's Chrome
defaults to a *different* Google account (Yash Gupta / guptayash0270@gmail.com). Switch to
**minervapandaniki@gmail.com** via the account picker (no password needed) before touching
Google Cloud, or resources land in the wrong account.

---

_Method note: this plan was produced by a multi-agent design pass — four parallel design
briefs (auth, infra, Drive import, security+migration), an adversarial fact-check of 14
external claims against July 2026 sources, a synthesis, and a skeptic review whose ten
corrections are folded in above. Build log + follow-ups appended 2026-07-18 after the
activation and sign-in-required change._
