'use strict';
// .mnote project format + library (folder listing, open / save / rename / trash).
//
// Folder layout:
//   <folder>/note.png                  <- the image everyone sees (overwritten on save)
//   <folder>/_편집파일/note.png.mnote   <- layered, editable project for that image
//   <folder>/_휴지통/                  <- local trash (Drive uses its own trash)
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
    // draw on an empty layer above the image, so the original stays untouched (and outlines can sit behind strokes)
    const L1 = doc.createLayer('레이어 1');
    doc.layers.push(L, L1);
    doc.active = L1;
    return doc;
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });

  // ---------------- library ----------------
  const lib = App.library = {
    backend: null, dir: null, stack: [],
    images: [], dirs: [], projects: new Map(), editDir: null,

    setBackend(b) { this.backend = b; this.dir = b.root(); this.stack = []; this.images = []; this.dirs = []; this.projects = new Map(); },
    get path() { return [...this.stack, this.dir].map(d => d.name); },
    async enter(dir) { this.stack.push(this.dir); this.dir = dir; await this.refresh(); },
    async up() { if (!this.stack.length) return false; this.dir = this.stack.pop(); await this.refresh(); return true; },

    async refresh() {
      const b = this.backend, dir = this.dir;
      const all = await b.list(dir);
      if (dir !== this.dir) return; // navigated away meanwhile
      this.images = all.filter(e => e.kind === 'file' && U.isImage(e.name));
      this.dirs = all.filter(e => e.kind === 'dir' && !/^[._]/.test(e.name)).sort(byName);
      this.editDir = all.find(e => e.kind === 'dir' && e.name === EDIT_DIR) || null;
      this.projects = new Map();
      if (this.editDir) {
        for (const p of await b.list(this.editDir)) if (p.kind === 'file' && p.name.endsWith(EXT)) this.projects.set(p.name, p);
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
    hasProject(entry) { return this.projects.has(entry.name + EXT); },

    // -------- open --------
    async open(entry) {
      const b = this.backend, dir = this.dir;
      const ctx = { backend: b, dir, editDir: this.editDir, image: entry, name: entry.name, project: this.projects.get(entry.name + EXT) || null };
      if (ctx.project) {
        let data = null;
        try { data = await App.project.decode(await b.read(ctx.project)); }
        catch (e) { console.warn(e); U.toast('편집파일을 읽지 못해 원본 이미지로 엽니다'); }
        if (data) {
          const im = data.header.image || {};
          const maybeChanged = (entry.mtime && im.mtime && entry.mtime > im.mtime + 3000) || (im.size && entry.size && im.size !== entry.size);
          if (maybeChanged) {
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
      const ctx = { backend: this.backend, dir: this.dir, editDir: this.editDir, image: null, name: `note_${U.stamp()}.png`, project: null };
      return { doc, ctx };
    },

    // -------- save: overwrite original image + write project --------
    async save(doc, ctx) {
      const b = ctx.backend;
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
      if (ctx.image) Object.assign(ctx.image, written); else ctx.image = written;

      if (!ctx.editDir) ctx.editDir = await b.findDir(ctx.dir, EDIT_DIR, true);
      const projName = ctx.name + EXT;
      if (!ctx.project) ctx.project = await b.find(ctx.editDir, projName);
      const projBlob = await App.project.encode(doc, { name: ctx.name, mtime: written.mtime, size: written.size || imgBlob.size, hash });
      const pw = await b.write(ctx.editDir, projName, projBlob, ctx.project);
      if (ctx.project) Object.assign(ctx.project, pw); else ctx.project = pw;

      if (this.backend === b && this.dir === ctx.dir) {
        this.editDir = ctx.editDir;
        this.projects.set(projName, ctx.project);
        if (isNew) { this.images.push(ctx.image); this.sort(); }
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
      const b = this.backend, dir = this.dir;
      const proj = this.projects.get(entry.name + EXT);
      if (b.trashToFolder) {
        const t = await b.findDir(dir, TRASH_DIR, true);
        const name = await this.freeName(b, t, entry.name);
        await b.write(t, name, await b.read(entry));
        await b.remove(dir, entry);
        if (proj) {
          const te = await b.findDir(t, EDIT_DIR, true);
          await b.write(te, name + EXT, await b.read(proj));
          await b.remove(this.editDir, proj);
        }
      } else {
        await b.remove(dir, entry);
        if (proj) await b.remove(this.editDir, proj);
      }
      this.images = this.images.filter(e => e !== entry);
      this.projects.delete(entry.name + EXT);
    },
    async rename(entry, newBase) {
      const b = this.backend, dir = this.dir;
      const newName = newBase.trim() + '.' + U.ext(entry.name);
      if (!newBase.trim() || /[\\/:*?"<>|]/.test(newBase)) throw new Error('사용할 수 없는 이름입니다');
      if (newName === entry.name) return;
      if (this.images.some(e => e.name === newName)) throw new Error('같은 이름의 이미지가 이미 있습니다');
      const oldProj = entry.name + EXT;
      const proj = this.projects.get(oldProj);
      Object.assign(entry, await b.rename(dir, entry, newName));
      if (proj) {
        const np = await b.rename(this.editDir, proj, newName + EXT);
        this.projects.delete(oldProj);
        this.projects.set(newName + EXT, np);
      }
    },
    async createFolder(name) {
      name = name.trim();
      if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('사용할 수 없는 이름입니다');
      const d = await this.backend.findDir(this.dir, name, true);
      if (!this.dirs.some(x => x.name === d.name)) this.dirs.push(d);
      this.dirs.sort(byName);
      return d;
    },
  };
  lib.docFromImageBlob = docFromImageBlob;
})();
