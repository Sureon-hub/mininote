'use strict';
window.App = window.App || {};

(() => {
  const U = App.util = {};

  U.$ = (s, r = document) => r.querySelector(s);
  U.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.uid = () => Math.random().toString(36).slice(2, 10);
  U.sleep = ms => new Promise(r => setTimeout(r, ms));
  U.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  U.isTouchDevice = () => matchMedia('(pointer: coarse)').matches;

  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'title', 'type', 'min', 'max', 'step']);
  U.h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };

  // ---------- canvas / rect ----------
  U.canvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };
  U.cloneCanvas = src => { const c = U.canvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; };
  U.rUnion = (a, b) => !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
  U.rClamp = (r, w, h, pad = 0) => {
    if (!r) return null;
    const x0 = Math.max(0, Math.floor(r.x0 - pad)), y0 = Math.max(0, Math.floor(r.y0 - pad));
    const x1 = Math.min(w, Math.ceil(r.x1 + pad)), y1 = Math.min(h, Math.ceil(r.y1 + pad));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  };
  U.rFull = (w, h) => ({ x0: 0, y0: 0, x1: w, y1: h });
  U.canvasToBlob = (c, type = 'image/png', q) => new Promise((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('이미지 인코딩 실패'))), type, q));

  // ---------- files ----------
  U.ext = n => { const m = /\.([^.]+)$/.exec(n); return m ? m[1].toLowerCase() : ''; };
  U.isImage = n => /\.(png|jpe?g|webp)$/i.test(n);
  U.mime = n => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[U.ext(n)] || 'image/png';
  U.baseName = n => n.replace(/\.[^.]+$/, '');
  U.pad = n => String(n).padStart(2, '0');
  U.stamp = (d = new Date()) => `${d.getFullYear()}${U.pad(d.getMonth() + 1)}${U.pad(d.getDate())}_${U.pad(d.getHours())}${U.pad(d.getMinutes())}${U.pad(d.getSeconds())}`;
  U.fmtDate = ms => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}.${U.pad(d.getMonth() + 1)}.${U.pad(d.getDate())} ${U.pad(d.getHours())}:${U.pad(d.getMinutes())}`; };
  U.hash = async blob => {
    const b = new Uint8Array(await blob.arrayBuffer());
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + ':' + b.length;
  };
  U.download = (blob, name) => {
    const a = U.h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // ---------- IndexedDB ----------
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('mininote', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('thumbs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const q = fn(d.transaction(store, mode).objectStore(store));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  };
  U.idbGet = (s, k) => tx(s, 'readonly', o => o.get(k)).catch(() => undefined);
  U.idbSet = (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)).catch(() => undefined);
  U.idbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k)).catch(() => undefined);
  U.idbClear = s => tx(s, 'readwrite', o => o.clear()).catch(() => undefined);

  // ---------- toast / dialog / menu ----------
  U.toast = (msg, ms = 2200) => {
    let box = document.getElementById('toasts');
    if (!box) { box = U.h('div', { id: 'toasts' }); document.body.append(box); }
    const t = U.h('div', { class: 'toast' }, msg);
    box.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  };

  U.dialog = ({ title, body, buttons = [{ label: '확인', value: true, primary: true }], input }) => new Promise(res => {
    const back = U.h('div', { class: 'modal-back' });
    const inp = input ? U.h('input', { class: 'field', type: 'text', value: input.value || '', placeholder: input.placeholder || '' }) : null;
    const valueOf = b => (inp && b.value === true ? inp.value : b.value);
    const done = v => { back.remove(); document.removeEventListener('keydown', onKey, true); res(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
      else if (e.key === 'Enter') {
        const p = buttons.find(b => b.primary);
        if (p) { e.stopPropagation(); e.preventDefault(); done(valueOf(p)); }
      }
    };
    const box = U.h('div', { class: 'modal' },
      title && U.h('h3', null, title),
      body && (typeof body === 'string' ? U.h('p', null, body) : body),
      inp,
      U.h('div', { class: 'modal-btns' }, buttons.map(b =>
        U.h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onclick: () => done(valueOf(b)) }, b.label))));
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('pointerdown', e => { if (e.target === back) done(null); });
    back.append(box);
    document.body.append(back);
    if (inp) { inp.focus(); inp.select(); } else box.querySelector('.primary')?.focus();
  });

  U.menu = (items, x, y) => new Promise(res => {
    const back = U.h('div', { class: 'menu-back' });
    const m = U.h('div', { class: 'menu' }, items.filter(Boolean).map(it => it === '-' ? U.h('hr') :
      U.h('button', { class: 'menu-item' + (it.checked ? ' checked' : '') + (it.danger ? ' danger' : ''), onclick: () => done(it.value) },
        U.h('span', { class: 'mi-check' }, it.checked ? '✓' : ''), it.label)));
    const done = v => { back.remove(); res(v); };
    back.addEventListener('pointerdown', e => { if (e.target === back) done(null); });
    back.append(m);
    document.body.append(back);
    const r = m.getBoundingClientRect();
    m.style.left = U.clamp(x, 8, innerWidth - r.width - 8) + 'px';
    m.style.top = U.clamp(y, 8, innerHeight - r.height - 8) + 'px';
  });

  U.menuAt = (btn, items) => { const r = btn.getBoundingClientRect(); return U.menu(items, r.right - 200, r.bottom + 4); };

  // ---------- icons ----------
  const I = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    up: '<path d="M18 15l-6-6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
    brush: '<path d="M17 3l4 4L8 20l-5 1 1-5z"/><path d="M14 6l4 4"/>',
    eraser: '<path d="M7 21h13"/><path d="M4.6 15.6l9.9-9.9a2 2 0 0 1 2.8 0l2.8 2.8a2 2 0 0 1 0 2.8L12 19.4a2 2 0 0 1-1.4.6H8.4a2 2 0 0 1-1.4-.6l-2.4-2.4a1 1 0 0 1 0-1.4z"/><path d="M9 11l5 5"/>',
    fill: '<path d="M19 11l-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0z"/><path d="M5 2l5 5M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 2-4 2-4s2 2.4 2 4z"/>',
    select: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M11 4h2M11 20h2M4 11v2M20 11v2"/>',
    lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>',
    transform: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
    picker: '<path d="M2 22l1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
    layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.8 3.6M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    merge: '<path d="M12 4v10M7 9l5 5 5-5M5 20h14"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>',
    folderPlus: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/><path d="M12 10v6M9 13h6"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    sort: '<path d="M3 6h18M6 12h12M10 18h4"/>',
    more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    flipH: '<path d="M12 3v18M8 7l-5 5 5 5V7zM16 7l5 5-5 5V7z"/>',
    flipV: '<path d="M3 12h18M7 8l5-5 5 5H7zM7 16l5 5 5-5H7z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    invert: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  };
  App.icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[name] || ''}</svg>`;
  U.iconBtn = (icon, title, onclick, cls = '') => U.h('button', { class: 'ib ' + cls, title, 'aria-label': title, html: App.icon(icon), onclick });

  // ---------- settings ----------
  const DEFAULTS = {
    source: null,              // 'local' | 'opfs' | 'drive'
    driveClientId: '',
    driveFolder: null,         // {id, name}
    gridCols: 0,               // 0 = auto
    gridAspect: '3/4',         // '1' | '3/4' | 'fit'
    sort: 'mtime-desc',
    autosave: true,
    fingerDraw: true,
    palmRejection: true,
    jpegQuality: 0.92,
    newNote: { w: 1080, h: 1440, bg: '#ffffff' },
    color: '#3a3a3a',
    recentColors: [],
    currentBrush: 'pencil',
    settingsVersion: 4,
    pressure: { gamma: 1.0, size: true, minSize: 0.15, opacity: false, minOpacity: 0.25 },
    brushes: {
      pencil: { name: '연필', size: 16, opacity: 1, flow: 1, hardness: 0.45, grain: 0.6, spacing: 0.025, smoothing: 0.12, pFlow: true, pFlowMin: 0.6, outline: { on: false, color: '#ffffff', width: 4, smooth: 1 } },
      pen: { name: '펜', size: 5, opacity: 1, flow: 1, hardness: 0.97, grain: 0, spacing: 0.05, smoothing: 0.15, outline: { on: false, color: '#ffffff', width: 3, smooth: 1 } },
      marker: { name: '마커', size: 28, opacity: 0.55, flow: 1, hardness: 0.92, grain: 0, spacing: 0.05, smoothing: 0.12, outline: { on: false, color: '#ffffff', width: 4, smooth: 1 } },
      air: { name: '에어브러시', size: 90, opacity: 0.6, flow: 0.12, hardness: 0, grain: 0, spacing: 0.08, smoothing: 0.2, outline: { on: false, color: '#ffffff', width: 6, smooth: 1 } },
      eraser: { name: '지우개', size: 30, opacity: 1, flow: 1, hardness: 0.9, grain: 0, spacing: 0.05, smoothing: 0.2 },
    },
    fill: { tolerance: 24, sample: 'layer', expand: 1 },
    selMode: 'new',
    transformKeepRatio: true,
    dockOpen: true,
    dockTab: 'layers',
  };
  const merge = (d, s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return s === undefined ? d : s;
    const out = Array.isArray(d) ? [] : { ...d };
    for (const k of Object.keys(s)) out[k] = d && typeof d[k] === 'object' && d[k] && !Array.isArray(d[k]) ? merge(d[k], s[k]) : s[k];
    return out;
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('mininote.settings') || '{}'); } catch { saved = {}; }
  App.DEFAULTS = DEFAULTS;
  App.settings = merge(JSON.parse(JSON.stringify(DEFAULTS)), saved);
  // v2: clearly visible pressure taper; v3: denser cream pencil (+ outline options)
  const sv = saved.settingsVersion || 1;
  if (sv < 2) App.settings.pressure = JSON.parse(JSON.stringify(DEFAULTS.pressure));
  if (sv < 3) App.settings.brushes.pencil = JSON.parse(JSON.stringify(DEFAULTS.brushes.pencil));
  // v4: lighter default smoothing (less lag behind the pen) – only where the old default was never changed
  if (sv < 4) {
    const old = { pencil: 0.3, pen: 0.45, marker: 0.3 };
    for (const k of Object.keys(old)) {
      const b = App.settings.brushes[k];
      if (b && Math.abs(b.smoothing - old[k]) < 1e-6) b.smoothing = DEFAULTS.brushes[k].smoothing;
    }
  }
  App.settings.settingsVersion = DEFAULTS.settingsVersion;
  App.saveSettings = U.debounce(() => {
    try { localStorage.setItem('mininote.settings', JSON.stringify(App.settings)); } catch { /* storage unavailable */ }
  }, 250);
})();
