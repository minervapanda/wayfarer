// exporter.js — JSON export/import + self-contained shareable HTML flipbook.
// OWNER: Builder 5. Contract: ARCHITECTURE.md §3.
//
//   #btn-export-json → download store.allForExport() with blobs as dataURLs
//   #btn-import-json → #import-json-input → store.importData →
//                      emit 'entries-changed' { reason: 'import' }
//   #btn-export-html → standalone read-only flipbook, photos baked in as
//                      base64 — no module dependencies, works from a file://
//                      double-click, forever.
//
// XSS: the flipbook embeds diary data as JSON in a <script type="application/json">
// tag ('<' escaped to <) and its inline renderer builds DOM exclusively
// with textContent — user strings never touch innerHTML in the exported page.

import { bus } from './state.js';
import { toast, confirmDialog, fmtDate, esc } from './util.js';
import { allForExport, importData } from './store.js';
import { narrativeFor } from './narratives.js';

export function initExporter() {
  wire('btn-export-json', exportJson);
  wire('btn-import-json', () => document.getElementById('import-json-input')?.click());
  wire('btn-export-html', exportHtml);

  const input = document.getElementById('import-json-input');
  if (input) input.addEventListener('change', onImportFile);
}

function wire(id, fn) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); }
    finally { btn.disabled = false; }
  });
}

/* ---------------- shared helpers ---------------- */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Could not read blob'));
    r.readAsDataURL(blob);
  });
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- JSON export ---------------- */

async function exportJson() {
  try {
    const data = await allForExport();
    if (!data.entries.length) {
      toast('Nothing to save yet — write an entry first.', 'info');
      return;
    }
    const blobs = [];
    for (const rec of data.blobs) {
      try {
        blobs.push({
          id: rec.id, kind: rec.kind, w: rec.w, h: rec.h, mime: rec.mime,
          dataUrl: await blobToDataUrl(rec.blob)
        });
      } catch (err) {
        console.warn('Wayfarer export: skipping unreadable blob', rec.id, err);
      }
    }
    const json = JSON.stringify({
      version: data.version, exportedAt: data.exportedAt,
      entries: data.entries, blobs
    });
    downloadText(json, `wayfarer-diary-${today()}.json`, 'application/json');
    toast(`Diary saved — ${data.entries.length} entr${data.entries.length === 1 ? 'y' : 'ies'}, ${fmtBytes(json.length)}.`, 'success');
  } catch (err) {
    console.error('Wayfarer export failed', err);
    toast('Couldn’t save the diary. Please try again.', 'error');
  }
}

/* ---------------- JSON import ---------------- */

async function onImportFile(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = ''; // allow re-picking the same file later
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (err) {
    toast('That file isn’t readable JSON — is it a Wayfarer diary export?', 'error');
    return;
  }
  if (!payload || !Array.isArray(payload.entries)) {
    toast('That file doesn’t look like a Wayfarer diary export.', 'error');
    return;
  }

  const n = payload.entries.length;
  const ok = await confirmDialog(
    `Load ${n} entr${n === 1 ? 'y' : 'ies'} from “${file.name}”? They’ll be merged into this diary — anything already here stays, and entries with matching ids are replaced by the file’s version.`
  );
  if (!ok) return;

  try {
    const res = await importData(payload);
    bus.emit('entries-changed', { reason: 'import' });
    toast(`Imported ${res.entries} entr${res.entries === 1 ? 'y' : 'ies'} and ${res.blobs} photo${res.blobs === 1 ? '' : 's'}.`, 'success');
  } catch (err) {
    console.error('Wayfarer import failed', err);
    toast('Couldn’t import that diary file.', 'error');
  }
}

/* ---------------- shareable HTML flipbook ---------------- */

