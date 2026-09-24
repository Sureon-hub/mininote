'use strict';
// Settings sync between devices through the app folder: brushes, favourites, recent colours and text settings
// are kept in "<app folder>/_미니수첩설정.json". Newest change wins. Device-specific things (pressure, finger
// drawing, shortcuts, gallery layout) stay local on purpose.
(() => {
  const NAME = '_미니수첩설정.json';
  // `folders` = the image folder list as paths below 내 드라이브 ({at, list}); it has its own timestamp
  const pick = S => ({ brushes: S.brushes, favOrder: S.favOrder, recentColors: S.recentColors, text: S.text, folders: S.sharedFolders });
  const key = l => (l || []).map(r => r.join('/')).sort().join('|');

  const sync = App.sync = {
    NAME,
    last: null,   // JSON of the synced part as last uploaded / applied
    entry: null,  // the settings file in the app folder
    timer: 0,
    ready() { const L = App.library; return !!(L.backend && L.appDir); },

    // read the shared file; apply it when it is newer than our own last change
    async pull() {
      if (!this.ready() || this.pulling) return;
      this.pulling = true;
      const L = App.library, S = App.settings;
      let foldersIn = false;
      try {
        this.entry = await L.backend.find(L.appDir, NAME);
        const j = this.entry ? JSON.parse(await (await L.backend.read(this.entry)).text()) : {};
        const rf = j.data && j.data.folders;
        foldersIn = this.mergeFolders(rf);
        if (!this.entry) { await this.push(true); return; }
        const remoteAt = j.updatedAt || 0, localAt = S.syncLocalAt || 0;
        if (j.data && remoteAt > localAt) this.apply(j.data, remoteAt);
        else if (localAt > remoteAt) await this.push(true);
        else this.last = JSON.stringify(pick(S));
        if (S.sharedFolders && S.sharedFolders.at > ((rf && rf.at) || 0)) await this.push(true);
      } catch (e) { console.warn('settings sync (pull):', e); }
      finally { this.pulling = false; }
      if (foldersIn) await App.applySharedFolders?.();
    },
    // folder list: newest list wins; the first time on a device its own folders are added to the shared ones
    mergeFolders(rf) {
      const S = App.settings, lf = S.sharedFolders;
      if (!lf) {
        const mine = App.folderRels ? App.folderRels() : [];
        const list = [...((rf && rf.list) || [])];
        for (const r of mine) if (!list.some(x => x.join('/') === r.join('/'))) list.push(r);
        const grew = list.length > ((rf && rf.list) || []).length;
        S.sharedFolders = { at: grew ? Date.now() : (rf && rf.at) || 0, list };
        App.saveSettings();
        return !!(rf && rf.list.length);
      }
      if (rf && rf.at > lf.at) {
        S.sharedFolders = rf;
        App.saveSettings();
        return key(rf.list) !== key(lf.list);
      }
      return false;
    },
    apply(data, at) {
      const S = App.settings;
      if (data.brushes) S.brushes = { ...S.brushes, ...data.brushes };
      // favourites deleted on the other device disappear here too
      for (const k of Object.keys(S.brushes)) if (k.startsWith('fav_') && !(data.brushes || {})[k]) delete S.brushes[k];
      if (data.favOrder) S.favOrder = data.favOrder.filter(k => S.brushes[k]);
      if (data.recentColors) S.recentColors = data.recentColors;
      if (data.text) S.text = { ...S.text, ...data.text };
      if (!S.brushes[S.currentBrush]) S.currentBrush = 'pencil';
      S.syncLocalAt = at;
      this.last = JSON.stringify(pick(S));
      App.saveSettings();
      App.editor.onSettingsSynced?.();
    },
    // called after every settings save: upload the synced part a moment later if it changed
    changed() {
      if (!this.ready() || this.pulling) return;
      if (JSON.stringify(pick(App.settings)) === this.last) return;
      App.settings.syncLocalAt = Date.now();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.push(), 2500);
    },
    async push(force) {
      if (!this.ready()) return;
      const S = App.settings, L = App.library;
      const json = JSON.stringify(pick(S));
      if (!force && json === this.last) return;
      const body = { app: 'mininote', updatedAt: S.syncLocalAt || Date.now(), data: pick(S) };
      try {
        if (!this.entry) this.entry = await L.backend.find(L.appDir, NAME);
        this.entry = await L.backend.write(L.appDir, NAME, new Blob([JSON.stringify(body)], { type: 'application/json' }), this.entry);
        this.last = json;
      } catch (e) { console.warn('settings sync (push):', e); }
    },
  };

  // coming back to the app (e.g. after using the other device): pick up changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync.pull();
    else if (sync.timer) { clearTimeout(sync.timer); sync.timer = 0; sync.push(); }
  });
})();
