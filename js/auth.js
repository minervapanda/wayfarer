// auth.js — password ("passport") auth (Supabase). SIGN-IN IS REQUIRED: there
// is no anonymous / "continue offline" path for the deployed app.
// OWNER: Builder 4 (backend). Contract: ARCHITECTURE.md §3 + §7/§8 addendum.
//
// - config empty  → UNCONFIGURED (dev only): hide #login-gate, emit
//   'auth-changed' { session: null, mode: 'local' } so a backend-less fork
//   still runs. The live app always has config filled, so this never triggers.
// - config filled → dynamic import of supabase-js from esm.sh. The frozen
//   #login-gate is turned into a small runtime-injected MULTI-VIEW state
//   machine (index.html stays frozen): SIGN IN · CREATE ACCOUNT ·
//   FORGOT PASSWORD · SET NEW PASSWORD. Wires signInWithPassword / signUp /
//   resetPasswordForEmail / updateUser, keeps signInWithOtp (magic link) +
//   signInWithOAuth(google) as secondary actions, handles PASSWORD_RECOVERY.
//   On session → hide gate, emit 'auth-changed' { session, mode: 'cloud' },
//   start initSync(). Sign-out returns to the gate — the app stays locked
//   behind it until a real session exists.
// - If supabase-js can't load (offline / CDN blocked) → the gate stays SHOWN
//   with an error asking to reload. There is no usable offline fallback, so a
//   brand-new user needs a connection for the first sign-in; a returning
//   user's session is restored from cache once the client loads.

import { app, bus } from './state.js';
import { config } from '../config.js';
import { toast, confirmDialog } from './util.js';
import { initSync } from './sync.js';
import { clearLocalData } from './store.js';

const SUPABASE_MODULE = 'https://esm.sh/@supabase/supabase-js@2';
const LOCAL_TOAST_KEY = 'wayfarer-local-toast-seen';   // localStorage: one-time hint

let client = null;         // Supabase client, or null in local mode
let lastEmitKey = null;    // dedupes 'auth-changed' (token refreshes are silent)
let recoveryPending = false; // true while the SET NEW PASSWORD view is showing

// Injected-gate handles (set by wireGate)
let currentView = 'signin';
let setView = null;        // (view) => void
let gateEl = null;
let signoutEl = null;

const $ = (id) => document.getElementById(id);
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const redirectUrl = () => location.origin + location.pathname;

/* ---------------- tiny safe-storage helpers (private mode never throws) --- */

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* noop */ } }

/* ---------------- auth-changed emission ---------------- */

function emitAuth(session, mode) {
  app.session = session || null;
  const key = `${mode}|${session && session.user ? session.user.id : ''}`;
  if (key === lastEmitKey) return; // same state (e.g. TOKEN_REFRESHED) — stay quiet
  lastEmitKey = key;
  bus.emit('auth-changed', { session: session || null, mode });
}

/* ---------------- friendly auth error copy ---------------- */

function friendlyAuthError(err) {
  const m = ((err && err.message) || '').toLowerCase();
  if (m.includes('not confirmed') || m.includes('email not confirmed')) {
    return 'Please confirm your email first — check your inbox for the confirmation link.';
  }
  if (m.includes('invalid login') || m.includes('invalid credentials') ||
      m.includes('invalid_credentials') || m.includes('invalid grant')) {
    return 'That email or password doesn’t match. Try again, or reset your password.';
  }
  if (m.includes('already registered') || m.includes('already exists') || m.includes('user already')) {
    return 'An account with this email already exists — try signing in instead.';
  }
  if (m.includes('password') && (m.includes('at least') || m.includes('should be') || m.includes('length'))) {
    return err.message; // server's own length hint is the clearest thing to show
  }
  if (m.includes('provider is not enabled') || m.includes('not enabled')) {
    return 'That sign-in method isn’t available yet. Use email and password instead.';
  }
  return (err && err.message) ? err.message : 'Something went wrong. Please try again.';
}

