# journal — cross-file needs

## 2026-07-12 — collage chapters (photo-only entries)

### 1. js/collage.js (engine builder) — exact call shape journal.js codes against

```js
import { renderCollage, resolveTemplate, TEMPLATES } from './collage.js';

// TEMPLATES — ordered set of template keys → labels. journal.js normalizes
// defensively (object map of key→{label} / key→string, or an array of keys /
// {key,label} objects all work), and cycles the style chip in this order.
// Expected keys: auto | scatter | mosaic | grid | filmstrip | wall.

// resolveTemplate(templateKey, photos, seed) -> concrete template key.
// journal.js only uses it to caption the chip when the entry is on 'auto'
// (shows "Auto · <Resolved>"); the call is try/caught, so a different
// signature degrades to a plain "Auto" label rather than breaking.

// renderCollage(mountEl, photos, { template, seed, onPhotoClick })
//   mountEl: empty <div class="jr-co-mount"> already in the document flow,
//            full available width of the chapter body.
//   photos:  [{ id, url, w, h, orient: 'portrait'|'landscape'|'square', alt }]
//            — url from util.blobUrl, w/h from the BlobRec, orient computed
//            with the shared thresholds (aspect < 0.85 / > 1.18).
//   template: entry.collage?.template || 'auto' (concrete or 'auto').
//   seed:    entry.id (stable per entry — re-renders must look identical).
//   onPhotoClick(index): journal opens its lightbox at that photo index.
//   Return: may render into mountEl and return nothing, OR return an element
//           (sync or Promise) — journal appends a returned node it doesn't
//           already contain. Any throw/rejection/empty render falls back to a
//           plain even grid (.jr-co-fallback) so the chapter never breaks.
```

NOTE: journal.js imports `./collage.js` statically (per spec) and main.js
imports journal.js statically, so the app will not boot until collage.js
exists on disk. If the engine lands later than this module, even a stub
exporting the three names keeps the app alive.

### 2. js/util.js — entryDisplayTitle(entry) -> string

journal.js prefers `util.entryDisplayTitle(entry)` for chapter headings (both
editorial and collage chapters) via a namespace import, and falls back to the
historical rule (`title || first location segment || 'Untitled memory'`) when
the helper is absent or returns a falsy value — so shipping order doesn't
matter for this one.
