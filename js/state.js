// state.js — shared app state + event bus. Architect-owned.
// See ARCHITECTURE.md §2 and §3 for the contracts.

export const app = {
  entries: [],                        // snapshot cache, maintained by main.js (read-only elsewhere)
  session: null,                      // Supabase session or null (set by auth.js)
  view: 'book',                       // 'book' | 'journal'
  settings: { theme: 'passport' }     // 'passport' | 'minimal' | 'scrapbook'
};

const target = new EventTarget();
const handlerMap = new WeakMap();     // fn -> Map<evt, wrapped>, so off() works per event

export const bus = {
  on(evt, fn) {
    const wrapped = (e) => fn(e.detail);
    let byEvt = handlerMap.get(fn);
    if (!byEvt) { byEvt = new Map(); handlerMap.set(fn, byEvt); }
    byEvt.set(evt, wrapped);
    target.addEventListener(evt, wrapped);
    return fn;
  },
  off(evt, fn) {
    const byEvt = handlerMap.get(fn);
    const wrapped = byEvt && byEvt.get(evt);
    if (wrapped) {
      target.removeEventListener(evt, wrapped);
      byEvt.delete(evt);
    }
  },
  emit(evt, detail = {}) {
    target.dispatchEvent(new CustomEvent(evt, { detail }));
  }
};
