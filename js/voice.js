// voice.js — dictation (Web Speech API) + voice notes (MediaRecorder).
// OWNER: Builder 3 (with css/voice.css). Contracts: ARCHITECTURE.md §3.
// No alert()/confirm()/prompt(). No unescaped user text near innerHTML —
// everything here is built with createElement/textContent.

/* =========================================================================
   shared helpers
   ========================================================================= */

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** seconds -> 'm:ss' (never negative, never NaN). */
function fmtTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '–:––';
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** el('button', 'vp-play', { type:'button', 'aria-label':'Play' }, 'text') */
function el(tag, className, attrs, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function svgIcon(pathD, viewBox = '0 0 16 16') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

const ICON_PLAY = 'M4 2.5v11l9-5.5z';
const ICON_PAUSE = 'M4 2.5h3v11H4zM9 2.5h3v11H9z';

/* =========================================================================
   1. Dictation — Web Speech API into a textarea
   ========================================================================= */

/**
 * Insert dictated text at the textarea cursor with smart spacing:
 * a space is added before/after when the surrounding characters need one,
 * and the fragment is capitalized at the start of the text or a sentence.
 */
function insertDictated(textarea, raw) {
  let text = String(raw || '').trim();
  if (!text) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);

  const prevSignificant = before.replace(/\s+$/, '').slice(-1);
  if (!prevSignificant || /[.!?…]/.test(prevSignificant)) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^[\s.,!?;:)\]]/.test(after) ? ' ' : '';

  textarea.value = before + pre + text + post + after;
  const caret = start + pre.length + text.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
  // let any listeners (e.g. autosave/validation) know the value changed
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Wire dictation into a textarea via a toggle button.
 * Handles: unsupported browser, permission denied, listening + interim ghost
 * text, auto-restart on silence. All state is narrated in statusEl.
 * @param {{textarea: HTMLTextAreaElement, button: HTMLButtonElement, statusEl: HTMLElement}} opts
 * @returns {{ stop: () => void }} handle so the compose controller can kill
 *   the mic when the dialog closes (Esc/Cancel must never leave a live mic).
 */
export function initDictation({ textarea, button, statusEl } = {}) {
  const noop = { stop() {} };
  if (!textarea || !button) return noop;

  /** status line = fixed state text + italic "ghost" of interim speech. */
  function setStatus(state, ghost) {
    if (!statusEl) return;
    statusEl.textContent = '';
    if (state) statusEl.appendChild(el('span', 'dictation-state', null, state));
    if (ghost) {
      statusEl.appendChild(document.createTextNode(' '));
      statusEl.appendChild(el('span', 'dictation-ghost', null, ghost));
    }
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.title = 'Dictation is not supported in this browser';
    setStatus('Dictation not supported in this browser — type instead.');
    return noop;
  }

  const idleLabel = button.textContent;
  let rec;
  try {
    rec = new SR();
  } catch (err) {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    setStatus('Dictation not supported in this browser — type instead.');
    return noop;
  }
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = document.documentElement.lang || navigator.language || 'en-US';

  let listening = false;    // user intent: mic toggled on
  let restartTimer = null;

  function reflectLive(live) {
    button.classList.toggle('mic-live', live);
    button.setAttribute('aria-pressed', live ? 'true' : 'false');
    button.textContent = live ? '🎙 Stop' : idleLabel;
  }

  function stopListening(message) {
    listening = false;
    clearTimeout(restartTimer);
    restartTimer = null;
    try { rec.stop(); } catch (e) { /* not started — fine */ }
    reflectLive(false);
    setStatus(message || '');
  }

  function startListening() {
    listening = true;
    reflectLive(true);
    setStatus('Listening…');
    try {
      rec.start();
    } catch (e) {
      // start() throws if already started; harmless.
    }
  }

  rec.onstart = () => { if (listening) setStatus('Listening…'); };

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcript = res[0] ? res[0].transcript : '';
      if (res.isFinal) insertDictated(textarea, transcript);
      else interim += transcript;
    }
    if (listening) setStatus('Listening…', interim.trim());
  };

  rec.onerror = (event) => {
    const code = event && event.error;
    if (code === 'no-speech' || code === 'aborted') return; // onend handles restart
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      stopListening('Microphone access is blocked. Click the mic/lock icon by your '
        + 'browser’s address bar, allow the microphone for this site, then try again.');
    } else if (code === 'audio-capture') {
      stopListening('No microphone was found. Plug one in or check your sound settings, then try again.');
    } else if (code === 'network') {
      stopListening('Dictation in this browser needs a network connection. You can keep typing.');
    } else {
      stopListening('Dictation hit a snag — press the mic to try again.');
    }
  };

  rec.onend = () => {
    if (!listening) return;
    // Engine gave up (silence / timeout) while the user still wants dictation:
    // restart quietly after a beat.
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!listening) return;
      try { rec.start(); } catch (e) { /* already running */ }
    }, 300);
  };

  button.addEventListener('click', () => {
    if (listening) stopListening('Dictation paused.');
    else startListening();
  });

  // Failsafe: never leave the mic running if the page goes away.
  // (pagehide fires on WINDOW, not document — a document listener never runs.)
  window.addEventListener('pagehide', () => { if (listening) stopListening(''); });

  return {
    /** Stop listening and reset the toggle — called when compose closes. */
    stop() { if (listening) stopListening(''); }
  };
}

