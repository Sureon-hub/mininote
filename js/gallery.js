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
      this.sel = new Set(); this.selecting = false; this.anchor = null;
      this.buildBar();
      this.selBar = h('header', { class: 'bar g-bar g-selbar', hidden: true });
      this.root.append(this.selBar);
      this.bindScroll();
      this.bindPinch();
      this.bindKeys();
      new ResizeObserver(() => this.applyCols()).observe(this.scroll);
      U.$('#g-new').addEventListener('click', () => App.editor.openNew());
    }

    // ---------- multi-select ----------
    // phone: long-press a note → selection mode (tap to toggle) · PC: Ctrl+click / Shift+click / Ctrl+A
    tileOf(entry) { return [...this.grid.children].find(t => t.entry === entry) || null; }
    enterSelect(entry) {
      if (!this.selecting) {
        this.selecting = true;
        this.root.classList.add('selecting');
        history.pushState({ gsel: true }, ''); // phone back button leaves selection mode
      }
      if (entry) this.toggle(entry, true);
      this.renderSelBar();
    }
    exitSelect(fromPop) {
      if (!this.selecting) return;
      this.selecting = false;
      this.sel.clear();
      this.anchor = null;
      this.root.classList.remove('selecting');
      this.grid.querySelectorAll('.tile.sel').forEach(t => t.classList.remove('sel'));
      this.selBar.hidden = true;
      if (!fromPop && history.state && history.state.gsel) { App._ignorePop = true; history.back(); }
    }
    toggle(entry, on) {
      const v = on ?? !this.sel.has(entry);
      if (v) this.sel.add(entry); else this.sel.delete(entry);
      this.tileOf(entry)?.classList.toggle('sel', v);
      this.anchor = entry;
    }
    selectRange(entry) {
      const list = App.library.visible();
      const a = list.indexOf(this.anchor), b = list.indexOf(entry);
      if (a < 0) { this.toggle(entry, true); return; }
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.toggle(list[i], true);
      this.anchor = entry;
    }
    selectAll() {
      const list = App.library.visible();
      const all = list.length && list.every(e => this.sel.has(e));
      list.forEach(e => this.toggle(e, !all));
      this.renderSelBar();
    }
    renderSelBar() {
      if (!this.selecting) return;
      const L = App.library, items = [...this.sel], n = items.length;
      const withProj = items.filter(e => e.edited || L.projectOf(e)).length;
      const images = items.filter(e => !e.edited).length;
      const all = n && L.visible().every(e => this.sel.has(e));
      this.selBar.hidden = false;
      this.selBar.replaceChildren(...[
        U.iconBtn('x', '선택 끝내기 (Esc)', () => this.exitSelect()),
        h('div', { class: 'g-title' }, h('b', null, n ? `${n}개 선택` : '노트 선택'), h('small', null, 'PC: Ctrl+클릭 · Shift+클릭 · Ctrl+A')),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn small', onclick: () => this.selectAll() }, all ? '전체 해제' : '전체 선택'),
        n === 1 && U.iconBtn('more', '더보기 (이름 바꾸기·폴더 열기·정보)', e => { const t = this.tileOf(items[0]); if (t) { const r = e.currentTarget.getBoundingClientRect(); this.tileMenu(t, r.right - 220, r.bottom + 4); } }),
        withProj > 0 && h('button', { class: 'btn small', title: '원본 이미지는 그대로 두고 편집 기록만 지워요', onclick: () => this.bulkDelete('proj') }, `편집파일 삭제${withProj !== n ? ` (${withProj})` : ''}`),
        images > 0 && h('button', { class: 'btn small danger', title: '이미지와 편집파일을 휴지통으로', onclick: () => this.bulkDelete('trash') }, `휴지통${images !== n ? ` (${images})` : ''}`),
      ].filter(Boolean));
    }
    async bulkDelete(mode) {
      const L = App.library, items = [...this.sel];
      let targets, title, body;
      if (mode === 'proj') {
        targets = items.map(e => (e.edited ? e.project : L.projectOf(e))).filter(Boolean);
        title = `편집파일 ${targets.length}개를 삭제할까요?`;
        body = '레이어 편집 기록만 지워요. 원본 이미지는 그대로 남아요.';
      } else {
        targets = items.filter(e => !e.edited);
        title = `노트 ${targets.length}개를 휴지통으로 옮길까요?`;
        body = `이미지와 편집파일을 ${L.backend.trashToFolder ? `각 폴더의 "${App.project.TRASH_DIR}" 폴더로` : 'Google Drive 휴지통으로'} 옮겨요.`;
      }
      if (!targets.length) return;
      const ok = await U.dialog({ title, body, buttons: [{ label: '취소', value: false }, { label: mode === 'proj' ? '편집파일 삭제' : '휴지통으로', value: true, danger: true, primary: true }] });
      if (!ok) return;
      this.setBusy(true);
      let done = 0, failed = 0;
      for (const t of targets) {
        try { if (mode === 'proj') await L.deleteProject(t); else await L.trash(t); done++; }
        catch (e) { if (e.auth) { App.handleError(e); break; } failed++; console.warn(e); }
      }
      this.setBusy(false);
      this.exitSelect();
      this.render();
      U.toast(`${done}개 ${mode === 'proj' ? '편집파일을 지웠어요 (원본은 그대로)' : '휴지통으로 옮겼어요'}${failed ? ` · ${failed}개 실패` : ''}`);
    }
    bindKeys() {
      window.addEventListener('keydown', e => {
        if (this.root.hidden || document.querySelector('.modal-back, .menu-back')) return;
        if (e.target.matches && e.target.matches('input,textarea,select')) return;
        const combo = App.keys.comboOf(e);
        if (combo === 'escape' && this.selecting) { e.preventDefault(); this.exitSelect(); return; }
        const act = App.keys.actionFor(combo, 'gallery');
        if (!act) return;
        e.preventDefault();
        if (act === 'gallery.refresh') this.reload();
        else if (act === 'gallery.selectAll') { this.enterSelect(); this.selectAll(); }
        else if (act === 'gallery.delete') { if (this.sel.size) this.bulkDelete('trash'); }
        else if (act === 'gallery.deleteProj') { if (this.sel.size) this.bulkDelete('proj'); }
        else if (act === 'gallery.new') App.editor.openNew();
        else if (act === 'gallery.openImage') App.openAnyImage();
      });
    }
    buildBar() {
      this.btnUp = U.iconBtn('back', '저장소 선택', () => App.showHome());
      this.titleEl = h('div', { class: 'g-title' });
      this.bar.replaceChildren(
        this.btnUp, this.titleEl, h('div', { class: 'grow' }),
        U.iconBtn('download', '앱으로 설치', () => App.install(), 'install-only accent'),
        U.iconBtn('image', '이미지 열기 — 어느 폴더의 이미지든 골라서 편집', e => App.openAnyImage(e.currentTarget)),
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

    // ---------- render ----------
    render(focusEntry) {
      const L = App.library, list = L.visible(), cur = L.current;
      this.titleEl.replaceChildren(
        h('b', null, cur ? cur.name : L.filter === 'edited' ? '편집한 노트' : '전체 노트'),
        h('small', null, `${L.backend?.kind === 'drive' ? 'Google Drive' : L.backend?.kind === 'opfs' ? '앱 내부' : 'PC 폴더'} · ${list.length}장${cur ? '' : ` · 폴더 ${L.folders.length}개`}`));
      // folder chips: 전체 + each registered folder (+ add). Long-press / right-click a folder for options.
      const chip = (key, label, count, extra = '') => {
        const b = h('button', {
          class: 'dir-chip' + (L.filter === key ? ' on' : '') + extra, onclick: async () => {
            if (b.longPressed) return;
            const f = L.folderByKey(key);
            if (f && f.needsPermission) {
              // folder access wasn't granted yet: ask now (this tap is the required user gesture)
              if ((await f.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
              f.needsPermission = false;
              await this.reload();
            }
            L.setFilter(key); this.render(); this.scroll.scrollTop = 0;
          },
        },
          h('span', null, label), count != null ? h('small', null, String(count)) : null);
        if (key !== 'all' && key !== 'edited') {
          let t = 0;
          b.addEventListener('pointerdown', e => { b.longPressed = false; t = setTimeout(() => { b.longPressed = true; this.folderMenu(key, e.clientX, e.clientY); }, 500); });
          ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(t)));
          b.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(t); this.folderMenu(key, e.clientX, e.clientY); });
        }
        return b;
      };
      this.dirsEl.replaceChildren(
        chip('all', '전체', L.images.length),
        chip('edited', '편집한 노트', L.projects.size),
        ...L.folders.map(f => chip(f.key, (f.error ? '⚠ ' : '') + f.name, f.count ?? 0, f.error ? ' err' : '')),
        h('button', { class: 'dir-chip add', title: '폴더 추가 — 다른 폴더의 이미지도 함께 보고 편집해요', onclick: () => App.addFolder(), html: App.icon('folderPlus') + '<span>폴더 추가</span>' }));
      this.io.disconnect();
      this.queue = [];
      const frag = document.createDocumentFragment();
      list.forEach((entry, i) => {
        const tile = h('div', { class: 'tile', tabindex: 0 });
        tile.entry = entry;
        tile.idx = i;
        const url = this.urls.get(this.key(entry));
        if (url) tile.append(h('img', { src: url, alt: '', draggable: 'false' }));
        else this.io.observe(tile);
        if (L.hasProject(entry)) tile.append(h('span', { class: 'badge', title: '편집파일 있음', html: App.icon('layers') }));
        if (entry.missing) tile.classList.add('missing');
        tile.append(h('span', { class: 'chk' }));
        if (this.sel.has(entry)) tile.classList.add('sel');
        frag.append(tile);
      });
      this.grid.replaceChildren(frag);
      this.empty.hidden = list.length > 0;
      // selection only keeps notes that are still shown
      if (this.selecting) { for (const e of [...this.sel]) if (!list.includes(e)) this.sel.delete(e); this.renderSelBar(); }
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
    key(entry) {
      if (entry.edited) return entry.entry ? this.key(entry.entry) : 'edited|' + entry.project.name + '|' + entry.project.mtime;
      return App.library.backend.key + '|' + (entry.id || entry.path || (entry.rel && entry.rel.join('/')) || entry.name) + '|' + entry.mtime;
    }
    thumbUrl(entry) { return this.urls.get(this.key(entry)); }
    enqueue(tile) { this.queue.push(tile); this.pump(); }
    pump() {
      const max = App.library.backend?.kind === 'drive' ? 4 : 6;
      while (this.running < max && this.queue.length) {
        const tile = this.queue.shift();
        if (!tile.isConnected) continue;
        this.running++;
        this.loadThumb(tile.entry, tile).then(url => {
          if (url && tile.isConnected && !tile.querySelector('img')) tile.prepend(h('img', { src: url, alt: '', draggable: 'false' }));
        }).catch(e => {
          if (e && e.auth) App.needLogin(); else tile.classList.add('broken');
        }).finally(() => { this.running--; this.pump(); });
      }
    }
    async loadThumb(entry, tile) {
      if (entry.edited) {
        // edited view: find the linked image (follows moves); if it's gone, draw the edit file itself
        const real = await App.library.resolveEdited(entry, false);
        if (real) return this.loadThumb(real);
        tile?.classList.add('missing');
        const k = this.key(entry);
        if (this.urls.has(k)) return this.urls.get(k);
        let blob = await U.idbGet('thumbs', k);
        if (!blob) {
          const { doc } = await App.project.decode(await App.library.backend.read(entry.project));
          const flat = doc.flatten();
          blob = await this.makeThumb(flat, flat.width, flat.height);
          U.idbSet('thumbs', k, blob);
        }
        const url = URL.createObjectURL(blob);
        this.urls.set(k, url);
        return url;
      }
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
    // after a background save: swap the tile's picture for the fresh thumbnail
    refreshEntry(entry) {
      const tile = [...this.grid.children].find(t => t.entry === entry);
      const url = entry && this.thumbUrl(entry);
      if (!tile || !url) return;
      const img = tile.querySelector('img');
      if (img) img.src = url; else tile.prepend(h('img', { src: url, alt: '', draggable: 'false' }));
      if (App.library.hasProject(entry) && !tile.querySelector('.badge')) tile.append(h('span', { class: 'badge', title: '편집파일 있음', html: App.icon('layers') }));
    }
    // called after saving: store the fresh thumbnail right away
    async putThumb(entry, canvas) {
      if (!entry || !App.library.backend) return;
      const k = this.key(entry);
      const blob = await this.makeThumb(canvas, canvas.width, canvas.height);
      U.idbSet('thumbs', k, blob);
      this.urls.set(k, URL.createObjectURL(blob));
      this.refreshEntry(entry);
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

      // tap = open (or toggle while selecting) · long-press = start selecting · right click = menu
      // Ctrl/⌘+click = toggle · Shift+click = select a range
      let press = null;
      this.grid.addEventListener('pointerdown', e => {
        const tile = e.target.closest('.tile');
        if (!tile || e.button > 0) return;
        press = {
          tile, x: e.clientX, y: e.clientY, t: setTimeout(() => {
            press.long = true;
            try { navigator.vibrate?.(15); } catch { /* ignore */ }
            if (!this.selecting) this.enterSelect(tile.entry);
            else { this.toggle(tile.entry); this.renderSelBar(); }
          }, 480),
        };
      });
      const cancel = () => { if (press) { clearTimeout(press.t); press = null; } };
      this.grid.addEventListener('pointermove', e => { if (press && !press.long && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel(); });
      this.grid.addEventListener('pointercancel', cancel);
      this.grid.addEventListener('pointerup', e => {
        if (!press) return;
        const { tile, long } = press;
        cancel();
        if (long || this.pinching) return;
        const entry = tile.entry;
        if (e.shiftKey) { this.enterSelect(); this.selectRange(entry); this.renderSelBar(); return; }
        if (this.selecting || e.ctrlKey || e.metaKey) {
          this.enterSelect();
          this.toggle(entry);
          if (!this.sel.size && !(e.ctrlKey || e.metaKey)) this.exitSelect(); else this.renderSelBar();
          return;
        }
        const list = App.library.visible();
        App.editor.open(list, list.indexOf(entry));
      });
      this.grid.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (e.pointerType === 'touch' || e.pointerType === 'pen') return; // long-press is handled above
        const tile = e.target.closest('.tile');
        cancel();
        if (tile) this.tileMenu(tile, e.clientX, e.clientY);
      });
      this.grid.addEventListener('keydown', e => {
        const tile = e.target.closest('.tile');
        if (tile && e.key === 'Enter') { const list = App.library.visible(); App.editor.open(list, list.indexOf(tile.entry)); }
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
      const proj = entry.edited ? entry.project : L.projectOf(entry);
      const v = await U.menu([
        { label: entry.name, value: null },
        '-',
        { label: '열기', value: 'open' },
        !this.selecting && { label: '선택 (여러 개 고르기)', value: 'select' },
        { label: '이미지가 있는 폴더 열기', value: 'folder' },
        !entry.edited && { label: '이름 바꾸기', value: 'rename' },
        { label: '정보', value: 'info' },
        '-',
        proj && { label: '편집파일만 삭제 (원본 이미지는 그대로)', value: 'delproj', danger: true },
        !entry.edited && { label: `이미지와 편집파일을 ${L.backend.trashToFolder ? '휴지통 폴더로' : 'Drive 휴지통으로'}`, value: 'trash', danger: true },
      ], x, y);
      try {
        if (v === 'open') { this.exitSelect(true); const list = L.visible(); App.editor.open(list, list.indexOf(entry)); }
        else if (v === 'select') this.enterSelect(entry);
        else if (v === 'folder') App.openFolderOf(entry);
        else if (v === 'delproj') {
          const ok = await U.dialog({ title: '편집파일만 삭제할까요?', body: `"${entry.name}"의 레이어 편집 기록만 지워요. 원본 이미지는 그대로 남아요.`, buttons: [{ label: '취소', value: false }, { label: '편집파일 삭제', value: true, danger: true, primary: true }] });
          if (ok) { await L.deleteProject(proj); this.render(); U.toast('편집파일을 지웠어요 (원본은 그대로)'); }
        } else if (v === 'info' && entry.edited) {
          const real = await L.resolveEdited(entry, true);
          U.dialog({ title: entry.name, body: `원본: ${real ? (L.relOf(real) || [real.dir.name, real.name]).join(' / ') : '찾을 수 없음'}\n편집파일: ${entry.project.name}\n편집파일 저장: ${U.fmtDate(entry.project.mtime)}` });
        } else if (v === 'rename') {
          const n = await U.dialog({ title: '이름 바꾸기', input: { value: U.baseName(entry.name) }, buttons: [{ label: '취소', value: null }, { label: '확인', value: true, primary: true }] });
          if (n) { await L.rename(entry, n); this.render(); }
        } else if (v === 'info') {
          U.dialog({ title: entry.name, body: `폴더: ${entry.dir.name}\n수정: ${U.fmtDate(entry.mtime)}\n크기: ${Math.round((entry.size || 0) / 1024)} KB\n편집파일: ${L.hasProject(entry) ? `있음 (앱 폴더 "${L.appDir.name}")` : '없음 (처음 저장할 때 생성)'}` });
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
    async folderMenu(key, x, y) {
      const S = App.settings, f = App.library.folderByKey(key);
      if (!f) return;
      const isTarget = (App.library.folderByKey(S.newNoteFolder) || App.library.folders[0]) === f;
      const v = await U.menu([
        { label: f.name + (f.error ? ` — ${f.error}` : ''), value: null }, '-',
        { label: '새 노트를 이 폴더에 저장', value: 'target', checked: isTarget },
        { label: '목록에서 빼기', value: 'remove', danger: true },
      ], x, y);
      if (v === 'target') { S.newNoteFolder = key; App.saveSettings(); U.toast(`새 노트는 "${f.name}"에 저장돼요 (전체 보기일 때)`); }
      else if (v === 'remove') App.removeFolder(key);
    }
  }

  function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  App.gallery = new Gallery();
})();
