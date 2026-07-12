// exif.js — EXIF GPS + capture-date extraction. OWNER: Builder 2 (capture pipeline).
//
// Dependency-free JPEG APP1/TIFF parser ported from legacy/wayfarer-v1.html
// (parseExifBuffer + readExif), hardened:
//   - both TIFF byte orders ('II' little-endian / 'MM' big-endian)
//   - GPS lat/lon from DMS rationals + N/S/E/W refs → signed decimal degrees
//   - DateTimeOriginal (0x9003, Exif sub-IFD) with IFD0 DateTime (0x0132) fallback
//   - Orientation (0x0112) surfaced for the ingest downscaler
//   - keeps scanning past non-Exif APP1 segments (XMP also lives in APP1)
//   - never throws: malformed/truncated JPEGs and non-JPEG files (PNG, HEIC, …)
//     resolve to nulls. Contract: ARCHITECTURE.md §3.

// EXIF only lives in metadata segments near the head of the file; APP segments
// max out at 64 KB each, so half a megabyte is a generous scan window and keeps
// us from pulling a 12 MB photo into memory just to read its tags.
const HEAD_BYTES = 512 * 1024;

/**
 * Parse an ArrayBuffer of JPEG bytes.
 * @param {ArrayBuffer} buffer
 * @returns {{lat:number|null, lon:number|null, takenAt:string|null, orientation:number}|null}
 *   `takenAt` is the raw EXIF string ('YYYY:MM:DD HH:MM:SS'); null if not a JPEG
 *   or no EXIF segment found. Never throws.
 */
export function parseExifBuffer(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null; // not a JPEG

    // Walk the JPEG markers looking for an APP1 segment that starts 'Exif\0\0'.
    let offset = 2;
    let exifStart = null;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      if ((marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFDA) break; // start of scan — no more metadata segments
      const segLen = view.getUint16(offset + 2);
      if (segLen < 2) break; // corrupt length, bail
      if (marker === 0xFFE1 && offset + 10 <= view.byteLength &&
          view.getUint32(offset + 4) === 0x45786966 && // 'Exif'
          view.getUint16(offset + 8) === 0x0000) {
        exifStart = offset + 10;
        break;
      }
      offset += 2 + segLen; // skip non-Exif APP1 (e.g. XMP) and other segments
    }
    if (exifStart == null) return null;

    const tiffStart = exifStart;
    const little = view.getUint16(tiffStart) === 0x4949; // 'II' LE, 'MM' BE
    const u16 = (o) => view.getUint16(o, little);
    const u32 = (o) => view.getUint32(o, little);
    const rational = (o) => { const d = u32(o + 4); return d === 0 ? 0 : u32(o) / d; };

    function readIFD(ifdOffset) {
      const entries = {};
      if (ifdOffset < tiffStart || ifdOffset + 2 > view.byteLength) return entries;
      const count = u16(ifdOffset);
      for (let i = 0; i < count; i++) {
        const entryOffset = ifdOffset + 2 + i * 12;
        if (entryOffset + 12 > view.byteLength) break;
        entries[u16(entryOffset)] = {
          type: u16(entryOffset + 2),
          numValues: u32(entryOffset + 4),
          valueOffset: entryOffset + 8 // address of the 4-byte value/offset field
        };
      }
      return entries;
    }
    function getASCII(entry) {
      const len = entry.numValues;
      const addr = len <= 4 ? entry.valueOffset : tiffStart + u32(entry.valueOffset);
      let s = '';
      for (let i = 0; i < len - 1 && addr + i < view.byteLength; i++) {
        s += String.fromCharCode(view.getUint8(addr + i));
      }
      return s;
    }
    function getRationalArray(entry) {
      const addr = tiffStart + u32(entry.valueOffset);
      const arr = [];
      for (let i = 0; i < entry.numValues && addr + i * 8 + 8 <= view.byteLength; i++) {
        arr.push(rational(addr + i * 8));
      }
      return arr;
    }
    function getRefChar(entry) {
      if (entry.numValues <= 4) return String.fromCharCode(view.getUint8(entry.valueOffset));
      return getASCII(entry);
    }

    const ifd0Offset = u32(tiffStart + 4);
    const ifd0 = readIFD(tiffStart + ifd0Offset);
    let lat = null, lon = null, takenAt = null, orientation = 1;

    if (ifd0[0x0112]) { // Orientation (SHORT, stored inline)
      const o = u16(ifd0[0x0112].valueOffset);
      if (o >= 1 && o <= 8) orientation = o;
    }

    if (ifd0[0x8825]) { // GPS IFD pointer
      const gps = readIFD(tiffStart + u32(ifd0[0x8825].valueOffset));
      // 1: GPSLatitudeRef, 2: GPSLatitude, 3: GPSLongitudeRef, 4: GPSLongitude
      if (gps[1] && gps[2] && gps[3] && gps[4]) {
        const latDms = getRationalArray(gps[2]);
        const lonDms = getRationalArray(gps[4]);
        let la = (latDms[0] || 0) + (latDms[1] || 0) / 60 + (latDms[2] || 0) / 3600;
        let lo = (lonDms[0] || 0) + (lonDms[1] || 0) / 60 + (lonDms[2] || 0) / 3600;
        if (getRefChar(gps[1]) === 'S') la = -la;
        if (getRefChar(gps[3]) === 'W') lo = -lo;
        // Reject garbage: (0,0) is the classic "no fix" placeholder, and
        // anything outside the valid ranges means corrupt rationals.
        if (Number.isFinite(la) && Number.isFinite(lo) &&
            Math.abs(la) <= 90 && Math.abs(lo) <= 180 &&
            !(la === 0 && lo === 0)) {
          lat = la;
          lon = lo;
        }
      }
    }

    if (ifd0[0x8769]) { // Exif sub-IFD pointer
      const exifIfd = readIFD(tiffStart + u32(ifd0[0x8769].valueOffset));
      if (exifIfd[0x9003]) takenAt = getASCII(exifIfd[0x9003]); // DateTimeOriginal
    }
    if (!takenAt && ifd0[0x0132]) takenAt = getASCII(ifd0[0x0132]); // DateTime fallback

    return { lat, lon, takenAt, orientation };
  } catch (e) {
    return null; // truncated / malformed — treat as "no EXIF"
  }
}

