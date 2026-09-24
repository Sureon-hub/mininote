'use strict';
// .mnote project format + library (several image folders, one app folder for edit files).
//
// Layout:
//   <any image folder>/note.png                    <- the image everyone sees (overwritten on save)
//   <app folder>/<folder name>__note.png.mnote     <- layered, editable project for that image
//   <folder>/_휴지통/                               <- local trash (Drive uses its own trash)
(() => {
  const U = App.util;
  const EDIT_DIR = '_편집파일';
  const TRASH_DIR = '_휴지통';
  const EXT = '.mnote';
  const MAGIC = 'MNOTE001';

  // ---------------- .mnote binary format ----------------
  // [8 bytes magic][uint32 LE header length][header JSON][layer image blobs...]
  // Layers are lossless PNGs, except a background layer that is still exactly the original image: that one keeps
  // the original file's bytes (e.g. the 1 MB JPG instead of a 10 MB PNG of it) – same pixels, much smaller file.
  // fingerprint of a layer's pixels, to know whether it still is the untouched original
  const pixelSum = L => {
    const d = new Uint32Array(L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height).data.buffer);
    let a = 0x811c9dc5 | 0, s = 0;
    for (let i = 0; i < d.length; i++) { a = Math.imul(a ^ d[i], 16777619); s = (s + d[i]) | 0; }
    return a + ':' + s;
  };
  const keepSource = (L, blob) => { L.src = blob; L.srcSum = pixelSum(L); };
  App.project = {
    EDIT_DIR, TRASH_DIR, EXT,
    async encode(doc, image) {
      const blobs = await Promise.all(doc.layers.map(L =>
        (L.src && L.src.size && pixelSum(L) === L.srcSum ? L.src : U.canvasToBlob(L.canvas, 'image/png'))));
      let off = 0;
      const layers = doc.layers.map((L, i) => {
        const m = { name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, alphaLock: L.alphaLock, border: L.border, text: L.text || undefined, offset: off, length: blobs[i].size };
        if (blobs[i] === L.src) m.fmt = L.src.type || 'image/jpeg';
        off += blobs[i].size;
        return m;
      });
      const header = { app: 'mininote', version: 1, width: doc.w, height: doc.h, active: doc.layers.indexOf(doc.active), image, savedAt: Date.now(), layers };
      const hb = new TextEncoder().encode(JSON.stringify(header));
      const pre = new Uint8Array(12);
      pre.set(new TextEncoder().encode(MAGIC));
      new DataView(pre.buffer).setUint32(8, hb.length, true);
      return new Blob([pre, hb, ...blobs], { type: 'application/octet-stream' });
    },
    async decode(blob) {
      const buf = await blob.arrayBuffer();
      if (new TextDecoder().decode(new Uint8Array(buf, 0, 8)) !== MAGIC) throw new Error('편집파일 형식이 아닙니다');
      const hl = new DataView(buf).getUint32(8, true);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hl)));
      const base = 12 + hl;
      const doc = new App.Doc(header.width, header.height);
      for (const m of header.layers) {
        const L = doc.createLayer(m.name);
        Object.assign(L, { visible: m.visible !== false, opacity: m.opacity ?? 1, blend: m.blend || 'source-over', alphaLock: !!m.alphaLock });
        if (m.border) L.border = { ...L.border, ...m.border };
        if (m.text) L.text = m.text;
        if (m.length) {
          const lb = new Blob([new Uint8Array(buf, base + m.offset, m.length)], { type: m.fmt || 'image/png' });
          const bmp = await createImageBitmap(lb);
          L.ctx.drawImage(bmp, 0, 0);
          bmp.close?.();
          if (m.fmt) keepSource(L, lb);
        }
        doc.layers.push(L);
      }
      doc.active = doc.layers[header.active] || doc.layers[doc.layers.length - 1];
      return { doc, header };
    },
  };

  async function docFromImageBlob(blob) {
    const bmp = await createImageBitmap(blob);
    const doc = new App.Doc(bmp.width, bmp.height);
    const L = doc.createLayer('배경');
    L.ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    if (blob.size) keepSource(L, blob.type ? blob : new Blob([blob], { type: U.mime(blob.name || '') }));
    // draw on an empty layer above the image, so the original stays untouched
    const L1 = doc.createLayer('레이어 1');
    doc.layers.push(L, L1);
    doc.active = L1;
    return doc;
  }

  // header only (no layer decoding) – used to find a moved original
  App.project.readHeader = async blob => {
    const buf = await blob.slice(0, 1 << 20).arrayBuffer();
    const hl = new DataView(buf).getUint32(8, true);
    const head = hl + 12 <= buf.byteLength ? buf : await blob.slice(0, hl + 12).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(new Uint8Array(head, 12, hl)));
  };

  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '_');
  const SEP = '＞'; // edit file name = image path below the base folder, e.g. "일기＞2026＞0924.png.mnote"

  // ---------------- library ----------------
  // Registered image folders are shown together; every edit file lives in ONE app folder.
  // With a base folder (root, e.g. "내 드라이브") an edit file remembers its image by path, so the
  // "편집한 노트" view works without registering folders, and a moved image is found again.
  const lib = App.library = {
    backend: null, folders: [], appDir: null, root: null,
    images: [], projects: new Map(), filter: 'all',

    setup(backend, folders, appDir, root) {
      this.backend = backend; this.folders = folders; this.appDir = appDir; this.root = root || null;
      this.images = []; this.projects = new Map(); this._edited = null; this._dirs = new Map(); this._relinks = new Map();
      const f = App.settings.folderFilter;
      this.filter = f === 'edited' || folders.some(x => x.key === f) ? f : 'all';
    },
    folderByKey(k) { return this.folders.find(f => f.key === k) || null; },
    get current() { return this.folderByKey(this.filter); },
    setFilter(k) { this.filter = k; App.settings.folderFilter = k; App.saveSettings(); },
    visible() {
      if (this.filter === 'edited') return this.edited();
      const f = this.current;
      return f ? this.images.filter(e => e.dir === f) : this.images;
    },
    // where new notes / shared images go
    targetFolder() { return this.current || this.folderByKey(App.settings.newNoteFolder) || this.folders[0]; },

    async refresh() {
      const b = this.backend;
      await Promise.all(this.folders.map(f => this.relOfDir(f)));
      const lists = await Promise.all(this.folders.map(async f => {
        if (f.needsPermission) { f.error = '권한 필요 — 눌러서 허용'; return []; }
        try {
          f.error = null;
          return (await b.list(f)).filter(e => e.kind === 'file' && U.isImage(e.name))
            .map(e => Object.assign(e, { dir: f, rel: f.rel ? [...f.rel, e.name] : null }));
        } catch (e) {
          if (e.auth) throw e;
          f.error = e.message || String(e);
          return [];
        }
      }));
      this.images = lists.flat();
      for (const f of this.folders) f.count = this.images.filter(e => e.dir === f).length;
      this.projects = new Map();
      if (this.appDir) {
        try { for (const p of await b.list(this.appDir)) if (p.kind === 'file' && p.name.endsWith(EXT)) this.projects.set(p.name, p); }
        catch (e) { if (e.auth) throw e; }
      }
      this._edited = null;
      this.sort();
    },
    sort() {
      const s = App.settings.sort;
      const f = {
        'mtime-desc': (a, b) => b.mtime - a.mtime,
        'mtime-asc': (a, b) => a.mtime - b.mtime,
        'name-asc': byName,
        'name-desc': (a, b) => byName(b, a),
      }[s] || ((a, b) => b.mtime - a.mtime);
      this.images.sort(f);
      if (this._edited) this._edited.sort(f);
    },

    // ---- paths below the base folder ----
    async relOfDir(dir) {
      if (dir.rel !== undefined) return dir.rel;
      let rel = null;
      try {
        if (this.root && this.backend.kind === 'drive') rel = await this.backend.pathFromRoot(dir.id);
        else if (this.root && dir.handle && this.root.handle) rel = await this.root.handle.resolve(dir.handle);
      } catch { rel = null; }
      dir.rel = rel;
      return rel;
    },
    relOf(entry) { return entry.rel || (entry.dir && entry.dir.rel ? [...entry.dir.rel, entry.name] : null); },
    // the image file at a path below the base folder (null if it isn't there)
    async resolveRel(rel) {
      if (!this.root || !rel || !rel.length) return null;
      const b = this.backend;
      let dir = this.root;
      for (let i = 0; i < rel.length - 1; i++) {
        const key = rel.slice(0, i + 1).join('/');
        let d = this._dirs.get(key);
        if (!d) {
          d = await b.findDir(dir, rel[i], false);
          if (!d) return null;
          d.rel = rel.slice(0, i + 1);
          d.path = '/r/' + key;
          this._dirs.set(key, d);
        }
        dir = d;
      }
      const f = await b.find(dir, rel[rel.length - 1]);
      if (!f) return null;
      return Object.assign(f, { dir, rel });
    },

    // ---- edit file names ----
    projNameFor(entry) {
      const rel = this.relOf(entry);
      if (rel) return rel.map(safe).join(SEP) + EXT;
      if (entry.dir && entry.dir.external) return '외부' + SEP + safe(entry.name) + EXT;
      return `${safe(entry.dir.name)}__${entry.name}${EXT}`;
    },
    // older names: "<folder>__<image>.mnote" (v0.6) and "<image>.mnote" in the first folder's _편집파일 (≤ v0.5)
    projectOf(entry) {
      const p = this.projects.get(this.projNameFor(entry));
      if (p || !entry.dir || !entry.dir.key) return p || null;
      const legacy = this.appDir && this.appDir.ownerKey === entry.dir.key ? entry.name + EXT : null;
      return this.projects.get(`${safe(entry.dir.name)}__${entry.name}${EXT}`) || (legacy && this.projects.get(legacy)) || null;
    },
    hasProject(entry) { return entry.edited || !!this.projectOf(entry); },

    // ---- "편집한 노트": every edit file in the app folder, wherever its image lives ----
    edited() {
      if (this._edited) return this._edited;
      const out = [];
      for (const p of this.projects.values()) {
        const base = p.name.slice(0, -EXT.length);
        let rel = null, name, external = false;
        if (base.includes(SEP)) {
          const parts = base.split(SEP);
          if (parts[0] === '외부' && parts.length === 2) { external = true; name = parts[1]; }
          else { rel = parts; name = parts[parts.length - 1]; }
        } else if (base.includes('__')) name = base.slice(base.indexOf('__') + 2);
        else { name = base; rel = [base]; } // an image directly in the base folder
        const match = this.images.find(e => this.projectOf(e) === p) || null;
        out.push({ kind: 'file', edited: true, name, rel: match ? this.relOf(match) : rel, project: p, entry: match, external, mtime: match ? match.mtime : p.mtime, size: match ? match.size : 0 });
      }
      this._edited = out;
      this.sort();
      return out;
    },
    // find the real image behind an edited entry (follows moves); interactive = may ask for file permission
    async resolveEdited(e, interactive) {
      if (e.entry) return e.entry;
      let f = null;
      if (e.rel) f = await this.resolveRel(e.rel).catch(() => null);
      if (!f && e.external) f = await this.externalEntry(e.project.name, interactive);
      // on this PC a search can take a while, so it only runs when the note is actually opened (not for thumbnails)
      if (!f && (interactive || this.backend.kind === 'drive')) f = await this.relinkOnce(e);
      if (f) { e.entry = f; e.mtime = f.mtime; e.size = f.size; e.missing = false; } else e.missing = true;
      return f;
    },
    // a file outside the base folder on this PC: its handle is remembered in this browser only
    async externalEntry(pname, interactive) {
      const fh = await U.idbGet('kv', 'ext:' + pname);
      if (!fh) return null;
      const opts = { mode: 'readwrite' };
      if ((await fh.queryPermission(opts)) !== 'granted' && (!interactive || (await fh.requestPermission(opts)) !== 'granted')) return null;
      const file = await fh.getFile();
      return { kind: 'file', name: fh.name, handle: fh, mtime: file.lastModified, size: file.size, dir: { kind: 'dir', name: '외부 파일', external: true } };
    },
    // one search per edit file at a time: the gallery thumbnail, the preloader and a tap can all ask at once,
    // and the later ones wait for the running search instead of giving up
    async relinkOnce(e) {
      if (!e.relinkP) {
        const k = e.project.name;
        let p = this._relinks.get(k);
        if (!p) {
          p = this.relink(e);
          this._relinks.set(k, p);
          p.catch(() => {}).finally(() => this._relinks.delete(k));
        } else {
          p = p.then(f => {
            if (f) { e.rel = this.relOf(f); e.project = this.projects.get(this.projNameFor(f)) || e.project; }
            return f;
          });
        }
        e.relinkP = p;
      }
      return e.relinkP.catch(err => { if (err.auth) throw err; return null; });
    },
    // the original was moved or renamed: look for it again and fix the link (edit file gets the new name)
    async relink(e) {
      const b = this.backend;
      const header = await App.project.readHeader(await b.read(e.project));
      const im = header.image || {};
      let f = null;
      if (b.kind === 'drive') {
        if (im.driveId) f = await b.fileById(im.driveId);
        if (!f) { const c = await b.searchImages(im.name || e.name); if (c.length === 1) f = c[0]; }
        if (f) {
          const rel = await b.pathFromRoot(f.parentId);
          const pm = await b.meta(f.parentId);
          f.dir = { kind: 'dir', id: f.parentId, name: pm.name, rel };
          f.rel = rel ? [...rel, f.name] : null;
        }
      } else if (this.root && this.root.handle) {
        f = await this.locate(im.name || e.name, im.hash, im.rel);
      }
      if (!f) return null;
      e.rel = this.relOf(f);
      const newName = this.projNameFor(f);
      if (newName !== e.project.name && !this.projects.has(newName)) {
        const np = await b.rename(this.appDir, e.project, newName);
        this.projects.delete(e.project.name);
        this.projects.set(np.name, np);
        e.project = np;
        U.toast(`"${f.name}"이(가) 옮겨진 위치를 찾아서 연결을 고쳤어요`);
      }
      return f;
    },
    // an edit file for an image with the same name whose last saved image is exactly this one, and which no
    // longer has an image at its own path (= the image was moved). Saving then renames it to the new path.
    async adoptProject(entry) {
      const b = this.backend, own = this.projNameFor(entry), tail = safe(entry.name) + EXT;
      const cands = [...this.projects.values()].filter(p => p.name !== own && (p.name.endsWith(SEP + tail) || p.name.endsWith('__' + entry.name + EXT) || p.name === tail));
      if (!cands.length) return null;
      const hash = await U.hash(await b.read(entry));
      for (const p of cands) {
        const im = (await App.project.readHeader(await b.read(p))).image || {};
        if (im.hash !== hash) continue;
        if (im.rel && await this.resolveRel(im.rel).catch(() => null)) continue; // its own image is still there: a copy
        return p;
      }
      return null;
    },
    // ---- finding a moved original on this PC (fastest first) ----
    //  1. direct look-ups in likely folders: recently used ones, the collection's folders, the folders around
    //     the old place and the top folders of the base folder
    //  2. Google Drive's own search, when this PC is logged in to Google (instant; path → local file)
    //  3. last resort: walk every folder below the base folder, stopping at the first file with the same content
    async locate(name, hash, oldRel) {
      const b = this.backend;
      const same = async c => !hash || (await U.hash(await b.read(c))) === hash;
      const dirs = [], seen = new Set();
      const add = r => { if (r && !seen.has(r.join('/'))) { seen.add(r.join('/')); dirs.push(r); } };
      for (const r of App.settings.recentDirs || []) add(r);
      for (const f of this.folders) add(f.rel);
      const around = [];
      if (oldRel) for (let i = oldRel.length - 2; i >= 0; i--) around.push(oldRel.slice(0, i));
      if (!around.length) around.push([]);
      for (const r of around) {
        add(r);
        const d = await this.dirAtRel(r);
        if (d) try { for await (const h of d.handle.values()) if (h.kind === 'directory' && !/^[._]/.test(h.name)) add([...r, h.name]); } catch { /* ignore */ }
      }
      let loose = null;
      for (const r of dirs) {
        const d = await this.dirAtRel(r);
        const c = d && await b.find(d, name);
        if (!c) continue;
        Object.assign(c, { dir: d, rel: [...r, name] });
        if (await same(c)) return c;
        loose = loose || c;
      }
      if (App.settings.driveClientId && App.driveAuth && App.driveAuth.valid()) {
        try {
          const g = new App.DriveBackend({ id: 'root', name: '내 드라이브' });
          for (const x of await g.searchImages(name)) {
            const rel = x.parentId && await g.pathFromRoot(x.parentId);
            const c = rel && await this.resolveRel([...rel, name]).catch(() => null);
            if (c && await same(c)) return c;
          }
        } catch (err) { console.warn(err); }
      }
      U.toast('옮겨진 원본을 찾는 중이에요… (폴더가 많으면 조금 걸려요)');
      const cands = await this.findUnderRoot(name, same);
      return cands.find(c => c.exact) || (cands.length === 1 ? cands[0] : loose);
    },
    // a folder below the base folder by its path (null if it isn't there)
    async dirAtRel(rel) {
      if (!this.root) return null;
      let d = Object.assign({}, this.root, { rel: [] });
      for (let i = 0; i < rel.length; i++) {
        const key = rel.slice(0, i + 1).join('/');
        let n = this._dirs.get(key);
        if (!n) {
          n = await this.backend.findDir(d, rel[i], false).catch(() => null);
          if (!n) return null;
          n.rel = rel.slice(0, i + 1);
          this._dirs.set(key, n);
        }
        d = n;
      }
      return d;
    },
    rememberDir(rel) {
      if (!rel || !this.root) return;
      const S = App.settings, k = rel.join('/');
      if (S.recentDirs && S.recentDirs[0] && S.recentDirs[0].join('/') === k) return;
      S.recentDirs = [rel, ...(S.recentDirs || []).filter(r => r.join('/') !== k)].slice(0, 20);
      App.saveSettings();
    },
    // breadth-first search for image files with this name below the base folder (skips _ and . folders);
    // `accept` (optional) ends the search at the first file it approves (marked .exact)
    async findUnderRoot(name, accept, limit = 4000) {
      const b = this.backend, out = [], queue = [Object.assign({}, this.root, { rel: [] })];
      let seen = 0;
      while (queue.length && seen < limit) {
        const d = queue.shift();
        seen++;
        if (d.handle && b.kind !== 'drive') {
          // on this PC: only look at names (reading every file's details on a Drive-synced disk is slow)
          try {
            for await (const h of d.handle.values()) {
              if (h.kind === 'directory') { if (!/^[._]/.test(h.name)) queue.push({ kind: 'dir', name: h.name, handle: h, path: d.path + '/' + h.name, rel: [...d.rel, h.name] }); }
              else if (h.name === name) {
                const c = Object.assign(await b.fileEntry(h, d), { dir: d, rel: [...d.rel, h.name] });
                if (accept && await accept(c)) { c.exact = true; return [c]; }
                out.push(c);
              }
            }
          } catch { /* unreadable folder */ }
          continue;
        }
        let items;
        try { items = await b.list(d); } catch { continue; }
        for (const it of items) {
          if (it.kind === 'dir') { if (!/^[._]/.test(it.name)) queue.push(Object.assign(it, { rel: [...d.rel, it.name] })); }
          else if (it.name === name) out.push(Object.assign(it, { dir: d, rel: [...d.rel, it.name] }));
        }
      }
      return out;
    },

    // re-read the edit file until it belongs to this image (hash), for up to ~1 minute; the user can stop waiting
    async waitForProject(p, imgHash) {
      const b = this.backend;
      let stop = false;
      const back = U.h('div', { class: 'modal-back' },
        U.h('div', { class: 'modal' },
          U.h('h3', null, '최신 편집 내용을 받는 중…'),
          U.h('p', null, '다른 기기에서 저장한 편집파일이 구글 드라이브로 올라오는 중이에요. 도착하면 바로 열어요.'),
          U.h('div', { class: 'modal-btns' }, U.h('button', { class: 'btn', onclick: () => { stop = true; } }, '기다리지 않기'))));
      document.body.append(back);
      try {
        for (let i = 0; i < 30 && !stop; i++) {
          await new Promise(r => { const t = setTimeout(r, i ? 2000 : 300); const iv = setInterval(() => { if (stop) { clearTimeout(t); clearInterval(iv); r(); } }, 100); setTimeout(() => clearInterval(iv), 2100); });
          if (stop) break;
          const cur = (b.kind === 'drive' ? await b.fileById(p.id).catch(() => null) : null) || p;
          const blob = await b.read(cur).catch(() => null);
          if (!blob) continue;
          const head = await App.project.readHeader(blob).catch(() => null);
          if (head && head.image && head.image.hash === imgHash) return App.project.decode(blob);
        }
        return null;
      } finally { back.remove(); }
    },

    // -------- open --------
    // opts.quiet: used for background preloading – never shows a dialog, returns null instead
    async open(entry, opts = {}) {
      let proj = null;
      if (entry.edited) {
        proj = entry.project;
        const real = await this.resolveEdited(entry, !opts.quiet);
        if (!real) { if (opts.quiet) return null; return this.openOrphan(entry); }
        entry = real;
      }
      const b = this.backend, dir = entry.dir;
      const ctx = { backend: b, dir, image: entry, name: entry.name, project: proj || this.projectOf(entry) };
      if (!opts.quiet) this.rememberDir(dir.rel);
      // no edit file under this path: maybe the image was moved here and its edit file still has the old path
      if (!ctx.project) ctx.project = await this.adoptProject(entry).catch(() => null);
      if (!ctx.project && dir.key) {
        // edit file left by an older version inside the image's own folder
        const old = await b.findDir(dir, EDIT_DIR, false).catch(() => null);
        if (old) ctx.project = await b.find(old, entry.name + EXT).catch(() => null);
      }
      if (ctx.project) {
        let data = null;
        try { data = await App.project.decode(await b.read(ctx.project)); }
        catch (e) { console.warn(e); U.toast('편집파일을 읽지 못해 원본 이미지로 엽니다'); }
        if (data) {
          const im = data.header.image || {};
          const maybeChanged = (entry.mtime && im.mtime && entry.mtime > im.mtime + 3000) || (im.size && entry.size && im.size !== entry.size);
          if (maybeChanged) {
            if (opts.quiet) return null;
            const imgBlob = await b.read(entry);
            const imgHash = await U.hash(imgBlob);
            // the image is newer than the edit file: usually the other device saved both and the (much bigger)
            // edit file is still on its way through Google Drive → wait for it and open the newest version.
            // (edit file newer than the image = the image is the one still syncing → just open the edit file)
            const imageNewer = !data.header.savedAt || !entry.mtime || entry.mtime > data.header.savedAt + 3000;
            let choice = imgHash === im.hash || !imageNewer ? 'project' : 'wait';
            while (choice === 'wait') {
              const fresh = await this.waitForProject(ctx.project, imgHash);
              if (fresh) { data = fresh; choice = 'project'; U.toast('다른 기기에서 저장한 최신 편집 내용으로 열었어요'); break; }
              choice = await U.dialog({
                title: '원본 이미지가 편집파일보다 새로워요',
                body: `"${entry.name}"이(가) 편집파일을 마지막으로 저장한 뒤에 바뀌었어요.\n• 다른 기기에서 미니수첩으로 저장했다면: 편집파일이 아직 구글 드라이브로 올라가는 중이에요. "다시 기다리기"를 눌러 주세요.\n• 다른 앱에서 이미지를 고쳤다면: 아래에서 고르세요.`,
                buttons: [
                  { label: '다시 기다리기', value: 'wait', primary: true },
                  { label: '원본을 새 레이어로 추가', value: 'layer' },
                  { label: '원본 이미지로 새로 시작', value: 'image' },
                  { label: '편집파일 그대로', value: 'project' },
                ],
              });
            }
            {
              if (choice === 'image') return { doc: await docFromImageBlob(imgBlob), ctx };
              if (choice === 'layer') {
                const bmp = await createImageBitmap(imgBlob);
                const L = data.doc.createLayer('원본 (외부 수정)');
                L.ctx.drawImage(bmp, 0, 0, data.doc.w, data.doc.h);
                data.doc.layers.push(L);
                data.doc.active = L;
                data.externalChange = true;
              }
            }
          }
          return { doc: data.doc, ctx, dirty: !!data.externalChange };
        }
      }
      return { doc: await docFromImageBlob(await b.read(entry)), ctx };
    },
    // edit file whose image can't be found: open it anyway; saving creates a new image in the target folder
    async openOrphan(e) {
      const { doc } = await App.project.decode(await this.backend.read(e.project));
      const dir = this.targetFolder();
      U.dialog({ title: '원본 이미지를 찾지 못했어요', body: `"${e.name}"의 원본이 지워졌거나 이 기기에서 접근할 수 없어요.\n편집파일로 열었고, 저장하면 "${dir.name}" 폴더에 새 이미지로 저장돼요.` });
      return { doc, ctx: { backend: this.backend, dir, image: null, name: e.name, project: e.project } };
    },

    newDoc() {
      const { w, h, bg } = App.settings.newNote;
      const doc = new App.Doc(w, h);
      const L0 = doc.createLayer('배경');
      if (bg) { L0.ctx.fillStyle = bg; L0.ctx.fillRect(0, 0, w, h); }
      const L1 = doc.createLayer('레이어 1');
      doc.layers.push(L0, L1);
      doc.active = L1;
      const ctx = { backend: this.backend, dir: this.targetFolder(), image: null, name: `${U.noteStamp()}_미니노트.png`, project: null };
      return { doc, ctx };
    },
    // a new note whose background is an image (shared from another app, dropped, picked…)
    async newDocFromImage(blob) {
      const doc = await docFromImageBlob(blob);
      const ctx = { backend: this.backend, dir: this.targetFolder(), image: null, name: `${U.noteStamp()}_가져온이미지.png`, project: null };
      return { doc, ctx };
    },

    // -------- save: overwrite the image where it lives + write the edit file into the app folder --------
    async save(doc, ctx) {
      const b = ctx.backend;
      if (!this.appDir) throw new Error('앱 폴더(편집파일 보관 위치)가 없어요');
      const flat = doc.flatten();
      const mime = U.mime(ctx.name);
      let out = flat;
      if (mime === 'image/jpeg') {
        out = U.canvas(doc.w, doc.h);
        const c = out.getContext('2d');
        c.fillStyle = '#fff'; c.fillRect(0, 0, doc.w, doc.h); c.drawImage(flat, 0, 0);
      }
      const imgBlob = await U.canvasToBlob(out, mime, mime === 'image/png' ? undefined : App.settings.jpegQuality);
      const hash = await U.hash(imgBlob);
      // on this PC the original may have been moved since it was opened: writing to the old handle would
      // bring it back to the old place, so find where it went first (Drive files follow moves by id)
      let moved = false;
      if (ctx.image && ctx.image.handle && b.kind !== 'drive' && await ctx.image.handle.getFile().then(() => false, e => e.name === 'NotFoundError')) {
        moved = await this.followMoved(ctx);
      }

      const written = await b.write(ctx.dir, ctx.name, imgBlob, ctx.image);
      this.rememberDir(ctx.dir.rel);
      const isNew = !ctx.image;
      const rel = ctx.dir.rel ? [...ctx.dir.rel, ctx.name] : (ctx.image && ctx.image.rel) || null;
      if (ctx.image) Object.assign(ctx.image, written, { rel }); else ctx.image = Object.assign(written, { dir: ctx.dir, rel });

      const projName = this.projNameFor(ctx.image);
      // an older-style name for the same image → rename it instead of leaving a duplicate
      // (compared by name: a gallery refresh meanwhile replaces the entries in this.projects)
      if (ctx.project && ctx.project.name !== projName && this.projects.has(ctx.project.name) && !this.projects.has(projName)) {
        const np = await b.rename(this.appDir, this.projects.get(ctx.project.name), projName);
        this.projects.delete(ctx.project.name);
        ctx.project = np;
      }
      const existing = this.projects.get(projName) || (ctx.project && ctx.project.name === projName ? ctx.project : null) || await b.find(this.appDir, projName);
      const projBlob = await App.project.encode(doc, {
        name: ctx.name, folder: ctx.dir.name, rel, driveId: b.kind === 'drive' ? ctx.image.id : undefined,
        mtime: written.mtime, size: written.size || imgBlob.size, hash,
      });
      ctx.project = await b.write(this.appDir, projName, projBlob, existing);
      this.projects.set(projName, ctx.project);
      if (ctx.dir.external && ctx.image.handle) U.idbSet('kv', 'ext:' + projName, ctx.image.handle);
      this._edited = null;

      if (isNew && this.folders.includes(ctx.dir)) {
        this.images.push(ctx.image);
        ctx.dir.count = (ctx.dir.count || 0) + 1;
        this.sort();
      }
      App.gallery?.putThumb(ctx.image, flat);
      if (moved) App.gallery?.reload?.();
      return ctx.image;
    },
    // the original isn't where it was: look for it below the base folder (same name, same content as the last
    // save); otherwise ask where to save. Returns true when ctx now points somewhere else.
    async followMoved(ctx) {
      const b = ctx.backend, old = ctx.image;
      let f = null;
      if (this.root && this.root.handle) {
        let hash = null;
        if (ctx.project) try { hash = ((await App.project.readHeader(await b.read(ctx.project))).image || {}).hash; } catch { /* ignore */ }
        f = await this.locate(old.name, hash, old.rel || (ctx.dir && ctx.dir.rel ? [...ctx.dir.rel, old.name] : null));
      }
      if (f) {
        this.images = this.images.filter(e => e !== old);
        ctx.image = f; ctx.dir = f.dir;
        U.toast(`"${f.name}"이(가) 옮겨진 곳(${f.rel.slice(0, -1).join(' › ') || f.dir.name})을 찾아서 그 자리에 저장했어요`);
        return true;
      }
      const target = this.folderByKey(App.settings.newNoteFolder) || this.folders[0];
      const choice = await U.dialog({
        title: '원본 이미지가 원래 자리에 없어요',
        body: `"${old.name}"이(가) 옮겨졌거나 지워졌어요${this.root ? ` ("${this.root.name}" 안에서도 찾지 못했어요)` : ''}.\n어디에 저장할까요?`,
        buttons: [{ label: '원래 자리에 다시 만들기', value: 'old' }, { label: `"${target.name}"에 저장`, value: 'new', primary: true }],
      });
      if (choice !== 'new') return false;
      this.images = this.images.filter(e => e !== old);
      ctx.dir = target; ctx.image = null;
      ctx.name = await this.freeName(b, target, old.name);
      return true;
    },

    // -------- manage --------
    async freeName(b, dir, name) {
      if (!(await b.find(dir, name))) return name;
      return `${U.baseName(name)}_${U.stamp()}.${U.ext(name)}`;
    },
    // delete ONLY the edit file (the image stays as it is)
    async deleteProject(p) {
      const b = this.backend;
      if (b.trashToFolder) {
        const tp = await b.findDir(this.appDir, TRASH_DIR, true);
        await b.write(tp, await this.freeName(b, tp, p.name), await b.read(p));
      }
      await b.remove(this.appDir, p);
      this.projects.delete(p.name);
      this._edited = null;
    },
    // image AND its edit file to the trash
    async trash(entry) {
      const b = this.backend, dir = entry.dir;
      const proj = this.projectOf(entry);
      if (b.trashToFolder) {
        const t = await b.findDir(dir, TRASH_DIR, true);
        await b.write(t, await this.freeName(b, t, entry.name), await b.read(entry));
        await b.remove(dir, entry);
      } else await b.remove(dir, entry);
      if (proj) await this.deleteProject(proj);
      this.images = this.images.filter(e => e !== entry);
      this._edited = null;
      dir.count = Math.max(0, (dir.count || 1) - 1);
    },
    async rename(entry, newBase) {
      const b = this.backend, dir = entry.dir;
      const newName = newBase.trim() + '.' + U.ext(entry.name);
      if (!newBase.trim() || /[\\/:*?"<>|]/.test(newBase)) throw new Error('사용할 수 없는 이름입니다');
      if (newName === entry.name) return;
      if (this.images.some(e => e.dir === dir && e.name === newName)) throw new Error('같은 이름의 이미지가 이미 있습니다');
      const proj = this.projectOf(entry);
      Object.assign(entry, await b.rename(dir, entry, newName), { dir, rel: dir.rel ? [...dir.rel, newName] : null });
      if (proj) {
        const np = await b.rename(this.appDir, proj, this.projNameFor(entry));
        this.projects.delete(proj.name);
        this.projects.set(np.name, np);
      }
      this._edited = null;
    },
  };
  lib.docFromImageBlob = docFromImageBlob;
})();
