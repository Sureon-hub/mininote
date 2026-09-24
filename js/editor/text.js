'use strict';
// Text boxes: editable text layers (layer.text = {content, x, y, font, size, bold, color}).
// The layer's pixels are always re-rendered from that data, so text stays editable after saving.
(() => {
  const U = App.util, h = U.h, H = App.History;

  // [id, label, CSS family, Google Fonts family spec]
  const FONTS = [
    ['system', '기본', 'system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif', null],
    ['sans', '고딕', '"Noto Sans KR", sans-serif', 'Noto+Sans+KR:wght@400;700'],
    ['serif', '명조', '"Noto Serif KR", serif', 'Noto+Serif+KR:wght@400;700'],
    ['pen', '손글씨', '"Nanum Pen Script", cursive', 'Nanum+Pen+Script'],
    ['round', '둥근', '"Gowun Dodum", sans-serif', 'Gowun+Dodum'],
    ['brush', '붓글씨', '"Nanum Brush Script", cursive', 'Nanum+Brush+Script'],
  ];
  const LINE = 1.35;
  const familyOf = id => (FONTS.find(f => f[0] === id) || FONTS[0])[2];
  const fontOf = T => `${T.bold ? 700 : 400} ${T.size}px ${familyOf(T.font)}`;

  let fontsLinked = false;
  function linkFonts() {
    if (fontsLinked) return;
    fontsLinked = true;
    const fam = FONTS.filter(f => f[3]).map(f => 'family=' + f[3]).join('&');
    document.head.append(h('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?${fam}&display=swap` }));
  }
  async function ensureFont(T) {
    linkFonts();
    try { await document.fonts.load(fontOf(T), T.content || '가A'); } catch { /* offline: falls back to system font */ }
  }

  function render(L) {
    const T = L.text, c = L.ctx, cv = L.canvas;
    c.clearRect(0, 0, cv.width, cv.height);
    L.rev++;
    if (!T || !T.content) { if (T) { T.w = 0; T.h = 0; } return; }
    c.save();
    c.font = fontOf(T);
    c.fillStyle = T.color;
    c.textBaseline = 'top';
    const lines = T.content.split('\n'), lh = T.size * LINE;
    let w = 0;
    lines.forEach((ln, i) => {
      c.fillText(ln, T.x, T.y + i * lh + T.size * (LINE - 1) / 2);
      w = Math.max(w, c.measureText(ln).width);
    });
    c.restore();
    T.w = w; T.h = lines.length * lh;
  }
  // topmost visible text layer under a document point
  function hit(doc, pt) {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const L = doc.layers[i], T = L.text;
      if (!L.visible || !T || !T.content) continue;
      const pad = Math.max(8, T.size * 0.2);
      if (pt.x >= T.x - pad && pt.x <= T.x + (T.w || 0) + pad && pt.y >= T.y - pad && pt.y <= T.y + (T.h || T.size) + pad) return L;
    }
    return null;
  }

  // ---------------- tool ----------------
  class TextTool {
    constructor(ed) { this.ed = ed; this.cursor = 'text'; }
    down(pt) {
      const ed = this.ed;
      if (ed.textEd) { App.text.commit(ed); return false; }
      this.start = pt; this.moved = false;
      this.L = hit(ed.doc, pt);
      if (this.L) { this.orig = { x: this.L.text.x, y: this.L.text.y }; this.before = H.snap(ed.doc); }
    }
    move(pt) {
      const L = this.L;
      if (!L || !this.start) return;
      const dx = pt.x - this.start.x, dy = pt.y - this.start.y;
      if (!this.moved && Math.hypot(dx, dy) * this.ed.z < 6) return;
      this.moved = true;
      L.text.x = this.orig.x + dx; L.text.y = this.orig.y + dy;
      render(L);
      this.ed.changed(null);
    }
    up(pt) {
      const ed = this.ed, L = this.L;
      if (!this.start) return;
      this.start = null;
      if (L && this.moved) {
        ed.pushHistory(H.struct(ed.doc, this.before, H.snap(ed.doc), () => ed.changed(null)));
        return;
      }
      App.text.start(ed, L, pt);
    }
    cancel() { this.start = null; }
    drawOverlay(c) {
      // outline text boxes so they're easy to find with the text tool
      const ed = this.ed;
      if (!ed.doc) return;
      c.save();
      c.setLineDash([3, 3]); c.strokeStyle = 'rgba(47,124,246,.8)'; c.lineWidth = 1;
      for (const L of ed.doc.layers) {
        const T = L.text;
        if (!L.visible || !T || !T.content || (ed.textEd && ed.textEd.L === L)) continue;
        const pts = [[T.x, T.y], [T.x + T.w, T.y], [T.x + T.w, T.y + T.h], [T.x, T.y + T.h]].map(([x, y]) => ed.toScreen(x, y));
        c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
      }
      c.restore();
    }
  }
  App.tools.TextTool = TextTool;

  // ---------------- in-place editor (textarea over the canvas) ----------------
  App.text = {
    FONTS, render, hit, ensureFont, linkFonts,
    start(ed, L, pt) {
      const S = App.settings.text;
      linkFonts();
      const T = L ? { ...L.text } : { content: '', x: pt.x, y: pt.y - S.size * 0.6, font: S.font, size: S.size, bold: S.bold, color: ed.color };
      const ta = h('textarea', { class: 'text-edit', spellcheck: 'false', value: T.content });
      ta.addEventListener('input', () => this.place(ed));
      ta.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); this.cancel(ed); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(ed); }
      });
      ed.textEd = { L, T, ta, orig: L ? { ...L.text } : null };
      if (L) { L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height); ed.changed(null); } // hide while editing
      ed.stage.append(ta);
      this.place(ed);
      ed.renderOpts();
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
    },
    // keep the textarea glued to the text position / zoom / rotation
    place(ed) {
      const te = ed.textEd;
      if (!te) return;
      const { T, ta } = te;
      const [sx, sy] = ed.toScreen(T.x, T.y);
      Object.assign(ta.style, {
        left: sx + 'px', top: sy + 'px',
        font: `${T.bold ? 700 : 400} ${T.size * ed.z}px ${familyOf(T.font)}`,
        lineHeight: String(LINE), color: T.color,
        transform: `rotate(${ed.rot || 0}rad)`,
      });
      const lines = (ta.value || ' ').split('\n');
      ta.rows = Math.max(1, lines.length);
      ta.style.width = Math.max(T.size * ed.z * 2, ...lines.map(l => measure(l, ta.style.font) + T.size * ed.z)) + 'px';
    },
    update(ed, patch) {
      const te = ed.textEd;
      if (!te) return;
      Object.assign(te.T, patch);
      ensureFont(te.T).then(() => this.place(ed));
      this.place(ed);
    },
    close(ed) {
      const te = ed.textEd;
      ed.textEd = null;
      te.ta.remove();
      ed.renderOpts();
      ed.requestRender();
      return te;
    },
    async commit(ed) {
      const te = ed.textEd;
      if (!te) return;
      te.T.content = te.ta.value.replace(/\s+$/, '');
      this.close(ed);
      await ensureFont(te.T);
      const doc = ed.doc, name = 'T ' + te.T.content.split('\n')[0].slice(0, 14);
      if (!te.L) {
        if (!te.T.content) return;
        ed.struct(() => {
          const L = doc.createLayer(name);
          L.text = te.T;
          render(L);
          doc.layers.splice(doc.layers.indexOf(doc.active) + 1, 0, L);
          doc.active = L;
        });
        return;
      }
      const L = te.L;
      if (!te.T.content) {
        // emptied → remove the text layer
        L.text = te.orig; render(L);
        doc.active = L;
        ed.deleteLayer();
        return;
      }
      L.text = te.orig; render(L); // state before, for history
      ed.struct(() => { L.text = te.T; L.name = name; render(L); });
    },
    cancel(ed) {
      const te = ed.textEd;
      if (!te) return;
      this.close(ed);
      if (te.L) { render(te.L); ed.changed(null); }
    },
    optionsBar(ed) {
      const S = App.settings.text, te = ed.textEd, cur = te ? te.T : S;
      const set = patch => { Object.assign(S, patch); App.saveSettings(); this.update(ed, patch); };
      const sel = h('select', { class: 'field font-sel' }, FONTS.map(([id, label, css]) => h('option', { value: id, selected: cur.font === id, style: { fontFamily: css } }, label)));
      sel.addEventListener('change', () => set({ font: sel.value }));
      const size = h('input', { type: 'range', min: 10, max: 240, step: 1, value: cur.size });
      const sv = h('span', { class: 'sl-val' }, cur.size + 'px');
      size.addEventListener('input', () => { sv.textContent = size.value + 'px'; set({ size: Number(size.value) }); });
      const bold = h('button', { class: 'btn small' + (cur.bold ? ' primary' : ''), onclick: () => { set({ bold: !cur.bold }); ed.renderOpts(); } }, '굵게');
      return [sel, h('label', { class: 'sl' }, h('span', { class: 'sl-label' }, '크기'), size, sv), bold,
        te ? h('button', { class: 'btn small', onclick: () => this.cancel(ed) }, '취소') : null,
        te ? h('button', { class: 'btn small primary', onclick: () => this.commit(ed) }, '확정') : h('span', { class: 'hint' }, '빈 곳을 누르면 새 글상자 · 글상자를 누르면 수정 · 끌면 이동')].filter(Boolean);
    },
  };
  let mctx = null;
  function measure(s, font) {
    mctx = mctx || document.createElement('canvas').getContext('2d');
    mctx.font = font;
    return mctx.measureText(s).width;
  }
})();
