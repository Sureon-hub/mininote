'use strict';
// Quick viewer: tapping a note shows its image right away (like a phone's gallery app). Swipe / arrow keys go to
// the previous / next note, two fingers zoom. A tap (or any pen touch) opens the note in the editor.
// It shows the image file itself (small, fast), not the layered edit file.
(() => {
  const U = App.util, h = U.h;
  const KEEP = 3; // full images kept around the current one

  const V = App.viewer = {
    list: [], idx: 0,
    urls: new Map(), // entry -> Promise<object URL | null>
    get visible() { return !this.root.hidden; },

    init() {
      this.root = U.$('#viewer');
      this.nameEl = h('div', { class: 'e-title' });
      this.countEl = h('small', { class: 'v-count' });
      U.$('#v-bar').replaceChildren(
        U.iconBtn('back', '갤러리로 (Esc)', () => this.close()),
        this.nameEl, h('div', { class: 'grow' }), this.countEl,
        U.iconBtn('left', '이전 (←)', () => this.go(-1)),
        U.iconBtn('right', '다음 (→)', () => this.go(1)),
        h('span', { class: 'sep' }),
        U.iconBtn('edit', '편집하기 (Enter · 한 번 탭 · 펜으로 터치)', () => this.edit(), 'accent'));
      this.stage = U.$('#v-stage');
      this.track = h('div', { class: 'v-track' });
      this.slides = [-1, 0, 1].map(() => h('div', { class: 'v-slide' }, h('img', { alt: '', draggable: 'false' })));
      this.track.append(...this.slides);
      this.stage.append(this.track, h('div', { class: 'v-hint' }, '한 번 탭하거나 펜으로 터치하면 편집해요'));
      this.bindGestures();
      window.addEventListener('keydown', e => {
        if (!this.visible || document.querySelector('.modal-back, .menu-back')) return;
        const k = e.key;
        if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); this.go(-1); }
        else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); this.go(1); }
        else if (k === 'Enter' || k === 'e' || k === 'E') { e.preventDefault(); this.edit(); }
        else if (k === 'Escape') { e.preventDefault(); this.close(); }
      });
      this.stage.addEventListener('wheel', e => {
        if (e.ctrlKey || this.zoom.s > 1.01) return;
        e.preventDefault();
        if (this.wheelLock) return;
        if (Math.abs(e.deltaX) + Math.abs(e.deltaY) < 20) return;
        this.wheelLock = true; setTimeout(() => { this.wheelLock = false; }, 250);
        this.go((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) > 0 ? 1 : -1);
      }, { passive: false });
    },

    open(list, idx) {
      this.list = list; this.idx = Math.max(0, idx);
      App.show('viewer');
      this.root.classList.toggle('first-time', !App.settings.viewerHintSeen);
      if (!App.settings.viewerHintSeen) { App.settings.viewerHintSeen = true; App.saveSettings(); }
      this.layout();
    },
    // back from the editor: show the note that was open there
    resume(list, idx) {
      if (list && list.length) { this.list = list; this.idx = U.clamp(idx, 0, list.length - 1); }
      this.forget(this.list[this.idx]); // it may have just been saved
      App.show('viewer');
      this.layout();
    },
    close() {
      const cur = this.list[this.idx];
      App.show('gallery');
      App.gallery.render(cur);
      for (const e of [...this.urls.keys()]) this.forget(e);
    },
    edit() {
      if (!this.list[this.idx]) return;
      App.editor.open(this.list, this.idx, { fromViewer: true });
    },

    // ---- images ----
    forget(e) {
      const p = this.urls.get(e);
      if (!p) return;
      this.urls.delete(e);
      p.then(u => u && u.startsWith('blob:') && URL.revokeObjectURL(u)).catch(() => {});
    },
    full(e) {
      if (!this.urls.has(e)) {
        this.urls.set(e, (async () => {
          const L = App.library;
          let real = e;
          if (e.edited) real = await L.resolveEdited(e, false);
          if (!real) return App.gallery.loadThumb(e); // original not found: the edit file's own picture
          await App.editor.pendingSaves.get(e);
          return URL.createObjectURL(await L.backend.read(real));
        })().catch(err => { if (err && err.auth) App.needLogin(); return null; }));
      }
      return this.urls.get(e);
    },
    fill(slide, e) {
      const img = slide.firstChild;
      slide.entry = e;
      img.removeAttribute('src');
      slide.classList.toggle('empty', !e);
      if (!e) return;
      // the gallery thumbnail first (instant), then the real image
      const t = App.gallery.thumbUrl(e);
      if (t) img.src = t;
      else App.gallery.loadThumb(e).then(u => { if (slide.entry === e && u && !img.dataset.full) img.src = u; }).catch(() => {});
      delete img.dataset.full;
      this.full(e).then(u => {
        if (slide.entry !== e || !u) return;
        const pre = new Image();
        pre.src = u;
        (pre.decode ? pre.decode() : Promise.resolve()).catch(() => {}).then(() => {
          if (slide.entry === e) { img.src = u; img.dataset.full = '1'; }
        });
      });
    },
    layout() {
      const L = this.list, i = this.idx, e = L[i];
      this.resetZoom();
      this.track.style.transition = 'none';
      this.track.style.transform = 'translateX(0)';
      this.fill(this.slides[0], L[i - 1]);
      this.fill(this.slides[1], e);
      this.fill(this.slides[2], L[i + 1]);
      this.nameEl.textContent = e ? e.name : '';
      this.countEl.textContent = L.length ? `${i + 1} / ${L.length}` : '';
      // keep a few neighbours ready, drop the rest
      for (let d = 2; d <= KEEP; d++) { if (L[i + d]) this.full(L[i + d]); if (L[i - d]) this.full(L[i - d]); }
      const near = new Set(L.slice(Math.max(0, i - KEEP), i + KEEP + 1));
      for (const k of [...this.urls.keys()]) if (!near.has(k)) this.forget(k);
    },
    go(d) {
      const ni = this.idx + d;
      if (ni < 0 || ni >= this.list.length) { this.bounce(d); return; }
      this.slideTo(d);
    },
    slideTo(d) {
      const W = this.stage.clientWidth;
      this.track.style.transition = 'transform .16s ease-out';
      this.track.style.transform = `translateX(${-d * W}px)`;
      clearTimeout(this.slideT);
      this.slideT = setTimeout(() => { this.idx += d; this.layout(); }, 160);
    },
    bounce(d) {
      this.track.style.transition = 'transform .12s ease-out';
      this.track.style.transform = `translateX(${-d * 40}px)`;
      setTimeout(() => { this.track.style.transform = 'translateX(0)'; }, 120);
    },

    // ---- zoom ----
    zoom: { s: 1, x: 0, y: 0 },
    resetZoom() { this.zoom = { s: 1, x: 0, y: 0 }; this.applyZoom(); },
    applyZoom() {
      const z = this.zoom, img = this.slides[1].firstChild;
      img.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    },

    // ---- gestures: swipe, pinch, tap → edit, pen → edit ----
    bindGestures() {
      const st = this.stage, pts = new Map();
      let g = null;
      st.addEventListener('pointerdown', e => {
        if (e.pointerType === 'pen') { e.preventDefault(); this.edit(); return; }
        if (e.button > 0) return;
        st.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 1) g = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, mode: null, z0: { ...this.zoom } };
        else if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          g = { mode: 'pinch', moved: true, d0: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, z0: { ...this.zoom } };
          this.track.style.transition = 'none';
          this.track.style.transform = 'translateX(0)';
        }
      });
      st.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId) || !g) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (g.mode === 'pinch' && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const s = U.clamp(g.z0.s * Math.hypot(a.x - b.x, a.y - b.y) / (g.d0 || 1), 1, 8);
          const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          // keep the point between the fingers in place
          const r = st.getBoundingClientRect(), ox = g.cx - r.left - r.width / 2, oy = g.cy - r.top - r.height / 2;
          const k = s / g.z0.s;
          this.zoom = { s, x: ox - (ox - g.z0.x) * k + (cx - g.cx), y: oy - (oy - g.z0.y) * k + (cy - g.cy) };
          this.applyZoom();
          return;
        }
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (!g.moved && Math.hypot(dx, dy) > 8) { g.moved = true; g.mode = this.zoom.s > 1.01 ? 'pan' : 'swipe'; }
        if (g.mode === 'pan') { this.zoom = { ...this.zoom, x: g.z0.x + dx, y: g.z0.y + dy }; this.applyZoom(); }
        else if (g.mode === 'swipe') {
          const edge = (dx > 0 && this.idx === 0) || (dx < 0 && this.idx === this.list.length - 1);
          this.track.style.transition = 'none';
          this.track.style.transform = `translateX(${edge ? dx * 0.3 : dx}px)`;
        }
      });
      const up = e => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (!g) return;
        if (g.mode === 'pinch') {
          if (!pts.size) { if (this.zoom.s < 1.05) this.resetZoom(); g = null; }
          return;
        }
        if (pts.size) return;
        const dx = e.clientX - g.x0, dt = performance.now() - g.t0;
        if (!g.moved && e.type === 'pointerup' && dt < 450) this.edit();
        else if (g.mode === 'swipe') {
          const W = st.clientWidth, fast = Math.abs(dx) / Math.max(dt, 1) > 0.5;
          const d = dx < 0 ? 1 : -1, ni = this.idx + d;
          if ((Math.abs(dx) > W * 0.2 || (fast && Math.abs(dx) > 30)) && ni >= 0 && ni < this.list.length) this.slideTo(d);
          else { this.track.style.transition = 'transform .15s ease-out'; this.track.style.transform = 'translateX(0)'; }
        }
        g = null;
      };
      st.addEventListener('pointerup', up);
      st.addEventListener('pointercancel', up);
    },
  };
  document.addEventListener('DOMContentLoaded', () => V.init());
})();
