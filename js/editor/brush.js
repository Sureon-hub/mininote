'use strict';
// Brush engine: stamped round tips + a paper "grain" (fibrous pencil texture) masked in canvas space.
(() => {
  const U = App.util;
  const TIP = 256;
  const GRAIN = 256;

  const tipCache = new Map();
  const tintCache = new Map();
  const grainCache = new Map();
  let grainBase = null;

  function tip(hardness) {
    const hk = Math.round(hardness * 50) / 50;
    if (tipCache.has(hk)) return tipCache.get(hk);
    const c = U.canvas(TIP, TIP), g = c.getContext('2d');
    const r = TIP / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    if (hk <= 0.02) {
      // airbrush: gaussian-ish falloff
      for (let i = 0; i <= 10; i++) { const t = i / 10; grad.addColorStop(t, `rgba(0,0,0,${Math.exp(-t * t * 4.5) * (1 - t * t)})`); }
    } else {
      const h = Math.min(hk, 0.985);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(h, 'rgba(0,0,0,1)');
      grad.addColorStop(Math.min(1, h + (1 - h) * 0.5), 'rgba(0,0,0,0.45)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, TIP, TIP);
    tipCache.set(hk, c);
    return c;
  }

  function tinted(color, hardness) {
    const key = color + '|' + Math.round(hardness * 50);
    if (tintCache.has(key)) return tintCache.get(key);
    if (tintCache.size > 40) tintCache.clear();
    const c = U.cloneCanvas(tip(hardness)), g = c.getContext('2d');
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, TIP, TIP);
    tintCache.set(key, c);
    return c;
  }

  // Tileable fibrous grain, values 0..1 (1 = paint passes through).
  function makeGrainBase() {
    const S = GRAIN, c = U.canvas(S, S), g = c.getContext('2d', { willReadFrequently: true });
    let seed = 20240917;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    g.lineCap = 'round';
    const fiber = (x, y, a, len, lw, al) => {
      const dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
      g.strokeStyle = `rgba(0,0,0,${al})`;
      g.lineWidth = lw;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const cx = x + ox, cy = y + oy;
        if (cx < -len || cx > S + len || cy < -len || cy > S + len) continue;
        g.beginPath(); g.moveTo(cx - dx, cy - dy); g.lineTo(cx + dx, cy + dy); g.stroke();
      }
    };
    // long faint fibres + many short crisp ones + specks
    for (let i = 0; i < 700; i++) fiber(rnd() * S, rnd() * S, rnd() * Math.PI, 6 + rnd() * 14, 0.6 + rnd() * 0.5, 0.2 + rnd() * 0.3);
    for (let i = 0; i < 6500; i++) fiber(rnd() * S, rnd() * S, rnd() * Math.PI, 1.5 + rnd() * 5, 0.5 + rnd() * 0.7, 0.55 + rnd() * 0.45);
    for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(0,0,0,${0.4 + rnd() * 0.6})`; g.fillRect((rnd() * S) | 0, (rnd() * S) | 0, 1, 1); }
    const d = g.getImageData(0, 0, S, S).data;
    const v = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) v[i] = d[i * 4 + 3] / 255;
    return v;
  }

  function grainCanvas(strength) {
    const k = Math.round(strength * 20) / 20;
    if (grainCache.has(k)) return grainCache.get(k);
    if (!grainBase) grainBase = makeGrainBase();
    const c = U.canvas(GRAIN, GRAIN), g = c.getContext('2d');
    const img = g.createImageData(GRAIN, GRAIN);
    for (let i = 0; i < grainBase.length; i++) img.data[i * 4 + 3] = Math.round(255 * (1 - k * (1 - grainBase[i])));
    g.putImageData(img, 0, 0);
    grainCache.set(k, c);
    return c;
  }

  App.brush = { tip, tinted, grainCanvas, grainValues: () => grainBase || (grainBase = makeGrainBase()) };

  // Coverage -> alpha through the paper grain. Mid coverage is boosted so normal pressure stays dense;
  // only the thin edges and very light pressure turn grainy.
  function grainPass(img, x, y, G, s) {
    const d = img.data, w = img.width, h = img.height;
    for (let yy = 0; yy < h; yy++) {
      const gy = ((y + yy) & 255) << 8;
      let i = yy * w * 4 + 3;
      for (let xx = 0; xx < w; xx++, i += 4) {
        const c = d[i];
        if (!c) continue;
        const cv = 1 - c / 255, cb = 1 - cv * cv;
        const t = (1 - G[gy | ((x + xx) & 255)]) * s;
        const a = (cb - t) / (1.001 - t);
        d[i] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
      }
    }
  }

  // ---------------- a single stroke ----------------
  class Stroke {
    constructor(ed, preset, erase, color) {
      this.ed = ed;
      const doc = this.doc = ed.doc;
      const L = this.L = doc.active;
      this.p = preset;
      this.erase = erase;
      this.P = App.settings.pressure;
      const bufs = ed.buffers();
      this.bctx = bufs.strokeCtx;
      this.mbuf = bufs.masked; this.mctx = bufs.maskedCtx; this.buf = bufs.stroke;
      this.tip = tinted(erase ? '#000000' : color, preset.hardness);
      this.spacing = U.clamp(preset.spacing || 0.06, 0.01, 1);
      // ~number of stamps whose solid core covers a pixel on the centre line
      this.n = Math.max(1, Math.max(0.2, preset.hardness) * 0.8 / this.spacing);
      this.dirty = null; this.pending = null; this.last = null; this.acc = 0;
      // textured brush: grain is fixed to the paper (cream-pencil look)
      this.grain = preset.grain > 0.01 ? App.brush.grainValues() : null;
      // outline ("테두리"): a wider stamp in the outline colour, placed *behind* the layer's existing pixels
      const O = preset.outline;
      this.outline = !erase && O && O.on && O.width > 0 && !L.alphaLock ? O : null;
      if (this.outline) {
        const ob = ed.buffers('outline');
        this.octx = ob.strokeCtx; this.obuf = ob.stroke; this.ombuf = ob.masked; this.omctx = ob.maskedCtx;
        this.otip = tinted(O.color, U.lerp(preset.hardness, 0.92, O.smooth));
        this.ograin = this.grain ? preset.grain * (1 - O.smooth) : 0;
      }
      doc.preview = { layer: L, apply: (sc, r) => this.draw(sc, r) };
    }
    draw(c, r) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      c.globalAlpha = this.p.opacity;
      if (this.outline) {
        c.globalCompositeOperation = 'destination-over';
        c.drawImage(this.ombuf, r.x0, r.y0, w, h, r.x0, r.y0, w, h);
      }
      c.globalCompositeOperation = this.erase ? 'destination-out' : this.L.alphaLock ? 'source-atop' : 'source-over';
      c.drawImage(this.mbuf, r.x0, r.y0, w, h, r.x0, r.y0, w, h);
    }
    curve(p) { return Math.pow(U.clamp(p, 0, 1), this.P.gamma); }
    sizeAt(p) { return Math.max(0.5, this.p.size * (this.P.size ? U.lerp(this.P.minSize, 1, this.curve(p)) : 1)); }
    alphaAt(p) {
      let a = this.p.flow;
      const c = this.curve(p);
      if (this.p.pFlow) a *= U.lerp(this.p.pFlowMin ?? 0.6, 1, c);
      if (this.P.opacity) a *= U.lerp(this.P.minOpacity, 1, c);
      return 1 - Math.pow(1 - U.clamp(a, 0, 1), 1 / this.n);
    }
    stamp(x, y, p) {
      const s = this.sizeAt(p);
      let a = this.alphaAt(p), d = s;
      if (s < 1.5) { a *= s / 1.5; d = 1.5; }
      const c = this.bctx;
      c.globalAlpha = a;
      c.drawImage(this.tip, x - d / 2, y - d / 2, d, d);
      if (this.outline) {
        d = s + this.outline.width * 2;
        this.octx.globalAlpha = 1;
        this.octx.drawImage(this.otip, x - d / 2, y - d / 2, d, d);
      }
      this.pending = U.rUnion(this.pending, { x0: x - d / 2 - 1, y0: y - d / 2 - 1, x1: x + d / 2 + 1, y1: y + d / 2 + 1 });
    }
    add(x, y, p) {
      if (!this.last) { this.stamp(x, y, p); this.last = { x, y, p }; return; }
      const l = this.last, dx = x - l.x, dy = y - l.y, d = Math.hypot(dx, dy);
      if (d < 0.01) { this.last.p = p; return; }
      let s = 0;
      for (let guard = 0; guard < 100000; guard++) {
        const t0 = s / d;
        const step = Math.max(0.4, this.sizeAt(U.lerp(l.p, p, t0)) * this.spacing);
        const need = step - this.acc;
        if (s + need > d) { this.acc += d - s; break; }
        s += need; this.acc = 0;
        const t = s / d;
        this.stamp(l.x + dx * t, l.y + dy * t, U.lerp(l.p, p, t));
      }
      this.last = { x, y, p };
    }
    // coverage buffer -> masked buffer (grain + selection) for rect r
    pass(srcCanvas, srcCtx, dstCtx, grainS, r) {
      const x = r.x0, y = r.y0, w = r.x1 - r.x0, h = r.y1 - r.y0;
      const m = dstCtx, sel = this.doc.selection;
      m.save();
      // destination-in is an "unbounded" operator: without a clip it would wipe the rest of the buffer
      m.beginPath(); m.rect(x, y, w, h); m.clip();
      m.globalAlpha = 1;
      m.globalCompositeOperation = 'source-over';
      if (grainS > 0.01) {
        const img = srcCtx.getImageData(x, y, w, h);
        grainPass(img, x, y, this.grain, grainS);
        m.putImageData(img, x, y);
      } else {
        m.clearRect(x, y, w, h);
        m.drawImage(srcCanvas, x, y, w, h, x, y, w, h);
      }
      if (sel) { m.globalCompositeOperation = 'destination-in'; m.drawImage(sel.mask, x, y, w, h, x, y, w, h); }
      m.restore();
    }
    flush() {
      const doc = this.doc;
      const r = U.rClamp(this.pending, doc.w, doc.h, 1);
      this.pending = null;
      if (!r) return;
      this.pass(this.buf, this.bctx, this.mctx, this.grain ? this.p.grain : 0, r);
      if (this.outline) this.pass(this.obuf, this.octx, this.omctx, this.ograin, r);
      this.dirty = U.rUnion(this.dirty, r);
      this.ed.requestComposite(r);
    }
    commit() {
      const doc = this.doc, L = this.L, r = this.dirty;
      doc.preview = null;
      if (!r) return;
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      const before = L.ctx.getImageData(r.x0, r.y0, w, h);
      L.ctx.save();
      this.draw(L.ctx, r);
      L.ctx.restore();
      L.rev++;
      this.clear(r);
      this.ed.pushHistory(App.History.pixels(doc, L, r, before, rr => this.ed.changed(rr)));
      this.ed.changed(r);
    }
    discard() {
      this.doc.preview = null;
      if (this.dirty) { this.clear(this.dirty); this.ed.requestComposite(this.dirty); }
    }
    clear(r) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      this.bctx.clearRect(r.x0, r.y0, w, h);
      this.mctx.clearRect(r.x0, r.y0, w, h);
      if (this.outline) { this.octx.clearRect(r.x0, r.y0, w, h); this.omctx.clearRect(r.x0, r.y0, w, h); }
    }
  }
  App.Stroke = Stroke;
})();