/* =========================================================================
   2. Voice-note recorder — MediaRecorder widget
   ========================================================================= */

function pickMime() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ }
  }
  return '';
}

const MAX_RECORD_SECS = 600; // guard against a forgotten live mic

/**
 * Render a record / stop / preview / discard voice-note widget into rootEl.
 * @param {HTMLElement} rootEl
 * @param {Blob|null} [existingBlob] — an already-saved voice note (editing an
 *   entry that has one). It renders as a playable "Saved voice note" with
 *   Re-record / Remove, so the user can hear it and delete it — not just
 *   silently overwrite it.
 * @returns {{
 *   getResult: () => ({blob:Blob,duration:number,mime:string}|null),
 *   existingRemoved: () => boolean,  // user chose to drop the saved note
 *   reset: () => void
 * }}
 */
export function createVoiceRecorder(rootEl, existingBlob = null) {
  const noop = { getResult: () => null, existingRemoved: () => false, reset: () => {} };
  if (!rootEl) return noop;
  rootEl.classList.add('vr');

  let result = null;        // { blob, duration, mime } | null
  let existingDismissed = false; // user removed (or replaced-then-removed) the saved note
  let stream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerId = null;
  let rafId = null;
  let audioCtx = null;
  let disposed = false;

  function stopTracks() {
    if (stream) {
      for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { /* ignore */ } }
      stream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) { /* ignore */ }
      audioCtx = null;
    }
    clearInterval(timerId);
    timerId = null;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  let playerHost = null; // live preview player, torn down on every re-render

  function clear() {
    if (playerHost) {
      renderVoicePlayer(playerHost, null); // pause + revoke its object URL
      playerHost = null;
    }
    rootEl.textContent = '';
  }

  /* ---------- idle ---------- */
  function renderIdle(hint) {
    clear();
    const btn = el('button', 'btn vr-record-btn', { type: 'button' });
    btn.appendChild(el('span', 'vr-dot', { 'aria-hidden': 'true' }));
    btn.appendChild(document.createTextNode('Record voice note'));
    btn.addEventListener('click', startRecording);
    rootEl.appendChild(btn);
    rootEl.appendChild(el('p', 'vr-hint', null,
      hint || 'Sometimes a memory sounds better than it reads.'));
  }

  /* ---------- friendly inline problem states ---------- */
  function renderMessage(message, retry) {
    clear();
    const box = el('div', 'vr-msg', { role: 'status' });
    box.appendChild(el('p', 'vr-msg-text', null, message));
    if (retry) {
      const btn = el('button', 'btn vr-retry', { type: 'button' }, 'Try again');
      btn.addEventListener('click', startRecording);
      box.appendChild(btn);
    }
    rootEl.appendChild(box);
  }

  function renderUnsupported() {
    renderMessage('Voice notes aren’t supported in this browser — your photos and story still save perfectly.', false);
  }

  /* ---------- recording ---------- */
  function renderRecording() {
    clear();
    const live = el('div', 'vr-live');
    const badge = el('span', 'vr-rec-badge');
    badge.appendChild(el('span', 'vr-reddot', { 'aria-hidden': 'true' }));
    badge.appendChild(el('span', 'vr-rec-label', null, 'Recording'));
    const time = el('span', 'vr-time', { role: 'timer', 'aria-label': 'Elapsed time' }, '0:00');

    const dots = el('span', 'vr-dots', { 'aria-hidden': 'true' });
    const bars = [];
    for (let i = 0; i < 5; i++) {
      const d = el('span', 'vr-level-dot');
      d.style.setProperty('--i', String(i));
      dots.appendChild(d);
      bars.push(d);
    }

    const stopBtn = el('button', 'btn btn-primary vr-stop', { type: 'button' }, 'Stop');
    stopBtn.addEventListener('click', stopRecording);

    live.append(badge, time, dots, stopBtn);
    rootEl.appendChild(live);
    rootEl.appendChild(el('p', 'vr-hint', { 'aria-live': 'polite' }, 'Recording… press Stop when you’re done.'));

    timerId = setInterval(() => {
      const secs = (Date.now() - startedAt) / 1000;
      time.textContent = fmtTime(secs);
      if (secs >= MAX_RECORD_SECS) stopRecording();
    }, 250);

    startMeter(bars, dots);
    stopBtn.focus();
  }

  /** Animated level dots driven by the real mic signal; falls back to a CSS
      pulse; goes still under prefers-reduced-motion. */
  function startMeter(bars, dotsEl) {
    if (reducedMotion()) { dotsEl.classList.add('vr-dots--still'); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) { dotsEl.classList.add('vr-dots--pulse'); return; }
    try {
      audioCtx = new AC();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!audioCtx) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);           // ~0..1
        const level = Math.min(1, rms * 4);
        bars.forEach((b, i) => {
          const wobble = 0.55 + 0.45 * Math.sin(Date.now() / 90 + i * 1.7);
          b.style.transform = `scaleY(${Math.max(0.18, level * wobble).toFixed(3)})`;
        });
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } catch (e) {
      dotsEl.classList.add('vr-dots--pulse');
    }
  }

  /* ---------- preview (freshly recorded, not yet saved) ---------- */
  function renderPreview() {
    clear();
    const wrap = el('div', 'vr-preview');
    playerHost = el('div', 'vr-player');
    wrap.appendChild(playerHost);

    const row = el('div', 'vr-actions');
    const again = el('button', 'btn btn-ghost vr-again', { type: 'button' }, 'Re-record');
    again.addEventListener('click', () => { discard(); startRecording(); });
    const remove = el('button', 'btn btn-ghost vr-remove', { type: 'button' }, 'Remove');
    remove.addEventListener('click', () => {
      discard();
      // Removing the fresh take also means "no voice note on this entry" —
      // the old saved note must not silently reappear after save.
      if (existingBlob) existingDismissed = true;
      renderIdle('Voice note removed.');
    });
    row.append(again, remove);
    wrap.appendChild(row);
    rootEl.appendChild(wrap);

    renderVoicePlayer(playerHost, result.blob);

    // The Stop button the user just pressed is gone — without this, keyboard
    // focus falls back to <body> and the user has to Tab from the top of the
    // dialog to reach the new play/Re-record/Remove controls.
    const playBtn = playerHost.querySelector('.vp-play');
    if (playBtn) playBtn.focus();
  }

  /* ---------- existing saved note (editing an entry that has one) ---------- */
  function renderExisting() {
    clear();
    const wrap = el('div', 'vr-preview');
    wrap.appendChild(el('p', 'vr-hint', null, 'Saved voice note'));
    playerHost = el('div', 'vr-player');
    wrap.appendChild(playerHost);

    const row = el('div', 'vr-actions');
    const again = el('button', 'btn btn-ghost vr-again', { type: 'button' }, 'Re-record');
    // Re-record does NOT dismiss the saved note by itself: if the mic fails
    // or permission is denied mid-attempt, the old note must survive. A new
    // successful recording replaces it at save time via getResult().
    again.addEventListener('click', () => startRecording());
    const remove = el('button', 'btn btn-ghost vr-remove', { type: 'button' }, 'Remove');
    remove.addEventListener('click', () => {
      existingDismissed = true;
      renderIdle('Voice note removed — it will be deleted when you save.');
    });
    row.append(again, remove);
    wrap.appendChild(row);
    rootEl.appendChild(wrap);

    renderVoicePlayer(playerHost, existingBlob);
  }

  function discard() {
    if (result) result = null;
  }

  /* ---------- record flow ---------- */
  async function startRecording() {
    if (disposed) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function'
        || !window.MediaRecorder) {
      renderUnsupported();
      return;
    }
    renderMessage('Preparing microphone…', false);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        renderMessage('Microphone access was declined. To record, allow the microphone for this '
          + 'site (mic/lock icon by the address bar) and try again.', true);
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        renderMessage('No microphone was found on this device.', true);
      } else {
        renderMessage('The microphone couldn’t be started. Close other apps using it and try again.', true);
      }
      return;
    }
    if (disposed) { stopTracks(); return; }

    const mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      try {
        recorder = new MediaRecorder(stream);
      } catch (e2) {
        stopTracks();
        renderUnsupported();
        return;
      }
    }

    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = () => {
      stopTracks();
      recorder = null;
      renderMessage('Recording stopped unexpectedly. Nothing was lost but this note — try again.', true);
    };
    recorder.onstop = () => {
      const duration = Math.max(0, (Date.now() - startedAt) / 1000);
      const type = recorder && recorder.mimeType ? recorder.mimeType : (mime || 'audio/webm');
      recorder = null;
      stopTracks();
      if (disposed) return;
      if (!chunks.length) {
        renderMessage('Nothing was captured — the microphone may be muted. Try again.', true);
        return;
      }
      const blob = new Blob(chunks, { type });
      chunks = [];
      result = { blob, duration, mime: type };
      renderPreview();
    };

    try {
      recorder.start(250);
    } catch (e) {
      stopTracks();
      recorder = null;
      renderMessage('Recording couldn’t start in this browser. You can still write your story.', false);
      return;
    }
    startedAt = Date.now();
    renderRecording();
  }

  function stopRecording() {
    clearInterval(timerId);
    timerId = null;
    cancelAnimationFrame(rafId);
    rafId = null;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); return; } catch (e) { /* fall through */ }
    }
    stopTracks();
    if (!result) renderIdle();
  }

  if (existingBlob instanceof Blob) renderExisting();
  else renderIdle();

  return {
    getResult() { return result; },
    existingRemoved() { return existingDismissed; },
    reset() {
      disposed = true;
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (e) { /* ignore */ }
      }
      recorder = null;
      stopTracks();
      result = null;
      chunks = [];
      clear();
      rootEl.classList.remove('vr');
    }
  };
}