async function exportHtml() {
  try {
    const data = await allForExport();
    if (!data.entries.length) {
      toast('Nothing to share yet — write an entry first.', 'info');
      return;
    }
    toast('Binding your shareable page — photos are being baked in…', 'info');

    const urlById = new Map();
    for (const rec of data.blobs) {
      try { urlById.set(rec.id, { dataUrl: await blobToDataUrl(rec.blob), kind: rec.kind, mime: rec.mime }); }
      catch (err) { console.warn('Wayfarer export: skipping unreadable blob', rec.id, err); }
    }

    const entries = data.entries.map((e) => {
      const loc = e.location || {};
      const found = narrativeFor(loc.name || '');
      const photos = (e.photoIds || [])
        .map((id) => urlById.get(id))
        .filter((b) => b && b.kind === 'photo')
        .map((b) => b.dataUrl);
      const voiceRec = e.voiceId ? urlById.get(e.voiceId) : null;
      return {
        title: e.title || '',
        date: fmtDate(e.dateISO) || '',
        place: loc.name || '',
        story: e.story || '',
        narrative: found.sourced ? found.text : '',
        photos,
        voice: voiceRec && voiceRec.kind === 'audio' ? voiceRec.dataUrl : null
      };
    });

    const dates = data.entries.map((e) => e.dateISO).filter(Boolean).sort();
    const range = dates.length
      ? (dates[0] === dates[dates.length - 1]
          ? fmtDate(dates[0])
          : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`)
      : '';

    const html = flipbookHtml({ range, exportedOn: fmtDate(today()), entries });
    downloadText(html, `my-travel-diary-${today()}.html`, 'text/html');
    toast('Shareable page saved — send the file to anyone; it opens on its own.', 'success');
  } catch (err) {
    console.error('Wayfarer HTML export failed', err);
    toast('Couldn’t build the shareable page.', 'error');
  }
}

/**
 * A compact, fully self-contained read-only flipbook. Cream book styling,
 * prev/next page flip, keyboard arrows. No modules, no network, no innerHTML
 * for user strings (its renderer uses textContent only).
 */
function flipbookHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>My travel diary — Wayfarer</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh; padding: 4vh 16px 8vh;
    font-family: "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, "Times New Roman", serif;
    color: #3b2f21;
    background: radial-gradient(ellipse at 50% -10%, #ece2cf 40%, #ddcdb0 100%);
    background-attachment: fixed;
  }
  .book {
    max-width: 820px; margin: 0 auto;
    background: #faf4e6; color: #3b2f21;
    border: 1px solid #e8dcc0; border-radius: 14px;
    box-shadow: 0 14px 40px rgba(59,47,33,.28), 0 2px 8px rgba(59,47,33,.14);
    overflow: hidden;
  }
  .bk-top {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 14px 26px; border-bottom: 1px solid #e8dcc0;
    font-size: 13px; color: #71614a;
  }
  .bk-brand { font-style: italic; letter-spacing: .4px; }
  .page { min-height: 62vh; padding: 40px 46px 34px; }
  @media (max-width: 640px) { .page { padding: 26px 20px; } }
  .page.turn { animation: turn .42s cubic-bezier(.33,.1,.25,1); }
  @keyframes turn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .page.turn { animation: none; } }
  .cover { text-align: center; padding-top: 12vh; }
  .cover .fleuron { font-size: 34px; color: #a3402c; }
  .cover h1 { font-size: 40px; margin: 12px 0 6px; font-weight: 500; letter-spacing: .5px; }
  .cover .range { color: #71614a; font-style: italic; }
  .cover .hint { margin-top: 9vh; font-size: 13px; color: #71614a; }
  .eyebrow {
    font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
    color: #a3402c; margin: 0 0 6px;
  }
  h2.place { font-size: 30px; margin: 0 0 2px; font-weight: 500; line-height: 1.15; }
  .sub { color: #71614a; font-size: 14px; font-style: italic; margin: 0 0 18px; }
  .hero {
    width: 100%; max-height: 340px; object-fit: cover; border-radius: 8px;
    display: block; margin: 0 0 22px; box-shadow: 0 6px 18px rgba(59,47,33,.2);
  }
  .story { line-height: 1.8; font-size: 16.5px; white-space: pre-wrap; }
  .story::first-letter {
    font-size: 2.6em; float: left; line-height: .8; padding: 4px 8px 0 0; color: #a3402c;
  }
  .history { margin-top: 22px; padding-top: 18px; border-top: 1px solid #d8c6a0;
    line-height: 1.75; font-size: 14.5px; color: #57482f; }
  .history-note { font-size: 11.5px; font-style: italic; color: #71614a; margin-top: 10px; }
  .strip { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
  .strip img {
    width: 104px; height: 104px; object-fit: cover; border-radius: 5px;
    box-shadow: 0 2px 6px rgba(59,47,33,.22); display: block;
  }
  audio { width: 100%; margin-top: 18px; }
  .bk-nav {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 22px; border-top: 1px solid #e8dcc0;
  }
  .bk-nav button {
    font: inherit; font-size: 14px; color: #3b2f21; background: #faf4e6;
    border: 1px solid #d8c6a0; border-radius: 999px; padding: 10px 20px;
    min-height: 44px; min-width: 44px; cursor: pointer;
  }
  .bk-nav button:hover { border-color: #a3402c; color: #a3402c; }
  .bk-nav button:focus-visible { outline: 3px solid #a3402c; outline-offset: 2px; }
  .bk-nav button[disabled] { opacity: .4; cursor: default; }
  .bk-count { font-variant-numeric: tabular-nums; }
  footer.colophon { text-align: center; font-size: 12px; color: #6b5a44; margin-top: 22px; }
</style>
</head>
<body>
<div class="book">
  <div class="bk-top"><span class="bk-brand">✈ Wayfarer — a travel diary</span><span class="bk-count" id="count"></span></div>
  <main class="page" id="page" aria-live="polite"></main>
  <div class="bk-nav">
    <button type="button" id="prev">‹ Previous</button>
    <button type="button" id="next">Next ›</button>
  </div>
</div>
<footer class="colophon">This page is self-contained — every photo is baked into the file. Nothing loads from the internet.<br>Exported on ${esc(data.exportedOn)} · Historical notes drafted from general reference facts.</footer>
<script id="diary-data" type="application/json">${json}</script>
<script>
(function () {
  'use strict';
  var data;
  try { data = JSON.parse(document.getElementById('diary-data').textContent); }
  catch (e) { data = { entries: [] }; }
  var pages = [{ type: 'cover' }];
  (data.entries || []).forEach(function (entry) { pages.push({ type: 'entry', e: entry }); });
  var i = 0;
  var pageEl = document.getElementById('page');
  var prevBtn = document.getElementById('prev');
  var nextBtn = document.getElementById('next');
  var countEl = document.getElementById('count');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; /* textContent only — XSS-safe */
    return n;
  }

  function render() {
    pageEl.textContent = '';
    pageEl.classList.remove('turn');
    void pageEl.offsetWidth; /* restart the turn animation */
    pageEl.classList.add('turn');
    var p = pages[i];
    if (p.type === 'cover') {
      var cover = el('div', 'cover');
      cover.appendChild(el('div', 'fleuron', '\\u2766'));
      cover.appendChild(el('h1', null, 'My Travels'));
      if (data.range) cover.appendChild(el('p', 'range', data.range));
      var n = (data.entries || []).length;
      cover.appendChild(el('p', 'range', n + (n === 1 ? ' chapter' : ' chapters')));
      cover.appendChild(el('p', 'hint', 'Turn the page \\u2192'));
      pageEl.appendChild(cover);
    } else {
      var e = p.e;
      pageEl.appendChild(el('p', 'eyebrow', 'Chapter ' + i + (e.date ? ' \\u00b7 ' + e.date : '')));
      pageEl.appendChild(el('h2', 'place', e.title || e.place || 'Untitled memory'));
      if (e.title && e.place) pageEl.appendChild(el('p', 'sub', e.place));
      else pageEl.appendChild(el('p', 'sub', ''));
      if (e.photos && e.photos[0]) {
        var hero = el('img', 'hero');
        hero.alt = '';
        hero.src = e.photos[0];
        pageEl.appendChild(hero);
      }
      if (e.story) pageEl.appendChild(el('p', 'story', e.story));
      if (e.narrative) {
        var h = el('div', 'history');
        h.appendChild(el('p', null, e.narrative));
        h.appendChild(el('p', 'history-note', 'History drafted from general reference facts.'));
        pageEl.appendChild(h);
      }
      if (e.voice) {
        var au = document.createElement('audio');
        au.controls = true;
        au.src = e.voice;
        pageEl.appendChild(au);
      }
      if (e.photos && e.photos.length > 1) {
        var strip = el('div', 'strip');
        e.photos.slice(1).forEach(function (src) {
          var im = el('img');
          im.alt = '';
          im.loading = 'lazy';
          im.src = src;
          strip.appendChild(im);
        });
        pageEl.appendChild(strip);
      }
    }
    countEl.textContent = (i + 1) + ' / ' + pages.length;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === pages.length - 1;
    window.scrollTo({ top: 0 });
  }

  prevBtn.addEventListener('click', function () { if (i > 0) { i--; render(); } });
  nextBtn.addEventListener('click', function () { if (i < pages.length - 1) { i++; render(); } });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowLeft' && i > 0) { i--; render(); }
    else if (ev.key === 'ArrowRight' && i < pages.length - 1) { i++; render(); }
  });
  render();
})();
<\/script>
</body>
</html>`;
}
