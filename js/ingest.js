// ingest.js — photo ingestion (EXIF read + canvas downscale). OWNER: Builder 2.
//
// Pipeline (per file): read EXIF off the ORIGINAL bytes first (downscaling
// strips metadata), then decode and canvas-downscale to max 1600 px on the
// long edge, re-encoded as JPEG q0.8. Orientation (EXIF 0x0112) is preserved:
// modern browsers bake it in at decode time (image-orientation: from-image is
// the default); on older engines we apply the transform manually.
//
// Does NOT persist — the compose controller calls store.putBlob on save.
// Contract: ARCHITECTURE.md §3.

import { extractExif } from './exif.js';
import { uid } from './util.js';
import { bus } from './state.js';

const MAX_FILES = 24;      // per ingest call — keeps the compose sheet responsive
const MAX_EDGE = 1600;     // px, long edge
const JPEG_QUALITY = 0.8;

// Browsers where CSS `image-orientation: from-image` is supported apply EXIF
// orientation automatically when decoding (Chrome 81+, Safari 13.1+, Firefox 26+),
// so drawImage() already receives upright pixels. Only older engines need the
// manual transform below.
const BROWSER_AUTO_ORIENTS =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('image-orientation', 'from-image');

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('undecodable image')); };
    img.src = url;
  });
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * Downscale a decoded image to max 1600 px long edge, applying EXIF
 * orientation manually when the browser didn't already.
 * @returns {Promise<{blob: Blob, w: number, h: number}|null>}
 */
async function downscale(img, orientation) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return null;

  const applyManual = !BROWSER_AUTO_ORIENTS && orientation > 1 && orientation <= 8;
  const swapAxes = applyManual && orientation >= 5; // 5–8 are the rotated-90° cases

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale)); // drawn image size (pre-orientation)
  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = swapAxes ? dh : dw;
  canvas.height = swapAxes ? dw : dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // JPEG has no alpha — flatten transparent PNGs onto paper-white, not black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (applyManual) {
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, dw, 0); break;   // mirror X
      case 3: ctx.transform(-1, 0, 0, -1, dw, dh); break; // 180°
      case 4: ctx.transform(1, 0, 0, -1, 0, dh); break;   // mirror Y
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;     // mirror X + 90° CW
      case 6: ctx.transform(0, 1, -1, 0, dh, 0); break;   // 90° CW
      case 7: ctx.transform(0, -1, -1, 0, dh, dw); break; // mirror X + 90° CCW
      case 8: ctx.transform(0, -1, 1, 0, 0, dw); break;   // 90° CCW
    }
  }
  ctx.drawImage(img, 0, 0, dw, dh);

  const blob = await canvasToJpegBlob(canvas);
  if (!blob) return null;
  return { blob, w: canvas.width, h: canvas.height };
}

/**
 * Ingest a batch of user-picked/dropped files.
 * @param {FileList|File[]} fileListOrArray
 * @returns {Promise<Array<{
 *   blobRec: {id:string, blob:Blob, kind:'photo', w:number, h:number, mime:string},
 *   exif: {lat:number|null, lon:number|null, takenAt:string|null}
 * }>>}
 *   Filters to image/*; caps at 24 files per call (with a toast); skips
 *   unreadable files silently (HEIC on non-Safari, corrupt files, …).
 *   Never throws; [] when nothing usable. BlobRecs are NOT yet persisted.
 */
export async function ingestFiles(fileListOrArray) {
  let files = Array.from(fileListOrArray || [])
    .filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));

  if (files.length > MAX_FILES) {
    bus.emit('toast', {
      message: `That's a big batch! Keeping the first ${MAX_FILES} photos — add the rest in another go.`,
      kind: 'warning'
    });
    files = files.slice(0, MAX_FILES);
  }

  const out = [];
  for (const file of files) {
    try {
      // EXIF first, on the original bytes — the re-encode below strips it.
      const exif = await extractExif(file);
      const img = await loadImage(file); // rejects for undecodable formats → skipped
      const scaled = await downscale(img, exif.orientation || 1);
      if (!scaled) continue;
      out.push({
        blobRec: {
          id: uid(),
          blob: scaled.blob,
          kind: 'photo',
          w: scaled.w,
          h: scaled.h,
          mime: 'image/jpeg'
        },
        exif: { lat: exif.lat, lon: exif.lon, takenAt: exif.takenAt }
      });
    } catch (e) {
      // Unreadable file — skip silently per contract; the compose controller
      // shows guidance when nothing at all could be ingested.
    }
  }
  return out;
}
