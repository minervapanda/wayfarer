/* functions/_middleware.js — Cloudflare Pages Functions password gate for Wayfarer.
 *
 * Runs on EVERY request (root middleware intercepts static assets too).
 * Session cookie:  wayfarer_s = "<expiryEpochSeconds>.<sigBase64url>"
 *   sig = HMAC-SHA256(expiry string) with a key derived once per request from
 *   env.SITE_PASSWORD:  key = SHA-256(SITE_PASSWORD + ':wayfarer-session-v1').
 * Changing the password therefore invalidates every session — by design.
 *
 * Never logs or echoes the password. All auth-flow responses are no-store.
 */

const COOKIE_NAME = 'wayfarer_s';
const SESSION_MAX_AGE = 2592000; // 30 days, in seconds
const KEY_SALT = ':wayfarer-session-v1';
const SECRET_CMD = 'npx wrangler@4 pages secret put SITE_PASSWORD --project-name wayfarer';

const enc = new TextEncoder();

/* ---------------- crypto helpers ---------------- */

async function deriveKey(password) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(password + KEY_SALT));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function b64url(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSign(key, message) {
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}

/* Constant-time comparison of two ArrayBuffers/strings' bytes. */
function timingSafeEqual(a, b) {
  const ba = a instanceof ArrayBuffer ? new Uint8Array(a) : enc.encode(String(a));
  const bb = b instanceof ArrayBuffer ? new Uint8Array(b) : enc.encode(String(b));
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/* ---------------- session cookie ---------------- */

function readCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const p = part.trim();
    if (p.startsWith(COOKIE_NAME + '=')) return p.slice(COOKIE_NAME.length + 1);
  }
  return null;
}

async function hasValidSession(request, key) {
  if (!key) return false;
  const raw = readCookie(request);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const expiryStr = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || !/^\d+$/.test(expiryStr)) return false;
  if (expiry <= Math.floor(Date.now() / 1000)) return false;
  const expected = b64url(await hmacSign(key, expiryStr));
  return timingSafeEqual(sig, expected);
}

/* `secure` is derived from the request protocol: production Pages is always
 * https (the Secure flag applies), while `wrangler pages dev` serves plain
 * http://localhost:8788, where Safari refuses to store Secure cookies —
 * omitting the flag there keeps the documented local preview usable. */