/* ---------------- local mode ---------------- */

function enterLocalMode(gate, signout, { firstRunHint }) {
  if (gate) gate.hidden = true;
  syncSignoutButtons(signout, false);
  emitAuth(null, 'local');
  if (firstRunHint && !lsGet(LOCAL_TOAST_KEY)) {
    lsSet(LOCAL_TOAST_KEY, '1');
    toast('Running locally — set up sync in SETUP.md', 'info');
  }
}

// Configured, but the auth client couldn't load (offline / CDN blocked / bad
// config). Keep the gate SHOWN and the app locked behind it with an error —
// there is no offline fallback now that sign-in is required.
function showUnavailable(gate, message) {
  if (gate) gate.hidden = false;
  const statusEl = $('login-status');
  if (statusEl) statusEl.textContent = message;
  syncSignoutButtons($('btn-signout'), false);
  emitAuth(null, 'cloud');
}

/* ---------------- signout + clear-device button visibility ---------------- */

// Keep #btn-signout and the injected 'Delete my account and data' button in
// lockstep so they only ever appear together.
function syncSignoutButtons(signout, visible) {
  if (signout) signout.hidden = !visible;
  if (!signout || !signout.parentNode) return;
  const el = signout.parentNode.querySelector('.btn-delete-account');
  if (el) el.hidden = !visible;
}

