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
      this.rev = 0; // bumps when pixels change (for thumbnails)
    }
  }

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

    renderComposite(rect) {
      const r = rect ? U.rClamp(rect, this.w, this.h, 1) : U.rFull(this.w, this.h);
      if (!r) return;
      const x = r.x0, y = r.y0, w = r.x1 - r.x0, h = r.y1 - r.y0;
      const c = this.cctx;
      c.save();
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.clearRect(x, y, w, h);
      for (const L of this.layers) {
        if (!L.visible) continue;
        let src = L.canvas;
        if (this.preview && this.preview.layer === L) src = this.applyPreview(L, r);
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
    layers: doc.layers.map(L => ({ L, name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, alphaLock: L.alphaLock })),
  });
  History.restore = (doc, s) => {
    doc.layers = s.layers.map(o => { const { L, ...p } = o; Object.assign(L, p); return L; });
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