async function makeSessionCookie(key, secure) {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE);
  const sig = b64url(await hmacSign(key, expiry));
  return `${COOKIE_NAME}=${expiry}.${sig}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

function clearCookie(secure) {
  return `${COOKIE_NAME}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`;
}

/* ---------------- small utilities ---------------- */

/* Same-origin path only: must start with '/', must not start with '//' (or '/\'),
 * and must contain no control characters or backslashes anywhere — browsers strip
 * ASCII tab/newline from Location values, so '/<TAB>/evil.com' would otherwise
 * collapse into a protocol-relative '//evil.com' open redirect. */
function sanitizeTo(to) {
  if (typeof to !== 'string' || !to.startsWith('/')) return '/';
  if (to.startsWith('//') || to.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(to)) return '/';
  return to;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redirect(location, extraHeaders) {
  const headers = new Headers({
    'Location': location,
    'Cache-Control': 'no-store',
  });
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) headers.append(k, v);
  return new Response(null, { status: 302, headers });
}

/* ---------------- inline pages ---------------- */

const FAVICON_LINKS = `
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR42mNgGAWjYDCBxQ46/0nBVXryYEyqPqpYTokDsDoCJvHryzOiMcwBpOgZdQDRDihM9FqFC+NyADF6RqNgZKQB5Pw+IGkA2QEDEgUD7gCYRaPlwGg5MJoGRtMAWQ4YsDbhgLeKR8GIBQAEonvBUkBMZQAAAABJRU5ErkJggg==">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Ctext%20y='0.9em'%20font-size='90'%3E%F0%9F%93%96%3C/text%3E%3C/svg%3E">`;

/* Palette + primitives mirrored from css/base.css (passport paper + light/dark scene).
   Functions can't read the app's CSS at runtime, so the values are inlined here. */
const PAGE_CSS = `
:root {
  --paper: #faf4e6;
  --paper-edge: #e8dcc0;
  --ink: #3b2f21;
  --ink-soft: #71614a;
  --accent: #a3402c;
  --accent-contrast: #ffffff;
  --line: #d8c6a0;
  --scene-bg: #ece2cf;
  --scene-bg-deep: #e0d2b8;
  --scene-ink: #4a3d2c;
  --font-body: "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, "Times New Roman", serif;
  --font-script: "Snell Roundhand", "Savoye LET", "Apple Chancery", "Segoe Script", cursive;
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --radius: 14px;
  --radius-sm: 8px;
  --dur-2: 420ms;
  --focus-ring: 0 0 0 3px var(--paper), 0 0 0 6px var(--accent);
  --grain: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='140'%20height='140'%3E%3Cfilter%20id='n'%3E%3CfeTurbulence%20type='fractalNoise'%20baseFrequency='0.85'%20numOctaves='2'%20stitchTiles='stitch'/%3E%3CfeColorMatrix%20type='matrix'%20values='0%200%200%200%200.24%200%200%200%200%200.18%200%200%200%200%200.12%200%200%200%200.05%200'/%3E%3C/filter%3E%3Crect%20width='140'%20height='140'%20filter='url(%23n)'/%3E%3C/svg%3E");
}
@media (prefers-color-scheme: dark) {
  :root {
    --scene-bg: #241b13;
    --scene-bg-deep: #180f09;
    --scene-ink: #d8c9b2;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { height: 100%; }
body {
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  color: var(--scene-ink);
  background: radial-gradient(ellipse at 50% -10%, var(--scene-bg) 40%, var(--scene-bg-deep) 100%);
  background-attachment: fixed;
  -webkit-font-smoothing: antialiased;
}
.paper {
  width: 100%;
  max-width: 430px;
  padding: 44px 36px 36px;
  text-align: center;
  background-color: var(--paper);
  background-image: var(--grain);
  color: var(--ink);
  border: 1px solid var(--paper-edge);
  border-radius: var(--radius);
  box-shadow: 0 10px 30px rgba(59, 47, 33, 0.22), 0 2px 6px rgba(59, 47, 33, 0.12);
  animation: settle var(--dur-2) cubic-bezier(.33, .1, .25, 1) both;
}
@keyframes settle {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
}
.wordmark {
  font-family: var(--font-script);
  font-weight: 400;
  font-size: 52px;
  line-height: 1.15;
  color: var(--accent);
  margin: 0 0 4px;
}
.tagline {
  margin: 0 0 28px;
  color: var(--ink-soft);
  font-style: italic;
}
.rule {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 0 auto 28px;
  width: 72px;
}
form { text-align: left; }
label {
  display: block;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-bottom: 6px;
}
input[type="password"] {
  font-family: var(--font-body);
  font-size: 16px;
  color: var(--ink);
  background: #fdfaf1;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  min-height: 44px;
  width: 100%;
}
.error {
  margin: 10px 0 0;
  color: var(--accent);
  font-size: 15px;
}
button {
  font: inherit;
  font-family: var(--font-ui);
  font-size: 15px;
  font-weight: 600;
  width: 100%;
  margin-top: 20px;
  min-height: 48px;
  padding: 10px 18px;
  cursor: pointer;
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  box-shadow: 0 4px 14px rgba(59, 47, 33, 0.14);
  transition: background-color 160ms ease, transform 160ms ease;
}
button:hover { background: #8c3625; border-color: #8c3625; }
button:active { transform: translateY(1px); }
.hint {
  margin: 24px 0 0;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--ink-soft);
}
a { color: var(--accent); }
code, pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
pre {
  text-align: left;
  background: #fdfaf1;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  overflow-x: auto;
}
:focus { outline: none; }
:focus-visible { box-shadow: var(--focus-ring); border-radius: var(--radius-sm); }
button:focus-visible { border-radius: 999px; }
@media (prefers-reduced-motion: reduce) {
  .paper { animation: none; }
  * { transition-duration: 0.01ms !important; }
}`;

function pageShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>${FAVICON_LINKS}
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="paper">
${bodyHtml}
</main>
</body>
</html>`;
}

function loginPage({ to = '/', error = '', status = 200 } = {}) {
  const errorHtml = error
    ? `<p class="error" role="alert" id="pw-error">${escapeHtml(error)}</p>`
    : '';
  const html = pageShell('Wayfarer — This diary is private', `
<h1 class="wordmark">Wayfarer</h1>
<p class="tagline">This diary is private.</p>
<hr class="rule">
<form method="POST" action="/login" novalidate>
  <input type="hidden" name="to" value="${escapeHtml(sanitizeTo(to))}">
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" required autofocus
         autocomplete="current-password"${error ? ' aria-describedby="pw-error" aria-invalid="true"' : ''}>
  ${errorHtml}
  <button type="submit">Open my diary</button>
</form>
<p class="hint">You&rsquo;ll stay signed in on this device for 30 days.</p>`);
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function setupPage() {
  const html = pageShell('Wayfarer — Setup needed', `
<h1 class="wordmark">Wayfarer</h1>
<p class="tagline">Almost ready &mdash; one step left.</p>
<hr class="rule">
<p style="text-align:left">The <code>SITE_PASSWORD</code> secret hasn&rsquo;t been set for this
deployment yet, so the diary can&rsquo;t open its gate. From the project folder, run:</p>
<pre><code>${escapeHtml(SECRET_CMD)}</code></pre>
<p class="hint">Then redeploy (or wait a moment) and reload this page.</p>`);
  return new Response(html, {
    status: 500,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function logoutPage() {
  const html = pageShell('Wayfarer — Sign out', `
<h1 class="wordmark">Wayfarer</h1>
<p class="tagline">Close the diary on this device?</p>
<hr class="rule">
<form method="POST" action="/logout">
  <button type="submit">Sign out</button>
</form>
<p class="hint"><a href="/">Never mind &mdash; back to my diary</a></p>`);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/* ---------------- the gate ---------------- */

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const password = typeof env.SITE_PASSWORD === 'string' && env.SITE_PASSWORD.length > 0
    ? env.SITE_PASSWORD
    : null;
  const key = password ? await deriveKey(password) : null;
  const secure = url.protocol === 'https:';

  if (path === '/logout') {
    // State-changing: only a same-origin POST (the form below) clears the
    // cookie. A bare GET (link, cross-site navigation) just asks first, so a
    // hostile page can't force-clear a victim's session.
    if (request.method === 'POST') {
      return redirect('/login', { 'Set-Cookie': clearCookie(secure) });
    }
    return logoutPage();
  }

  if (path === '/login') {
    if (!password) return setupPage();

    if (request.method === 'POST') {
      let form;
      try {
        form = await request.formData();
      } catch {
        form = new Map();
      }
      const submitted = String(form.get('password') ?? '');
      const to = sanitizeTo(String(form.get('to') ?? '/'));

      // Constant-time check: compare HMACs of both values, never the raw strings.
      const sigSubmitted = await hmacSign(key, submitted);
      const sigActual = await hmacSign(key, password);
      if (!timingSafeEqual(sigSubmitted, sigActual)) {
        await delay(400);
        return loginPage({ to, error: "That's not the one — try again.", status: 401 });
      }

      return redirect(to, { 'Set-Cookie': await makeSessionCookie(key, secure) });
    }

    // GET (or HEAD) /login
    if (await hasValidSession(request, key)) return redirect('/');
    return loginPage({ to: sanitizeTo(url.searchParams.get('to') || '/') });
  }

  if (await hasValidSession(request, key)) {
    return next();
  }

  // Not authenticated. GET /login renders above; everything else bounces there.
  const to = sanitizeTo(path + url.search);
  return redirect('/login?to=' + encodeURIComponent(to));
}
