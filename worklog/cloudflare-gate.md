# Worklog — Cloudflare Gate

- **2026-07-12** — Built the site-wide password gate for the Cloudflare Pages move.
  - `functions/_middleware.js` (new): root Pages Functions middleware gating every
    request (static assets included). Session cookie `wayfarer_s = <expiryEpoch>.<sigBase64url>`,
    sig = HMAC-SHA256 of the expiry string via WebCrypto; key derived once per request as
    SHA-256(SITE_PASSWORD + ':wayfarer-session-v1') → HMAC key, so rotating the password
    invalidates all sessions by design. Valid cookie → `context.next()`. Unauth: GET /login
    renders an inline login page; anything else 302s to `/login?to=<same-origin path>`
    (sanitized: must start with `/`, not `//` or `/\`). POST /login does a constant-time
    compare (HMACs of both values, byte-wise XOR loop), 400ms delay + gentle inline error +
    401 on mismatch, and on success sets `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
    and 302s to the sanitized `to`. GET /logout clears the cookie. Missing SITE_PASSWORD →
    500 setup page with the exact `npx wrangler@4 pages secret put SITE_PASSWORD` command.
    All login/401/500/redirect responses are `Cache-Control: no-store`. No secret is ever
    logged or echoed.
  - Login page is inline in the middleware: cream `.paper` card with grain, script
    "Wayfarer" wordmark, "This diary is private." line, labeled password input
    (autofocus, `autocomplete="current-password"`, `role="alert"` + `aria-describedby`
    on error), "Open my diary" button — palette/fonts/focus-ring/grain hexes copied
    literally from `css/base.css` (passport paper + light/dark scene via
    `prefers-color-scheme`), same 📖 PNG+SVG favicon data-URIs as `index.html`,
    44px+ targets, `prefers-reduced-motion` respected.
  - `wrangler.toml` (new): `name = "wayfarer"`, `pages_build_output_dir = "."`,
    `compatibility_date = "2026-07-01"`.
  - `SETUP-CLOUDFLARE.md` (new): numbered checklist (login → project create →
    secret put SITE_PASSWORD → deploy), Supabase redirect-URL note incl. the
    "be past the gate before clicking a magic link" warning, and the
    password-rotation-invalidates-sessions note.
  - `README.md`: added a Hosting section (Cloudflare Pages, private by default;
    GitHub Pages retired; paths stay `./relative`) and listed the new files in Layout.
  - Verified: `node --check` clean; 22-assertion Node harness exercised redirects,
    `to` sanitization (open-redirect attempts), wrong/right password, cookie shape,
    tamper/expiry rejection, password-rotation invalidation, logout, missing-secret
    500 page, and no-store headers — all pass.
