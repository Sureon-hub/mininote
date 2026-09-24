'use strict';
// Tools. Each tool: down(pt,e) move(pt,e) up(pt,e) cancel() + optional activate/deactivate/drawOverlay.
// pt = {x, y (document px), p (pressure 0..1), sx, sy (screen px, css), type}
(() => {
  const U = App.util;
  const T = App.tools = {};

  // ---------------- brush / eraser ----------------
  class BrushTool {
    constructor(ed, erase) { this.ed = ed; this.erase = erase; this.cursor = 'crosshair'; }
    get preset() { const S = App.settings; return this.erase ? S.brushes.eraser : S.brushes[S.currentBrush] || S.brushes.pencil; }
    down(pt) {
      const L = this.ed.doc.active;
      if (!L.visible) { U.toast('숨겨진 레이어에는 그릴 수 없어요'); return false; }
      if (L.text) {
        if (this.erase) { U.toast('텍스트는 텍스트 도구로 고쳐주세요 (글상자를 누르면 수정)'); return false; }
        this.ed.addLayer(); // never paint into a text layer: draw on a fresh layer above it
        U.toast('텍스트 위에 새 레이어를 만들어 그려요');
      }
      this.stroke = new App.Stroke(this.ed, this.preset, this.erase, this.ed.color);
      this.sm = { x: pt.x, y: pt.y };
      this.start = { x: pt.x, y: pt.y };
      this.cur = pt;
      this.lastP = pt.p;
      this.straight = false;
      this.anchor = pt;
      this.armHold();
      this.q = [{ x: pt.x, y: pt.y, p: pt.p }];
      this.stroke.add(pt.x, pt.y, pt.p);
      this.stroke.flush();
    }
    // Input points are joined with quadratic curves through their midpoints (instead of straight segments),
    // so sparse samples from fast strokes don't show up as corners.
    feed(x, y, p) {
      const q = this.q;
      q.push({ x, y, p });
      if (q.length < 3) return;
      const [a, b, c] = q.slice(-3);
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 };
      const m2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2, p: (b.p + c.p) / 2 };
      if (q.length === 3) this.stroke.add(m1.x, m1.y, m1.p);
      const len = (Math.hypot(b.x - m1.x, b.y - m1.y) + Math.hypot(m2.x - b.x, m2.y - b.y)) * this.ed.z;
      const n = U.clamp(Math.ceil(len / 3), 1, 32);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        this.stroke.add(u * u * m1.x + 2 * u * t * b.x + t * t * m2.x, u * u * m1.y + 2 * u * t * b.y + t * t * m2.y, u * m1.p + t * m2.p);
      }
      q.shift();
    }
    finish(x, y, p) {
      const q = this.q;
      if (q.length === 2) { const [a, b] = q; this.stroke.add((a.x + b.x) / 2, (a.y + b.y) / 2, (a.p + b.p) / 2); }
      this.stroke.add(x, y, p);
    }
    move(pt) {
      if (!this.stroke) return;
      this.cur = pt;
      if (this.straight) { this.drawLine(); return; }
      // pen held still while drawing → snap to a straight line (restart the timer whenever it moves)
      if (Math.hypot(pt.x - this.anchor.x, pt.y - this.anchor.y) * this.ed.z > 4) { this.anchor = pt; this.armHold(); }
      // smoothing fades out with speed: slow wobbly lines get steadied, fast strokes don't trail behind the pen
      const gap = Math.hypot(pt.x - this.sm.x, pt.y - this.sm.y) * this.ed.z; // screen px
      const s = U.clamp(this.preset.smoothing || 0, 0, 0.95) * 0.6 * Math.exp(-gap / 12);
      this.sm.x += (pt.x - this.sm.x) * (1 - s);
      this.sm.y += (pt.y - this.sm.y) * (1 - s);
      this.lastP = pt.p;
      this.feed(this.sm.x, this.sm.y, pt.p);
    }
    armHold() {
      clearTimeout(this.holdT);
      if (this.preset.holdLine) this.holdT = setTimeout(() => this.makeStraight(), 550);
    }
    makeStraight() {
      if (!this.stroke || this.straight || !this.cur) return;
      if (Math.hypot(this.cur.x - this.start.x, this.cur.y - this.start.y) * this.ed.z < 20) return;
      this.straight = true;
      this.lineP = Math.max(this.lastP ?? 1, 0.5);
      try { navigator.vibrate?.(12); } catch { /* ignore */ }
      this.drawLine();
    }
    drawLine() {
      const s = this.stroke;
      s.reset();
      s.add(this.start.x, this.start.y, this.lineP);
      s.add(this.cur.x, this.cur.y, this.lineP);
      this.ed.scheduleFlush(s);
    }
    frame() { if (this.stroke) this.ed.scheduleFlush(this.stroke); }
    up(pt) {
      clearTimeout(this.holdT);
      if (!this.stroke) return;
      if (this.straight) {
        this.cur = pt;
        this.drawLine();
      } else {
        // let the smoothed point catch up with the pen, then close the curve at the final point
        const s = U.clamp(this.preset.smoothing || 0, 0, 0.95);
        if (s > 0.01) for (let i = 1; i <= 4; i++) {
          this.sm.x += (pt.x - this.sm.x) * 0.5; this.sm.y += (pt.y - this.sm.y) * 0.5;
          this.feed(this.sm.x, this.sm.y, this.lastP ?? pt.p);
        }
        this.finish(pt.x, pt.y, this.lastP ?? pt.p);
      }
      this.stroke.flush();
      this.stroke.commit();
      this.stroke = null;
    }
    cancel() { clearTimeout(this.holdT); this.stroke?.discard(); this.stroke = null; }
  }
  T.BrushTool = BrushTool;

  // ---------------- flood fill ----------------
  function flood(d32, W, H, sx, sy, tol) {
    const seed = d32[sy * W + sx];
    const sr = seed & 255, sg = (seed >>> 8) & 255, sb = (seed >>> 16) & 255, sa = seed >>> 24;
    const mask = new Uint8Array(W * H);
    const match = i => {
      if (mask[i]) return false;
      const c = d32[i], a = c >>> 24;
      if (a === 0 && sa === 0) return true;
      return Math.abs((c & 255) - sr) <= tol && Math.abs(((c >>> 8) & 255) - sg) <= tol &&
        Math.abs(((c >>> 16) & 255) - sb) <= tol && Math.abs(a - sa) <= tol;
    };
    let x0 = sx, x1 = sx, y0 = sy, y1 = sy;
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (!match(y * W + x)) continue;
      let lx = x, rx = x;
      while (lx > 0 && match(y * W + lx - 1)) lx--;
      while (rx < W - 1 && match(y * W + rx + 1)) rx++;
      mask.fill(1, y * W + lx, y * W + rx + 1);
      if (lx < x0) x0 = lx; if (rx > x1) x1 = rx; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= H) continue;
        let inSpan = false;
        for (let k = lx; k <= rx; k++) {
          const m = match(ny * W + k);
          if (m && !inSpan) { stack.push(k, ny); inSpan = true; } else if (!m) inSpan = false;
        }
      }
    }
    return { mask, b: { x0, y0, x1: x1 + 1, y1: y1 + 1 } };
  }
  function dilate(mask, W, H, b, n) {
    for (let it = 0; it < n; it++) {
      const nb = { x0: Math.max(0, b.x0 - 1), y0: Math.max(0, b.y0 - 1), x1: Math.min(W, b.x1 + 1), y1: Math.min(H, b.y1 + 1) };
      const add = [];
      for (let y = nb.y0; y < nb.y1; y++) for (let x = nb.x0; x < nb.x1; x++) {
        const i = y * W + x;
        if (mask[i]) continue;
        if ((x > 0 && mask[i - 1]) || (x < W - 1 && mask[i + 1]) || (y > 0 && mask[i - W]) || (y < H - 1 && mask[i + W])) add.push(i);
      }
      for (const i of add) mask[i] = 1;
      Object.assign(b, nb);
    }
  }
  class FillTool {
    constructor(ed) { this.ed = ed; this.cursor = 'crosshair'; }
    down(pt) { this.pt = pt; }
    move() {}
    cancel() { this.pt = null; }
    up() {
      const pt = this.pt; this.pt = null;
      if (!pt) return;
      const ed = this.ed, doc = ed.doc, L = doc.active, W = doc.w, H = doc.h;
      const x = Math.floor(pt.x), y = Math.floor(pt.y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      if (!L.visible) { U.toast('숨겨진 레이어에는 칠할 수 없어요'); return; }
      if (L.text) { U.toast('텍스트 레이어에는 칠할 수 없어요. 다른 레이어를 선택하세요'); return; }
      if (doc.selection && doc.selection.ctx.getImageData(x, y, 1, 1).data[3] < 8) return;
      const F = App.settings.fill;
      const src = F.sample === 'all' ? doc.flatten() : L.canvas;
      const d32 = new Uint32Array(src.getContext('2d').getImageData(0, 0, W, H).data.buffer);
      const { mask, b } = flood(d32, W, H, x, y, F.tolerance);
      if (F.expand > 0) dilate(mask, W, H, b, F.expand | 0);
      const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
      const img = new ImageData(bw, bh);
      const col = ed.colorRGB();
      const sel = doc.selection ? doc.selection.ctx.getImageData(b.x0, b.y0, bw, bh).data : null;
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) {
        if (!mask[(yy + b.y0) * W + xx + b.x0]) continue;
        const o = (yy * bw + xx) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
        img.data[o + 3] = sel ? sel[o + 3] : 255;
      }
      const tmp = U.canvas(bw, bh);
      tmp.getContext('2d').putImageData(img, 0, 0);
      const before = L.ctx.getImageData(b.x0, b.y0, bw, bh);
      L.ctx.save();
      L.ctx.globalCompositeOperation = L.alphaLock ? 'source-atop' : 'source-over';
      L.ctx.drawImage(tmp, b.x0, b.y0);
      L.ctx.restore();
      L.rev++;
      ed.pushHistory(App.History.pixels(doc, L, b, before, r => ed.changed(r)));
      ed.changed(b);
    }
  }
  T.FillTool = FillTool;

  // ---------------- eyedropper ----------------
  class PickerTool {
    constructor(ed) { this.ed = ed; this.cursor = 'crosshair'; }
    pick(pt) {
      const doc = this.ed.doc;
      const x = Math.floor(pt.x), y = Math.floor(pt.y);
      if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
      const d = doc.cctx.getImageData(x, y, 1, 1).data;
      if (d[3] < 10) return;
      this.ed.setColor('#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''), false);
    }
    down(pt) { this.pick(pt); }
    move(pt) { this.pick(pt); }
    up() { this.ed.setColor(this.ed.color, true); }
    cancel() {}
  }
  T.PickerTool = PickerTool;

  // ---------------- hand ----------------
  class HandTool {
    constructor(ed) { this.ed = ed; this.cursor = 'grab'; }
    down(pt) { this.last = pt; }
    move(pt) { if (!this.last) return; this.ed.panBy(pt.sx - this.last.sx, pt.sy - this.last.sy); this.last = pt; }
    up() { this.last = null; }
    cancel() { this.last = null; }
  }
  T.HandTool = HandTool;

  // ---------------- selection (rect / lasso) ----------------
  class SelectTool {
    constructor(ed, shape) { this.ed = ed; this.shape = shape; this.cursor = 'crosshair'; }
    down(pt, e) {
      this.mode = e && e.shiftKey ? 'add' : e && e.altKey ? 'sub' : App.settings.selMode;
      this.a = pt; this.b = pt;
      this.pts = [[pt.x, pt.y]];
    }
    move(pt) {
      if (!this.a) return;
      this.b = pt;
      if (this.shape === 'lasso') {
        const l = this.pts[this.pts.length - 1];
        if (Math.hypot(pt.x - l[0], pt.y - l[1]) * this.ed.z > 2) this.pts.push([pt.x, pt.y]);
      }
      this.ed.requestRender();
    }
    up(pt) {
      if (!this.a) return;
      if (pt && this.shape === 'rect') this.b = pt;
      const ed = this.ed, doc = ed.doc;
      let pts;
      if (this.shape === 'rect') {
        const x0 = Math.min(this.a.x, this.b.x), x1 = Math.max(this.a.x, this.b.x);
        const y0 = Math.min(this.a.y, this.b.y), y1 = Math.max(this.a.y, this.b.y);
        pts = (x1 - x0) * ed.z < 4 || (y1 - y0) * ed.z < 4 ? null : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      } else pts = this.pts.length > 3 ? this.pts : null;
      this.a = null;
      if (!pts) {
        if (this.mode === 'new') ed.setSelection(null);
        ed.requestRender();
        return;
      }
      const sel = doc.selection && this.mode !== 'new' ? doc.selection.clone() : new App.Selection(doc.w, doc.h);
      sel.apply(pts, this.mode);
      ed.setSelection(sel.empty ? null : sel);
    }
    cancel() { this.a = null; this.ed.requestRender(); }
    drawOverlay(c) {
      if (!this.a) return;
      const ed = this.ed;
      c.save();
      c.lineWidth = 1;
      c.beginPath();
      if (this.shape === 'rect') {
        // doc-space rectangle (may appear rotated on screen when the view is rotated)
        const { a, b } = this;
        [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]].forEach(([x, y], i) => { const s = ed.toScreen(x, y); i ? c.lineTo(s[0], s[1]) : c.moveTo(s[0], s[1]); });
        c.closePath();
      } else {
        this.pts.forEach(([x, y], i) => { const s = ed.toScreen(x, y); i ? c.lineTo(s[0], s[1]) : c.moveTo(s[0], s[1]); });
      }
      c.strokeStyle = '#fff'; c.stroke();
      c.setLineDash([4, 4]); c.strokeStyle = '#000'; c.stroke();
      c.restore();
    }
  }
  T.SelectTool = SelectTool;

  // ---------------- transform (move / scale / rotate) ----------------
  class TransformTool {
    constructor(ed) { this.ed = ed; this.cursor = 'default'; this.f = null; }
    get active() { return !!this.f; }
    activate() { this.begin(); }
    deactivate() { this.commit(); }
    begin() {
      if (this.f) return true;
      const ed = this.ed, doc = ed.doc, L = doc.active;
      if (!L.visible) { U.toast('숨겨진 레이어는 변형할 수 없어요'); return false; }
      if (L.text) { L.text = null; U.toast('텍스트가 이미지로 바뀌어요 (글자 수정은 더 이상 안 돼요)'); }
      const sel = doc.selection;
      const b = sel ? U.rClamp(sel.bounds, doc.w, doc.h) : doc.contentBounds(L);
      if (!b) { U.toast('변형할 내용이 없어요'); return false; }
      const w = b.x1 - b.x0, h = b.y1 - b.y0;
      const fc = U.canvas(w, h), fx = fc.getContext('2d');
      fx.drawImage(L.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
      if (sel) { fx.globalCompositeOperation = 'destination-in'; fx.drawImage(sel.mask, b.x0, b.y0, w, h, 0, 0, w, h); }
      this.backup = U.cloneCanvas(L.canvas);
      L.ctx.save();
      if (sel) { L.ctx.globalCompositeOperation = 'destination-out'; L.ctx.drawImage(sel.mask, 0, 0); }
      else L.ctx.clearRect(b.x0, b.y0, w, h);
      L.ctx.restore();
      this.L = L;
      this.f = { canvas: fc, w, h, cx: b.x0 + w / 2, cy: b.y0 + h / 2, sx: 1, sy: 1, rot: 0, orig: b };
      doc.preview = {
        layer: L,
        apply: sc => {
          const f = this.f;
          sc.setTransform(this.matrix());
          sc.imageSmoothingQuality = 'high';
          sc.globalCompositeOperation = 'source-over';
          sc.drawImage(f.canvas, -f.w / 2, -f.h / 2);
        },
      };
      ed.onTransformState(true);
      ed.requestComposite(null);
      return true;
    }
    matrix() {
      const f = this.f;
      return new DOMMatrix().translate(f.cx, f.cy).rotate(f.rot * 180 / Math.PI).scale(f.sx, f.sy);
    }
    corners() {
      const f = this.f, m = this.matrix();
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const p = m.transformPoint(new DOMPoint(u * f.w / 2, v * f.h / 2)); return [p.x, p.y]; });
    }
    handles() {
      const f = this.f, m = this.matrix(), ed = this.ed;
      const hs = [];
      for (const [u, v] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
        const p = m.transformPoint(new DOMPoint(u * f.w / 2, v * f.h / 2));
        hs.push({ u, v, s: ed.toScreen(p.x, p.y) });
      }
      const top = m.transformPoint(new DOMPoint(0, -f.h / 2)), c = ed.toScreen(f.cx, f.cy);
      const ts = ed.toScreen(top.x, top.y);
      const dx = ts[0] - c[0], dy = ts[1] - c[1], dl = Math.hypot(dx, dy) || 1;
      hs.push({ rot: true, s: [ts[0] + dx / dl * 30, ts[1] + dy / dl * 30] });
      return hs;
    }
    down(pt, e) {
      if (!this.f && !this.begin()) return false;
      const f = this.f;
      const R = pt.type === 'touch' ? 24 : 12;
      let hit = null;
      for (const h of this.handles()) if (Math.hypot(h.s[0] - pt.sx, h.s[1] - pt.sy) <= R) { hit = h; break; }
      this.start = { pt, f: { ...f } };
      if (hit && hit.rot) this.mode = 'rotate';
      else if (hit) { this.mode = 'scale'; this.h = hit; }
      else {
        // inside the box → move, outside → rotate
        const inv = this.matrix().inverse();
        const lp = inv.transformPoint(new DOMPoint(pt.x, pt.y));
        this.mode = Math.abs(lp.x) <= f.w / 2 && Math.abs(lp.y) <= f.h / 2 ? 'move' : 'rotate';
      }
      this.shift = e && e.shiftKey;
    }
    move(pt, e) {
      if (!this.start || !this.f) return;
      const f = this.f, s = this.start, f0 = s.f;
      if (this.mode === 'move') {
        f.cx = f0.cx + pt.x - s.pt.x; f.cy = f0.cy + pt.y - s.pt.y;
      } else if (this.mode === 'rotate') {
        const a0 = Math.atan2(s.pt.y - f0.cy, s.pt.x - f0.cx), a1 = Math.atan2(pt.y - f0.cy, pt.x - f0.cx);
        let r = f0.rot + a1 - a0;
        if (e && e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        f.rot = r;
      } else if (this.mode === 'scale') {
        const { u, v } = this.h;
        const cos = Math.cos(f0.rot), sin = Math.sin(f0.rot);
        const rotate = (x, y) => [x * cos - y * sin, x * sin + y * cos];
        const al = [-u * f0.w * f0.sx / 2, -v * f0.h * f0.sy / 2];
        const ar = rotate(al[0], al[1]);
        const anchor = [f0.cx + ar[0], f0.cy + ar[1]];
        const vx = pt.x - anchor[0], vy = pt.y - anchor[1];
        const lv = [vx * cos + vy * sin, -vx * sin + vy * cos];
        let sx = f0.sx, sy = f0.sy;
        const keep = (u && v) && (App.settings.transformKeepRatio !== !!(e && e.shiftKey));
        if (keep) {
          const d0 = [u * f0.w * f0.sx, v * f0.h * f0.sy];
          const k = (lv[0] * d0[0] + lv[1] * d0[1]) / (d0[0] * d0[0] + d0[1] * d0[1]);
          sx = f0.sx * k; sy = f0.sy * k;
        } else {
          if (u) sx = lv[0] / (u * f0.w);
          if (v) sy = lv[1] / (v * f0.h);
        }
        const minS = 2 / Math.max(f0.w, f0.h);
        if (Math.abs(sx) < minS) sx = sx < 0 ? -minS : minS;
        if (Math.abs(sy) < minS) sy = sy < 0 ? -minS : minS;
        f.sx = sx; f.sy = sy;
        const cr = rotate(u * f0.w * sx / 2, v * f0.h * sy / 2);
        f.cx = anchor[0] + cr[0]; f.cy = anchor[1] + cr[1];
      }
      this.ed.requestComposite(null);
    }
    up() { this.start = null; }
    cancel() { this.start = null; }
    flip(axis) { if (!this.f) return; if (axis === 'h') this.f.sx *= -1; else this.f.sy *= -1; this.ed.requestComposite(null); }
    commit() {
      if (!this.f) return;
      const ed = this.ed, doc = ed.doc, L = this.L, f = this.f;
      doc.preview = null;
      L.ctx.save();
      L.ctx.setTransform(this.matrix());
      L.ctx.imageSmoothingQuality = 'high';
      L.ctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);
      L.ctx.restore();
      L.rev++;
      let nb = null;
      for (const [x, y] of this.corners()) nb = U.rUnion(nb, { x0: x, y0: y, x1: x, y1: y });
      const r = U.rClamp(U.rUnion(nb, f.orig), doc.w, doc.h, 2);
      if (r) {
        const before = this.backup.getContext('2d').getImageData(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        ed.pushHistory(App.History.pixels(doc, L, r, before, rr => ed.changed(rr)));
      }
      this.f = null; this.backup = null;
      ed.setSelection(null);
      ed.onTransformState(false);
      ed.changed(null);
    }
    revert() {
      if (!this.f) return;
      const doc = this.ed.doc, L = this.L;
      doc.preview = null;
      L.ctx.save();
      L.ctx.globalCompositeOperation = 'copy';
      L.ctx.drawImage(this.backup, 0, 0);
      L.ctx.restore();
      L.rev++;
      this.f = null; this.backup = null;
      this.ed.onTransformState(false);
      this.ed.changed(null);
    }
    drawOverlay(c) {
      if (!this.f) return;
      const ed = this.ed;
      const cs = this.corners().map(([x, y]) => ed.toScreen(x, y));
      c.save();
      c.beginPath();
      cs.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      c.closePath();
      c.lineWidth = 1.5; c.strokeStyle = '#2f7cf6'; c.stroke();
      const hs = this.handles();
      const rot = hs[hs.length - 1], topMid = hs[1];
      c.beginPath(); c.moveTo(topMid.s[0], topMid.s[1]); c.lineTo(rot.s[0], rot.s[1]); c.stroke();
      for (const h of hs) {
        c.beginPath();
        if (h.rot) c.arc(h.s[0], h.s[1], 7, 0, Math.PI * 2);
        else c.rect(h.s[0] - 5, h.s[1] - 5, 10, 10);
        c.fillStyle = '#fff'; c.fill(); c.stroke();
      }
      c.restore();
    }
  }
  T.TransformTool = TransformTool;
})();
