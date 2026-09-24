'use strict';
// Editor side panels: brush settings, color picker, layers.
(() => {
  const U = App.util, h = U.h;
  const ui = App.ui = {};

  // ---------- small controls ----------
  ui.slider = ({ label, min, max, step = 1, get, set, fmt = v => v, onDone }) => {
    const val = h('span', { class: 'sl-val' });
    const inp = h('input', { type: 'range', min, max, step, value: get() });
    const sync = () => { inp.value = get(); val.textContent = fmt(get()); };
    inp.addEventListener('input', () => { set(Number(inp.value)); val.textContent = fmt(get()); });
    inp.addEventListener('change', () => { App.saveSettings(); onDone?.(); });
    sync();
    const el = h('label', { class: 'sl' }, h('span', { class: 'sl-label' }, label), inp, val);
    el.sync = sync;
    return el;
  };
  ui.toggle = ({ label, get, set }) => {
    const inp = h('input', { type: 'checkbox', checked: !!get() });
    inp.addEventListener('change', () => { set(inp.checked); App.saveSettings(); });
    return h('label', { class: 'tg' }, h('span', null, label), inp, h('i'));
  };
  ui.seg = ({ options, get, set }) => {
    const el = h('div', { class: 'seg' });
    const render = () => {
      el.replaceChildren(...options.map(([v, label]) => h('button', {
        class: get() === v ? 'on' : '', onclick: () => { set(v); App.saveSettings(); render(); },
      }, label)));
    };
    render();
    el.sync = render;
    return el;
  };

  // vertical quick slider (size / opacity) – custom so it works the same with mouse, pen and finger
  ui.vslider = ({ label, get, set, toPos, fromPos, fmt }) => {
    const fill = h('div', { class: 'vs-fill' });
    const tip = h('div', { class: 'vs-tip' });
    const el = h('div', { class: 'vs', title: label }, fill, tip);
    const sync = () => { const p = toPos(get()); fill.style.height = (p * 100) + '%'; tip.textContent = fmt(get()); };
    let drag = null;
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, p: toPos(get()) };
      el.classList.add('drag');
    });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      const r = el.getBoundingClientRect();
      const p = U.clamp(drag.p + (drag.y - e.clientY) / r.height, 0, 1);
      set(fromPos(p)); sync();
    });
    const end = () => { if (!drag) return; drag = null; el.classList.remove('drag'); App.saveSettings(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.sync = sync;
    sync();
    return el;
  };

  // ---------- colour ----------
  const hex2rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgb2hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const rgb2hsv = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hh = 0;
    if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(hh * 60 + 360) % 360, mx ? d / mx : 0, mx];
  };
  const hsv2rgb = (hh, s, v) => {
    const f = n => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  };
  ui.hex2rgb = hex2rgb;

  const PALETTE = ['#000000', '#3a3a3a', '#7a7a7a', '#bdbdbd', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41', '#f5d6ba'];

  class ColorPanel {
    constructor(ed) {
      this.ed = ed;
      this.hsv = rgb2hsv(...hex2rgb(ed.color));
      this.sv = h('canvas', { class: 'cp-sv' });
      this.hue = h('canvas', { class: 'cp-hue' });
      this.svDot = h('i', { class: 'cp-dot' });
      this.hueDot = h('i', { class: 'cp-hdot' });
      this.hex = h('input', { class: 'field cp-hex', maxlength: 7, spellcheck: 'false' });
      this.cur = h('div', { class: 'cp-cur' });
      this.recent = h('div', { class: 'swatches' });
      this.el = h('div', { class: 'panel cp' },
        h('div', { class: 'cp-svwrap' }, this.sv, this.svDot),
        h('div', { class: 'cp-huewrap' }, this.hue, this.hueDot),
        h('div', { class: 'cp-row' }, this.cur, this.hex),
        h('div', { class: 'p-sub' }, '최근 색'), this.recent,
        h('div', { class: 'p-sub' }, '팔레트'),
        h('div', { class: 'swatches' }, PALETTE.map(c => this.swatch(c))));
      this.hex.addEventListener('change', () => {
        let v = this.hex.value.trim();
        if (!v.startsWith('#')) v = '#' + v;
        if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map(c => c + c).join('');
        if (/^#[0-9a-f]{6}$/i.test(v)) this.ed.setColor(v.toLowerCase(), true); else this.sync();
      });
      this.drag(this.sv, (x, y) => { this.hsv[1] = x; this.hsv[2] = 1 - y; this.emit(); });
      this.drag(this.hue, x => { this.hsv[0] = x * 359.9; this.emit(); });
      new ResizeObserver(() => this.draw()).observe(this.sv);
    }
    swatch(c) { return h('button', { class: 'sw', style: { background: c }, title: c, onclick: () => this.ed.setColor(c, true) }); }
    drag(cv, fn) {
      let on = false;
      const at = e => { const r = cv.getBoundingClientRect(); fn(U.clamp((e.clientX - r.left) / r.width, 0, 1), U.clamp((e.clientY - r.top) / r.height, 0, 1)); };
      cv.addEventListener('pointerdown', e => { on = true; cv.setPointerCapture(e.pointerId); at(e); });
      cv.addEventListener('pointermove', e => on && at(e));
      const end = () => { if (on) { on = false; this.ed.setColor(this.ed.color, true); } };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
    }
    emit() { this.fromPicker = true; this.ed.setColor(rgb2hex(...hsv2rgb(...this.hsv)), false); this.fromPicker = false; this.draw(); }
    sync() {
      if (!this.fromPicker) {
        const hsv = rgb2hsv(...hex2rgb(this.ed.color));
        if (hsv[1] === 0 || hsv[2] === 0) hsv[0] = this.hsv[0]; // keep hue for greys
        this.hsv = hsv;
      }
      this.hex.value = this.ed.color;
      this.cur.style.background = this.ed.color;
      this.recent.replaceChildren(...App.settings.recentColors.map(c => this.swatch(c)));
      this.draw();
    }
    draw() {
      const dpr = devicePixelRatio || 1;
      for (const cv of [this.sv, this.hue]) {
        const w = Math.round(cv.clientWidth * dpr), hh = Math.round(cv.clientHeight * dpr);
        if (w && (cv.width !== w || cv.height !== hh)) { cv.width = w; cv.height = hh; }
      }
      const W = this.sv.width, H = this.sv.height;
      if (!W) return;
      const c = this.sv.getContext('2d');
      c.fillStyle = rgb2hex(...hsv2rgb(this.hsv[0], 1, 1));
      c.fillRect(0, 0, W, H);
      let g = c.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      const hc = this.hue.getContext('2d'), HW = this.hue.width, HH = this.hue.height;
      g = hc.createLinearGradient(0, 0, HW, 0);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, rgb2hex(...hsv2rgb(i * 60 % 360, 1, 1)));
      hc.fillStyle = g; hc.fillRect(0, 0, HW, HH);
      this.svDot.style.left = (this.hsv[1] * 100) + '%';
      this.svDot.style.top = ((1 - this.hsv[2]) * 100) + '%';
      this.hueDot.style.left = (this.hsv[0] / 360 * 100) + '%';
    }
  }
  ui.ColorPanel = ColorPanel;

  // ---------- brush ----------
  class BrushPanel {
    constructor(ed) { this.ed = ed; this.el = h('div', { class: 'panel bp' }); }
    render() {
      const S = App.settings, ed = this.ed;
      const erase = ed.toolName === 'eraser';
      const key = erase ? 'eraser' : S.currentBrush;
      const B = S.brushes[key];
      const kids = [];
      if (!erase) {
        kids.push(ed.brushChips());
      } else kids.push(h('div', { class: 'p-title' }, '지우개'));
      const pct = v => Math.round(v * 100) + '%';
      const sl = (label, prop, min, max, step, fmt) => ui.slider({ label, min, max, step, get: () => B[prop], set: v => { B[prop] = v; ed.onBrushChanged(); }, fmt });
      kids.push(
        sl('크기', 'size', 1, 400, 1, v => v + 'px'),
        sl('불투명도', 'opacity', 0.05, 1, 0.01, pct),
        sl('흐름', 'flow', 0.02, 1, 0.01, pct),
        sl('경도', 'hardness', 0, 1, 0.01, pct),
        sl('연필 질감', 'grain', 0, 1, 0.01, v => (v < 0.01 ? '없음' : pct(v))),
        sl('손떨림 보정', 'smoothing', 0, 0.95, 0.01, pct),
        sl('간격', 'spacing', 0.01, 0.5, 0.005, v => (v * 100).toFixed(1) + '%'),
        ui.toggle({ label: '필압 → 농도 (약하게 누르면 흐리고 거칠게)', get: () => !!B.pFlow, set: v => { B.pFlow = v; } }),
        ui.slider({ label: '약할 때 농도', min: 0.1, max: 1, step: 0.01, get: () => B.pFlowMin ?? 0.6, set: v => { B.pFlowMin = v; }, fmt: pct }),
        h('div', { class: 'row seg-row' }, h('span', { class: 'sl-label' }, '끝 모양'),
          ui.seg({ options: [['round', '둥글게'], ['square', '각지게']], get: () => B.tip || 'round', set: v => { B.tip = v; } })),
        !erase && h('div', { class: 'row seg-row' }, h('span', { class: 'sl-label' }, '겹칠 때'),
          ui.seg({ options: [['source-over', '덮기'], ['multiply', '형광펜 (글씨 비침)']], get: () => B.blend || 'source-over', set: v => { B.blend = v; } })),
        ui.toggle({ label: '긋다가 멈추고 누르고 있으면 직선으로', get: () => !!B.holdLine, set: v => { B.holdLine = v; } }),
        h('button', { class: 'btn small', onclick: () => {
          const base = App.DEFAULTS.brushes[B.fav ? B.base : key] || App.DEFAULTS.brushes.pencil;
          S.brushes[key] = { ...JSON.parse(JSON.stringify(base)), ...(B.fav ? { name: B.name, fav: true, base: B.base, color: B.color } : {}) };
          App.saveSettings(); this.render(); ed.onBrushChanged();
        } }, B.fav ? '기본 브러시 설정으로 되돌리기' : '이 브러시 초기화'));

      if (!erase) kids.push(h('p', { class: 'hint' }, '테두리는 레이어 속성이에요: 레이어 탭 → 테두리.'));

      // pressure
      const P = S.pressure;
      const curve = h('canvas', { class: 'pcurve', width: 240, height: 120 });
      const drawCurve = () => {
        const c = curve.getContext('2d'), W = curve.width, H = curve.height;
        c.clearRect(0, 0, W, H);
        c.strokeStyle = 'rgba(128,128,128,.35)'; c.lineWidth = 1;
        for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(i * W / 4, 0); c.lineTo(i * W / 4, H); c.moveTo(0, i * H / 4); c.lineTo(W, i * H / 4); c.stroke(); }
        c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#2f7cf6';
        c.lineWidth = 2.5; c.beginPath();
        for (let i = 0; i <= 60; i++) {
          const x = i / 60, y = U.lerp(P.size ? P.minSize : 1, 1, Math.pow(x, P.gamma));
          i ? c.lineTo(x * W, H - y * H) : c.moveTo(x * W, H - y * H);
        }
        c.stroke();
      };
      const onP = () => { drawCurve(); App.saveSettings(); };
      // pressure test pad: shows what the browser actually receives from the pen
      const pad = h('canvas', { class: 'ppad' });
      const padInfo = h('div', { class: 'ppad-info' }, '여기에 펜으로 그어보세요');
      let padLast = null;
      const padDraw = e => {
        const r = pad.getBoundingClientRect(), dpr = devicePixelRatio || 1;
        if (pad.width !== Math.round(r.width * dpr)) { pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr); }
        const c = pad.getContext('2d');
        const raw = e.pressure;
        const isPen = e.pointerType === 'pen' || (e.pointerType === 'mouse' && raw > 0 && raw !== 0.5);
        const pr = isPen ? Math.pow(U.clamp(raw, 0, 1), P.gamma) : 1;
        const size = (P.size ? U.lerp(P.minSize, 1, pr) : 1) * 14 * dpr;
        const x = (e.clientX - r.left) * dpr, y = (e.clientY - r.top) * dpr;
        c.lineCap = 'round';
        c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text');
        c.lineWidth = size;
        c.beginPath(); c.moveTo(padLast ? padLast[0] : x, padLast ? padLast[1] : y); c.lineTo(x, y); c.stroke();
        padLast = [x, y];
        const kind = { pen: '펜', mouse: '마우스', touch: '손가락' }[e.pointerType] || e.pointerType;
        padInfo.textContent = `입력: ${kind} · 필압 ${raw.toFixed(2)}` +
          (e.pointerType === 'mouse' && raw === 0.5 ? ' → 필압 정보가 안 들어와요 (Windows Ink 확인)' : isPen ? ' ✓ 필압 인식됨' : '');
      };
      pad.addEventListener('pointerdown', e => { pad.setPointerCapture(e.pointerId); padLast = null; padDraw(e); });
      pad.addEventListener('pointermove', e => { if (e.buttons) padDraw(e); });
      pad.addEventListener('dblclick', () => pad.getContext('2d').clearRect(0, 0, pad.width, pad.height));
      kids.push(
        h('div', { class: 'p-title' }, '필압'),
        h('div', { class: 'pcurve-wrap' }, curve, h('small', null, '가로: 누르는 힘 · 세로: 굵기')),
        h('div', { class: 'ppad-wrap' }, pad, padInfo),
        ui.toggle({ label: '필압 → 크기', get: () => P.size, set: v => { P.size = v; onP(); } }),
        ui.slider({ label: '최소 크기', min: 0.05, max: 1, step: 0.01, get: () => P.minSize, set: v => { P.minSize = v; drawCurve(); }, fmt: pct }),
        ui.slider({ label: '곡선', min: 0.3, max: 3, step: 0.05, get: () => P.gamma, set: v => { P.gamma = v; drawCurve(); }, fmt: v => (v < 0.95 ? '부드럽게 ' : v > 1.05 ? '단단하게 ' : '보통 ') + v.toFixed(2) }),
        ui.toggle({ label: '필압 → 불투명도', get: () => P.opacity, set: v => { P.opacity = v; onP(); } }),
        ui.slider({ label: '최소 불투명도', min: 0, max: 1, step: 0.01, get: () => P.minOpacity, set: v => { P.minOpacity = v; }, fmt: pct }),
        h('p', { class: 'hint' }, '필압은 펜(S펜·와콤 등)에서만 적용돼요. 마우스·손가락은 항상 최대 굵기로 그려집니다.'));
      this.el.replaceChildren(...kids.filter(Boolean));
      drawCurve();
    }
  }
  ui.BrushPanel = BrushPanel;

  // ---------- layers ----------
  class LayersPanel {
    constructor(ed) {
      this.ed = ed;
      this.list = h('div', { class: 'ly-list' });
      this.props = h('div', { class: 'ly-props' });
      this.thumbs = new WeakMap();
      const b = (icon, title, fn) => U.iconBtn(icon, title, fn);
      this.el = h('div', { class: 'panel lp' },
        h('div', { class: 'ly-actions' },
          b('plus', '새 레이어', () => ed.addLayer()),
          b('copy', '레이어 복제', () => ed.duplicateLayer()),
          b('merge', '아래 레이어와 병합', () => ed.mergeDown()),
          b('up', '위로', () => ed.moveLayer(1)),
          b('down', '아래로', () => ed.moveLayer(-1)),
          b('trash', '레이어 삭제', () => ed.deleteLayer())),
        this.props,
        this.list);
      this.bindDrag();
    }
    // drag rows to reorder: mouse/pen drag anywhere on a row, finger drags the grip (≡) or long-presses a row
    bindDrag() {
      const list = this.list;
      let d = null;
      const rows = () => [...list.querySelectorAll('.ly')];
      const begin = () => {
        d.started = true;
        const rs = rows();
        d.rects = rs.map(r => r.getBoundingClientRect());
        d.from = rs.indexOf(d.row);
        d.rowH = d.rects[d.from].height + 3;
        d.row.classList.add('dragging');
        list.classList.add('sorting');
        try { list.setPointerCapture(d.id); } catch { /* ignore */ }
        if (d.touch) try { navigator.vibrate?.(15); } catch { /* ignore */ }
      };
      const cancelTimer = () => { if (d && d.timer) { clearTimeout(d.timer); d.timer = 0; } };
      list.addEventListener('pointerdown', e => {
        const row = e.target.closest('.ly');
        if (!row || e.target.closest('.ly-eye') || e.button > 0) return;
        const grip = !!e.target.closest('.ly-grip');
        d = { row, id: e.pointerId, y0: e.clientY, x0: e.clientX, started: false, touch: e.pointerType === 'touch', grip };
        if (d.touch && grip) { e.preventDefault(); begin(); }
        else if (d.touch) d.timer = setTimeout(() => { if (d && !d.started) begin(); }, 380);
      });
      list.addEventListener('pointermove', e => {
        if (!d || e.pointerId !== d.id) return;
        const dy = e.clientY - d.y0;
        if (!d.started) {
          if (d.touch) { if (Math.hypot(dy, e.clientX - d.x0) > 8) { cancelTimer(); d = null; } return; }
          if (Math.abs(dy) < 5) return;
          begin();
        }
        d.row.style.transform = `translateY(${dy}px)`;
        const c = d.rects[d.from].top + d.rects[d.from].height / 2 + dy;
        let to = 0;
        d.rects.forEach((r, i) => { if (i !== d.from && r.top + r.height / 2 < c) to++; });
        d.to = to;
        rows().forEach((r, i) => {
          if (i === d.from) return;
          let s = 0;
          if (d.from < to && i > d.from && i <= to) s = -d.rowH;
          if (d.from > to && i >= to && i < d.from) s = d.rowH;
          r.style.transform = s ? `translateY(${s}px)` : '';
        });
      });
      const end = e => {
        if (!d || e.pointerId !== d.id) return;
        cancelTimer();
        const s = d; d = null;
        if (!s.started) return;
        list.classList.remove('sorting');
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 50);
        const n = this.ed.doc.layers.length;
        const L = this.ed.doc.layers[n - 1 - s.from];
        if (s.to != null && s.to !== s.from) this.ed.reorderLayer(L, n - 1 - s.to);
        else this.render();
      };
      list.addEventListener('pointerup', end);
      list.addEventListener('pointercancel', end);
      // stop the panel from scrolling while a row is being dragged with a finger
      list.addEventListener('touchmove', e => { if (d && d.started) e.preventDefault(); }, { passive: false });
      list.addEventListener('contextmenu', e => { if (e.target.closest('.ly')) e.preventDefault(); });
    }
    thumb(L) {
      let t = this.thumbs.get(L);
      if (!t) { t = { c: h('canvas', { class: 'ly-thumb', width: 48, height: 48 }), rev: -1 }; this.thumbs.set(L, t); }
      if (t.rev !== L.rev) {
        const doc = this.ed.doc, c = t.c.getContext('2d');
        const s = Math.min(48 / doc.w, 48 / doc.h), w = doc.w * s, hh = doc.h * s;
        c.clearRect(0, 0, 48, 48);
        c.drawImage(L.canvas, (48 - w) / 2, (48 - hh) / 2, w, hh);
        t.rev = L.rev;
      }
      return t.c;
    }
    render() {
      const ed = this.ed, doc = ed.doc;
      if (!doc) return;
      const A = doc.active;
      this.list.replaceChildren(...doc.layers.slice().reverse().map(L => {
        const row = h('div', { class: 'ly' + (L === A ? ' on' : '') + (L.visible ? '' : ' hidden') },
          h('button', { class: 'ib ly-eye', title: '보이기/숨기기', html: App.icon(L.visible ? 'eye' : 'eyeOff'), onclick: e => { e.stopPropagation(); ed.setLayerProp(L, 'visible', !L.visible, true); } }),
          this.thumb(L),
          h('div', { class: 'ly-name' }, h('b', null, L.name),
            h('small', null, `${Math.round(L.opacity * 100)}% · ${(App.BLENDS.find(b => b[0] === L.blend) || [0, '표준'])[1]}${L.alphaLock ? ' · 🔒' : ''}${L.border && L.border.on ? ' · 테두리' : ''}`)),
          h('span', { class: 'ly-grip', title: '끌어서 순서 바꾸기', html: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg>' }));
        row.addEventListener('click', () => { if (!this.suppressClick) ed.selectLayer(L); });
        row.addEventListener('dblclick', () => ed.renameLayer(L));
        return row;
      }));
      // properties of the active layer
      const blend = h('select', { class: 'field' }, App.BLENDS.map(([v, n]) => h('option', { value: v, selected: v === A.blend }, n)));
      blend.addEventListener('change', () => ed.setLayerProp(A, 'blend', blend.value, true));
      const op = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(A.opacity * 100) });
      const opv = h('span', { class: 'sl-val' }, Math.round(A.opacity * 100) + '%');
      op.addEventListener('input', () => { ed.setLayerProp(A, 'opacity', op.value / 100, false); opv.textContent = op.value + '%'; });
      op.addEventListener('change', () => ed.setLayerProp(A, 'opacity', op.value / 100, true));
      const lock = h('input', { type: 'checkbox', checked: A.alphaLock });
      lock.addEventListener('change', () => ed.setLayerProp(A, 'alphaLock', lock.checked, true));
      this.props.replaceChildren(
        h('label', { class: 'sl' }, h('span', { class: 'sl-label' }, '불투명도'), op, opv),
        h('div', { class: 'ly-row2' },
          h('label', { class: 'ly-blend' }, h('span', null, '합성'), blend),
          h('label', { class: 'tg compact', title: '투명 픽셀 잠금: 이미 칠해진 부분에만 그려집니다' }, h('span', null, '투명 잠금'), lock, h('i'))),
        this.borderUI(A),
        h('div', { class: 'ly-row2' },
          h('button', { class: 'btn small', onclick: () => ed.renameLayer(A) }, '이름 변경'),
          h('button', { class: 'btn small', onclick: () => ed.clearLayer() }, '레이어 비우기')));
    }
    // layer border (경계 효과): outline around everything drawn on the layer
    borderUI(A) {
      const ed = this.ed, Bd = A.border;
      const set = (patch, commit) => ed.setLayerProp(A, 'border', { ...A.border, ...patch }, commit);
      const on = h('input', { type: 'checkbox', checked: Bd.on });
      on.addEventListener('change', () => set({ on: on.checked }, true));
      const col = h('input', { type: 'color', value: Bd.color, class: 'ol-color' });
      col.addEventListener('input', () => set({ color: col.value }, false));
      col.addEventListener('change', () => set({ color: col.value }, true));
      const range = (label, prop, min, max, step, fmt) => {
        const inp = h('input', { type: 'range', min, max, step, value: Bd[prop] });
        const val = h('span', { class: 'sl-val' }, fmt(Bd[prop]));
        inp.addEventListener('input', () => { set({ [prop]: Number(inp.value) }, false); val.textContent = fmt(Number(inp.value)); });
        inp.addEventListener('change', () => set({ [prop]: Number(inp.value) }, true));
        return h('label', { class: 'sl' }, h('span', { class: 'sl-label' }, label), inp, val);
      };
      return h('div', { class: 'ly-border' },
        h('label', { class: 'tg compact' }, h('span', null, '테두리 (경계 효과)'), on, h('i')),
        Bd.on && h('div', null,
          h('div', { class: 'row ol-row' }, h('span', { class: 'sl-label' }, '색'), col,
            ...['#ffffff', '#000000', '#fff6c8'].map(c => h('button', { class: 'sw ol-sw', style: { background: c }, title: c, onclick: () => set({ color: c }, true) }))),
          range('굵기', 'width', 1, 40, 1, v => v + 'px'),
          range('매끈함', 'smooth', 0, 1, 0.05, v => (v > 0.95 ? '매끈' : v < 0.05 ? '거칠게' : Math.round(v * 100) + '%'))));
    }
  }
  ui.LayersPanel = LayersPanel;
})();
