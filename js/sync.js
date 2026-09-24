'use strict';
// Settings sync between devices through the app folder: brushes, favourites, recent colours and text settings
// are kept in "<app folder>/_미니수첩설정.json". Newest change wins. Device-specific things (pressure, finger
// drawing, shortcuts, gallery layout) stay local on purpose.
(() => {
  const NAME = '_미니수첩설정.json';
  const pick = S => ({ brushes: S.brushes, favOrder: S.favOrder, recentColors: S.recentColors, text: S.text });

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
      try {
        this.entry = await L.backend.find(L.appDir, NAME);
        if (!this.entry) { await this.push(true); return; }
        const j = JSON.parse(await (await L.backend.read(this.entry)).text());
        const remoteAt = j.updatedAt || 0, localAt = S.syncLocalAt || 0;
        if (j.data && remoteAt > localAt) this.apply(j.data, remoteAt);
        else if (localAt > remoteAt) await this.push(true);
        else this.last = JSON.stringify(pick(S));
      } catch (e) { console.warn('settings sync (pull):', e); }
      finally { this.pulling = false; }
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
      if (!this.ready()) return;
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
