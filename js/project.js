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
  // [8 bytes magic][uint32 LE header length][header JSON][layer PNG blobs...]
  App.project = {
    EDIT_DIR, TRASH_DIR, EXT,
    async encode(doc, image) {
      const blobs = await Promise.all(doc.layers.map(L => U.canvasToBlob(L.canvas, 'image/png')));
      let off = 0;
      const layers = doc.layers.map((L, i) => {
        const m = { name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, alphaLock: L.alphaLock, border: L.border, text: L.text || undefined, offset: off, length: blobs[i].size };
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
          const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, base + m.offset, m.length)], { type: 'image/png' }));
          L.ctx.drawImage(bmp, 0, 0);
          bmp.close?.();
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
    // draw on an empty layer above the image, so the original stays untouched
    const L1 = doc.createLayer('레이어 1');
    doc.layers.push(L, L1);
    doc.active = L1;
    return doc;
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '_');

  // ---------------- library ----------------
  // Several image folders are shown together. Every edit file lives in ONE app folder (appDir),
  // named "<folder name>__<image name>.mnote"; saving still overwrites the image in its own folder.
  const lib = App.library = {
    backend: null, folders: [], appDir: null,
    images: [], projects: new Map(), filter: 'all',

    setup(backend, folders, appDir) {
      this.backend = backend; this.folders = folders; this.appDir = appDir;
      this.images = []; this.projects = new Map();
      this.filter = folders.some(f => f.key === App.settings.folderFilter) ? App.settings.folderFilter : 'all';
    },
    folderByKey(k) { return this.folders.find(f => f.key === k) || null; },
    get current() { return this.filter === 'all' ? null : this.folderByKey(this.filter); },
    setFilter(k) { this.filter = k; App.settings.folderFilter = k; App.saveSettings(); },
    visible() { const f = this.current; return f ? this.images.filter(e => e.dir === f) : this.images; },
    // where new notes / shared images go
    targetFolder() { return this.current || this.folderByKey(App.settings.newNoteFolder) || this.folders[0]; },

    async refresh() {
      const b = this.backend;
      const lists = await Promise.all(this.folders.map(async f => {
        if (f.needsPermission) { f.error = '권한 필요 — 눌러서 허용'; return []; }
        try {
          f.error = null;
          return (await b.list(f)).filter(e => e.kind === 'file' && U.isImage(e.name)).map(e => Object.assign(e, { dir: f }));
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
    },
    projName(dir, name) { return `${safe(dir.name)}__${name}${EXT}`; },
    // older versions kept "<name>.mnote" in "<folder>/_편집파일"; when that is the app folder they are still found here
    legacyName(entry) { return this.appDir && this.appDir.ownerKey === entry.dir.key ? entry.name + EXT : null; },
    projectOf(entry) {
      const legacy = this.legacyName(entry);
      return this.projects.get(this.projName(entry.dir, entry.name)) || (legacy && this.projects.get(legacy)) || null;
    },
    hasProject(entry) { return !!this.projectOf(entry); },

    // -------- open --------
    // opts.quiet: used for background preloading – never shows a dialog, returns null instead
    async open(entry, opts = {}) {
      const b = this.backend, dir = entry.dir;
      const ctx = { backend: b, dir, image: entry, name: entry.name, project: this.projectOf(entry) };
      if (!ctx.project) {
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
            if ((await U.hash(imgBlob)) !== im.hash) {
              const choice = await U.dialog({
                title: '원본 이미지가 바뀌었어요',
                body: `"${entry.name}"이(가) 편집파일을 마지막으로 저장한 뒤에 다른 곳에서 수정되었습니다. 어떻게 열까요?`,
                buttons: [
                  { label: '원본을 새 레이어로 추가', value: 'layer', primary: true },
                  { label: '원본 이미지로 새로 시작', value: 'image' },
                  { label: '편집파일 그대로', value: 'project' },
                ],
              });
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

    newDoc() {
      const { w, h, bg } = App.settings.newNote;
      const doc = new App.Doc(w, h);
      const L0 = doc.createLayer('배경');
      if (bg) { L0.ctx.fillStyle = bg; L0.ctx.fillRect(0, 0, w, h); }
      const L1 = doc.createLayer('레이어 1');
      doc.layers.push(L0, L1);
      doc.active = L1;
      const ctx = { backend: this.backend, dir: this.targetFolder(), image: null, name: `note_${U.stamp()}.png`, project: null };
      return { doc, ctx };
    },
    // a new note whose background is an image (shared from another app, dropped, picked…)
    async newDocFromImage(blob) {
      const doc = await docFromImageBlob(blob);
      const ctx = { backend: this.backend, dir: this.targetFolder(), image: null, name: `image_${U.stamp()}.png`, project: null };
      return { doc, ctx };
    },

    // -------- save: overwrite the image in its folder + write the edit file into the app folder --------
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

      const written = await b.write(ctx.dir, ctx.name, imgBlob, ctx.image);
      const isNew = !ctx.image;
      if (ctx.image) Object.assign(ctx.image, written); else ctx.image = Object.assign(written, { dir: ctx.dir });

      const projName = this.projName(ctx.dir, ctx.name);
      const existing = this.projects.get(projName) || (ctx.project && ctx.project.name === projName ? ctx.project : null) || await b.find(this.appDir, projName);
      const projBlob = await App.project.encode(doc, { name: ctx.name, folder: ctx.dir.name, mtime: written.mtime, size: written.size || imgBlob.size, hash });
      ctx.project = await b.write(this.appDir, projName, projBlob, existing);
      this.projects.set(projName, ctx.project);

      if (isNew && this.folders.includes(ctx.dir)) {
        this.images.push(ctx.image);
        ctx.dir.count = (ctx.dir.count || 0) + 1;
        this.sort();
      }
      App.gallery?.putThumb(ctx.image, flat);
      return ctx.image;
    },

    // -------- manage --------
    async freeName(b, dir, name) {
      if (!(await b.find(dir, name))) return name;
      return `${U.baseName(name)}_${U.stamp()}.${U.ext(name)}`;
    },
    async trash(entry) {
      const b = this.backend, dir = entry.dir;
      const proj = this.projectOf(entry);
      if (b.trashToFolder) {
        const t = await b.findDir(dir, TRASH_DIR, true);
        await b.write(t, await this.freeName(b, t, entry.name), await b.read(entry));
        await b.remove(dir, entry);
        if (proj) {
          const tp = await b.findDir(this.appDir, TRASH_DIR, true);
          await b.write(tp, await this.freeName(b, tp, proj.name), await b.read(proj));
          await b.remove(this.appDir, proj);
        }
      } else {
        await b.remove(dir, entry);
        if (proj) await b.remove(this.appDir, proj);
      }
      this.images = this.images.filter(e => e !== entry);
      if (proj) this.projects.delete(proj.name);
      dir.count = Math.max(0, (dir.count || 1) - 1);
    },
    async rename(entry, newBase) {
      const b = this.backend, dir = entry.dir;
      const newName = newBase.trim() + '.' + U.ext(entry.name);
      if (!newBase.trim() || /[\\/:*?"<>|]/.test(newBase)) throw new Error('사용할 수 없는 이름입니다');
      if (newName === entry.name) return;
      if (this.images.some(e => e.dir === dir && e.name === newName)) throw new Error('같은 이름의 이미지가 이미 있습니다');
      const proj = this.projectOf(entry);
      Object.assign(entry, await b.rename(dir, entry, newName), { dir });
      if (proj) {
        const np = await b.rename(this.appDir, proj, this.projName(dir, newName));
        this.projects.delete(proj.name);
        this.projects.set(np.name, np);
      }
    },
  };
  lib.docFromImageBlob = docFromImageBlob;
})();