// Inject a 'Delete my account and data' control beside #btn-signout. Danger
// confirm → call the JWT-scoped delete-account Edge Function (purges cloud
// Storage + auth.users) → wipe this device → sign out.
function injectDeleteAccount(signout) {
  if (!signout || !signout.parentNode) return;
  if (signout.parentNode.querySelector('.btn-delete-account')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost btn-delete-account';
  btn.style.minHeight = '44px';
  btn.style.color = 'var(--accent)'; // token-based danger accent (never a raw color)
  btn.textContent = 'Delete my account and data';
  btn.hidden = signout.hidden;
  btn.addEventListener('click', async () => {
    if (!client) {
      toast('You’re offline — sign in to delete your account.', 'warning');
      return;
    }
    const ok = await confirmDialog(
      'Permanently delete your Wayfarer account and every entry and photo stored in the cloud? This cannot be undone.',
      true
    );
    if (!ok) return;
    btn.disabled = true;
    try {
      // The function derives the uid from the verified JWT — no body param.
      const { data, error } = await client.functions.invoke('delete-account', { method: 'POST' });
      if (error) throw error;
      if (data && data.error) throw new Error(data.error);
    } catch (err) {
      console.warn('Wayfarer: account deletion failed', err);
      toast('We couldn’t delete your account just now. Please try again.', 'error');
      btn.disabled = false;
      return;
    }
    // Cloud data is gone — now purge this device and sign out.
    try {
      await clearLocalData();
      bus.emit('entries-changed', { reason: 'sync' }); // views refresh to empty
    } catch (err) {
      console.warn('Wayfarer: clear local data failed', err);
    }
    toast('Your account and all its data have been deleted.', 'success');
    await signOut();
  });
  signout.parentNode.insertBefore(btn, signout.nextSibling);
}

/* ---------------- cloud mode: session handling ---------------- */

function showRecovery(gate, signout) {
  if (gate) gate.hidden = false;
  syncSignoutButtons(signout, false);
  if (setView) setView('recovery');
  emitAuth(null, 'cloud'); // parked: not a real sign-in until the password is set
}

function applySession(gate, signout, session) {
  if (session) {
    if (gate) gate.hidden = true;
    syncSignoutButtons(signout, true);
    emitAuth(session, 'cloud');
    try { initSync(); } catch (err) { console.error('Wayfarer: initSync failed', err); }
    return;
  }

  syncSignoutButtons(signout, false);

  // Signed out with a backend configured → show the gate and keep the app
  // locked behind it. There is no "continue offline" bypass; sign-in is required.
  if (gate) {
    const wasHidden = gate.hidden;
    gate.hidden = false;
    if (wasHidden && setView) setView(currentView === 'recovery' ? 'signin' : currentView);
  }
  emitAuth(null, 'cloud'); // configured, signed out — sync stays parked
}

/* ---------------- cloud mode: gate wiring (multi-view state machine) ------- */

// Password inputs aren't in css/base.css's styled selector list — style them
// once with the same token-based rules the email input already gets.
function injectGateStyle() {
  if (document.getElementById('wf-auth-style')) return;
  const st = document.createElement('style');
  st.id = 'wf-auth-style';
  st.textContent =
    '#login-gate input[type="password"]{font-family:var(--font-body);font-size:16px;' +
    'color:var(--ink);background:color-mix(in srgb,var(--paper) 60%,#ffffff 40%);' +
    'border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;' +
    'min-height:44px;width:100%;}' +
    '.gate-actions{display:flex;flex-direction:column;gap:4px;align-items:center;margin-top:12px;}' +
    '.gate-link{min-height:44px;background:none;border:none;color:var(--accent);' +
    'text-decoration:underline;padding:8px;font-size:14px;cursor:pointer;}' +
    '.gate-oauth{min-height:44px;width:100%;border:1px solid var(--line);margin-top:6px;}';
  document.head.appendChild(st);
}

const VIEWS = {
  signin: {
    lede: 'Welcome back. Sign in to your diary.',
    send: 'Sign in', email: true, pw: true, pw2: false,
    pwAuto: 'current-password', pwPlace: 'Password'
  },
  signup: {
    lede: 'Create your Wayfarer account — your diary syncs privately to the cloud.',
    send: 'Create account', email: true, pw: true, pw2: true,
    pwAuto: 'new-password', pwPlace: 'Choose a password (8+ characters)'
  },
  forgot: {
    lede: 'Forgot your password? We’ll email you a reset link.',
    send: 'Send reset link', email: true, pw: false, pw2: false
  },
  recovery: {
    lede: 'Set a new password for your account.',
    send: 'Set new password', email: false, pw: true, pw2: true,
    pwAuto: 'new-password', pwPlace: 'New password (8+ characters)'
  }
};

function makePwField(id, label) {
  const wrap = document.createElement('div');
  const lab = document.createElement('label');
  lab.className = 'visually-hidden';
  lab.setAttribute('for', id);
  lab.textContent = label;
  const inp = document.createElement('input');
  inp.id = id;
  inp.name = id;
  inp.type = 'password';
  inp.autocomplete = 'new-password';
  wrap.append(lab, inp);
  return { wrap, inp };
}

function wireGate(gate) {
  if (!gate || gate.dataset.authWired) return;
  gate.dataset.authWired = '1';
  injectGateStyle();

  const card = gate.querySelector('.gate-card') || gate;
  const lede = gate.querySelector('.gate-lede');
  const form = gate.querySelector('.gate-form');
  const email = $('login-email');
  const send = $('login-send');
  const statusEl = $('login-status');
  const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };

  // --- inject password + confirm-password fields (before first paint so
  //     password managers pick them up) ---
  const pwField = makePwField('login-password', 'Password');
  const pw2Field = makePwField('login-password2', 'Confirm password');
  if (form && send) {
    form.insertBefore(pwField.wrap, send);
    form.insertBefore(pw2Field.wrap, send);
  }

  // --- actions row (view switches + secondary sign-in methods) ---
  const actions = document.createElement('div');
  actions.className = 'gate-actions';
  if (statusEl && statusEl.parentNode) {
    statusEl.parentNode.insertBefore(actions, statusEl.nextSibling);
  } else {
    card.appendChild(actions);
  }

  const linkBtn = (text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gate-link';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  async function sendMagicLink() {
    const addr = ((email && email.value) || '').trim();
    if (!validEmail(addr)) {
      setStatus('Enter your email first, then request a magic link.');
      if (email) email.focus();
      return;
    }
    setStatus('Sending your sign-in link…');
    try {
      const { error } = await client.auth.signInWithOtp({
        email: addr, options: { emailRedirectTo: redirectUrl() }
      });
      if (error) throw error;
      setStatus('Check your inbox — open the link on this device and your diary will unlock.');
    } catch (err) {
      console.warn('Wayfarer: magic link request failed', err);
      setStatus(friendlyAuthError(err));
    }
  }

  function googleBtn() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost gate-oauth';
    b.textContent = 'Continue with Google';
    b.addEventListener('click', async () => {
      setStatus('Redirecting to Google…');
      try {
        // Harmless if Google isn't enabled server-side — the error surfaces below.
        const { error } = await client.auth.signInWithOAuth({
          provider: 'google', options: { redirectTo: redirectUrl() }
        });
        if (error) throw error;
      } catch (err) {
        console.warn('Wayfarer: Google sign-in failed', err);
        setStatus(friendlyAuthError(err));
      }
    });
    return b;
  }

  function renderActions(view) {
    actions.textContent = '';
    if (view === 'signin') {
      actions.append(
        linkBtn('New here? Create an account', () => setView('signup')),
        linkBtn('Forgot your password?', () => setView('forgot')),
        linkBtn('Email me a magic link instead', sendMagicLink),
        googleBtn()
      );
    } else if (view === 'signup') {
      actions.append(
        linkBtn('Already have an account? Sign in', () => setView('signin')),
        googleBtn()
      );
    } else if (view === 'forgot') {
      actions.append(linkBtn('Back to sign in', () => setView('signin')));
    } else if (view === 'recovery') {
      actions.append(linkBtn('Cancel', () => setView('signin')));
    }
  }

  // --- the view switcher ---
  setView = function (view) {
    const cfg = VIEWS[view] || VIEWS.signin;
    currentView = view;
    if (lede) lede.textContent = cfg.lede;
    if (email) email.hidden = !cfg.email;
    pwField.wrap.hidden = !cfg.pw;
    pw2Field.wrap.hidden = !cfg.pw2;
    if (cfg.pw) {
      pwField.inp.autocomplete = cfg.pwAuto;
      pwField.inp.placeholder = cfg.pwPlace;
    }
    if (send) send.textContent = cfg.send;
    renderActions(view);
    setStatus('');
    const first = cfg.email ? email : pwField.inp;
    if (first && typeof first.focus === 'function') { try { first.focus(); } catch (e) { /* noop */ } }
  };

  const busy = (on) => {
    if (!send) return;
    send.disabled = on;
    send.textContent = on ? 'Working…' : (VIEWS[currentView] || VIEWS.signin).send;
  };

  // --- the one submit handler, branching on the active view ---
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const view = currentView;
      const addr = ((email && email.value) || '').trim();
      const pw = pwField.inp.value || '';
      const pw2 = pw2Field.inp.value || '';

      if (VIEWS[view].email && !validEmail(addr)) {
        setStatus('Please enter a valid email address.');
        if (email) email.focus();
        return;
      }
      if (VIEWS[view].pw && pw.length < 8) {
        setStatus('Password must be at least 8 characters.');
        pwField.inp.focus();
        return;
      }
      if (VIEWS[view].pw2 && pw !== pw2) {
        setStatus('Passwords don’t match.');
        pw2Field.inp.focus();
        return;
      }

      busy(true);
      try {
        if (view === 'signin') {
          const { error } = await client.auth.signInWithPassword({ email: addr, password: pw });
          if (error) throw error;
          setStatus('Signed in — opening your diary…');
        } else if (view === 'signup') {
          const { data, error } = await client.auth.signUp({
            email: addr, password: pw, options: { emailRedirectTo: redirectUrl() }
          });
          if (error) throw error;
          if (data && data.session) {
            setStatus('Account created — opening your diary…');
          } else {
            // Confirm-email is on: no session until they click the link.
            setStatus('Account created — check your inbox to confirm your email, then sign in.');
            setView('signin');
          }
        } else if (view === 'forgot') {
          const { error } = await client.auth.resetPasswordForEmail(addr, { redirectTo: redirectUrl() });
          if (error) throw error;
          setStatus('If that email has an account, a reset link is on its way — open it on this device.');
        } else if (view === 'recovery') {
          const { error } = await client.auth.updateUser({ password: pw });
          if (error) throw error;
          recoveryPending = false;
          setStatus('Password updated — opening your diary…');
          try {
            const { data } = await client.auth.getSession();
            applySession(gateEl, signoutEl, data ? data.session : null);
          } catch (e2) { /* onAuthStateChange will catch up */ }
        }
      } catch (err) {
        console.warn('Wayfarer auth: action failed', view, err);
        setStatus(friendlyAuthError(err));
      } finally {
        busy(false);
      }
    });
  }

  injectGateLegal(card);

  setView('signin'); // default view; ensures the password field exists pre-paint
}