/* =========================================================================
   3. Read-only voice-note player — a little ticket stub
   ========================================================================= */

const playerCleanups = new Map(); // rootEl -> teardown fn (Map, not WeakMap: we must be able to sweep)

/** Tear down players whose mount elements have left the document. Book and
    journal rebuild their DOM on every 'entries-changed', throwing the old
    mounts away — with a WeakMap their cleanups never ran and every re-render
    leaked one object URL (pinning its audio blob in memory) per voice note. */
function sweepDetachedPlayers() {
  for (const [el, cleanup] of playerCleanups) {
    if (!el.isConnected) {
      cleanup();
      playerCleanups.delete(el);
    }
  }
}

/**
 * Render a small seekable play/pause player for an audio blob into rootEl.
 * Re-rendering into the same root tears the previous player down
 * (pauses audio, revokes its object URL).
 */
export function renderVoicePlayer(rootEl, blob) {
  if (!rootEl) return;
  sweepDetachedPlayers();
  const prior = playerCleanups.get(rootEl);
  if (prior) { prior(); playerCleanups.delete(rootEl); }
  rootEl.textContent = '';
  if (!blob) return;

  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;

  const box = el('div', 'vp', { role: 'group', 'aria-label': 'Voice note player' });

  const playBtn = el('button', 'vp-play', { type: 'button', 'aria-label': 'Play voice note' });
  playBtn.appendChild(svgIcon(ICON_PLAY));

  const body = el('div', 'vp-body');
  const seek = el('input', 'vp-seek', {
    type: 'range', min: '0', max: '100', step: '1', value: '0',
    'aria-label': 'Seek within voice note', disabled: ''
  });
  const timeRow = el('div', 'vp-time');
  const cur = el('span', 'vp-cur', null, '0:00');
  const total = el('span', 'vp-total', null, '–:––');
  timeRow.append(cur, el('span', 'vp-sep', { 'aria-hidden': 'true' }, ' / '), total);
  body.append(seek, timeRow);

  box.append(playBtn, body);
  rootEl.appendChild(box);

  let duration = NaN;
  let scrubbing = false;
  let dead = false;

  function setIcon(playing) {
    playBtn.textContent = '';
    playBtn.appendChild(svgIcon(playing ? ICON_PAUSE : ICON_PLAY));
    playBtn.setAttribute('aria-label', playing ? 'Pause voice note' : 'Play voice note');
    box.classList.toggle('vp-playing', playing);
  }

  function ready(d) {
    duration = d;
    total.textContent = fmtTime(d);
    seek.max = String(Math.max(1, Math.ceil(d)));
    seek.removeAttribute('disabled');
  }

  // MediaRecorder webm blobs often report duration=Infinity until we poke
  // the element past the end once (well-known Chrome quirk).
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      ready(audio.duration);
    } else {
      const onDur = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.removeEventListener('durationchange', onDur);
          audio.currentTime = 0;
          ready(audio.duration);
        }
      };
      audio.addEventListener('durationchange', onDur);
      try { audio.currentTime = 1e7; } catch (e) { /* ignore */ }
    }
  });

  audio.addEventListener('timeupdate', () => {
    if (dead || scrubbing || !Number.isFinite(duration)) return;
    cur.textContent = fmtTime(audio.currentTime);
    seek.value = String(Math.min(Number(seek.max), audio.currentTime));
  });

  audio.addEventListener('ended', () => {
    if (dead) return;
    setIcon(false);
    audio.currentTime = 0;
    seek.value = '0';
    cur.textContent = '0:00';
  });

  audio.addEventListener('error', () => {
    if (dead) return;
    rootEl.textContent = '';
    rootEl.appendChild(el('p', 'vp-error', { role: 'status' }, 'This voice note couldn’t be played.'));
  });

  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().then(() => setIcon(true)).catch(() => {
        setIcon(false);
      });
    } else {
      audio.pause();
      setIcon(false);
    }
  });
  audio.addEventListener('pause', () => { if (!dead) setIcon(false); });
  audio.addEventListener('play', () => { if (!dead) setIcon(true); });

  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  seek.addEventListener('pointerup', () => { scrubbing = false; });
  seek.addEventListener('input', () => {
    const t = Number(seek.value);
    if (Number.isFinite(t)) {
      try { audio.currentTime = Math.min(t, duration || t); } catch (e) { /* ignore */ }
      cur.textContent = fmtTime(t);
    }
  });
  seek.addEventListener('change', () => { scrubbing = false; });

  playerCleanups.set(rootEl, () => {
    dead = true;
    try { audio.pause(); } catch (e) { /* ignore */ }
    audio.removeAttribute('src');
    try { audio.load(); } catch (e) { /* ignore */ }
    URL.revokeObjectURL(url);
  });
}
