# Worklog — voice module (Builder 3)

- 2026-07-11 — Replaced stubs in `js/voice.js` and `css/voice.css` with the full voice module.
  - `initDictation({textarea, button, statusEl})`: Web Speech API feature-detected
    (`SpeechRecognition || webkitSpeechRecognition`); unsupported browsers get a disabled
    button + tooltip + "type instead" status. Toggle listening on click (continuous,
    interimResults); final results insert at the textarea cursor with smart spacing and
    sentence capitalization (fires a bubbling `input` event); interim speech shows as
    italic ghost text in the status line; pulsing red mic style while live (reduced-motion
    safe); `not-allowed` errors explain how to re-enable the mic permission; auto-restarts
    after `no-speech`/engine timeouts while toggled on; `network`/`audio-capture` errors
    get friendly status copy. No alerts anywhere.
  - `createVoiceRecorder(rootEl)`: idle → recording (elapsed timer, five level dots driven
    by a WebAudio analyser with CSS-pulse fallback and a still variant under reduced
    motion, Stop button) → preview (ticket player + Re-record + Remove). MediaRecorder
    mime negotiation: `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` (Safari) →
    browser default. All tracks + AudioContext stopped on stop/reset; 10-minute auto-stop
    guard; permission-denied / no-mic / capture-error / empty-capture states rendered
    inline with a Try-again button. `getResult()` returns `{blob, duration (secs), mime}`
    or null; `reset()` disposes everything (used by main.js on compose close).
  - `renderVoicePlayer(rootEl, blob)`: ticket-stub player (perforated dashed edge) with a
    44px round play/pause button, seekable themed range input (keyboard operable), tabular
    time readout. Offscreen `Audio` + object URL, revoked on teardown (WeakMap cleanup per
    root; re-rendering the same root tears down the prior player — the recorder uses this
    to avoid URL leaks). Handles the Chrome MediaRecorder `duration === Infinity` quirk by
    poking `currentTime` past the end once. Error state renders a quiet message.
  - All DOM built via `createElement`/`textContent` — no `innerHTML`, no user text near
    markup. Only base.css tokens used, except a recording-red pair (`#8c2b1e`/`#a3402c`)
    matching base.css's own `.btn-danger` literals, since recording indicators should stay
    red in every paper theme.
  - `node --check js/voice.js` passes. No requests outside my files; `index.html` already
    links `./css/voice.css` and `main.js` already wires all three exports.
