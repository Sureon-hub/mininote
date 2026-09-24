'use strict';
// Boot, screens, storage source selection, settings, Google Drive folder picker.
(() => {
  const U = App.util, h = U.h, S = App.settings;
  App.VERSION = '0.3.4';

  // ---------------- screens ----------------
  App.show = name => {
    for (const id of ['home', 'gallery', 'editor']) U.$('#' + id).hidden = id !== name;
    if (name === 'editor' && !(history.state && history.state.editor)) history.pushState({ editor: true }, '');
    if (name !== 'editor' && history.state && history.state.editor) { App._ignorePop = true; history.back(); }
    if (name === 'editor') requestAnimationFrame(() => App.editor.resize());
  };
  window.addEventListener('popstate', async () => {
    if (App._ignorePop) { App._ignorePop = false; return; }
    if (App.editor.visible) {
      const ok = await App.editor.close();
      if (!ok) history.pushState({ editor: true }, '');
    }
  });
  window.addEventListener('beforeunload', e => {
    if (App.editor.visible && App.editor.dirty) { e.preventDefault(); e.returnValue = ''; }
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
  }
  async function useLocal(handle, interactive) {
    const b = new App.LocalBackend(handle, 'local');
    if (!(await b.ensurePermission(interactive))) return false;
    App.library.setBackend(b);
    S.source = 'local'; App.saveSettings();
    await U.idbSet('kv', 'localRoot', handle);
    await enterGallery();
    return true;
  }
  async function useOpfs() {
    const root = await navigator.storage.getDirectory();
    const hd = await root.getDirectoryHandle('MiniNote', { create: true });
    try { await navigator.storage.persist?.(); } catch { /* ignore */ }
    App.library.setBackend(new App.LocalBackend(hd, 'opfs'));
    S.source = 'opfs'; App.saveSettings();
    await enterGallery();
  }
  async function useDrive(folder) {
    App.library.setBackend(new App.DriveBackend(folder));
    S.source = 'drive'; S.driveFolder = folder; App.saveSettings();
    await enterGallery();
  }
  async function pickLocal() {
    try {
      const hd = await showDirectoryPicker({ id: 'mininote', mode: 'readwrite' });
      await useLocal(hd, true);
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
      const folder = await pickDriveFolder();
      if (folder) await useDrive(folder);
    } catch (e) { App.handleError(e, 'Google Drive 연결 실패'); }
  }
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
  App.showHome = async () => {
    App.show('home');
    const el = U.$('#home-actions');
    const prev = S.source;
    const kids = [];
    if (prev === 'local') {
      const hd = await U.idbGet('kv', 'localRoot');
      if (hd) kids.push(h('button', { class: 'home-btn primary', onclick: () => useLocal(hd, true).then(ok => ok || U.toast('폴더 권한이 거부됐어요')), html: App.icon('folder') + `<span><b>이어서 열기</b><small></small></span>` }));
      if (hd) kids[kids.length - 1].querySelector('small').textContent = hd.name;
    }
    if (prev === 'drive' && S.driveFolder) {
      const b = h('button', {
        class: 'home-btn primary', html: App.icon('cloud') + '<span><b>이어서 열기 (Google Drive)</b><small></small></span>',
        onclick: async () => { try { await App.driveAuth.loadGis(); if (!App.driveAuth.valid()) await App.driveAuth.request(); await useDrive(S.driveFolder); } catch (e) { App.handleError(e, '로그인 실패'); } },
      });
      b.querySelector('small').textContent = S.driveFolder.name;
      kids.push(b);
    }
    if (window.showDirectoryPicker) kids.push(h('button', { class: 'home-btn', onclick: pickLocal, html: App.icon('folder') + '<span><b>PC 폴더 열기</b><small>구글 드라이브 동기화 폴더(G:)를 고르면 폰과 자동으로 공유돼요</small></span>' }));
    kids.push(h('button', { class: 'home-btn', onclick: connectDrive, html: App.icon('cloud') + '<span><b>Google Drive 폴더 연결</b><small>폰·태블릿에서는 이 방법을 쓰세요</small></span>' }));
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

    const body = h('div', { class: 'settings' },
      h('h4', null, '저장 위치'),
      h('div', { class: 'row' }, h('span', null, App.library.backend ? App.library.backend.label : '없음'),
        h('button', { class: 'btn small', onclick: () => { back.remove(); App.showHome(); } }, '변경')),
      h('p', { class: 'hint' }, `저장하면 원본 이미지를 덮어쓰고, 레이어가 살아있는 편집파일은 같은 폴더의 "${App.project.EDIT_DIR}" 폴더에 보관돼요.`),
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

  // ---------------- boot ----------------
  async function boot() {
    App.editor.init();
    App.gallery.init();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
    try {
      if (S.source === 'local') {
        const hd = await U.idbGet('kv', 'localRoot');
        if (hd && (await useLocal(hd, false))) return;
      } else if (S.source === 'opfs') { await useOpfs(); return; }
      else if (S.source === 'drive' && S.driveFolder && App.driveAuth.valid()) { await useDrive(S.driveFolder); return; }
    } catch (e) { console.warn(e); }
    App.showHome();
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