// Runtime-injected Privacy / Terms footer link on the gate. Relative paths keep
// the subpath-hosting rule; open in a new tab so the sign-in flow isn't lost.
function injectGateLegal(card) {
  if (!card || card.querySelector('.gate-legal')) return;
  const foot = document.createElement('p');
  foot.className = 'gate-legal gate-status';
  foot.style.cssText = 'margin-top:14px;font-size:12px;text-align:center;';
  const link = (href, text) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    a.style.color = 'var(--accent)';
    return a;
  };
  foot.append(
    link('./PRIVACY.md', 'Privacy'),
    document.createTextNode(' · '),
    link('./TERMS.md', 'Terms')
  );
  card.appendChild(foot);
}

/* ---------------- public API ---------------- */

export async function initAuth() {
  const gate = $('login-gate');
  const signout = $('btn-signout');
  gateEl = gate;
  signoutEl = signout;

  // No backend configured → pure local mode, never load Supabase.
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    enterLocalMode(gate, signout, { firstRunHint: true });
    return;
  }

  let createClient = null;
  try {
    ({ createClient } = await import(SUPABASE_MODULE));
  } catch (err) {
    console.warn('Wayfarer: could not load Supabase client (offline / CDN blocked).', err);
    showUnavailable(gate, 'Couldn’t reach the sign-in service. Check your connection and reload the page.');
    return;
  }

  try {
    client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true // magic-link / confirm / recovery redirects land here
      }
    });
  } catch (err) {
    console.error('Wayfarer: Supabase client creation failed — check config.js.', err);
    client = null;
    showUnavailable(gate, 'Sign-in is temporarily unavailable (configuration error). Please try again later.');
    return;
  }

  wireGate(gate);
  injectDeleteAccount(signout);

  // Recovery links land on this same redirect URL. Detect early so the session
  // the recovery token creates can't silently open the diary before the user
  // has set a new password.
  if (/type=recovery/.test(location.hash) || /type=recovery/.test(location.search)) {
    recoveryPending = true;
  }

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') recoveryPending = true;
    if (recoveryPending) { showRecovery(gate, signout); return; }
    applySession(gate, signout, session);
  });

  let session = null;
  try {
    const { data } = await client.auth.getSession(); // also resolves a link/token in the URL
    session = data ? data.session : null;
  } catch (err) {
    console.warn('Wayfarer: session restore failed', err);
  }

  if (recoveryPending) showRecovery(gate, signout);
  else applySession(gate, signout, session);
}

/** @returns {object|null} Supabase client, or null in local mode. */
export function getClient() {
  return client;
}

export async function signOut() {
  if (!client) return; // local mode: nothing to sign out of
  try {
    const { error } = await client.auth.signOut();
    if (error) throw error;
    toast('Signed out. Your diary stays on this device.', 'info');
    // onAuthStateChange brings the gate back.
  } catch (err) {
    console.warn('Wayfarer: sign out failed', err);
    toast('Sign out didn’t complete. Check your connection and try again.', 'error');
  }
}
