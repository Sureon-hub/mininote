'use strict';
// Storage backends. Every backend exposes the same interface:
//   root() list(dir) read(file) find(dir,name) findDir(dir,name,create) write(dir,name,blob,existing) remove(dir,entry) rename(dir,entry,newName)
// Entries: {kind:'file'|'dir', name, mtime, size, ...backend-specific}
(() => {
  const U = App.util;

  class AuthError extends Error { constructor() { super('Google 로그인이 필요합니다'); this.auth = true; } }
  App.AuthError = AuthError;

  // ================= Local folder (File System Access API / OPFS) =================
  class LocalBackend {
    constructor(handle, kind = 'local') {
      this.handle = handle;
      this.kind = kind;
      this.key = kind + ':' + handle.name;
      this.trashToFolder = true;
    }
    get label() { return this.kind === 'opfs' ? '앱 내부 저장소' : this.handle.name; }
    async ensurePermission(interactive) {
      if (this.kind === 'opfs' || !this.handle.queryPermission) return true;
      const opts = { mode: 'readwrite' };
      if ((await this.handle.queryPermission(opts)) === 'granted') return true;
      if (!interactive) return false;
      return (await this.handle.requestPermission(opts)) === 'granted';
    }
    root() { return { kind: 'dir', name: this.kind === 'opfs' ? '앱 내부 저장소' : this.handle.name, handle: this.handle, path: '' }; }
    async fileEntry(h, dir) {
      const f = await h.getFile();
      return { kind: 'file', name: h.name, handle: h, mtime: f.lastModified, size: f.size, path: (dir ? dir.path : '') + '/' + h.name };
    }
    async list(dir) {
      const out = [];
      for await (const h of dir.handle.values()) {
        if (h.kind === 'directory') out.push({ kind: 'dir', name: h.name, handle: h, path: dir.path + '/' + h.name });
        else if (U.isImage(h.name) || h.name.endsWith('.mnote')) {
          try { out.push(await this.fileEntry(h, dir)); } catch { /* unreadable file */ }
        }
      }
      return out;
    }
    read(file) { return file.handle.getFile(); }
    async find(dir, name) {
      try { return await this.fileEntry(await dir.handle.getFileHandle(name), dir); } catch { return null; }
    }
    async findDir(dir, name, create) {
      try {
        const h = await dir.handle.getDirectoryHandle(name, { create: !!create });
        return { kind: 'dir', name, handle: h, path: dir.path + '/' + name };
      } catch { return null; }
    }
    async write(dir, name, blob, existing) {
      const h = existing?.handle || await dir.handle.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return this.fileEntry(h, dir);
    }
    async remove(dir, entry) { await dir.handle.removeEntry(entry.name); }
    async rename(dir, entry, newName) {
      if (entry.handle.move) {
        try { await entry.handle.move(newName); return await this.find(dir, newName); } catch { /* fall back to copy */ }
      }
      const n = await this.write(dir, newName, await this.read(entry));
      await this.remove(dir, entry);
      return n;
    }
  }
  App.LocalBackend = LocalBackend;

  // ================= Google Drive =================
  const API = 'https://www.googleapis.com/drive/v3';
  const UP = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const FIELDS = 'id,name,mimeType,modifiedTime,size';

  const auth = App.driveAuth = {
    token: null, exp: 0, client: null, clientId: null, pending: null,
    load() {
      try {
        const t = JSON.parse(localStorage.getItem('mininote.dtok') || 'null');
        if (t && t.exp > Date.now()) { this.token = t.token; this.exp = t.exp; }
      } catch { /* ignore */ }
    },
    valid(margin = 60000) { return !!this.token && this.exp > Date.now() + margin; },
    ready() { return !!(window.google && google.accounts && google.accounts.oauth2); },
    loadGis() {
      if (this.ready()) return Promise.resolve();
      if (this._gisP) return this._gisP;
      return (this._gisP = new Promise((res, rej) => {
        const s = U.h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
        s.onload = () => res();
        s.onerror = () => { this._gisP = null; rej(new Error('Google 로그인 스크립트를 불러오지 못했습니다 (인터넷 연결 확인)')); };
        document.head.append(s);
      }));
    },
    init() {
      const id = (App.settings.driveClientId || '').trim();
      if (!id) throw new Error('설정에서 Google OAuth Client ID를 먼저 입력하세요');
      if (!this.ready()) throw new Error('Google 로그인 준비 중입니다. 잠시 후 다시 눌러주세요');
      // the account used last time: Google can then skip the account chooser and close its window by itself
      const hint = App.settings.driveEmail || '';
      if (this.client && this.clientId === id && this.hint === hint) return;
      this.clientId = id; this.hint = hint;
      this.client = google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: 'https://www.googleapis.com/auth/drive',
        ...(hint ? { hint } : {}),
        callback: r => this._done(r),
        error_callback: e => this._fail(e),
      });
    },
    _done(r) {
      const p = this.pending; this.pending = null;
      if (r.error) { p?.rej(new Error(r.error_description || r.error)); return; }
      this.token = r.access_token;
      this.exp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
      try { localStorage.setItem('mininote.dtok', JSON.stringify({ token: this.token, exp: this.exp })); } catch { /* ignore */ }
      p?.res(this.token);
    },
    _fail(e) {
      const p = this.pending; this.pending = null;
      p?.rej(new Error(e && e.type === 'popup_closed' ? '로그인 창이 닫혔습니다' : (e && (e.message || e.type)) || '로그인 실패'));
    },
    // Must be called synchronously from a user gesture (click/tap), otherwise the popup is blocked.
    request(prompt = '') {
      this.init();
      if (this.pending) return this.pending.promise;
      let res, rej;
      const promise = new Promise((a, b) => { res = a; rej = b; });
      this.pending = { res, rej, promise };
      this.client.requestAccessToken({ prompt });
      return promise;
    },
    signOut() {
      try { if (this.token && this.ready()) google.accounts.oauth2.revoke(this.token, () => {}); } catch { /* ignore */ }
      this.token = null; this.exp = 0;
      try { localStorage.removeItem('mininote.dtok'); } catch { /* ignore */ }
    },
  };
  auth.load();

  class DriveBackend {
    constructor(folder) {
      this.folder = folder;
      this.kind = 'drive';
      this.key = 'drive:' + folder.id;
      this.trashToFolder = false; // Drive has its own trash
    }
    get label() { return this.folder.name; }
    async ensurePermission(interactive) {
      if (auth.valid()) return true;
      if (!interactive) return false;
      await auth.request();
      return true;
    }
    async api(url, opts = {}) {
      // a login started by a tap is on its way: wait for it instead of failing
      if (!auth.valid(0) && auth.pending) await auth.pending.promise.catch(() => {});
      if (!auth.valid(0)) throw new AuthError();
      const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + auth.token } });
      if (r.status === 401) { auth.token = null; throw new AuthError(); }
      if (!r.ok) {
        let m = '';
        try { m = (await r.json()).error.message; } catch { /* ignore */ }
        throw new Error(`Drive 오류 ${r.status} ${m}`);
      }
      return r;
    }
    conv(f) {
      return f.mimeType === FOLDER
        ? { kind: 'dir', id: f.id, name: f.name }
        : { kind: 'file', id: f.id, name: f.name, mtime: Date.parse(f.modifiedTime), size: Number(f.size) || 0, mime: f.mimeType };
    }
    root() { return { kind: 'dir', id: this.folder.id, name: this.folder.name }; }
    async query(q) {
      const out = [];
      let token = '';
      do {
        const u = new URL(API + '/files');
        u.searchParams.set('q', q);
        u.searchParams.set('fields', `nextPageToken,files(${FIELDS})`);
        u.searchParams.set('pageSize', '1000');
        u.searchParams.set('supportsAllDrives', 'true');
        u.searchParams.set('includeItemsFromAllDrives', 'true');
        if (token) u.searchParams.set('pageToken', token);
        const j = await (await this.api(u)).json();
        out.push(...j.files);
        token = j.nextPageToken;
      } while (token);
      return out;
    }
    esc(n) { return n.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
    async list(dir) { return (await this.query(`'${dir.id}' in parents and trashed=false`)).map(f => this.conv(f)); }
    async listFolders(parentId) {
      return (await this.query(`'${parentId}' in parents and trashed=false and mimeType='${FOLDER}'`))
        .map(f => this.conv(f)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }
    async find(dir, name) {
      const r = await this.query(`'${dir.id}' in parents and trashed=false and name='${this.esc(name)}' and mimeType!='${FOLDER}'`);
      if (!r.length) return null;
      r.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime));
      return this.conv(r[0]);
    }
    async findDir(dir, name, create) {
      const r = await this.query(`'${dir.id}' in parents and trashed=false and name='${this.esc(name)}' and mimeType='${FOLDER}'`);
      if (r.length) return this.conv(r[0]);
      if (!create) return null;
      const j = await (await this.api(`${API}/files?fields=${FIELDS}&supportsAllDrives=true`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [dir.id] }),
      })).json();
      return this.conv(j);
    }
    async read(file) { return (await this.api(`${API}/files/${file.id}?alt=media&supportsAllDrives=true`)).blob(); }
    async write(dir, name, blob, existing) {
      const type = blob.type || 'application/octet-stream';
      let r;
      if (existing && existing.id) {
        r = await this.api(`${UP}/files/${existing.id}?uploadType=media&fields=${FIELDS}&supportsAllDrives=true`,
          { method: 'PATCH', headers: { 'Content-Type': type }, body: blob });
      } else {
        const b = 'mn' + U.uid() + U.uid();
        const body = new Blob([
          `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [dir.id] })}\r\n`,
          `--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`,
        ]);
        r = await this.api(`${UP}/files?uploadType=multipart&fields=${FIELDS}&supportsAllDrives=true`,
          { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
      }
      return this.conv(await r.json());
    }
    async patchMeta(entry, meta) {
      const j = await (await this.api(`${API}/files/${entry.id}?fields=${FIELDS}&supportsAllDrives=true`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
      })).json();
      return this.conv(j);
    }
    async remove(dir, entry) { await this.patchMeta(entry, { trashed: true }); }
    rename(dir, entry, newName) { return this.patchMeta(entry, { name: newName }); }

    // ---- locating files anywhere in My Drive (links from edit files to their images) ----
    async rootId() {
      if (!this._rootId) this._rootId = (await (await this.api(`${API}/files/root?fields=id`)).json()).id;
      return this._rootId;
    }
    async meta(id) {
      this._meta = this._meta || new Map();
      if (this._meta.has(id)) return this._meta.get(id);
      const j = await (await this.api(`${API}/files/${id}?fields=${FIELDS},parents,trashed&supportsAllDrives=true`)).json();
      this._meta.set(id, j);
      return j;
    }
    forget(id) { this._meta?.delete(id); }
    // the signed-in account (used as a login hint next time)
    async email() {
      const j = await (await this.api(`${API}/about?fields=user(emailAddress)`)).json();
      return (j.user && j.user.emailAddress) || '';
    }
    // folder names from My Drive down to the folder `id` ([] = My Drive itself, null = not inside My Drive)
    async pathFromRoot(id) {
      const rid = await this.rootId(), names = [];
      let cur = id;
      for (let i = 0; i < 60; i++) {
        if (cur === rid || cur === 'root') return names.reverse();
        const j = await this.meta(cur);
        if (!j.parents || !j.parents.length) return null;
        names.push(j.name);
        cur = j.parents[0];
      }
      return null;
    }
    // a file by id (still valid after the user moved it to another folder)
    async fileById(id) {
      this.forget(id);
      const j = await this.meta(id).catch(() => null);
      if (!j || j.trashed) return null;
      const f = this.conv(j);
      f.parentId = j.parents && j.parents[0];
      return f;
    }
    async searchImages(name) {
      const r = await this.query(`name='${this.esc(name)}' and trashed=false and mimeType contains 'image/'`);
      return (await Promise.all(r.map(async x => {
        const j = await this.meta(x.id).catch(() => null);
        return j ? Object.assign(this.conv(x), { parentId: j.parents && j.parents[0] }) : null;
      }))).filter(Boolean);
    }
    // folders + images of one folder, for the in-app file picker
    async listForPicker(parentId) {
      const all = await this.query(`'${parentId}' in parents and trashed=false and (mimeType='${FOLDER}' or mimeType contains 'image/')`);
      const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
      return {
        folders: all.filter(f => f.mimeType === FOLDER).map(f => this.conv(f)).sort(byName),
        images: all.filter(f => f.mimeType !== FOLDER && /\.(png|jpe?g|webp)$/i.test(f.name)).map(f => this.conv(f)).sort(byName),
      };
    }
  }
  App.DriveBackend = DriveBackend;
})();
