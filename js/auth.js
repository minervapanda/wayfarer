// auth.js — magic-link auth (Supabase) with a fully offline local mode.
// OWNER: Builder 4 (backend). Contract: ARCHITECTURE.md §3.
//
// - config empty  → LOCAL MODE: hide #login-gate, emit 'auth-changed'
//   { session: null, mode: 'local' }, one-time toast pointing at SETUP.md.
//   Supabase is never loaded, no network is touched.
// - config filled → dynamic import of supabase-js from esm.sh; magic-link form
//   inside #login-gate; session restore + detectSessionInUrl (the emailed link
//   redirects back to the GitHub Pages URL and lands here); on session → hide
//   gate, emit 'auth-changed' { session, mode: 'cloud' }, start initSync().
//   Sign-out returns to the gate. A runtime-injected 'Continue offline' button
//   is the escape hatch (index.html is frozen, so it's added here).
// - If the esm.sh import fails (offline / blocked) → local mode with a toast.
//   The diary must always open.

import { app, bus } from './state.js';
import { config } from '../config.js';
import { toast } from './util.js';
import { initSync } from './sync.js';

const SUPABASE_MODULE = 'https://esm.sh/@supabase/supabase-js@2';
const LOCAL_TOAST_KEY = 'wayfarer-local-toast-seen';   // localStorage: one-time hint
const OFFLINE_CHOICE_KEY = 'wayfarer-offline-choice';  // sessionStorage: gate skipped

let client = null;       // Supabase client, or null in local mode
let lastEmitKey = null;  // dedupes 'auth-changed' (token refreshes are silent)

const $ = (id) => document.getElementById(id);

/* ---------------- tiny safe-storage helpers (private mode never throws) --- */

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* noop */ } }
function ssGet(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
function ssSet(key, val) { try { sessionStorage.setItem(key, val); } catch (e) { /* noop */ } }
function ssDel(key) { try { sessionStorage.removeItem(key); } catch (e) { /* noop */ } }

/* ---------------- auth-changed emission ---------------- */

function emitAuth(session, mode) {
  app.session = session || null;
  const key = `${mode}|${session && session.user ? session.user.id : ''}`;
  if (key === lastEmitKey) return; // same state (e.g. TOKEN_REFRESHED) — stay quiet
  lastEmitKey = key;
  bus.emit('auth-changed', { session: session || null, mode });
}

/* ---------------- local mode ---------------- */

function enterLocalMode(gate, signout, { firstRunHint }) {
  if (gate) gate.hidden = true;
  if (signout) signout.hidden = true;
  emitAuth(null, 'local');
  if (firstRunHint && !lsGet(LOCAL_TOAST_KEY)) {
    lsSet(LOCAL_TOAST_KEY, '1');
    toast('Running locally — set up sync in SETUP.md', 'info');
  }
}

/* ---------------- cloud mode: session handling ---------------- */

function applySession(gate, signout, session) {
  if (session) {
    ssDel(OFFLINE_CHOICE_KEY); // signing in supersedes an earlier "offline" choice
    if (gate) gate.hidden = true;
    if (signout) signout.hidden = false;
    emitAuth(session, 'cloud');
    try { initSync(); } catch (err) { console.error('Wayfarer: initSync failed', err); }
    return;
  }

  if (signout) signout.hidden = true;

  if (ssGet(OFFLINE_CHOICE_KEY)) {
    // User chose "Continue offline" this session — behave exactly like local mode.
    if (gate) gate.hidden = true;
    emitAuth(null, 'local');
    return;
  }

  if (gate) {
    const wasHidden = gate.hidden;
    gate.hidden = false;
    if (wasHidden) {
      const email = $('login-email');
      if (email && typeof email.focus === 'function') email.focus();
    }
  }
  emitAuth(null, 'cloud'); // configured, signed out — sync stays parked
}

/* ---------------- cloud mode: gate wiring ---------------- */

function wireGate(gate) {
  if (!gate || gate.dataset.authWired) return;
  gate.dataset.authWired = '1';

  const form = gate.querySelector('.gate-form');
  const email = $('login-email');
  const send = $('login-send');
  const statusEl = $('login-status');
  const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const addr = ((email && email.value) || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
        setStatus('Please enter a valid email address.');
        if (email) email.focus();
        return;
      }
      if (send) { send.disabled = true; send.textContent = 'Sending…'; }
      setStatus('Sending your sign-in link…');
      try {
        const { error } = await client.auth.signInWithOtp({
          email: addr,
          // Land back on this exact page (works on the GitHub Pages subpath
          // and on localhost alike). detectSessionInUrl picks the token up.
          options: { emailRedirectTo: location.origin + location.pathname }
        });
        if (error) throw error;
        setStatus('Check your inbox — open the link on this device and your diary will unlock.');
      } catch (err) {
        console.warn('Wayfarer: magic link request failed', err);
        setStatus(err && err.message
          ? `Couldn’t send the link: ${err.message}`
          : 'Couldn’t send the link. Please try again in a minute.');
      } finally {
        if (send) { send.disabled = false; send.textContent = 'Send magic link'; }
      }
    });
  }

  // 'Continue offline' escape hatch — injected at runtime (index.html is frozen).
  const card = gate.querySelector('.gate-card') || gate;
  if (!gate.querySelector('.gate-offline')) {
    const wrap = document.createElement('div');
    wrap.className = 'gate-offline';
    wrap.style.cssText =
      'margin-top:18px;padding-top:14px;border-top:1px solid var(--line);' +
      'display:flex;flex-direction:column;gap:6px;align-items:center;text-align:center;';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.style.minHeight = '44px';
    btn.textContent = 'Continue offline';
    const note = document.createElement('p');
    note.className = 'gate-status';
    note.style.margin = '0';
    note.textContent = 'No account needed — your diary stays on this device until you sign in.';
    btn.addEventListener('click', () => {
      ssSet(OFFLINE_CHOICE_KEY, '1');
      gate.hidden = true;
      emitAuth(null, 'local');
      toast('Running locally — sign in any time to turn on cloud sync.', 'info');
    });
    wrap.append(btn, note);
    card.appendChild(wrap);
  }
}

/* ---------------- public API ---------------- */

export async function initAuth() {
  const gate = $('login-gate');
  const signout = $('btn-signout');

  // No backend configured → pure local mode, never load Supabase.
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    enterLocalMode(gate, signout, { firstRunHint: true });
    return;
  }

  let createClient = null;
  try {
    ({ createClient } = await import(SUPABASE_MODULE));
  } catch (err) {
    console.warn('Wayfarer: could not load Supabase client (offline?) — falling back to local mode.', err);
    enterLocalMode(gate, signout, { firstRunHint: false });
    toast('Couldn’t reach the sync service — running locally. Your diary is safe on this device.', 'warning');
    return;
  }

  try {
    client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true // magic-link redirect lands on the Pages URL
      }
    });
  } catch (err) {
    console.error('Wayfarer: Supabase client creation failed — check config.js.', err);
    client = null;
    enterLocalMode(gate, signout, { firstRunHint: false });
    toast('Sync configuration looks wrong (see SETUP.md) — running locally.', 'warning');
    return;
  }

  wireGate(gate);

  client.auth.onAuthStateChange((_event, session) => {
    applySession(gate, signout, session);
  });

  let session = null;
  try {
    const { data } = await client.auth.getSession(); // also resolves a magic-link URL
    session = data ? data.session : null;
  } catch (err) {
    console.warn('Wayfarer: session restore failed', err);
  }
  applySession(gate, signout, session);
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
