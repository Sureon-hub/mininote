'use strict';
// Boot, screens, storage source selection, settings, Google Drive folder picker.
(() => {
  const U = App.util, h = U.h, S = App.settings;
  App.VERSION = '0.9.5';

  // ---------------- screens ----------------
  App.show = name => {
    for (const id of ['home', 'gallery', 'editor']) U.$('#' + id).hidden = id !== name;
    if (name === 'editor' && !(history.state && history.state.editor)) history.pushState({ editor: true }, '');
    if (name !== 'editor' && history.state && history.state.editor) { App._ignorePop = true; history.back(); }
    if (name === 'editor') requestAnimationFrame(() => App.editor.resize());
  };
  window.addEventListener('popstate', async () => {
    if (App._ignorePop) { App._ignorePop = false; return; }
    if (!App.editor.visible && App.gallery.selecting) { App.gallery.exitSelect(true); return; }
    if (App.editor.visible) {
      const ok = await App.editor.close();
      if (!ok) history.pushState({ editor: true }, '');
    }
  });
  window.addEventListener('beforeunload', e => {
    if ((App.editor.visible && App.editor.dirty) || App.editor.pendingSaves.size) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------- install as app (Chrome / Edge) ----------------
  let installEvt = null;
  App.isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installEvt = e;
    document.body.classList.add('can-install');
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    document.body.classList.remove('can-install');
    U.dialog({ title: '설치됐어요', body: '앱 목록(홈 화면에서 위로 쓸어올리기)에서 "미니수첩"을 찾아 여세요.\n아이콘을 길게 눌러 "홈에 추가"하면 홈 화면에도 놓을 수 있어요.' });
  });
  App.install = async () => {
    if (installEvt) {
      installEvt.prompt();
      await installEvt.userChoice;
      installEvt = null;
      document.body.classList.remove('can-install');
      return;
    }
    U.dialog({
      title: '앱으로 설치하기',
      body: App.isInstalled() ? '지금 설치된 앱으로 실행 중이에요.' :
        '• 안드로이드: 크롬으로 이 주소를 열고 ⋮ → "설치 및 바로가기 만들기" → "설치"\n' +
        '• PC: Edge/크롬 주소창 오른쪽의 설치 아이콘, 또는 ⋯ → 앱 → "이 사이트를 앱으로 설치"\n\n' +
        '웨일·삼성 인터넷 등 다른 브라우저에서는 설치가 안 되거나 바로가기만 만들어질 수 있어요. 이미 설치했다면 앱 목록에서 "미니수첩"을 찾아보세요.',
    });
  };

  // ---------------- errors ----------------
  App.handleError = async (e, title = '오류') => {
    console.error(e);
    if (e && e.auth) {
      const ok = await U.dialog({
        title: 'Google 로그인이 필요해요', body: '로그인이 만료됐어요. 다시 로그인하면 이어서 진행합니다.',
        buttons: [{ label: '취소', value: false }, { label: '로그인', value: true, primary: true }],
      });
      if (!ok) return;
      try { await App.driveAuth.request(); return 'retry'; }
      catch (err) { U.toast(err.message); return; }
    }
    U.dialog({ title, body: String((e && e.message) || e) });
  };
  let loginBanner = null;
  App.needLogin = () => {
    if (loginBanner) return;
    loginBanner = h('div', { class: 'banner' }, 'Google 로그인이 만료됐어요 ',
      h('button', {
        class: 'btn small primary', onclick: async () => {
          try { await App.driveAuth.request(); loginBanner.remove(); loginBanner = null; App.gallery.reload(); } catch (e) { U.toast(e.message); }
        },
      }, '다시 로그인'));
    U.$('#gallery').append(loginBanner);
  };

  // ---------------- sources ----------------
  async function enterGallery() {
    App.show('gallery');
    App.gallery.render();
    await App.gallery.reload();
    if (App.pendingImages) { const b = App.pendingImages; App.pendingImages = null; App.receiveImages(b); }
    App.sync.last = null; App.sync.entry = null;
    App.sync.pull();
  }
  // A "collection" = several image folders + the app's own folders under the base folder:
  //   <base>/미니수첩/편집파일   – every edit file (+ settings sync file)
  //   <base>/미니수첩/새 노트    – new notes and images brought in from the phone / share / drop
  // local: folder handles live in IndexedDB; drive: {id,name} in settings (base = 내 드라이브); opfs: MiniNote.
  const APP_HOME = '미니수첩', APP_EDIT = '편집파일', APP_NEW = '새 노트';
  const localDir = (hd, i) => ({ kind: 'dir', name: hd.name, handle: hd, path: `/${i}:${hd.name}`, key: `L${i}:${hd.name}` });
  async function localHandles() {
    let hs = await U.idbGet('kv', 'localFolders');
    if (!hs) { const old = await U.idbGet('kv', 'localRoot'); hs = old ? [old] : []; } // v0.4 and older: one folder
    return hs;
  }
  async function permitted(handles, interactive) {
    for (const hd of handles) {
      if (!hd.queryPermission) continue;
      if ((await hd.queryPermission({ mode: 'readwrite' })) === 'granted') continue;
      if (!interactive || (await hd.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
    }
    return true;
  }
  // create (if needed) 미니수첩/편집파일 and 미니수첩/새 노트 under the base folder
  async function appStructure(b, root) {
    const home = await b.findDir(root, APP_HOME, true);
    const edit = await b.findDir(home, APP_EDIT, true);
    const notes = await b.findDir(home, APP_NEW, true);
    edit.rel = [APP_HOME, APP_EDIT]; notes.rel = [APP_HOME, APP_NEW];
    return { edit, notes };
  }
  // move edit files (and the settings file) from the old app folder into 미니수첩/편집파일 — once
  async function migrateEditFiles(b, oldDir, newDir, oldOwner) {
    if (!oldDir) return 0;
    let items;
    try { items = await b.list(oldDir); } catch { return 0; }
    const syncFile = await b.find(oldDir, App.sync.NAME).catch(() => null);
    if (syncFile) items.push(syncFile);
    let moved = 0;
    for (const it of items) {
      if (it.kind !== 'file' || !(it.name.endsWith(App.project.EXT) || it.name === App.sync.NAME)) continue;
      let name = it.name;
      // "<image>.mnote" of the old first folder → give it its path name so it keeps its image
      if (oldOwner && oldOwner.rel && !name.includes('＞') && !name.includes('__') && name !== App.sync.NAME) name = [...oldOwner.rel, name].join('＞');
      const there = await b.find(newDir, name);
      // keep whichever copy is newer; the old one is removed only after the copy was written
      if (!there || (it.mtime || 0) > (there.mtime || 0)) await b.write(newDir, name, await b.read(it), there || undefined);
      await b.remove(oldDir, it);
      moved++;
    }
    return moved;
  }
  async function useLocal(interactive) {
    let hs = await localHandles();
    const baseH = await U.idbGet('kv', 'baseDir');
    if (!hs.length && !baseH) return false;
    let root = null;
    if (baseH && (await permitted([baseH], interactive).catch(() => false))) root = { kind: 'dir', name: baseH.name, handle: baseH, path: '/r' };
    else if (baseH && !interactive) return false;
    const b = new App.LocalBackend(root ? baseH : hs[0], 'local');
    let appDir, notesKey = null;
    if (root) {
      const st = await appStructure(b, root);
      appDir = st.edit;
      // "새 노트" is always the first folder of the collection
      const same = await Promise.all(hs.map(x => x.isSameEntry(st.notes.handle)));
      hs = [st.notes.handle, ...hs.filter((_, i) => !same[i])];
      notesKey = localDir(st.notes.handle, 0).key;
    }
    // each folder needs its own permission; folders that aren't allowed yet show as "권한 필요" and can be tapped later
    const states = await Promise.all(hs.map(hd => (hd.queryPermission ? hd.queryPermission({ mode: 'readwrite' }) : 'granted')));
    if (!interactive && states.some(s => s !== 'granted')) return false;
    for (let i = 0; i < hs.length; i++) {
      if (states[i] === 'granted') continue;
      try { states[i] = await hs[i].requestPermission({ mode: 'readwrite' }); } catch { states[i] = 'prompt'; }
    }
    if (!root && states[0] !== 'granted') return false;
    const folders = hs.map(localDir);
    folders.forEach((f, i) => { f.needsPermission = states[i] !== 'granted'; });
    const oldH = await U.idbGet('kv', 'localAppDir');
    if (root) {
      App.library.setup(b, folders, appDir, root);
      if (oldH && !(await oldH.isSameEntry(appDir.handle)) && (await permitted([oldH], interactive).catch(() => false))) {
        const oldOwner = folders.find(f => f.key === S.appOwner) || null;
        if (oldOwner) await App.library.relOfDir(oldOwner);
        const n = await migrateEditFiles(b, { kind: 'dir', name: oldH.name, handle: oldH, path: '/old' }, appDir, oldOwner);
        if (n) U.toast(`편집파일 ${n}개를 "미니수첩\\편집파일"로 옮겼어요`);
      }
      await U.idbSet('kv', 'localAppDir', appDir.handle);
      S.appOwner = null;
      if (!S.newNoteFolder || !folders.some(f => f.key === S.newNoteFolder)) S.newNoteFolder = notesKey;
    } else {
      // no base folder yet (older setups): the app folder stays "_편집파일" in the first folder
      let appH = oldH;
      if (appH && !(await permitted([appH], interactive))) return false;
      if (appH) appDir = { kind: 'dir', name: appH.name, handle: appH, path: '/app', ownerKey: S.appOwner || null };
      else {
        appDir = await b.findDir(folders[0], App.project.EDIT_DIR, true);
        appDir.ownerKey = folders[0].key;
        S.appOwner = appDir.ownerKey;
        await U.idbSet('kv', 'localAppDir', appDir.handle);
      }
      App.library.setup(b, folders, appDir, null);
    }
    S.source = 'local'; App.saveSettings();
    await U.idbSet('kv', 'localFolders', hs);
    await enterGallery();
    return true;
  }
  async function useOpfs() {
    const top = await navigator.storage.getDirectory();
    const hd = await top.getDirectoryHandle('MiniNote', { create: true });
    try { await navigator.storage.persist?.(); } catch { /* ignore */ }
    const b = new App.LocalBackend(hd, 'opfs');
    const root = { kind: 'dir', name: '앱 내부 저장소', handle: hd, path: '/r' };
    const st = await appStructure(b, root);
    const names = (S.opfsFolders || []).filter(Boolean);
    const folders = [{ kind: 'dir', name: APP_NEW, handle: st.notes.handle, path: '/o0', key: 'O0:new', rel: st.notes.rel }];
    for (const [i, n] of names.entries()) folders.push({ kind: 'dir', name: n, handle: await hd.getDirectoryHandle(n, { create: true }), path: `/o${i + 1}`, key: `O${i + 1}:${n}` });
    App.library.setup(b, folders, st.edit, root);
    if (!S.opfsMigrated) {
      // earlier versions kept notes directly in MiniNote and edit files in MiniNote/_편집파일
      const old = await b.findDir(root, App.project.EDIT_DIR, false);
      if (old) await migrateEditFiles(b, old, st.edit, { rel: [] });
      // notes that sat directly in MiniNote move into 미니수첩/새 노트 (their edit files are renamed to match)
      for (const it of await b.list(root)) {
        if (it.kind !== 'file' || !U.isImage(it.name)) continue;
        await b.write(st.notes, it.name, await b.read(it));
        await b.remove(root, it);
        for (const oldName of [it.name + App.project.EXT, `앱 내부 저장소__${it.name}${App.project.EXT}`]) {
          const p = await b.find(st.edit, oldName);
          if (p) { await b.rename(st.edit, p, ['미니수첩', '새 노트', it.name].join('＞') + App.project.EXT).catch(() => {}); break; }
        }
      }
      S.opfsMigrated = true;
    }
    if (!S.newNoteFolder || !folders.some(f => f.key === S.newNoteFolder)) S.newNoteFolder = 'O0:new';
    S.source = 'opfs'; App.saveSettings();
    await enterGallery();
  }
  function driveFolders() {
    if (!S.driveFolders && S.driveFolder) S.driveFolders = [S.driveFolder];
    return S.driveFolders || [];
  }
  async function useDrive() {
    const b = new App.DriveBackend({ id: 'root', name: '내 드라이브' });
    // on Drive the base folder is always "내 드라이브" (the same place as G:\...\내 드라이브 on the PC)
    const root = { kind: 'dir', id: 'root', name: '내 드라이브' };
    const st = await appStructure(b, root);
    const list = [{ id: st.notes.id, name: APP_NEW }, ...driveFolders().filter(f => f.id !== st.notes.id)];
    S.driveFolders = list.slice(1);
    const folders = list.map(f => ({ kind: 'dir', id: f.id, name: f.name, key: 'D' + f.id }));
    App.library.setup(b, folders, st.edit, root);
    if (S.driveAppDir && S.driveAppDir.id !== st.edit.id) {
      const oldOwner = folders.find(f => f.key === S.driveAppDir.ownerKey) || null;
      if (oldOwner) await App.library.relOfDir(oldOwner);
      const n = await migrateEditFiles(b, { kind: 'dir', id: S.driveAppDir.id, name: S.driveAppDir.name }, st.edit, oldOwner).catch(() => 0);
      if (n) U.toast(`편집파일 ${n}개를 "미니수첩/편집파일"로 옮겼어요`);
    }
    S.driveAppDir = { id: st.edit.id, name: st.edit.name, ownerKey: null };
    if (!S.newNoteFolder || !folders.some(f => f.key === S.newNoteFolder)) S.newNoteFolder = 'D' + st.notes.id;
    S.source = 'drive'; App.saveSettings();
    await enterGallery();
    return true;
  }
  async function reopen() {
    if (S.source === 'local') return useLocal(true);
    if (S.source === 'drive') return useDrive();
    if (S.source === 'opfs') return useOpfs();
  }
  // PC: pick the base folder (ideally 내 드라이브); 미니수첩/편집파일 and 미니수첩/새 노트 are created inside it
  async function pickLocal() {
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const ok = await U.dialog(mobile ? {
      title: '휴대폰 안의 폴더 열기',
      body: '휴대폰 저장공간의 폴더를 골라요(예: Pictures 안의 폴더). 그 안에 "미니수첩" 폴더를 만들어요.\n• PC와 연동되지 않아요 — PC와 함께 쓰려면 "Google Drive로 시작"을 쓰세요.\n• 저장공간 맨 위, Download 폴더는 안드로이드가 막아서 고를 수 없어요.',
      buttons: [{ label: '취소', value: false }, { label: '폴더 고르기', value: true, primary: true }],
    } : {
      title: 'PC에서 시작하기',
      body: '구글 드라이브 동기화 폴더의 "내 드라이브"를 골라주세요.\n그 안에 "미니수첩" 폴더를 만들어 새 노트와 편집파일을 깔끔하게 모아둬요. 폰(Google Drive)과도 같은 폴더를 쓰게 돼요.',
      buttons: [{ label: '취소', value: false }, { label: '폴더 고르기', value: true, primary: true }],
    });
    if (!ok) return;
    try {
      const hd = await showDirectoryPicker({ id: 'mininote-base', mode: 'readwrite' });
      await U.idbSet('kv', 'baseDir', hd);
      await useLocal(true);
    } catch (e) { if (e.name !== 'AbortError') App.handleError(e, '폴더를 열지 못했어요'); }
  }
  async function connectDrive() {
    if (!S.driveClientId) {
      const id = await askClientId();
      if (!id) return;
    }
    try {
      await App.driveAuth.loadGis();
      if (!App.driveAuth.valid()) await App.driveAuth.request();
      // "내 드라이브/미니수첩" is created automatically; more folders can be added from the gallery
      await useDrive();
    } catch (e) { App.handleError(e, 'Google Drive 연결 실패'); }
  }

  // ---- add / remove folders of the current collection ----
  App.addFolder = async () => {
    const L = App.library;
    try {
      let name;
      if (S.source === 'local') {
        const hd = await showDirectoryPicker({ id: 'mininote-add', mode: 'readwrite' });
        name = hd.name;
        if (L.folders.some(f => f.name === name)) throw new Error(`"${name}" 이름의 폴더가 이미 있어요. 편집파일 이름이 겹칠 수 있어서 같은 이름의 폴더는 함께 추가할 수 없어요.`);
        const hs = await localHandles();
        await U.idbSet('kv', 'localFolders', [...hs, hd]);
        await useLocal(true);
      } else if (S.source === 'drive') {
        const f = await pickDriveFolder();
        if (!f) return;
        name = f.name;
        if (L.folders.some(x => x.id === f.id)) throw new Error('이미 추가된 폴더예요');
        if (L.folders.some(x => x.name === f.name)) throw new Error(`"${name}" 이름의 폴더가 이미 있어요. 같은 이름의 폴더는 함께 추가할 수 없어요.`);
        S.driveFolders = [...driveFolders(), f];
        await useDrive();
      } else if (S.source === 'opfs') {
        name = await U.dialog({ title: '새 폴더', input: { placeholder: '폴더 이름' }, buttons: [{ label: '취소', value: null }, { label: '만들기', value: true, primary: true }] });
        if (!name || !name.trim() || /[\\/:*?"<>|]/.test(name)) return;
        name = name.trim();
        if (L.folders.some(f => f.name === name)) throw new Error('같은 이름의 폴더가 이미 있어요');
        S.opfsFolders = [...(S.opfsFolders || []).filter(Boolean), name];
        await useOpfs();
      }
      if (name) {
        const f = L.folders.find(x => x.name === name);
        if (f) shareFolder(await L.relOfDir(f), true);
        U.toast(`"${name}" 폴더를 추가했어요`);
      }
    } catch (e) { if (e.name !== 'AbortError') App.handleError(e, '폴더를 추가하지 못했어요'); }
  };
  // ---- the folder list is shared between devices (as paths below 내 드라이브) through the settings file ----
  const NOTES_REL = [APP_HOME, APP_NEW].join('/');
  App.folderRels = () => {
    const L = App.library;
    if (!L.root || S.source === 'opfs') return [];
    return L.folders.map(f => f.rel).filter(r => r && r.length && r.join('/') !== NOTES_REL);
  };
  function shareFolder(rel, add) {
    if (!rel || !App.library.root || S.source === 'opfs') return;
    const k = rel.join('/');
    const list = (S.sharedFolders ? S.sharedFolders.list : App.folderRels()).filter(r => r.join('/') !== k);
    if (add) list.push(rel);
    S.sharedFolders = { at: Date.now(), list };
    App.saveSettings();
  }
  async function dirAt(b, root, rel) {
    let d = root;
    for (const n of rel) { d = await b.findDir(d, n, false); if (!d) return null; }
    d.rel = rel;
    return d;
  }
  // make this device's folder list match the shared one (folders that don't exist here are skipped)
  App.applySharedFolders = async () => {
    const L = App.library, sf = S.sharedFolders;
    if (!sf || !L.root || S.source === 'opfs' || !L.backend) return;
    const found = [];
    for (const rel of sf.list) {
      if (rel.join('/') === NOTES_REL || found.some(d => d.rel.join('/') === rel.join('/'))) continue;
      const d = await dirAt(L.backend, L.root, rel).catch(() => null);
      if (d) found.push(d);
    }
    const want = found.map(d => d.rel.join('/')).sort().join('|');
    const have = App.folderRels().map(r => r.join('/')).sort().join('|');
    if (want === have) return;
    // folders outside 내 드라이브 can't be shared; they stay on this device
    const own = L.folders.slice(1).filter(f => !f.rel);
    if (S.source === 'drive') S.driveFolders = [...found.map(d => ({ id: d.id, name: d.name })), ...own.map(f => ({ id: f.id, name: f.name }))];
    else await U.idbSet('kv', 'localFolders', [...found.map(d => d.handle), ...own.map(f => f.handle)]);
    App.saveSettings();
    U.toast('다른 기기에서 바꾼 폴더 목록을 적용했어요');
    await reopen();
  };
  App.removeFolder = async key => {
    const L = App.library, i = L.folders.findIndex(f => f.key === key);
    if (i < 0) return;
    if (L.folders.length === 1) { U.toast('마지막 폴더는 뺄 수 없어요'); return; }
    if (L.root && i === 0) { U.toast('"새 노트"는 미니수첩 기본 폴더라 뺄 수 없어요'); return; }
    const ok = await U.dialog({
      title: `"${L.folders[i].name}" 폴더를 목록에서 뺄까요?`, body: '폴더와 이미지는 그대로 남고, 미니수첩 목록에서만 빠져요.',
      buttons: [{ label: '취소', value: false }, { label: '빼기', value: true, primary: true }],
    });
    if (!ok) return;
    shareFolder(await L.relOfDir(L.folders[i]), false);
    if (S.source === 'local') { const hs = await localHandles(); hs.splice(i, 1); await U.idbSet('kv', 'localFolders', hs); }
    else if (S.source === 'drive') S.driveFolders = driveFolders().filter((_, j) => j !== i - 1); // folder 0 is "새 노트"
    else if (S.source === 'opfs') S.opfsFolders = (S.opfsFolders || []).filter(Boolean).filter((_, j) => j !== i - 1);
    if (S.folderFilter === key) S.folderFilter = 'all';
    App.saveSettings();
    await reopen();
  };
  // ---- base folder (PC): one top folder, e.g. "내 드라이브", so any image below it can be opened and replaced ----
  App.setBaseFolder = async () => {
    if (S.source !== 'local') { U.toast(S.source === 'drive' ? 'Google Drive에서는 "내 드라이브"가 기준이에요' : '앱 내부 저장소는 기준 폴더를 바꿀 수 없어요'); return false; }
    const ok = await U.dialog({
      title: '기준 폴더 고르기',
      body: '미니수첩이 이미지를 찾고 바꿀 수 있는 가장 바깥 폴더를 한 번만 골라주세요.\n추천: 구글 드라이브 동기화 폴더의 "내 드라이브" — 그러면 폰(Google Drive)과 경로가 똑같아서 편집파일 연결이 이어져요.',
      buttons: [{ label: '취소', value: false }, { label: '폴더 고르기', value: true, primary: true }],
    });
    if (!ok) return false;
    try {
      const hd = await showDirectoryPicker({ id: 'mininote-base', mode: 'readwrite' });
      await U.idbSet('kv', 'baseDir', hd);
      await reopen();
      U.toast(`기준 폴더: ${hd.name}`);
      return true;
    } catch (e) { if (e.name !== 'AbortError') App.handleError(e, '기준 폴더를 정하지 못했어요'); return false; }
  };

  // ---- "이미지 열기": any image, wherever it is ----
  App.openAnyImage = async btn => {
    const L = App.library;
    if (!L.backend) { U.toast('먼저 저장 위치를 열어주세요'); return; }
    let how = S.source === 'local' ? 'pc' : S.source === 'drive' ? null : 'copy';
    if (!how) {
      const r = btn ? btn.getBoundingClientRect() : { right: innerWidth / 2 + 100, bottom: 60 };
      how = await U.menu([
        { label: 'Google Drive에서 고르기 (저장하면 원본이 바뀌어요)', value: 'drive' },
        { label: '휴대폰 사진에서 가져오기 (복사본으로 새 노트)', value: 'copy' },
      ], r.right - 260, r.bottom + 4);
      if (!how) return;
    }
    try {
      let entry = null;
      if (how === 'copy') {
        const inp = U.h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        inp.addEventListener('change', () => { App.receiveImages([...inp.files]); inp.remove(); });
        document.body.append(inp); inp.click();
        U.toast('휴대폰 사진은 원본을 바꿀 수 없어서, 복사본으로 새 노트를 만들어요');
        return;
      }
      if (how === 'pc') {
        if (!L.root && !(await App.setBaseFolder())) return;
        const R = App.library.root;
        const [fh] = await showOpenFilePicker({ id: 'mininote-open', startIn: R.handle, types: [{ description: '이미지', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] } }] });
        const rel = await R.handle.resolve(fh);
        if (rel) entry = await App.library.resolveRel(rel);
        else {
          // outside the base folder: works on this PC only (the file itself is remembered in this browser)
          if ((await fh.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
          const f = await fh.getFile();
          entry = { kind: 'file', name: fh.name, handle: fh, mtime: f.lastModified, size: f.size, dir: { kind: 'dir', name: '외부 파일', external: true } };
          U.toast('기준 폴더 밖의 파일이라 이 PC에서만 연결돼요');
        }
      }
      if (how === 'drive') {
        const f = await pickDriveFile();
        if (!f) return;
        const b = L.backend, rel = await b.pathFromRoot(f.parentId);
        entry = Object.assign(f, { dir: { kind: 'dir', id: f.parentId, name: f.parentName, rel }, rel: rel ? [...rel, f.name] : null });
      }
      if (!entry) { U.toast('이미지를 찾지 못했어요'); return; }
      const known = L.images.find(e => (e.id && e.id === entry.id) || (e.rel && entry.rel && e.rel.join('/') === entry.rel.join('/')));
      App.editor.open([known || entry], 0);
    } catch (e) { if (e.name !== 'AbortError') App.handleError(e, '이미지를 열지 못했어요'); }
  };

  // ---- "폴더 열기": show where the original image lives ----
  App.openFolderOf = async e => {
    const L = App.library;
    const real = e && e.edited ? await L.resolveEdited(e, true) : e;
    if (!real) { U.toast('원본 이미지를 찾지 못했어요'); return; }
    if (L.backend.kind === 'drive') {
      const id = (real.dir && real.dir.id) || real.parentId;
      window.open(`https://drive.google.com/drive/folders/${id}`, '_blank'); // opens the Drive app on phones
      return;
    }
    if (L.backend.kind === 'opfs') { U.toast('앱 내부 저장소는 탐색기로 열 수 없어요'); return; }
    const rel = L.relOf(real);
    if (!rel) { U.toast(L.root ? '기준 폴더 밖의 파일이라 위치를 알 수 없어요' : '설정에서 기준 폴더를 먼저 정해주세요'); return; }
    if (!S.basePath || !S.explorerHelper) {
      const path = await U.dialog({
        title: '탐색기로 열기 준비 (한 번만)',
        body: U.h('div', null,
          U.h('p', null, `1) 미니수첩 폴더의 "탐색기 연결 설치.bat"을 한 번 실행해 주세요. (웹앱은 보안상 탐색기를 직접 못 열어서, 작은 연결 프로그램이 필요해요)`),
          U.h('p', null, `2) 기준 폴더 "${L.root.name}"의 실제 경로를 적어주세요. 탐색기 주소창에서 복사하면 돼요.`)),
        input: { value: S.basePath || '', placeholder: '예) G:\\구글드라이브 PC동기화폴더\\내 드라이브' },
        buttons: [{ label: '취소', value: null }, { label: '저장하고 열기', value: true, primary: true }],
      });
      if (!path || !/^[A-Za-z]:\\/.test(path.trim())) { if (path) U.toast('C:\\ 처럼 드라이브 문자로 시작하는 경로를 적어주세요'); return; }
      S.basePath = path.trim(); S.explorerHelper = true; App.saveSettings();
    }
    const abs = S.basePath.replace(/[\\/]+$/, '') + '\\' + rel.join('\\');
    location.href = 'mininote-open:' + encodeURIComponent(abs);
  };

  // choose a different app folder (where all edit files are kept)
  App.changeAppFolder = async () => {
    try {
      if (S.source === 'local') {
        const hd = await showDirectoryPicker({ id: 'mininote-app', mode: 'readwrite' });
        await U.idbSet('kv', 'localAppDir', hd); S.appOwner = null;
      } else if (S.source === 'drive') {
        const f = await pickDriveFolder();
        if (!f) return;
        S.driveAppDir = { id: f.id, name: f.name, ownerKey: null };
      } else { U.toast('앱 내부 저장소에서는 바꿀 수 없어요'); return; }
      App.saveSettings();
      await reopen();
      U.toast('앱 폴더를 바꿨어요. 기존 편집파일은 예전 폴더에 그대로 있어요');
    } catch (e) { if (e.name !== 'AbortError') App.handleError(e, '앱 폴더를 바꾸지 못했어요'); }
  };
  async function askClientId() {
    const id = await U.dialog({
      title: 'Google Drive 연결 준비',
      body: h('div', null,
        h('p', null, 'Google Drive를 쓰려면 한 번만 "OAuth 클라이언트 ID"를 만들어 붙여넣어야 해요. 방법은 앱 폴더의 "사용설명서.md"에 단계별로 적어뒀어요.'),
        h('p', { class: 'hint' }, `승인된 JavaScript 원본에 넣을 주소: ${location.origin}`)),
      input: { value: S.driveClientId, placeholder: '예) 1234-abcd.apps.googleusercontent.com' },
      buttons: [{ label: '취소', value: null }, { label: '저장', value: true, primary: true }],
    });
    if (id && id.trim()) { S.driveClientId = id.trim(); App.saveSettings(); App.driveAuth.loadGis().catch(() => {}); return S.driveClientId; }
    return null;
  }

  // Drive image browser: walk folders, tap an image → {id, name, mtime, size, parentId, parentName}
  function pickDriveFile() {
    const b = App.library.backend;
    const stack = [{ id: 'root', name: '내 드라이브' }];
    return new Promise(res => {
      const back = h('div', { class: 'modal-back' });
      const pathEl = h('div', { class: 'df-path' });
      const list = h('div', { class: 'df-list' });
      const done = v => { back.remove(); res(v); };
      const load = async () => {
        const cur = stack[stack.length - 1];
        pathEl.textContent = stack.map(s => s.name).join(' / ');
        list.replaceChildren(h('div', { class: 'spinner' }));
        try {
          const { folders, images } = await b.listForPicker(cur.id);
          const item = (icon, label, onclick, cls = '') => { const x = h('button', { class: 'df-item ' + cls, onclick, html: App.icon(icon) + '<span></span>' }); x.querySelector('span').textContent = label; return x; };
          list.replaceChildren(
            ...(stack.length > 1 ? [item('back', '상위 폴더', () => { stack.pop(); load(); }, 'up')] : []),
            ...folders.map(f => item('folder', f.name, () => { stack.push(f); load(); })),
            ...images.map(f => item('image', f.name, () => done(Object.assign(f, { parentId: cur.id === 'root' ? null : cur.id, parentName: cur.name })), 'img')));
          if (!folders.length && !images.length) list.append(h('p', { class: 'hint' }, '비어 있어요'));
        } catch (e) { list.replaceChildren(h('p', { class: 'hint' }, e.message)); }
      };
      back.append(h('div', { class: 'modal wide' },
        h('h3', null, '이미지 열기 (Google Drive)'),
        h('p', { class: 'hint' }, '편집하고 저장하면 이 원본 이미지가 바뀌어요. 편집파일은 앱 폴더에 모여요.'),
        pathEl, list,
        h('div', { class: 'modal-btns' }, h('button', { class: 'btn', onclick: () => done(null) }, '취소'))));
      document.body.append(back);
      load();
    }).then(async f => {
      if (f && !f.parentId) f.parentId = await b.rootId(); // images directly in "내 드라이브"
      return f;
    });
  }

  // Drive folder browser
  function pickDriveFolder() {
    const tmp = new App.DriveBackend({ id: 'root', name: '내 드라이브' });
    let stack = [{ id: 'root', name: '내 드라이브' }];
    return new Promise(res => {
      const back = h('div', { class: 'modal-back' });
      const pathEl = h('div', { class: 'df-path' });
      const list = h('div', { class: 'df-list' });
      const done = v => { back.remove(); res(v); };
      const load = async () => {
        const cur = stack[stack.length - 1];
        pathEl.textContent = stack.map(s => s.name).join(' / ');
        list.replaceChildren(h('div', { class: 'spinner' }));
        try {
          const fs = await tmp.listFolders(cur.id);
          list.replaceChildren(
            ...(stack.length > 1 ? [h('button', { class: 'df-item up', onclick: () => { stack.pop(); load(); }, html: App.icon('back') + '<span>상위 폴더</span>' })] : []),
            ...fs.map(f => h('button', { class: 'df-item', onclick: () => { stack.push(f); load(); }, html: App.icon('folder') + `<span></span>` }, )),
          );
          [...list.querySelectorAll('.df-item:not(.up) span')].forEach((s, i) => { s.textContent = fs[i].name; });
          if (!fs.length) list.append(h('p', { class: 'hint' }, '하위 폴더가 없어요'));
        } catch (e) { list.replaceChildren(h('p', { class: 'hint' }, e.message)); }
      };
      const box = h('div', { class: 'modal wide' },
        h('h3', null, '노트 폴더 선택 (Google Drive)'),
        h('p', { class: 'hint' }, '이미지(노트)가 들어있거나 들어갈 폴더로 들어간 뒤 "이 폴더 사용"을 누르세요.'),
        pathEl, list,
        h('div', { class: 'modal-btns' },
          h('button', { class: 'btn', onclick: () => done(null) }, '취소'),
          h('button', {
            class: 'btn', onclick: async () => {
              const n = await U.dialog({ title: '새 폴더', input: { placeholder: '폴더 이름' }, buttons: [{ label: '취소', value: null }, { label: '만들기', value: true, primary: true }] });
              if (n && n.trim()) { try { const d = await tmp.findDir(stack[stack.length - 1], n.trim(), true); stack.push(d); load(); } catch (e) { U.toast(e.message); } }
            },
          }, '새 폴더'),
          h('button', { class: 'btn primary', onclick: () => { const c = stack[stack.length - 1]; done({ id: c.id, name: c.name }); } }, '이 폴더 사용')));
      back.append(box);
      document.body.append(back);
      load();
    });
  }

  // ---------------- home ----------------
  // Once set up, the storage is fixed: the home screen only asks for the one tap the browser needs
  // (folder permission after a restart on PC, Google login after it expired). `choose` shows every option.
  App.showHome = async choose => {
    App.show('home');
    const el = U.$('#home-actions'), home = U.$('#home');
    const prev = S.source;
    const kids = [];
    let resume = null, note = '';
    if (prev === 'local') {
      const hs = await localHandles(), baseH = await U.idbGet('kv', 'baseDir');
      if (hs.length || baseH) {
        resume = h('button', { class: 'home-btn primary', onclick: () => useLocal(true).then(ok => ok || U.toast('폴더 권한이 거부됐어요')), html: App.icon('folder') + '<span><b>미니수첩 열기</b><small></small></span>' });
        resume.querySelector('small').textContent = baseH ? `${baseH.name} › 미니수첩` : hs.map(x => x.name).join(', ');
        note = '브라우저 보안 때문에 다시 켜면 폴더 접근을 한 번 허용해야 해요.\n허용 창에 "방문할 때마다 허용"이 보이면 그걸 고르세요 — 다음부터는 이 화면 없이 바로 열려요.';
      }
    }
    if (prev === 'drive') {
      resume = h('button', {
        class: 'home-btn primary', html: App.icon('cloud') + '<span><b>미니수첩 열기</b><small>내 드라이브 › 미니수첩</small></span>',
        onclick: async () => { try { await App.driveAuth.loadGis(); if (!App.driveAuth.valid()) await App.driveAuth.request(); await useDrive(); } catch (e) { App.handleError(e, '로그인 실패'); } },
      });
      note = 'Google 로그인은 1시간이 지나면 만료돼서, 그 뒤에 열 때는 한 번 눌러 다시 연결해요.';
    }
    home.onclick = null;
    if (resume && !choose) {
      el.replaceChildren(resume, h('p', { class: 'home-note' }, note));
      // a tap anywhere on the screen does the same
      home.onclick = e => { if (!e.target.closest('button')) resume.click(); };
      if (S.driveClientId) App.driveAuth.loadGis().catch(() => {});
      return;
    }
    if (resume) kids.push(resume);
    // phones/tablets: Google Drive first; their system folder picker can't show Drive and blocks top-level folders
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const driveBtn = h('button', { class: 'home-btn' + (mobile && prev !== 'drive' ? ' primary' : ''), onclick: connectDrive, html: App.icon('cloud') + `<span><b>Google Drive로 시작</b><small>${mobile ? '휴대폰은 이걸 누르세요 — PC와 같은 "내 드라이브 › 미니수첩"을 써요' : '폰·태블릿에서 쓰는 방법 (내 드라이브 › 미니수첩)'}</small></span>` });
    const pcBtn = window.showDirectoryPicker && (mobile
      ? h('button', { class: 'home-btn', onclick: pickLocal, html: App.icon('folder') + '<span><b>휴대폰 안의 폴더 열기 (고급)</b><small>구글 드라이브가 아닌 휴대폰 저장공간 폴더예요. PC와 연동되지 않고, 저장공간 맨 위·Download 폴더는 안드로이드가 막아요</small></span>' })
      : h('button', { class: 'home-btn', onclick: pickLocal, html: App.icon('folder') + '<span><b>PC에서 시작</b><small>"내 드라이브"(구글 드라이브 동기화 폴더)를 고르면 그 안에 미니수첩 폴더를 만들어요</small></span>' }));
    if (mobile) kids.push(driveBtn); else if (pcBtn) kids.push(pcBtn);
    if (mobile) { if (pcBtn) kids.push(pcBtn); } else kids.push(driveBtn);
    if (navigator.storage && navigator.storage.getDirectory) kids.push(h('button', { class: 'home-btn', onclick: () => useOpfs().catch(e => App.handleError(e)), html: App.icon('image') + '<span><b>앱 내부 저장소로 체험</b><small>설정 없이 바로 테스트 (이 기기 브라우저 안에만 저장)</small></span>' }));
    if (!App.isInstalled()) kids.push(h('button', { class: 'home-btn', onclick: () => App.install(), html: App.icon('download') + '<span><b>앱으로 설치</b><small>홈 화면 아이콘으로 바로 열고, 인터넷 없이도 실행돼요</small></span>' }));
    el.replaceChildren(...kids);
    if (S.driveClientId) App.driveAuth.loadGis().catch(() => {});
  };

  // ---------------- settings ----------------
  App.openSettings = () => {
    const ui = App.ui;
    const nn = S.newNote;
    const wIn = h('input', { class: 'field num', type: 'number', min: 64, max: 8000, value: nn.w });
    const hIn = h('input', { class: 'field num', type: 'number', min: 64, max: 8000, value: nn.h });
    const bgIn = h('input', { type: 'color', value: nn.bg || '#ffffff' });
    const setSize = () => { nn.w = U.clamp(Number(wIn.value) || 1080, 64, 8000); nn.h = U.clamp(Number(hIn.value) || 1440, 64, 8000); nn.bg = bgIn.value; App.saveSettings(); };
    [wIn, hIn, bgIn].forEach(i => i.addEventListener('change', setSize));
    const preset = (label, w, hh) => h('button', { class: 'chip', onclick: () => { wIn.value = w; hIn.value = hh; setSize(); } }, label);
    const cid = h('input', { class: 'field', value: S.driveClientId, placeholder: 'xxxx.apps.googleusercontent.com' });
    cid.addEventListener('change', () => { S.driveClientId = cid.value.trim(); App.saveSettings(); if (S.driveClientId) App.driveAuth.loadGis().catch(() => {}); });

    // PC only: the real path of the base folder, used to open Explorer at an image (see "탐색기 연결 설치.bat")
    const basePathRow = () => {
      const inp = h('input', { class: 'field', value: S.basePath || '', placeholder: '예) G:\\구글드라이브 PC동기화폴더\\내 드라이브' });
      inp.addEventListener('change', () => { S.basePath = inp.value.trim(); S.explorerHelper = !!S.basePath; App.saveSettings(); });
      return h('label', { class: 'fieldrow' }, h('span', null, '기준 폴더의 실제 경로 (탐색기로 열기용)'), inp);
    };
    const body = h('div', { class: 'settings' },
      h('h4', null, '저장 위치'),
      h('div', { class: 'row' }, h('span', null, `이미지 폴더 ${App.library.folders.length}개: ${App.library.folders.map(f => f.name).join(', ') || '없음'}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { back.remove(); App.addFolder(); } }, '폴더 추가'),
        h('button', { class: 'btn small', onclick: () => { back.remove(); App.showHome(true); } }, '저장 방식 바꾸기')),
      h('div', { class: 'row' }, h('span', null, `앱 폴더(편집파일 보관): ${App.library.appDir ? App.library.appDir.name + (App.library.appDir.ownerKey ? ` (${(App.library.folderByKey(App.library.appDir.ownerKey) || {}).name || ''} 안)` : '') : '없음'}`),
        h('button', { class: 'btn small', onclick: () => { back.remove(); App.changeAppFolder(); } }, '변경')),
      h('div', { class: 'row' }, h('span', null, `기준 폴더: ${App.library.root ? App.library.root.name : '없음 (이미지 열기·편집한 노트에 필요)'}`),
        S.source === 'local' && h('button', { class: 'btn small', onclick: () => { back.remove(); App.setBaseFolder(); } }, App.library.root ? '변경' : '정하기')),
      S.source === 'local' && basePathRow(),
      h('p', { class: 'hint' }, '기준 폴더 아래의 이미지는 "이미지 열기"로 어디서든 열 수 있고, 편집파일이 원본 위치를 기억해요. 원본을 다른 폴더로 옮겨도 다시 찾아서 연결을 고쳐요. PC는 "내 드라이브"(구글 드라이브 동기화 폴더)를 고르면 폰과 경로가 같아져요.'),
      h('p', { class: 'hint' }, '여러 폴더의 이미지를 함께 보고 편집할 수 있어요. 저장하면 원본 이미지는 원래 폴더에서 바뀌고, 레이어가 살아있는 편집파일은 모두 앱 폴더 한 곳에 모여요. PC와 폰에서 같은 앱 폴더를 쓰면 편집파일도 함께 이어져요.'),
      h('p', { class: 'hint' }, `기기 간 연동: 브러시 설정·즐겨찾기·최근 색·글꼴 설정은 앱 폴더의 "${App.sync.NAME}" 파일로 자동으로 맞춰져요. 필압·손가락 그리기·단축키·갤러리 보기는 기기마다 따로예요.`),
      h('h4', null, '그리기'),
      ui.toggle({ label: '손가락으로 그리기', get: () => S.fingerDraw, set: v => { S.fingerDraw = v; } }),
      ui.toggle({ label: '펜이 감지되면 손가락은 이동·확대 전용 (손바닥 인식 방지)', get: () => S.palmRejection, set: v => { S.palmRejection = v; } }),
      ui.toggle({ label: '선 끝 예측 (반응이 빨라 보이지만, 선이 끌려오는 느낌이 들 수 있음)', get: () => S.predict, set: v => { S.predict = v; } }),
      h('p', { class: 'hint' }, '손가락 그리기가 꺼져 있으면 한 손가락으로 좌우로 밀어 다음 노트로 넘어가요. 두 손가락 탭 = 실행취소, 세 손가락 탭 = 다시 실행.'),
      h('h4', null, '저장'),
      ui.toggle({ label: '다른 노트로 넘어가거나 닫을 때 자동 저장', get: () => S.autosave, set: v => { S.autosave = v; } }),
      ui.slider({ label: 'JPG 품질', min: 0.6, max: 1, step: 0.01, get: () => S.jpegQuality, set: v => { S.jpegQuality = v; }, fmt: v => Math.round(v * 100) + '%' }),
      h('h4', null, '새 노트'),
      h('div', { class: 'row' }, wIn, '×', hIn, 'px', bgIn),
      h('div', { class: 'chips' }, preset('세로 3:4', 1080, 1440), preset('A5 세로', 1240, 1748), preset('정사각', 1440, 1440), preset('가로 4:3', 1440, 1080), preset('폰 화면', 1080, 2340)),
      h('h4', null, 'Google Drive'),
      h('label', { class: 'fieldrow' }, h('span', null, 'OAuth 클라이언트 ID'), cid),
      h('p', { class: 'hint' }, `승인된 JavaScript 원본: ${location.origin}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { App.driveAuth.signOut(); U.toast('로그아웃했어요'); } }, 'Google 로그아웃')),
      h('h4', null, '기타'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => App.keys.openDialog() }, '단축키 설정 (PC)'),
        h('button', { class: 'btn small', onclick: () => App.install() }, App.isInstalled() ? '앱으로 설치됨 ✓' : '앱으로 설치'),
        h('button', { class: 'btn small', onclick: async () => { await U.idbClear('thumbs'); App.gallery.urls.clear(); U.toast('썸네일 캐시를 비웠어요'); App.gallery.render(); } }, '썸네일 캐시 비우기')),
      h('p', { class: 'hint' }, `미니수첩 v${App.VERSION}`));

    const back = h('div', { class: 'modal-back' });
    const box = h('div', { class: 'modal wide' }, h('h3', null, '설정'), body,
      h('div', { class: 'modal-btns' }, h('button', { class: 'btn primary', onclick: () => back.remove() }, '닫기')));
    back.addEventListener('pointerdown', e => { if (e.target === back) back.remove(); });
    back.append(box);
    document.body.append(back);
  };

  // ---------------- images coming from outside: drop, share ----------------
  // In the editor an image becomes a new layer; in the gallery it becomes a new note.
  App.receiveImages = async blobs => {
    blobs = blobs.filter(b => b && /^image\//.test(b.type || 'image/png'));
    if (!blobs.length) return;
    const ed = App.editor;
    if (ed.visible && ed.doc) { for (const b of blobs) await ed.pasteImage(b); return; }
    if (!App.library.backend) { App.pendingImages = blobs; U.toast('먼저 저장 위치를 열어주세요. 열면 이미지가 새 노트로 들어가요'); return; }
    try {
      const { doc, ctx } = await App.library.newDocFromImage(blobs[0]);
      ed.list = App.library.visible(); ed.idx = -1;
      App.show('editor');
      ed.setDoc(doc, ctx, true);
      for (const b of blobs.slice(1)) await ed.pasteImage(b);
      U.toast(`새 노트로 열었어요 — 저장하면 "${ctx.dir.name}" 폴더에 들어가요`);
    } catch (e) { App.handleError(e, '이미지를 열지 못했어요'); }
  };
  const draggedImages = async dt => {
    const files = [...(dt.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) return files;
    // dragged from a web page / some apps: an image URL instead of a file
    const url = (dt.getData('text/uri-list') || '').split('\n').find(s => /^(https?:|data:image)/.test(s.trim()))
      || ((dt.getData('text/html') || '').match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (!url) return [];
    try { const r = await fetch(url.trim()); const b = await r.blob(); return b.type.startsWith('image/') ? [b] : []; }
    catch { U.toast('이 이미지는 끌어다 놓을 수 없어요 (저장 후 넣어주세요)'); return []; }
  };
  window.addEventListener('dragover', e => {
    if (![...(e.dataTransfer?.types || [])].some(t => t === 'Files' || t === 'text/uri-list' || t === 'text/html')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dropping');
  });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', async e => {
    document.body.classList.remove('dropping');
    if (!e.dataTransfer) return;
    e.preventDefault();
    App.receiveImages(await draggedImages(e.dataTransfer));
  });
  // "공유" from the phone's gallery: the service worker stores the files and reopens the app with ?share=N
  async function takeSharedImages() {
    const n = Number(new URLSearchParams(location.search).get('share') || 0);
    if (!n || !('caches' in window)) return [];
    history.replaceState(null, '', location.pathname);
    const c = await caches.open('mininote-share');
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = await c.match(`share/${i}`);
      if (r) out.push(await r.blob());
      await c.delete(`share/${i}`);
    }
    return out;
  }

  // ---------------- boot ----------------
  async function boot() {
    App.editor.init();
    App.gallery.init();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
    try { const shared = await takeSharedImages(); if (shared.length) App.pendingImages = shared; } catch (e) { console.warn(e); }
    try {
      if (S.source === 'local') { if (await useLocal(false)) return; }
      else if (S.source === 'opfs') { await useOpfs(); return; }
      else if (S.source === 'drive' && App.driveAuth.valid()) { await useDrive(); return; }
    } catch (e) { console.warn(e); }
    App.showHome();
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
