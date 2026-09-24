'use strict';
// Gallery: edge-to-edge thumbnail grid (Samsung Gallery style), folders, pinch to change columns.
(() => {
  const U = App.util, h = U.h;

  class Gallery {
    init() {
      this.root = U.$('#gallery');
      this.scroll = U.$('#g-scroll');
      this.grid = U.$('#g-grid');
      this.dirsEl = U.$('#g-dirs');
      this.empty = U.$('#g-empty');
      this.bar = U.$('#g-bar');
      this.urls = new Map();      // thumb key -> object URL
      this.queue = []; this.running = 0;
      this.io = new IntersectionObserver(es => {
        for (const en of es) if (en.isIntersecting) { this.io.unobserve(en.target); this.enqueue(en.target); }
      }, { root: this.scroll, rootMargin: '800px 0px' });
      this.buildBar();
      this.bindScroll();
      this.bindPinch();
      new ResizeObserver(() => this.applyCols()).observe(this.scroll);
      U.$('#g-new').addEventListener('click', () => App.editor.openNew());
    }
    buildBar() {
      this.btnUp = U.iconBtn('back', '상위 폴더', () => this.up());
      this.titleEl = h('div', { class: 'g-title' });
      this.bar.replaceChildren(
        this.btnUp, this.titleEl, h('div', { class: 'grow' }),
        U.iconBtn('download', '앱으로 설치', () => App.install(), 'install-only accent'),
        U.iconBtn('refresh', '새로고침', () => this.reload()),
        U.iconBtn('grid', '보기', e => this.viewMenu(e.currentTarget)),
        U.iconBtn('sort', '정렬', e => this.sortMenu(e.currentTarget)),
        U.iconBtn('gear', '설정', () => App.openSettings()));
    }

    // ---------- data ----------
    async reload() {
      if (!App.library.backend) return;
      this.setBusy(true);
      try {
        await App.library.refresh();
        this.render();
      } catch (e) {
        if ((await App.handleError(e, '목록을 불러오지 못했어요')) === 'retry') return this.reload();
      } finally { this.setBusy(false); }
    }
    setBusy(b) { this.root.classList.toggle('busy', b); }
    async up() {
      if (await App.library.up()) this.render(); else App.showHome();
    }
    async enter(dir) {
      this.setBusy(true);
      try { await App.library.enter(dir); this.render(); this.scroll.scrollTop = 0; }
      catch (e) { App.handleError(e, '폴더를 열지 못했어요'); }
      finally { this.setBusy(false); }
    }

    // ---------- render ----------
    render(focusEntry) {
      const L = App.library;
      const path = L.path;
      this.titleEl.replaceChildren(
        h('b', null, path[path.length - 1] || ''),
        h('small', null, `${L.backend?.kind === 'drive' ? 'Google Drive' : L.backend?.kind === 'opfs' ? '앱 내부' : 'PC 폴더'} · ${L.images.length}장`));
      this.dirsEl.replaceChildren(
        ...L.dirs.map(d => h('button', { class: 'dir-chip', onclick: () => this.enter(d), html: App.icon('folder') + `<span>${escapeHtml(d.name)}</span>` })),
        h('button', { class: 'dir-chip add', title: '새 폴더', onclick: () => this.newFolder(), html: App.icon('folderPlus') }));
      this.io.disconnect();
      this.queue = [];
      const frag = document.createDocumentFragment();
      L.images.forEach((entry, i) => {
        const tile = h('div', { class: 'tile', tabindex: 0 });
        tile.entry = entry;
        tile.idx = i;
        const url = this.urls.get(this.key(entry));
        if (url) tile.append(h('img', { src: url, alt: '', draggable: 'false' }));
        else this.io.observe(tile);
        if (L.hasProject(entry)) tile.append(h('span', { class: 'badge', title: '편집파일 있음', html: App.icon('layers') }));
        frag.append(tile);
      });
      this.grid.replaceChildren(frag);
      this.empty.hidden = L.images.length > 0;
      this.applyCols();
      if (focusEntry) {
        const t = [...this.grid.children].find(x => x.entry === focusEntry);
        if (t) {
          const r = t.getBoundingClientRect(), sr = this.scroll.getBoundingClientRect();
          if (r.top < sr.top + 56 || r.bottom > sr.bottom) t.scrollIntoView({ block: 'center' });
        }
      }
    }
    applyCols() {
      const w = this.scroll.clientWidth || innerWidth;
      let cols = App.settings.gridCols;
      if (!cols) cols = w < 600 ? 3 : Math.max(4, Math.round(w / 210));
      this.root.style.setProperty('--cols', cols);
      const a = App.settings.gridAspect;
      this.root.style.setProperty('--tile-aspect', a === 'fit' ? '3/4' : a);
      this.root.classList.toggle('fit', a === 'fit');
      this.cols = cols;
    }

    // ---------- thumbnails ----------
    key(entry) { return App.library.backend.key + '|' + (entry.id || entry.path || entry.name) + '|' + entry.mtime; }
    thumbUrl(entry) { return this.urls.get(this.key(entry)); }
    enqueue(tile) { this.queue.push(tile); this.pump(); }
    pump() {
      const max = App.library.backend?.kind === 'drive' ? 4 : 6;
      while (this.running < max && this.queue.length) {
        const tile = this.queue.shift();
        if (!tile.isConnected) continue;
        this.running++;
        this.loadThumb(tile.entry).then(url => {
          if (url && tile.isConnected && !tile.querySelector('img')) tile.prepend(h('img', { src: url, alt: '', draggable: 'false' }));
        }).catch(e => {
          if (e && e.auth) App.needLogin(); else tile.classList.add('broken');
        }).finally(() => { this.running--; this.pump(); });
      }
    }
    async loadThumb(entry) {
      const k = this.key(entry);
      if (this.urls.has(k)) return this.urls.get(k);
      let blob = await U.idbGet('thumbs', k);
      if (!blob) {
        const src = await App.library.backend.read(entry);
        const bmp = await createImageBitmap(src);
        blob = await this.makeThumb(bmp, bmp.width, bmp.height);
        bmp.close?.();
        U.idbSet('thumbs', k, blob);
      }
      const url = URL.createObjectURL(blob);
      this.urls.set(k, url);
      return url;
    }
    async makeThumb(src, w, hh) {
      const s = Math.min(1, 480 / Math.min(w, hh), 1400 / Math.max(w, hh));
      const c = U.canvas(w * s, hh * s), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, 0, 0, c.width, c.height);
      return U.canvasToBlob(c, 'image/webp', 0.85);
    }
    // called after saving: store the fresh thumbnail right away
    async putThumb(entry, canvas) {
      if (!entry || !App.library.backend) return;
      const blob = await this.makeThumb(canvas, canvas.width, canvas.height);
      const k = this.key(entry);
      U.idbSet('thumbs', k, blob);
      this.urls.set(k, URL.createObjectURL(blob));
    }

    // ---------- interactions ----------
    bindScroll() {
      let lastY = 0;
      this.scroll.addEventListener('scroll', () => {
        const y = this.scroll.scrollTop;
        if (y > lastY + 6 && y > 80) this.root.classList.add('bar-hidden');
        else if (y < lastY - 6 || y < 40) this.root.classList.remove('bar-hidden');
        lastY = y;
      }, { passive: true });

      // tap = open, long-press / right click = menu
      let press = null;
      this.grid.addEventListener('pointerdown', e => {
        const tile = e.target.closest('.tile');
        if (!tile || e.button > 0) return;
        press = { tile, x: e.clientX, y: e.clientY, t: setTimeout(() => { press = null; this.tileMenu(tile, e.clientX, e.clientY); }, 520) };
      });
      const cancel = () => { if (press) { clearTimeout(press.t); press = null; } };
      this.grid.addEventListener('pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel(); });
      this.grid.addEventListener('pointercancel', cancel);
      this.grid.addEventListener('pointerup', e => {
        if (!press) return;
        const tile = press.tile;
        cancel();
        if (this.pinching) return;
        App.editor.open(App.library.images, App.library.images.indexOf(tile.entry));
      });
      this.grid.addEventListener('contextmenu', e => {
        const tile = e.target.closest('.tile');
        e.preventDefault();
        cancel();
        if (tile) this.tileMenu(tile, e.clientX, e.clientY);
      });
      this.grid.addEventListener('keydown', e => {
        const tile = e.target.closest('.tile');
        if (tile && e.key === 'Enter') App.editor.open(App.library.images, App.library.images.indexOf(tile.entry));
      });
    }
    bindPinch() {
      // two-finger pinch or Ctrl+wheel changes the number of columns
      const pts = new Map();
      let d0 = 0, cols0 = 0;
      this.scroll.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') pts.set(e.pointerId, e); if (pts.size === 2) { const [a, b] = [...pts.values()]; d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); cols0 = this.cols; this.pinching = true; } });
      this.scroll.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, e);
        if (pts.size !== 2 || !d0) return;
        const [a, b] = [...pts.values()];
        const r = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / d0;
        const cols = U.clamp(Math.round(cols0 / r), 1, 12);
        if (cols !== this.cols) { App.settings.gridCols = cols; this.applyCols(); App.saveSettings(); }
      });
      const end = e => { pts.delete(e.pointerId); if (pts.size < 2) { d0 = 0; setTimeout(() => { this.pinching = false; }, 50); } };
      this.scroll.addEventListener('pointerup', end);
      this.scroll.addEventListener('pointercancel', end);
      this.scroll.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const cols = U.clamp((this.cols || 4) + (e.deltaY > 0 ? 1 : -1), 1, 12);
        App.settings.gridCols = cols; this.applyCols(); App.saveSettings();
      }, { passive: false });
    }
    async tileMenu(tile, x, y) {
      const entry = tile.entry, L = App.library;
      const v = await U.menu([
        { label: entry.name, value: null },
        '-',
        { label: '열기', value: 'open' },
        { label: '이름 바꾸기', value: 'rename' },
        { label: '정보', value: 'info' },
        '-',
        { label: L.backend.trashToFolder ? '휴지통 폴더로 이동' : 'Drive 휴지통으로 이동', value: 'trash', danger: true },
      ], x, y);
      try {
        if (v === 'open') App.editor.open(L.images, L.images.indexOf(entry));
        else if (v === 'rename') {
          const n = await U.dialog({ title: '이름 바꾸기', input: { value: U.baseName(entry.name) }, buttons: [{ label: '취소', value: null }, { label: '확인', value: true, primary: true }] });
          if (n) { await L.rename(entry, n); this.render(); }
        } else if (v === 'info') {
          U.dialog({ title: entry.name, body: `수정: ${U.fmtDate(entry.mtime)}\n크기: ${Math.round((entry.size || 0) / 1024)} KB\n편집파일: ${L.hasProject(entry) ? '있음 (' + App.project.EDIT_DIR + ' 폴더)' : '없음 (처음 저장할 때 생성)'}` });
        } else if (v === 'trash') {
          const ok = await U.dialog({ title: '휴지통으로 이동할까요?', body: `"${entry.name}"과(와) 편집파일을 ${L.backend.trashToFolder ? `"${App.project.TRASH_DIR}" 폴더로` : 'Google Drive 휴지통으로'} 옮깁니다.`, buttons: [{ label: '취소', value: false }, { label: '이동', value: true, danger: true, primary: true }] });
          if (ok) { await L.trash(entry); this.render(); U.toast('휴지통으로 옮겼어요'); }
        }
      } catch (e) { App.handleError(e, '작업 실패'); }
    }
    async viewMenu(btn) {
      const S = App.settings;
      const v = await U.menuAt(btn, [
        { label: '열 수: 자동', value: 'c0', checked: !S.gridCols },
        ...[2, 3, 4, 5, 6, 8].map(n => ({ label: `열 수: ${n}`, value: 'c' + n, checked: S.gridCols === n })),
        '-',
        { label: '세로형 타일 (3:4)', value: 'a3/4', checked: S.gridAspect === '3/4' },
        { label: '정사각형 타일', value: 'a1', checked: S.gridAspect === '1' },
        { label: '잘림 없이 전체 보기', value: 'afit', checked: S.gridAspect === 'fit' },
      ]);
      if (!v) return;
      if (v[0] === 'c') S.gridCols = Number(v.slice(1)); else S.gridAspect = v.slice(1);
      App.saveSettings();
      this.applyCols();
    }
    async sortMenu(btn) {
      const S = App.settings;
      const v = await U.menuAt(btn, [
        ['mtime-desc', '최근 수정순'], ['mtime-asc', '오래된 순'], ['name-asc', '이름 (가나다)'], ['name-desc', '이름 (역순)'],
      ].map(([value, label]) => ({ label, value, checked: S.sort === value })));
      if (!v) return;
      S.sort = v; App.saveSettings();
      App.library.sort();
      this.render();
    }
    async newFolder() {
      const n = await U.dialog({ title: '새 폴더', input: { placeholder: '폴더 이름' }, buttons: [{ label: '취소', value: null }, { label: '만들기', value: true, primary: true }] });
      if (!n) return;
      try { await App.library.createFolder(n); this.render(); } catch (e) { App.handleError(e, '폴더를 만들지 못했어요'); }
    }
  }

  function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  App.gallery = new Gallery();
})();
