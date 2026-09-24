'use strict';
// Document model: layers, compositing, selection and undo history.
(() => {
  const U = App.util;

  App.BLENDS = [
    ['source-over', '표준'], ['multiply', '곱하기'], ['screen', '스크린'], ['overlay', '오버레이'],
    ['darken', '어둡게'], ['lighten', '밝게'], ['color-dodge', '닷지(발광)'], ['color-burn', '번(굽기)'],
    ['lighter', '더하기'], ['hard-light', '하드 라이트'], ['soft-light', '소프트 라이트'],
    ['difference', '차이'], ['exclusion', '제외'], ['hue', '색조'], ['saturation', '채도'],
    ['color', '색상'], ['luminosity', '광도'],
  ];

  class Layer {
    constructor(w, h, name) {
      this.id = U.uid();
      this.name = name;
      this.canvas = U.canvas(w, h);
      this.ctx = this.canvas.getContext('2d');
      this.visible = true;
      this.opacity = 1;
      this.blend = 'source-over';
      this.alphaLock = false;
      // layer border effect (like CSP "경계 효과" / Photoshop "Stroke"): drawn behind everything on the layer
      this.border = { on: false, color: '#ffffff', width: 4, smooth: 1 };
      this.rev = 0; // bumps when pixels change (for thumbnails)
    }
  }

  // ---------- border effect helpers ----------
  const INF = 1e20;
  // exact squared Euclidean distance transform, 1-D pass (Felzenszwalb & Huttenlocher)
  function edt1d(f, n, stride, off, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      const fq = f[off + q * stride] + q * q;
      let p = v[k], s = (fq - (f[off + p * stride] + p * p)) / (2 * (q - p));
      while (s <= z[k]) { k--; p = v[k]; s = (fq - (f[off + p * stride] + p * p)) / (2 * (q - p)); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[off + v[k] * stride];
    }
    for (let q = 0; q < n; q++) f[off + q * stride] = d[q];
  }
  function edt2d(f, w, h) {
    const n = Math.max(w, h);
    const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) edt1d(f, h, w, x, d, v, z);
    for (let y = 0; y < h; y++) edt1d(f, w, 1, y * w, d, v, z);
  }
  // separable box blur of a float field (radius k)
  function boxBlur(a, w, h, k) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length), win = 2 * k + 1;
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let x = -k; x <= k; x++) s += a[row + U.clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        t[row + x] = s / win;
        s += a[row + Math.min(w - 1, x + k + 1)] - a[row + Math.max(0, x - k)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -k; y <= k; y++) s += t[U.clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        o[y * w + x] = s / win;
        s += t[Math.min(h - 1, y + k + 1) * w + x] - t[Math.max(0, y - k) * w + x];
      }
    }
    return o;
  }
  const borderKey = b => `${b.color}|${b.width}|${b.smooth}`;

  class Doc {
    constructor(w, h) {
      this.w = w; this.h = h;
      this.layers = [];
      this.active = null;
      this.selection = null;
      this.preview = null; // {layer, apply(ctx, rect)} – live stroke / floating transform
      this.composite = U.canvas(w, h);
      this.cctx = this.composite.getContext('2d');
      this._scratch = null;
    }
    createLayer(name) { return new Layer(this.w, this.h, name); }
    nextLayerName() {
      let n = this.layers.length;
      const names = new Set(this.layers.map(l => l.name));
      while (names.has('레이어 ' + n)) n++;
      return '레이어 ' + n;
    }
    get scratch() {
      if (!this._scratch) this._scratch = U.canvas(this.w, this.h);
      return this._scratch;
    }

    get scratch2() {
      if (!this._scratch2) this._scratch2 = U.canvas(this.w, this.h);
      return this._scratch2;
    }

    // Recompute a layer's border inside rect r (needs the layer's pixels up to `width` beyond r).
    updateBorder(L, r) {
      const B = L.border, W = this.w, H = this.h;
      if (!L.bcanvas) { L.bcanvas = U.canvas(W, H); L.bctx = L.bcanvas.getContext('2d'); }
      const wpx = Math.max(0.5, B.width);
      const k = Math.round(B.smooth * Math.min(6, 1 + wpx * 0.35)); // smoothing blur radius
      const pad = Math.ceil(wpx) + k + 2;
      const S = U.rClamp({ x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad }, W, H);
      if (!S) return;
      const sw = S.x1 - S.x0, sh = S.y1 - S.y0, n = sw * sh;
      const src = L.ctx.getImageData(S.x0, S.y0, sw, sh).data;
      let a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = src[i * 4 + 3] / 255;
      if (k > 0) a = boxBlur(a, sw, sh, k);
      const thr = k > 0 ? 0.12 : 0.06;
      const f = new Float64Array(n);
      for (let i = 0; i < n; i++) f[i] = a[i] > thr ? 0 : INF;
      edt2d(f, sw, sh);
      const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
      const out = new ImageData(rw, rh), o = out.data;
      const [cr, cg, cb] = App.ui.hex2rgb(B.color);
      for (let y = 0; y < rh; y++) {
        const sy = y + r.y0 - S.y0;
        for (let x = 0; x < rw; x++) {
          const d = Math.sqrt(f[sy * sw + x + r.x0 - S.x0]);
          let al = wpx + 0.5 - d;
          if (al <= 0) continue;
          if (al > 1) al = 1;
          const j = (y * rw + x) * 4;
          o[j] = cr; o[j + 1] = cg; o[j + 2] = cb; o[j + 3] = al * 255;
        }
      }
      L.bctx.putImageData(out, r.x0, r.y0);
    }
    // bring border caches up to date; returns the (possibly enlarged) rect that must be recomposited
    syncBorders(r) {
      for (const L of this.layers) {
        if (!L.border || !L.border.on) { L.bKey = null; continue; }
        const key = borderKey(L.border);
        if (L.bRev === L.rev && L.bKey === key) continue;
        const full = L.bKey !== key || !L.bcanvas;
        const g = Math.ceil(L.border.width) + 8;
        const er = full ? U.rFull(this.w, this.h) : U.rClamp({ x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g }, this.w, this.h);
        this.updateBorder(L, er);
        L.bRev = L.rev; L.bKey = key;
        r = U.rUnion(r, er);
      }
      return r;
    }
    // what a layer contributes: its pixels (+ live preview) with its border behind
    layerSource(L, r) {
      let src = L.canvas;
      if (this.preview && this.preview.layer === L) src = this.applyPreview(L, r);
      if (!(L.border && L.border.on && L.bcanvas)) return src;
      const s = this.scratch2, c = s.getContext('2d');
      const x = r.x0, y = r.y0, w = r.x1 - r.x0, h = r.y1 - r.y0;
      c.clearRect(x, y, w, h);
      c.drawImage(L.bcanvas, x, y, w, h, x, y, w, h);
      c.drawImage(src, x, y, w, h, x, y, w, h);
      return s;
    }
    renderComposite(rect) {
      let r = rect ? U.rClamp(rect, this.w, this.h, 1) : U.rFull(this.w, this.h);
      if (!r) return;
      r = this.syncBorders(r);
      const x = r.x0, y = r.y0, w = r.x1 - r.x0, h = r.y1 - r.y0;
      const c = this.cctx;
      c.save();
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.clearRect(x, y, w, h);
      for (const L of this.layers) {
        if (!L.visible) continue;
        const src = this.layerSource(L, r);
        c.globalAlpha = L.opacity;
        c.globalCompositeOperation = L.blend;
        c.drawImage(src, x, y, w, h, x, y, w, h);
      }
      c.restore();
    }
    applyPreview(L, r) {
      const s = this.scratch, sc = s.getContext('2d');
      const x = r.x0, y = r.y0, w = r.x1 - r.x0, h = r.y1 - r.y0;
      sc.save();
      sc.beginPath(); sc.rect(x, y, w, h); sc.clip();
      sc.clearRect(x, y, w, h);
      sc.drawImage(L.canvas, x, y, w, h, x, y, w, h);
      this.preview.apply(sc, r);
      sc.restore();
      return s;
    }
    flatten() {
      const pv = this.preview;
      this.preview = null;
      this.renderComposite(null);
      const out = U.cloneCanvas(this.composite);
      this.preview = pv;
      if (pv) this.renderComposite(null);
      return out;
    }
    // bounding box of non-transparent pixels in a layer
    contentBounds(L) {
      const d = L.ctx.getImageData(0, 0, this.w, this.h).data;
      let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
      for (let y = 0; y < this.h; y++) {
        const row = y * this.w * 4;
        for (let x = 0; x < this.w; x++) {
          if (d[row + x * 4 + 3]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    }
  }

  // ---------------- selection (alpha mask) ----------------
  class Selection {
    constructor(w, h) {
      this.w = w; this.h = h;
      this.mask = U.canvas(w, h);
      this.ctx = this.mask.getContext('2d', { willReadFrequently: true });
      this.paths = [];
      this.bounds = null;
      this._overlay = null;
    }
    apply(pts, mode) {
      const c = this.ctx;
      c.save();
      if (mode === 'new') { c.clearRect(0, 0, this.w, this.h); this.paths = []; this.bounds = null; }
      c.globalCompositeOperation = mode === 'sub' ? 'destination-out' : 'source-over';
      c.fillStyle = '#000';
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      c.fill();
      c.restore();
      this.paths.push(pts);
      if (mode === 'sub') this.computeBounds();
      else {
        let b = null;
        for (const [x, y] of pts) b = U.rUnion(b, { x0: x, y0: y, x1: x, y1: y });
        this.bounds = U.rClamp(U.rUnion(this.bounds, b), this.w, this.h, 1);
      }
      this._overlay = null;
    }
    selectAll() {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.w, this.h);
      this.paths = [[[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]]];
      this.bounds = U.rFull(this.w, this.h);
      this._overlay = null;
    }
    invert() {
      const old = U.cloneCanvas(this.mask);
      const c = this.ctx;
      c.save();
      c.globalCompositeOperation = 'copy';
      c.fillStyle = '#000';
      c.fillRect(0, 0, this.w, this.h);
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(old, 0, 0);
      c.restore();
      this.computeBounds();
      this._overlay = null;
    }
    computeBounds() {
      const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
      let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        if (d[(y * this.w + x) * 4 + 3] > 2) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      this.bounds = x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    }
    get empty() { return !this.bounds; }
    // dim outside the selection – shown on top of the canvas
    overlay() {
      if (!this._overlay) {
        const o = U.canvas(this.w, this.h), c = o.getContext('2d');
        c.fillStyle = 'rgba(30, 40, 70, 0.28)';
        c.fillRect(0, 0, this.w, this.h);
        c.globalCompositeOperation = 'destination-out';
        c.drawImage(this.mask, 0, 0);
        this._overlay = o;
      }
      return this._overlay;
    }
    clone() {
      const s = new Selection(this.w, this.h);
      s.ctx.drawImage(this.mask, 0, 0);
      s.paths = this.paths.slice();
      s.bounds = this.bounds && { ...this.bounds };
      return s;
    }
  }

  // ---------------- history ----------------
  class History {
    constructor(onChange) {
      this.onChange = onChange;
      this.undos = []; this.redos = [];
      this.bytes = 0;
      this.limit = U.isTouchDevice() ? 250e6 : 700e6;
    }
    clear() { this.undos = []; this.redos = []; this.bytes = 0; this.onChange?.(); }
    push(e) {
      e.bytes = e.bytes || 0;
      for (const r of this.redos) this.bytes -= r.bytes;
      this.redos = [];
      this.undos.push(e);
      this.bytes += e.bytes;
      while ((this.bytes > this.limit || this.undos.length > 80) && this.undos.length > 1) this.bytes -= this.undos.shift().bytes;
      this.onChange?.(e);
    }
    undo() { const e = this.undos.pop(); if (!e) return false; e.undo(); this.redos.push(e); this.onChange?.(e); return true; }
    redo() { const e = this.redos.pop(); if (!e) return false; e.redo(); this.undos.push(e); this.onChange?.(e); return true; }
  }

  // pixel change on one layer; `before` is ImageData of rect r taken before the change
  History.pixels = (doc, L, r, before, afterCb) => {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const after = L.ctx.getImageData(r.x0, r.y0, w, h);
    const put = d => { L.ctx.putImageData(d, r.x0, r.y0); L.rev++; afterCb?.(r); };
    return { bytes: before.data.length * 2, undo: () => put(before), redo: () => put(after) };
  };
  History.snap = doc => ({
    active: doc.active,
    layers: doc.layers.map(L => ({ L, name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, alphaLock: L.alphaLock, border: { ...L.border } })),
  });
  History.restore = (doc, s) => {
    doc.layers = s.layers.map(o => { const { L, ...p } = o; Object.assign(L, p, { border: { ...p.border } }); return L; });
    doc.active = s.active;
  };
  History.struct = (doc, before, after, cb) => ({
    bytes: 0,
    undo: () => { History.restore(doc, before); cb?.(); },
    redo: () => { History.restore(doc, after); cb?.(); },
  });
  History.group = items => ({
    bytes: items.reduce((s, e) => s + (e.bytes || 0), 0),
    undo: () => { for (let i = items.length - 1; i >= 0; i--) items[i].undo(); },
    redo: () => { for (const e of items) e.redo(); },
  });

  App.Layer = Layer;
  App.Doc = Doc;
  App.Selection = Selection;
  App.History = History;
})();