/** 'YYYY:MM:DD HH:MM:SS' (local time of capture) → ISO datetime string, or null.
    The result keeps the capture-local WALL TIME (no timezone suffix): EXIF has
    no timezone, and round-tripping through Date.toISOString() would shift the
    calendar day for anyone east/west of UTC (a 07:30 Tokyo photo would become
    "yesterday, 22:30Z" and prefill the wrong date). */
function exifDateToISO(raw) {
  const m = /(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(d.getTime()) || +m[1] < 1900) return null;
  // Reject rolled-over garbage like month 13 / day 40 (Date silently wraps).
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function readHead(file) {
  const head = typeof file.slice === 'function' ? file.slice(0, HEAD_BYTES) : file;
  if (typeof head.arrayBuffer === 'function') return head.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsArrayBuffer(head);
  });
}

/**
 * Extract GPS + capture date from a photo file.
 * @param {File|Blob} file
 * @returns {Promise<{lat:number|null, lon:number|null, takenAt:string|null, orientation:number}>}
 *   `takenAt` is an ISO datetime string. `orientation` (extra field, EXIF tag
 *   0x0112, default 1) is consumed by ingest.js for the downscale step.
 *   Never throws / never rejects — nulls for anything absent or unreadable
 *   (HEIC, PNG, malformed JPEG, …).
 */
export async function extractExif(file) {
  const empty = { lat: null, lon: null, takenAt: null, orientation: 1 };
  try {
    if (!file) return empty;
    const buffer = await readHead(file);
    const parsed = parseExifBuffer(buffer);
    if (!parsed) return empty;
    return {
      lat: parsed.lat,
      lon: parsed.lon,
      takenAt: exifDateToISO(parsed.takenAt),
      orientation: parsed.orientation || 1
    };
  } catch (e) {
    return empty;
  }
}
