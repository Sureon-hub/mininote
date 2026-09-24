'use strict';
// Editor screen: viewport, input (mouse / pen / touch gestures), tool switching, layer ops, save & page navigation.
(() => {
  const U = App.util, h = U.h, T = App.tools, H = App.History;

  const TOOLS = [
    ['brush', 'brush', '브러시 (B)'],
    ['eraser', 'eraser', '지우개 (E)'],
    ['fill', 'fill', '채우기 (G)'],
    ['select', 'select', '사각 선택 (M)'],
    ['lasso', 'lasso', '올가미 선택 (L)'],
    ['transform', 'transform', '변형·이동 (V)'],
    ['picker', 'picker', '스포이트 (I / Alt)'],
    ['text', 'text', '텍스트 (T)'],
    ['hand', 'hand', '손 도구 (H / Space)'],
  ];
  // snap an angle (radians) to the nearest multiple of 90° when within `deg` degrees; result in (-π, π]
  const snapAngle = (a, deg) => {
    a = Math.atan2(Math.sin(a), Math.cos(a));
    const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    return Math.abs(a - q) < deg * Math.PI / 180 ? Math.atan2(Math.sin(q), Math.cos(q)) : a;
  };
  const sizeToPos = s => Math.pow((s - 1) / 399, 1 / 2.2);
  const posToSize = p => Math.max(1, Math.round(1 + 399 * Math.pow(p, 2.2)));

  class Editor {
    init() {
      this.root = U.$('#editor');
      this.stage = U.$('#e-stage');
      this.canvas = U.$('#e-canvas');
      this.vctx = this.canvas.getContext('2d');
      this.doc = null; this.ctx = null;
      this.z = 1; this.fitZ = 1; this.ox = 0; this.oy = 0;
      this.dpr = devicePixelRatio || 1;
      this.history = new H(e => this.onHistory(e));
      this.tools = {
        brush: new T.BrushTool(this, false), eraser: new T.BrushTool(this, true), fill: new T.FillTool(this),
        select: new T.SelectTool(this, 'rect'), lasso: new T.SelectTool(this, 'lasso'),
        transform: new T.TransformTool(this), picker: new T.PickerTool(this), hand: new T.HandTool(this), text: new T.TextTool(this),
      };
      this.toolName = 'brush';
      this.color = App.settings.color;
      this.pointers = new Map();
      this.action = null; this.gesture = null;
      this.penSeen = false;
      this.ants = 0;
      this.list = []; this.idx = -1;
      this.cache = new Map();        // entry -> Promise<{doc, ctx}> preloaded neighbours
      this.pendingSaves = new Map(); // entry -> Promise of a background save
      this.pBrush = new App.ui.BrushPanel(this);
      this.pColor = new App.ui.ColorPanel(this);
      this.pLayers = new App.ui.LayersPanel(this);
      this.buildUI();
      this.bindInput();
      new ResizeObserver(() => this.resize()).observe(this.stage);
      matchMedia('(min-width: 900px)').addEventListener('change', () => this.layoutDock());
      setInterval(() => { if (this.visible && this.doc?.selection) { this.ants = (this.ants + 1) % 8; this.requestRender(); } }, 140);
      this.refreshLayersSoon = U.debounce(() => this.pLayers.render(), 120);
    }
    get visible() { return !this.root.hidden; }
    isWide() { return matchMedia('(min-width: 900px)').matches; }

    // ================= UI =================
    buildUI() {
      const bar = U.$('#e-bar');
      this.nameEl = h('div', { class: 'e-title' });
      this.btnUndo = U.iconBtn('undo', '실행 취소 (Ctrl+Z · 두 손가락 탭)', () => this.undo());
      this.btnRedo = U.iconBtn('redo', '다시 실행 (Ctrl+Y · 세 손가락 탭)', () => this.redo());
      this.btnSave = U.iconBtn('save', '저장 (Ctrl+S) — 원본 이미지 + 편집파일', () => this.save(), 'accent');
      this.btnPrev = U.iconBtn('left', '이전 노트 (←)', () => this.navigate(-1));
      this.btnNext = U.iconBtn('right', '다음 노트 (→)', () => this.navigate(1));
      bar.replaceChildren(
        U.iconBtn('back', '갤러리로', () => this.close()),
        this.nameEl, h('div', { class: 'grow' }),
        this.btnPrev, this.btnNext, h('span', { class: 'sep' }),
        this.btnUndo, this.btnRedo, this.btnSave,
        U.iconBtn('image', '이미지 넣기 (사진·카메라·파일 → 새 레이어)', () => this.pickImage()),
        U.iconBtn('layers', '레이어', () => this.toggleTab('layers')),
        U.iconBtn('more', '더보기', e => this.moreMenu(e.currentTarget)));

      // tool rail
      const rail = U.$('#e-tools');
      this.toolBtns = {};
      for (const [name, icon, title] of TOOLS) {
        const b = U.iconBtn(icon, title, () => {
          if (this.toolName === name && (name === 'brush' || name === 'eraser')) this.toggleTab('brush');
          else this.setTool(name);
        }, name === 'hand' ? 'tool wide-only' : 'tool'); // phones pan with two fingers
        this.toolBtns[name] = b;
        rail.append(b);
      }
      this.swatch = h('button', { class: 'swatch-btn', title: '색상', onclick: () => this.toggleTab('color') });
      rail.append(h('span', { class: 'rail-sep' }), this.swatch,
        U.iconBtn('edit', '브러시 설정', () => this.toggleTab('brush'), 'tool narrow-only'));

      // dock
      this.dock = U.$('#e-dock');
      this.dockBody = U.$('#e-dock-body');
      this.dockTabs = U.$$('#e-dock .dock-tabs button');
      for (const b of this.dockTabs) b.addEventListener('click', () => this.showTab(b.dataset.tab));
      U.$('#e-dock-close').addEventListener('click', () => { if (this.isWide()) App.settings.dockOpen = false; else this.sheetOpen = false; App.saveSettings(); this.layoutDock(); });

      // quick sliders
      const q = U.$('#e-quick');
      this.qSize = App.ui.vslider({ label: '브러시 크기', get: () => this.preset().size, set: v => { this.preset().size = v; this.onBrushChanged(true); }, toPos: sizeToPos, fromPos: posToSize, fmt: v => v + '' });
      this.qOpacity = App.ui.vslider({ label: '불투명도', get: () => this.preset().opacity, set: v => { this.preset().opacity = v; this.onBrushChanged(true); }, toPos: v => v, fromPos: p => Math.max(0.02, Math.round(p * 100) / 100), fmt: v => Math.round(v * 100) + '%' });
      q.append(this.qSize, this.qOpacity);

      this.opts = U.$('#e-opts');
      this.ctxbar = U.$('#e-ctxbar');
      this.loadingEl = U.$('#e-loading');
      this.setTool('brush');
      this.showTab(App.settings.dockTab || 'layers', false);
      this.layoutDock();
      this.updateSwatch();
    }
    preset() { const S = App.settings; return this.toolName === 'eraser' ? S.brushes.eraser : S.brushes[S.currentBrush]; }

    showTab(tab, open = true) {
      App.settings.dockTab = tab;
      for (const b of this.dockTabs) b.classList.toggle('on', b.dataset.tab === tab);
      const p = { brush: this.pBrush, color: this.pColor, layers: this.pLayers }[tab];
      this.dockBody.replaceChildren(p.el);
      if (tab === 'brush') this.pBrush.render();
      if (tab === 'color') this.pColor.sync();
      if (tab === 'layers') this.pLayers.render();
      if (open) { if (this.isWide()) App.settings.dockOpen = true; else this.sheetOpen = true; }
      App.saveSettings();
      this.layoutDock();
    }
    toggleTab(tab) {
      const open = this.isWide() ? App.settings.dockOpen : this.sheetOpen;
      if (open && App.settings.dockTab === tab) {
        if (this.isWide()) App.settings.dockOpen = false; else this.sheetOpen = false;
        App.saveSettings();
        this.layoutDock();
      } else this.showTab(tab);
    }
    layoutDock() {
      const open = this.isWide() ? App.settings.dockOpen : this.sheetOpen;
      this.root.classList.toggle('dock-open', !!open);
    }

    setTool(name) {
      if (this.textEd && name !== 'text') App.text.commit(this);
      if (this.toolName === 'transform' && name !== 'transform') this.tools.transform.commit();
      const prev = this.toolName;
      this.toolName = name;
      for (const [n, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', n === name);
      this.canvas.style.cursor = this.tools[name].cursor;
      U.$('#e-quick').hidden = !(name === 'brush' || name === 'eraser');
      this.qSize.sync(); this.qOpacity.sync();
      if (App.settings.dockTab === 'brush') this.pBrush.render();
      this.renderOpts();
      if (name === 'transform' && prev !== 'transform' && this.doc) this.tools.transform.activate();
      this.requestRender();
    }
    onBrushChanged(fromQuick) {
      if (!fromQuick) { this.qSize.sync(); this.qOpacity.sync(); }
      else if (App.settings.dockTab === 'brush' && this.dockBody.contains(this.pBrush.el)) U.$$('.sl', this.pBrush.el).forEach(s => s.sync && s.sync());
      this.renderOpts();
      this.requestRender();
    }

    renderOpts() {
      const S = App.settings, name = this.toolName, o = [];
      if (name === 'brush') {
        o.push(this.brushChips());
      } else if (name === 'text') {
        o.push(...App.text.optionsBar(this));
      } else if (name === 'fill') {
        o.push(App.ui.slider({ label: '허용치', min: 0, max: 128, step: 1, get: () => S.fill.tolerance, set: v => { S.fill.tolerance = v; } }),
          App.ui.seg({ options: [['layer', '현재 레이어'], ['all', '모든 레이어']], get: () => S.fill.sample, set: v => { S.fill.sample = v; } }),
          App.ui.slider({ label: '확장', min: 0, max: 4, step: 1, get: () => S.fill.expand, set: v => { S.fill.expand = v; }, fmt: v => v + 'px' }));
      } else if (name === 'select' || name === 'lasso') {
        o.push(App.ui.seg({ options: [['new', '새로'], ['add', '추가'], ['sub', '빼기']], get: () => S.selMode, set: v => { S.selMode = v; } }),
          h('button', { class: 'btn small', onclick: () => this.selectAll() }, '전체 선택'));
      } else if (name === 'transform') {
        const t = this.tools.transform;
        if (t.active) {
          o.push(App.ui.toggle({ label: '비율 고정', get: () => S.transformKeepRatio, set: v => { S.transformKeepRatio = v; } }),
            U.iconBtn('flipH', '좌우 반전', () => t.flip('h')),
            U.iconBtn('flipV', '상하 반전', () => t.flip('v')),
            h('button', { class: 'btn small', onclick: () => { t.revert(); } }, '취소'),
            h('button', { class: 'btn small primary', onclick: () => { t.commit(); } }, '확정'));
        } else o.push(h('span', { class: 'hint' }, '레이어(또는 선택 영역)를 드래그해 이동 · 모서리로 크기 · 바깥쪽 드래그로 회전'));
      }
      this.opts.replaceChildren(...o);
      this.opts.hidden = !o.length;
      this.renderCtxbar();
    }
    // brushes / favourites arrived from another device
    onSettingsSynced() {
      this.renderOpts();
      this.qSize.sync(); this.qOpacity.sync();
      if (this.dockBody.contains(this.pBrush.el)) this.pBrush.render();
      if (this.dockBody.contains(this.pColor.el)) this.pColor.sync();
    }
    // ---------- brushes & favourites ----------
    // built-in brushes first, then saved favourites (each favourite is a full brush preset + colour)
    brushKeys() {
      const S = App.settings;
      return ['pencil', 'pen', 'marker', ...(S.favOrder || []).filter(k => S.brushes[k])];
    }
    selectBrush(k) {
      const S = App.settings, B = S.brushes[k];
      if (!B) return;
      S.currentBrush = k;
      if (B.fav && B.color) this.setColor(B.color, false);
      App.saveSettings();
      if (this.toolName !== 'brush') this.setTool('brush');
      else this.onBrushChanged();
      if (this.dockBody.contains(this.pBrush.el)) this.pBrush.render();
    }
    brushChips() {
      const S = App.settings;
      const chips = this.brushKeys().map((k, i) => {
        const B = S.brushes[k];
        const b = h('button', { class: 'chip' + (S.currentBrush === k ? ' on' : '') + (B.fav ? ' fav' : ''), title: `${B.name}${i < 9 ? ` (${i + 1})` : ''}`, onclick: () => { if (!b.longPressed) this.selectBrush(k); } },
          B.fav && B.color ? h('i', { class: 'chip-dot', style: { background: B.color } }) : null, B.name);
        if (B.fav) {
          let t = 0;
          b.addEventListener('pointerdown', e => { b.longPressed = false; t = setTimeout(() => { b.longPressed = true; this.favMenu(k, e.clientX, e.clientY); }, 500); });
          ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(t)));
          b.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(t); this.favMenu(k, e.clientX, e.clientY); });
        }
        return b;
      });
      chips.push(h('button', { class: 'chip add', title: '지금 브러시 설정과 색을 즐겨찾기로 저장', onclick: () => this.addFavorite() }, '＋ 즐겨찾기'));
      return h('div', { class: 'chips brush-chips' }, chips);
    }
    async addFavorite() {
      const S = App.settings, cur = S.brushes[S.currentBrush];
      const name = await U.dialog({
        title: '브러시 즐겨찾기 추가', body: '지금 브러시 설정(크기·질감·필압 등)과 색이 함께 저장돼요.',
        input: { value: `${cur.fav ? cur.name : cur.name + ' '}${cur.fav ? ' 2' : (S.favOrder || []).length + 1}` },
        buttons: [{ label: '취소', value: null }, { label: '저장', value: true, primary: true }],
      });
      if (!name || !name.trim()) return;
      const k = 'fav_' + U.uid();
      S.brushes[k] = { ...JSON.parse(JSON.stringify(cur)), name: name.trim(), fav: true, base: cur.base || S.currentBrush, color: this.color };
      S.favOrder = [...(S.favOrder || []), k];
      this.selectBrush(k);
      U.toast(`"${name.trim()}" 즐겨찾기에 추가했어요 (길게 누르면 편집)`);
    }
    async favMenu(k, x, y) {
      const S = App.settings, B = S.brushes[k];
      const v = await U.menu([
        { label: B.name, value: null }, '-',
        { label: '이름 바꾸기', value: 'rename' },
        { label: '지금 색으로 바꾸기', value: 'color' },
        { label: '앞으로 옮기기', value: 'left' },
        { label: '뒤로 옮기기', value: 'right' },
        { label: '삭제', value: 'del', danger: true },
      ], x, y);
      const order = S.favOrder || [], i = order.indexOf(k);
      if (v === 'rename') {
        const n = await U.dialog({ title: '이름 바꾸기', input: { value: B.name }, buttons: [{ label: '취소', value: null }, { label: '확인', value: true, primary: true }] });
        if (n && n.trim()) B.name = n.trim();
      } else if (v === 'color') B.color = this.color;
      else if ((v === 'left' && i > 0) || (v === 'right' && i < order.length - 1)) {
        const j = v === 'left' ? i - 1 : i + 1;
        [order[i], order[j]] = [order[j], order[i]];
      } else if (v === 'del') {
        S.favOrder = order.filter(x2 => x2 !== k);
        delete S.brushes[k];
        if (S.currentBrush === k) S.currentBrush = 'pencil';
      } else return;
      App.saveSettings();
      this.onBrushChanged();
      if (this.dockBody.contains(this.pBrush.el)) this.pBrush.render();
    }
    renderCtxbar() {
      const sel = this.doc?.selection;
      const show = sel && this.toolName !== 'transform';
      this.ctxbar.hidden = !show;
      if (!show) return;
      this.ctxbar.replaceChildren(
        h('button', { class: 'btn small', onclick: () => this.setSelection(null) }, '선택 해제'),
        h('button', { class: 'btn small', onclick: () => this.invertSelection() }, '반전'),
        h('button', { class: 'btn small', onclick: () => this.clearLayer() }, '지우기'),
        h('button', { class: 'btn small', onclick: () => this.copyToNewLayer() }, '새 레이어로 복사'),
        h('button', { class: 'btn small primary', onclick: () => this.setTool('transform') }, '변형'));
    }
    updateSwatch() { this.swatch.style.background = this.color; }
    updateTitle() {
      if (!this.ctx) return;
      const total = this.list.length;
      this.nameEl.replaceChildren(...[
        h('span', { class: 'e-name' }, this.ctx.name),
        this.dirty && h('i', { class: 'dirty', title: '저장 안 됨' }),
        h('small', null, this.idx >= 0 ? ` ${this.idx + 1}/${total}` : ' 새 노트')].filter(Boolean));
      this.btnPrev.disabled = this.idx <= 0;
      this.btnNext.disabled = this.idx >= total - 1;
    }
    async moreMenu(btn) {
      const v = await U.menuAt(btn, [
        { label: '화면에 맞추기 (Ctrl+0)', value: 'fit' },
        { label: '실제 크기 (100%)', value: '100' },
        '-',
        { label: '이미지 다운로드 (PNG)', value: 'export' },
        { label: '편집파일 다운로드 (.mnote)', value: 'exportProj' },
        { label: `캔버스 정보 (${this.doc ? this.doc.w + '×' + this.doc.h : ''})`, value: 'info' },
        this.ctx && this.ctx.image && { label: '이미지가 있는 폴더 열기', value: 'folder' },
        '-',
        { label: '설정', value: 'settings' },
      ]);
      if (v === 'folder') App.openFolderOf(this.ctx.image);
      else if (v === 'fit') this.fit();
      else if (v === '100') this.zoomAt(this.stage.clientWidth / 2, this.stage.clientHeight / 2, 1 / this.z);
      else if (v === 'export') U.download(await U.canvasToBlob(this.doc.flatten()), U.baseName(this.ctx.name) + '.png');
      else if (v === 'exportProj') U.download(await App.project.encode(this.doc, { name: this.ctx.name }), this.ctx.name + App.project.EXT);
      else if (v === 'info') {
        const rel = this.ctx.image && App.library.relOf(this.ctx.image);
        U.dialog({ title: '캔버스 정보', body: `${this.ctx.name}\n${this.doc.w} × ${this.doc.h}px · 레이어 ${this.doc.layers.length}개\n원본 위치: ${rel ? rel.join(' / ') : this.ctx.dir.name}` });
      }
      else if (v === 'settings') App.openSettings();
    }
    showLoading(on, entry) {
      this.loadingEl.hidden = !on;
      if (!on) { this.loadingEl.replaceChildren(); return; }
      const url = entry && App.gallery?.thumbUrl(entry);
      this.loadingEl.replaceChildren(url ? h('img', { src: url }) : '', h('div', { class: 'spinner' }));
    }

    // ================= document lifecycle =================
    async open(list, idx, opts = {}) {
      this.fromViewer = !!opts.fromViewer; // back returns to the viewer
      this.list = list; this.idx = idx;
      App.show('editor');
      await this.loadIndex(idx);
    }
    openNew() {
      if (!App.library.backend) return;
      this.list = App.library.visible(); this.idx = -1;
      App.show('editor');
      const { doc, ctx } = App.library.newDoc();
      this.setDoc(doc, ctx, false);
    }
    async loadIndex(i) {
      const entry = this.list[i];
      if (!entry) return;
      this.loading = true;
      this.nameEl.textContent = entry.name;
      // only show the loading overlay if it isn't instant (preloaded notes appear immediately)
      const lt = setTimeout(() => { this.doc = null; this.requestRender(); this.showLoading(true, entry); }, 90);
      try {
        const r = await this.fetchDoc(entry);
        if (this.list[this.idx] !== entry) return;
        this.setDoc(r.doc, r.ctx, r.dirty);
        setTimeout(() => this.preloadAround(), 60);
      } catch (e) {
        if ((await App.handleError(e, '열기 실패')) === 'retry') return this.loadIndex(i);
      } finally {
        clearTimeout(lt);
        this.loading = false;
        this.showLoading(false);
      }
    }
    // ---- speed: neighbours are loaded ahead, saves run in the background ----
    async fetchDoc(entry) {
      const c = this.cache.get(entry);
      this.cache.delete(entry);
      if (c) { const v = await c; if (v) return v; }
      await this.pendingSaves.get(entry);
      return App.library.open(entry);
    }
    preloadAround() {
      if (this.idx < 0 || !this.doc) return;
      const want = new Set([this.list[this.idx - 1], this.list[this.idx + 1]].filter(Boolean));
      for (const e of [...this.cache.keys()]) if (!want.has(e)) this.cache.delete(e);
      for (const e of want) {
        if (this.cache.has(e)) continue;
        this.cache.set(e, (async () => {
          await this.pendingSaves.get(e);
          return App.library.open(e, { quiet: true });
        })().catch(() => null));
      }
    }
    // save the note being left without making the user wait; a failure brings up a retry dialog
    saveInBackground() {
      const doc = this.doc, ctx = this.ctx, entry = (this.idx >= 0 && this.list[this.idx]) || ctx.image; // list item (may be an "편집한 노트" wrapper)
      this.dirty = false;
      const run = async () => {
        try {
          await App.library.save(doc, ctx);
          App.gallery.refreshEntry(ctx.image);
          if (entry !== ctx.image) App.gallery.refreshEntry(entry);
        } catch (e) {
          const r = await App.handleError(e, `"${ctx.name}" 저장 실패`);
          if (r === 'retry') return run();
          const again = await U.dialog({ title: '저장하지 못했어요', body: `"${ctx.name}"의 변경 내용이 아직 저장되지 않았어요.`, buttons: [{ label: '버리기', value: false, danger: true }, { label: '다시 시도', value: true, primary: true }] });
          if (again) return run();
        }
      };
      const p = run().finally(() => { if (this.pendingSaves.get(entry) === p) this.pendingSaves.delete(entry); });
      this.pendingSaves.set(entry, p);
      this.cache.delete(entry);
    }
    setDoc(doc, ctx, dirty) {
      if (this.textEd) App.text.cancel(this);
      this.action = null; this.gesture = null; this.pointers.clear();
      this.tools.transform.f = null;
      this.doc = doc; this.ctx = ctx;
      this.bufs = null;
      this.history.clear();
      this.dirty = !!dirty;
      doc.renderComposite(null);
      this.resize(true);
      this.updateTitle();
      this.pLayers.render();
      this.renderOpts();
      if (this.toolName === 'transform') this.setTool('brush');
      if (doc.w * doc.h > 25e6) U.toast('큰 이미지라 느릴 수 있어요');
    }
    // stroke work buffers (kind: 'main' | 'outline'), reallocated when the document size changes
    buffers(kind = 'main') {
      const d = this.doc;
      if (!this.bufs || this.bufs.w !== d.w || this.bufs.h !== d.h) this.bufs = { w: d.w, h: d.h };
      if (!this.bufs[kind]) {
        const stroke = U.canvas(d.w, d.h), masked = U.canvas(d.w, d.h);
        this.bufs[kind] = { stroke, masked, strokeCtx: stroke.getContext('2d', { willReadFrequently: true }), maskedCtx: masked.getContext('2d') };
      }
      return this.bufs[kind];
    }
    // brush strokes are pushed through grain/selection once per animation frame, not per pointer event
    scheduleFlush(stroke) { this.pendingFlush = stroke; this.requestRender(); }
    async leaveGuard(background) {
      if (!this.doc) return true;
      if (this.textEd) await App.text.commit(this);
      if (this.action) this.cancelAction(true);
      this.tools.transform.commit();
      if (!this.dirty) return true;
      if (App.settings.autosave) {
        // existing notes save in the background; brand-new notes are saved first (they join the list)
        if (background && this.ctx.image) { this.saveInBackground(); return true; }
        return this.save();
      }
      const r = await U.dialog({
        title: '저장할까요?', body: '변경 내용이 아직 저장되지 않았어요.',
        buttons: [{ label: '취소', value: null }, { label: '저장 안 함', value: 'discard', danger: true }, { label: '저장', value: 'save', primary: true }],
      });
      if (r === 'save') return this.save();
      return r === 'discard';
    }
    async close() {
      if (this.closing) return false;
      this.closing = true;
      try {
        if (!(await this.leaveGuard(true))) return false;
        const cur = this.ctx?.image;
        this.doc = null; this.ctx = null; this.bufs = null;
        this.cache.clear();
        this.history.clear();
        if (this.fromViewer && this.idx >= 0) App.viewer.resume(this.list, this.idx);
        else { App.show('gallery'); App.gallery.render(cur); }
        return true;
      } finally { this.closing = false; }
    }
    async navigate(delta) {
      if (this.loading || this.saving || this.navBusy) return;
      const ni = this.idx + delta;
      if (ni < 0 || ni >= this.list.length) { this.bounce(delta); return; }
      this.navBusy = true;
      try {
        if (!(await this.leaveGuard(true))) { this.snapBack(); return; }
        const W = this.stage.clientWidth;
        const cv = this.canvas;
        cv.style.transition = 'transform .12s ease-in';
        cv.style.transform = `translateX(${-delta * W}px)`;
        await U.sleep(110);
        cv.style.transition = 'none';
        cv.style.transform = `translateX(${delta * W * 0.4}px)`;
        this.idx = ni;
        await this.loadIndex(ni);
        requestAnimationFrame(() => {
          cv.style.transition = 'transform .18s ease-out';
          cv.style.transform = 'translateX(0)';
        });
      } finally { this.navBusy = false; }
    }
    bounce(delta) {
      const cv = this.canvas;
      cv.style.transition = 'transform .12s ease-out';
      cv.style.transform = `translateX(${-delta * 30}px)`;
      setTimeout(() => this.snapBack(), 120);
    }
    snapBack() {
      const cv = this.canvas;
      cv.style.transition = 'transform .18s ease-out';
      cv.style.transform = 'translateX(0)';
    }
    async save() {
      if (!this.doc || this.saving) return false;
      if (this.textEd) await App.text.commit(this);
      if (this.action) this.cancelAction(true);
      this.tools.transform.commit();
      // the note is copied first (a moment), then encoding + uploading run in the background: drawing,
      // swiping and leaving stay possible (opening this note again waits for the save)
      const doc = this.doc, ctx = this.ctx;
      const entry = (this.idx >= 0 && this.list[this.idx]) || ctx.image || ctx;
      const prev = this.pendingSaves.get(entry);
      this.saving = true;
      this.btnSave.classList.add('busy');
      let snapped;
      const snapP = new Promise(r => { snapped = r; });
      const run = async () => {
        await prev;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await App.library.save(doc, ctx, () => { if (this.ctx === ctx) this.dirty = false; snapped(); });
            if (this.ctx === ctx) {
              if (this.idx < 0) { this.list = App.library.visible(); this.idx = this.list.indexOf(ctx.image); }
              this.updateTitle();
            }
            App.gallery.refreshEntry?.(ctx.image);
            U.toast('저장됨 · 원본 이미지와 편집파일이 모두 갱신됐어요');
            return true;
          } catch (e) {
            snapped();
            if ((await App.handleError(e, '저장 실패')) !== 'retry') { if (this.ctx === ctx) this.dirty = true; return false; }
          }
        }
        return false;
      };
      const p = run().finally(() => {
        if (this.pendingSaves.get(entry) === p) { this.pendingSaves.delete(entry); this.btnSave.classList.remove('busy'); }
      });
      this.pendingSaves.set(entry, p);
      this.cache.delete(entry);
      await snapP;
      this.saving = false;
      return p;
    }

    // ================= history / changes =================
    pushHistory(e) { this.history.push(e); }
    onHistory(e) {
      if (e) { this.dirty = true; this.updateTitle(); }
      this.btnUndo.disabled = !this.history.undos.length;
      this.btnRedo.disabled = !this.history.redos.length;
    }
    changed(r) { this.requestComposite(r); this.refreshLayersSoon(); }
    undo() {
      if (!this.doc || this.action) return;
      if (this.tools.transform.active) { this.tools.transform.revert(); return; }
      if (this.history.undo()) { this.renderCtxbar(); this.pLayers.render(); }
    }
    redo() {
      if (!this.doc || this.action) return;
      if (this.history.redo()) this.pLayers.render();
    }

    // ================= colour =================
    setColor(c, commit) {
      this.color = c;
      App.settings.color = c;
      if (commit) {
        const rc = App.settings.recentColors.filter(x => x !== c);
        rc.unshift(c);
        App.settings.recentColors = rc.slice(0, 16);
        App.saveSettings();
      }
      this.updateSwatch();
      this.pColor.sync();
    }
    colorRGB() { return App.ui.hex2rgb(this.color); }

    // ================= layers =================
    struct(fn) {
      const doc = this.doc;
      this.tools.transform.commit();
      const b = H.snap(doc);
      fn();
      const a = H.snap(doc);
      this.pushHistory(H.struct(doc, b, a, () => this.changed(null)));
      this.changed(null);
      this.pLayers.render();
    }
    addLayer() {
      const doc = this.doc;
      this.struct(() => {
        const L = doc.createLayer(doc.nextLayerName());
        doc.layers.splice(doc.layers.indexOf(doc.active) + 1, 0, L);
        doc.active = L;
      });
      return doc.active;
    }
    duplicateLayer() {
      const doc = this.doc, A = doc.active;
      this.struct(() => {
        const L = doc.createLayer(A.name + ' 복사');
        L.ctx.drawImage(A.canvas, 0, 0);
        Object.assign(L, { visible: A.visible, opacity: A.opacity, blend: A.blend, alphaLock: A.alphaLock, border: { ...A.border } });
        doc.layers.splice(doc.layers.indexOf(A) + 1, 0, L);
        doc.active = L;
      });
    }
    deleteLayer() {
      const doc = this.doc;
      if (doc.layers.length <= 1) { U.toast('마지막 레이어는 삭제할 수 없어요'); return; }
      this.struct(() => {
        const i = doc.layers.indexOf(doc.active);
        doc.layers.splice(i, 1);
        doc.active = doc.layers[Math.max(0, i - 1)];
      });
    }
    moveLayer(dir) {
      const doc = this.doc, i = doc.layers.indexOf(doc.active), j = i + dir;
      if (j < 0 || j >= doc.layers.length) return;
      this.struct(() => { const L = doc.layers.splice(i, 1)[0]; doc.layers.splice(j, 0, L); });
    }
    reorderLayer(L, to) {
      const doc = this.doc, from = doc.layers.indexOf(L);
      if (from < 0 || to === from) return;
      this.struct(() => { doc.layers.splice(from, 1); doc.layers.splice(to, 0, L); });
    }
    mergeDown() {
      const doc = this.doc, A = doc.active, i = doc.layers.indexOf(A);
      if (i === 0) { U.toast('아래에 병합할 레이어가 없어요'); return; }
      if (!A.visible) { U.toast('숨긴 레이어는 병합할 수 없어요'); return; }
      this.tools.transform.commit();
      const B = doc.layers[i - 1], r = U.rFull(doc.w, doc.h);
      const before = B.ctx.getImageData(0, 0, doc.w, doc.h);
      if (A.border.on) doc.syncBorders(r);
      B.ctx.save();
      B.ctx.globalAlpha = A.opacity;
      B.ctx.globalCompositeOperation = A.blend;
      B.ctx.drawImage(A.border.on ? doc.layerSource(A, r) : A.canvas, 0, 0); // bake A's border in
      B.ctx.restore();
      B.rev++;
      const pix = H.pixels(doc, B, r, before, rr => this.changed(rr));
      const sb = H.snap(doc);
      doc.layers.splice(i, 1);
      doc.active = B;
      const st = H.struct(doc, sb, H.snap(doc), () => this.changed(null));
      this.pushHistory(H.group([pix, st]));
      this.changed(null);
      this.pLayers.render();
    }
    selectLayer(L) {
      if (this.doc.active === L) return;
      this.tools.transform.commit();
      this.doc.active = L;
      this.pLayers.render();
    }
    setLayerProp(L, prop, v, commit) {
      if (!this.propBefore) this.propBefore = H.snap(this.doc);
      L[prop] = v;
      this.requestComposite(null);
      if (commit) {
        const b = this.propBefore, a = H.snap(this.doc);
        this.propBefore = null;
        if (JSON.stringify(b.layers.map(o => [o.name, o.visible, o.opacity, o.blend, o.alphaLock, o.border])) !==
          JSON.stringify(a.layers.map(o => [o.name, o.visible, o.opacity, o.blend, o.alphaLock, o.border]))) {
          this.pushHistory(H.struct(this.doc, b, a, () => { this.changed(null); this.pLayers.render(); }));
        }
        this.pLayers.render();
      }
    }
    async renameLayer(L) {
      const n = await U.dialog({ title: '레이어 이름', input: { value: L.name }, buttons: [{ label: '취소', value: null }, { label: '확인', value: true, primary: true }] });
      if (n && n.trim() && n.trim() !== L.name) this.struct(() => { L.name = n.trim(); });
    }
    clearLayer() {
      const doc = this.doc, L = doc.active, sel = doc.selection;
      this.tools.transform.commit();
      const r = sel ? sel.bounds : U.rFull(doc.w, doc.h);
      if (!r) return;
      const before = L.ctx.getImageData(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      L.ctx.save();
      if (sel) { L.ctx.globalCompositeOperation = 'destination-out'; L.ctx.drawImage(sel.mask, 0, 0); }
      else L.ctx.clearRect(0, 0, doc.w, doc.h);
      L.ctx.restore();
      L.rev++;
      this.pushHistory(H.pixels(doc, L, r, before, rr => this.changed(rr)));
      this.changed(r);
    }
    selectionCanvas() {
      const doc = this.doc, sel = doc.selection, L = doc.active;
      const b = sel ? sel.bounds : doc.contentBounds(L);
      if (!b) return null;
      const w = b.x1 - b.x0, hh = b.y1 - b.y0;
      const c = U.canvas(w, hh), x = c.getContext('2d');
      x.drawImage(L.canvas, b.x0, b.y0, w, hh, 0, 0, w, hh);
      if (sel) { x.globalCompositeOperation = 'destination-in'; x.drawImage(sel.mask, b.x0, b.y0, w, hh, 0, 0, w, hh); }
      return { c, b };
    }
    copyToNewLayer() {
      const s = this.selectionCanvas();
      if (!s) return;
      const src = this.doc.active;
      this.struct(() => {
        const L = this.doc.createLayer(src.name + ' 조각');
        L.ctx.drawImage(s.c, s.b.x0, s.b.y0);
        this.doc.layers.splice(this.doc.layers.indexOf(src) + 1, 0, L);
        this.doc.active = L;
      });
      this.setSelection(null);
    }
    async copy(cut) {
      const s = this.selectionCanvas();
      if (!s) return;
      this.clip = s;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': U.canvasToBlob(s.c) })]); } catch { /* internal clipboard only */ }
      if (cut) this.clearLayer();
      U.toast(cut ? '잘라냈어요' : '복사했어요');
    }
    async pasteImage(blobOrCanvas, at) {
      const doc = this.doc;
      let src = blobOrCanvas;
      if (src instanceof Blob) src = await createImageBitmap(src);
      const w = src.width, hh = src.height;
      const s = Math.min(1, doc.w / w, doc.h / hh);
      this.struct(() => {
        const L = doc.createLayer('붙여넣기');
        const x = at ? at.x0 : (doc.w - w * s) / 2, y = at ? at.y0 : (doc.h - hh * s) / 2;
        L.ctx.drawImage(src, x, y, w * s, hh * s);
        doc.layers.splice(doc.layers.indexOf(doc.active) + 1, 0, L);
        doc.active = L;
      });
      this.setSelection(null);
      if (this.toolName === 'transform') this.tools.transform.activate(); else this.setTool('transform');
    }

    // ================= selection =================
    setSelection(sel) {
      if (!this.doc) return;
      this.doc.selection = sel;
      this.renderCtxbar();
      this.requestRender();
    }
    selectAll() { const s = new App.Selection(this.doc.w, this.doc.h); s.selectAll(); this.setSelection(s); }
    invertSelection() {
      const doc = this.doc;
      const s = doc.selection ? doc.selection.clone() : new App.Selection(doc.w, doc.h);
      s.invert();
      this.setSelection(s.empty ? null : s);
    }
    onTransformState() { this.renderOpts(); this.requestRender(); }

    // ================= view =================
    resize(refit) {
      const wide = this.isWide();
      if (wide !== this.wasWide) { this.wasWide = wide; this.layoutDock(); }
      const r = this.stage.getBoundingClientRect();
      this.dpr = devicePixelRatio || 1;
      const W = Math.round(r.width * this.dpr), Hh = Math.round(r.height * this.dpr);
      const wasFit = Math.abs(this.z - this.fitZ) < 1e-6;
      if (this.canvas.width !== W || this.canvas.height !== Hh) { this.canvas.width = W; this.canvas.height = Hh; }
      if (this.doc && (refit || wasFit)) this.fit(); else this.requestRender();
    }
    fit() {
      if (!this.doc) return;
      const cw = this.stage.clientWidth, ch = this.stage.clientHeight;
      const pad = this.isWide() ? 28 : 6;
      this.fitZ = Math.max(0.01, Math.min((cw - pad * 2) / this.doc.w, (ch - pad * 2) / this.doc.h));
      this.z = this.fitZ;
      this.rot = 0;
      this.ox = (cw - this.doc.w * this.z) / 2;
      this.oy = (ch - this.doc.h * this.z) / 2;
      this.updateRotBadge();
      this.requestRender();
    }
    // view transform: screen = o + R(rot) · (doc · z)
    toDoc(sx, sy) {
      const dx = (sx - this.ox) / this.z, dy = (sy - this.oy) / this.z;
      const c = Math.cos(this.rot || 0), s = Math.sin(this.rot || 0);
      return [dx * c + dy * s, -dx * s + dy * c];
    }
    toScreen(x, y) {
      const c = Math.cos(this.rot || 0), s = Math.sin(this.rot || 0);
      return [this.ox + this.z * (x * c - y * s), this.oy + this.z * (x * s + y * c)];
    }
    // place doc point (dx,dy) at screen (sx,sy) with the current zoom / rotation
    pin(dx, dy, sx, sy) {
      const c = Math.cos(this.rot || 0), s = Math.sin(this.rot || 0);
      this.ox = sx - this.z * (dx * c - dy * s);
      this.oy = sy - this.z * (dx * s + dy * c);
    }
    zoomAt(sx, sy, f) {
      const [dx, dy] = this.toDoc(sx, sy);
      this.z = U.clamp(this.z * f, Math.min(0.05, this.fitZ), 32);
      this.pin(dx, dy, sx, sy);
      this.requestRender();
    }
    rotateBy(deg, sx = this.stage.clientWidth / 2, sy = this.stage.clientHeight / 2) {
      const [dx, dy] = this.toDoc(sx, sy);
      this.rot = snapAngle((this.rot || 0) + deg * Math.PI / 180, 0.5);
      this.pin(dx, dy, sx, sy);
      this.updateRotBadge();
      this.requestRender();
    }
    resetRotation() { this.rotateBy(-(this.rot || 0) * 180 / Math.PI); }
    updateRotBadge() {
      if (!this.rotBadge) {
        this.rotBadge = h('button', { class: 'rot-badge', title: '회전 초기화', onclick: () => this.resetRotation() });
        this.stage.append(this.rotBadge);
      }
      const deg = Math.round(((this.rot || 0) * 180 / Math.PI) % 360);
      this.rotBadge.hidden = !deg;
      this.rotBadge.textContent = `↻ ${deg}°`;
    }
    panBy(dx, dy) { this.ox += dx; this.oy += dy; this.requestRender(); }
    isFitView() { return this.z <= this.fitZ * 1.08 && !this.rot; }

    requestComposite(r) {
      if (r === null) this.compAll = true; else this.compRect = U.rUnion(this.compRect, r);
      this.requestRender();
    }
    requestRender() {
      if (this.raf) return;
      // raf stays set while rendering so requests made during render() don't queue an extra frame
      this.raf = requestAnimationFrame(() => { try { this.render(); } finally { this.raf = 0; } });
    }
    checker() {
      if (!this._checker) {
        const c = U.canvas(16, 16), g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, 16, 16);
        g.fillStyle = '#e4e4e7'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
        this._checker = this.vctx.createPattern(c, 'repeat');
      }
      return this._checker;
    }
    render() {
      const c = this.vctx, doc = this.doc, dpr = this.dpr;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!doc) return;
      if (this.pendingFlush) { const s = this.pendingFlush; this.pendingFlush = null; s.flush(); }
      if (this.textEd) App.text.place(this);
      if (this.compAll) doc.renderComposite(null);
      else if (this.compRect) doc.renderComposite(this.compRect);
      this.compAll = false; this.compRect = null;

      const z = this.z * dpr, cs = Math.cos(this.rot || 0) * z, sn = Math.sin(this.rot || 0) * z;
      c.save();
      c.setTransform(cs, sn, -sn, cs, this.ox * dpr, this.oy * dpr);
      // cheap page edge (shadowBlur is costly on phones at high DPR and this runs every frame)
      const e = 1 / this.z;
      c.fillStyle = 'rgba(0,0,0,.22)';
      c.fillRect(-e, -e, doc.w + 2 * e, doc.h + 3 * e);
      c.fillStyle = this.checker(); c.fillRect(0, 0, doc.w, doc.h);
      c.imageSmoothingEnabled = this.z < 2;
      c.imageSmoothingQuality = 'high';
      c.drawImage(doc.composite, 0, 0);
      if (doc.selection && !this.tools.transform.active) c.drawImage(doc.selection.overlay(), 0, 0);
      c.restore();

      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (doc.selection && !this.tools.transform.active) {
        c.save();
        c.beginPath();
        for (const pts of doc.selection.paths) {
          pts.forEach(([px, py], i) => { const s = this.toScreen(px, py); i ? c.lineTo(s[0], s[1]) : c.moveTo(s[0], s[1]); });
          c.closePath();
        }
        c.lineWidth = 1; c.strokeStyle = '#fff'; c.stroke();
        c.setLineDash([4, 4]); c.lineDashOffset = -this.ants; c.strokeStyle = '#111'; c.stroke();
        c.restore();
      }
      const st = this.action?.tool?.stroke, pred = this.predicted;
      if (st && st.last && pred && pred.length) {
        const s0 = this.toScreen(st.last.x, st.last.y);
        c.save();
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.strokeStyle = this.color;
        c.globalAlpha = st.p.opacity * 0.85;
        c.lineWidth = Math.max(1, st.sizeAt(st.last.p) * this.z * 0.9);
        c.beginPath(); c.moveTo(s0[0], s0[1]);
        for (const q of pred) c.lineTo(q.sx, q.sy);
        c.stroke();
        c.restore();
      }
      const tool = this.action?.tool || this.tools[this.toolName];
      tool.drawOverlay?.(c);
      if (tool !== this.tools.transform) this.tools.transform.drawOverlay(c);
      const hv = this.hover;
      if (hv && hv.type !== 'touch' && (this.toolName === 'brush' || this.toolName === 'eraser')) {
        const r = Math.max(1.5, this.preset().size * this.z / 2);
        c.beginPath(); c.arc(hv.sx, hv.sy, r, 0, Math.PI * 2);
        c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.9)'; c.stroke();
        c.beginPath(); c.arc(hv.sx, hv.sy, r + 1, 0, Math.PI * 2);
        c.strokeStyle = 'rgba(0,0,0,.6)'; c.stroke();
      }
    }

    // ================= input =================
    bindInput() {
      const cv = this.canvas;
      cv.addEventListener('pointerdown', e => this.onDown(e));
      cv.addEventListener('pointermove', e => this.onMove(e));
      cv.addEventListener('pointerup', e => this.onUp(e, false));
      cv.addEventListener('pointercancel', e => this.onUp(e, true));
      cv.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !this.pointers.size) { this.hover = null; this.requestRender(); } });
      cv.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      cv.addEventListener('contextmenu', e => e.preventDefault());
      window.addEventListener('keydown', e => this.onKey(e));
      window.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceDown = false; this.canvas.style.cursor = this.tools[this.toolName].cursor; } });
      document.addEventListener('paste', e => {
        if (!this.visible || !this.doc || e.target.matches?.('input,textarea')) return;
        const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
        if (item) { e.preventDefault(); this.pasteImage(item.getAsFile()); }
        else if (this.clip) { e.preventDefault(); this.pasteImage(this.clip.c, this.clip.b); }
      });
    }
    // photo library / camera / file → new layer (then the transform tool to place it)
    pickImage() {
      if (!this.doc) return;
      const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
      inp.addEventListener('change', async () => {
        for (const f of inp.files) await this.pasteImage(f);
        inp.remove();
      });
      document.body.append(inp);
      inp.click();
    }
    ptOf(e) {
      const r = this.canvasRect || (this.canvasRect = this.canvas.getBoundingClientRect());
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [x, y] = this.toDoc(sx, sy);
      let p = 1;
      if (e.pointerType === 'pen') p = e.pressure > 0 ? e.pressure : 0.3;
      // some tablet drivers report the pen as a mouse but still send real pressure (mouse is always 0 or 0.5)
      else if (e.pointerType === 'mouse' && e.pressure > 0 && e.pressure !== 0.5) p = e.pressure;
      return { x, y, sx, sy, p, type: e.pointerType };
    }
    onDown(e) {
      if (!this.doc || this.loading) return;
      if (this.textEd && e.pointerType !== 'touch' && this.toolName !== 'text') { App.text.commit(this); return; }
      if (e.pointerType === 'touch' && this.action && this.action.type === 'pen') return; // palm while drawing
      if (!this.isWide() && this.sheetOpen) { this.sheetOpen = false; this.layoutDock(); }
      this.canvasRect = this.canvas.getBoundingClientRect();
      const pt = this.ptOf(e);
      this.pointers.set(e.pointerId, { x: pt.sx, y: pt.sy, x0: pt.sx, y0: pt.sy, type: e.pointerType });
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (e.pointerType === 'pen') this.penSeen = true;

      if (e.pointerType === 'touch') {
        const n = this.touchCount();
        if (this.gesture) { this.gesture.max = Math.max(this.gesture.max, n); this.gesture.base = this.gestureBase(); return; }
        if (n >= 2) {
          if (this.action) {
            const a = this.action;
            if (a.kind === 'tool') {
              // a second finger arrived: short stroke = start of a pinch → throw away, long stroke = keep it
              if (performance.now() - a.t0 < 350) a.tool.cancel(); else a.tool.up(a.lastPt || pt, e);
            }
            if (a.kind === 'swipe') this.snapBack();
            this.action = null;
          }
          this.gesture = { t0: performance.now(), max: n, moved: false, base: this.gestureBase() };
          return;
        }
        if (this.action) return;
        const fingerDraws = App.settings.fingerDraw && !(App.settings.palmRejection && this.penSeen);
        if (!fingerDraws && this.toolName !== 'transform' && this.toolName !== 'hand') {
          this.action = this.isFitView() && this.list.length
            ? { kind: 'swipe', id: e.pointerId, x0: pt.sx, y0: pt.sy, t0: performance.now(), dx: 0, type: 'touch' }
            : { kind: 'pan', id: e.pointerId, last: pt, type: 'touch' };
          return;
        }
      } else if (this.action) return;

      let name = this.toolName;
      if (e.pointerType === 'mouse') {
        if (e.button === 1 || this.spaceDown) { this.action = { kind: 'pan', id: e.pointerId, last: pt, type: 'mouse' }; return; }
        if (e.button === 2) { this.tools.picker.pick(pt); this.setColor(this.color, true); return; }
        if (e.button !== 0) return;
      }
      if (e.pointerType === 'pen' && (e.buttons & 32)) name = 'eraser';
      if (this.spaceDown) name = 'hand';
      if (e.altKey && (name === 'brush' || name === 'eraser' || name === 'fill')) name = 'picker';
      const tool = this.tools[name];
      if (tool.down(pt, e) === false) return;
      this.action = { kind: 'tool', id: e.pointerId, tool, type: e.pointerType, t0: performance.now(), lastPt: pt };
    }
    onMove(e) {
      const P = this.pointers.get(e.pointerId);
      if (!P) {
        if (e.pointerType !== 'touch' && this.doc) {
          this.canvasRect = this.canvasRect || this.canvas.getBoundingClientRect();
          this.hover = this.ptOf(e);
          this.requestRender();
        }
        return;
      }
      const pt = this.ptOf(e);
      P.x = pt.sx; P.y = pt.sy;
      if (Math.hypot(P.x - P.x0, P.y - P.y0) > 12 && this.gesture) this.gesture.moved = true;
      if (this.gesture) { this.updateGesture(); return; }
      const a = this.action;
      if (!a || a.id !== e.pointerId) return;
      if (a.kind === 'pan') { this.panBy(pt.sx - a.last.sx, pt.sy - a.last.sy); a.last = pt; return; }
      if (a.kind === 'swipe') { this.swipeMove(a, pt); return; }
      if (a.kind === 'tool') {
        const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
        for (const ce of evs.length ? evs : [e]) a.tool.move(this.ptOf(ce), e);
        a.tool.frame?.();
        // where the pen is about to be: drawn as a temporary tail so the line keeps up with the pen tip
        this.predicted = App.settings.predict && a.tool.stroke && !a.tool.erase && !a.tool.straight && e.getPredictedEvents ? e.getPredictedEvents().map(pe => this.ptOf(pe)) : null;
        a.lastPt = pt;
        if (e.pointerType !== 'touch') this.hover = pt;
        this.requestRender();
      }
    }
    onUp(e, cancelled) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.gesture) {
        if (!this.touchCount()) {
          const g = this.gesture;
          this.gesture = null;
          if (!g.moved && performance.now() - g.t0 < 320) { if (g.max === 2) this.undo(); else if (g.max >= 3) this.redo(); }
        } else this.gesture.base = this.gestureBase();
        return;
      }
      const a = this.action;
      if (!a || a.id !== e.pointerId) return;
      this.action = null;
      this.predicted = null;
      if (a.kind === 'tool') {
        if (cancelled) a.tool.cancel(); else a.tool.up(this.ptOf(e), e);
        this.requestRender();
      } else if (a.kind === 'swipe') this.swipeEnd(a);
    }
    cancelAction(commit) {
      const a = this.action;
      this.action = null;
      if (a && a.kind === 'tool') { if (commit) a.tool.up(a.lastPt, {}); else a.tool.cancel(); }
    }
    touchCount() { let n = 0; for (const p of this.pointers.values()) if (p.type === 'touch') n++; return n; }
    gestureBase() {
      const ts = [...this.pointers.values()].filter(p => p.type === 'touch');
      if (ts.length < 2) return null;
      const [a, b] = ts;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      return {
        cx, cy, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x),
        z: this.z, rot: this.rot || 0, docPt: this.toDoc(cx, cy),
      };
    }
    // two fingers: pan + pinch zoom + rotate (rotation kicks in after a small twist, and snaps to 90° steps)
    updateGesture() {
      const g = this.gesture, B = g.base;
      if (!B) { g.base = this.gestureBase(); return; }
      const ts = [...this.pointers.values()].filter(p => p.type === 'touch');
      if (ts.length < 2) return;
      const [a, b] = ts;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      let da = Math.atan2(b.y - a.y, b.x - a.x) - B.ang;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (!g.rotating && Math.abs(da) > 0.14) { g.rotating = true; g.moved = true; }
      this.z = U.clamp(B.z * d / B.d, Math.min(0.05, this.fitZ), 32);
      if (g.rotating) this.rot = snapAngle(B.rot + da, 5);
      this.pin(B.docPt[0], B.docPt[1], cx, cy);
      this.updateRotBadge();
      this.requestRender();
    }
    swipeMove(a, pt) {
      const dx = pt.sx - a.x0, dy = pt.sy - a.y0;
      if (!a.dir) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) a.dir = 'h';
        else if (Math.abs(dy) > 10) { a.dir = 'v'; a.last = pt; }
      }
      if (a.dir === 'h') {
        let d = dx;
        if ((d > 0 && this.idx <= 0) || (d < 0 && this.idx >= this.list.length - 1)) d *= 0.3;
        a.dx = d;
        const now = performance.now();
        if (a.lt) a.v = (pt.sx - a.lx) / Math.max(1, now - a.lt);
        a.lx = pt.sx; a.lt = now;
        this.canvas.style.transition = 'none';
        this.canvas.style.transform = `translateX(${d}px)`;
      } else if (a.dir === 'v') { this.panBy(0, pt.sy - a.last.sy); a.last = pt; }
    }
    swipeEnd(a) {
      if (a.dir !== 'h') return;
      const W = this.stage.clientWidth;
      const delta = a.dx < 0 ? 1 : -1;
      const can = this.idx + delta >= 0 && this.idx + delta < this.list.length;
      if (can && (Math.abs(a.dx) > W * 0.2 || Math.abs(a.v || 0) > 0.6)) this.navigate(delta);
      else this.snapBack();
    }
    onWheel(e) {
      e.preventDefault();
      if (!this.doc) return;
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (e.shiftKey) { this.panBy(-e.deltaY, 0); return; }
      const k = e.ctrlKey ? 0.01 : e.deltaMode === 1 ? 0.05 : 0.0018;
      this.zoomAt(sx, sy, Math.exp(-e.deltaY * k));
    }
    onKey(e) {
      if (!this.visible || !this.doc) return;
      if (e.target.matches && e.target.matches('input,textarea,select')) return;
      if (document.querySelector('.modal-back, .menu-back')) return;
      const t = this.tools.transform;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      const combo = App.keys.comboOf(e);
      // fixed keys
      if (combo === 'space') { stop(); if (!this.spaceDown) { this.spaceDown = true; this.canvas.style.cursor = 'grab'; } return; }
      if (combo === 'enter' && t.active) { stop(); t.commit(); return; }
      if (combo === 'escape') {
        if (t.active) { stop(); t.revert(); } else if (this.doc.selection) { stop(); this.setSelection(null); }
        return;
      }
      // user-configurable keys (설정 → 단축키)
      const act = App.keys.actionFor(combo);
      if (!act) {
        // don't let a browser reload throw away the drawing
        if (combo === 'ctrl+r' || combo === 'f5') { stop(); U.toast('편집 중에는 새로고침이 꺼져 있어요 (갤러리에서 쓸 수 있어요)'); }
        return;
      }
      stop();
      this.runAction(act);
    }
    runAction(id) {
      const t = this.tools.transform, cx = this.stage.clientWidth / 2, cy = this.stage.clientHeight / 2;
      if (id.startsWith('tool.')) return this.setTool(id.slice(5));
      if (id.startsWith('brush.fav')) { const k = this.brushKeys()[Number(id.slice(9)) - 1]; if (k) this.selectBrush(k); return; }
      const size = d => { const p = this.preset(); p.size = posToSize(U.clamp(sizeToPos(p.size) + d, 0, 1)); this.onBrushChanged(); App.saveSettings(); };
      const A = {
        undo: () => this.undo(), redo: () => this.redo(), save: () => this.save(),
        'layer.new': () => this.addLayer(), 'layer.dup': () => this.duplicateLayer(), 'layer.del': () => this.deleteLayer(),
        'layer.up': () => this.moveLayer(1), 'layer.down': () => this.moveLayer(-1), 'layer.merge': () => this.mergeDown(),
        'layer.selUp': () => { const L = this.doc.layers; const i = L.indexOf(this.doc.active); if (i < L.length - 1) this.selectLayer(L[i + 1]); },
        'layer.selDown': () => { const L = this.doc.layers; const i = L.indexOf(this.doc.active); if (i > 0) this.selectLayer(L[i - 1]); },
        'view.zoomIn': () => this.zoomAt(cx, cy, 1.25), 'view.zoomOut': () => this.zoomAt(cx, cy, 0.8),
        'view.fit': () => this.fit(), 'view.actual': () => this.zoomAt(cx, cy, 1 / this.z),
        'view.rotL': () => this.rotateBy(-15), 'view.rotR': () => this.rotateBy(15), 'view.rotReset': () => this.resetRotation(),
        'brush.smaller': () => size(-0.04), 'brush.bigger': () => size(0.04),
        'sel.all': () => this.selectAll(), 'sel.none': () => this.setSelection(null), 'sel.invert': () => this.invertSelection(),
        'edit.copy': () => this.copy(false), 'edit.cut': () => this.copy(true), 'edit.clear': () => { if (!t.active) this.clearLayer(); },
        'note.prev': () => { if (!t.active) this.navigate(-1); }, 'note.next': () => { if (!t.active) this.navigate(1); },
        'panel.layers': () => this.toggleTab('layers'), 'panel.brush': () => this.toggleTab('brush'), 'panel.color': () => this.toggleTab('color'),
      };
      A[id]?.();
    }
  }

  App.editor = new Editor();
})();
