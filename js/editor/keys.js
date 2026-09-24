'use strict';
// Keyboard shortcuts: action list with defaults, user overrides (App.settings.keys), and the editor dialog.
// Combos are built from physical keys (e.code), so shortcuts keep working while the Korean IME is on.
(() => {
  const U = App.util, h = U.h;

  // [id, label, default combos]
  const ACTIONS = [
    ['도구', [
      ['tool.brush', '브러시', ['b']], ['tool.eraser', '지우개', ['e']], ['tool.fill', '채우기', ['g']],
      ['tool.select', '사각 선택', ['m']], ['tool.lasso', '올가미 선택', ['l']], ['tool.transform', '변형·이동', ['v', 'ctrl+t']],
      ['tool.picker', '스포이트', ['i']], ['tool.text', '텍스트', ['t']], ['tool.hand', '손 도구', ['h']],
    ]],
    ['브러시', [
      ['brush.smaller', '브러시 작게', ['[']], ['brush.bigger', '브러시 크게', [']']],
      ...Array.from({ length: 9 }, (_, i) => [`brush.fav${i + 1}`, `브러시 목록 ${i + 1}번 (연필·펜·형광펜·즐겨찾기 순)`, [String(i + 1)]]),
    ]],
    ['편집', [
      ['undo', '실행 취소', ['ctrl+z']], ['redo', '다시 실행', ['ctrl+y', 'ctrl+shift+z']], ['save', '저장', ['ctrl+s']],
      ['edit.copy', '복사', ['ctrl+c']], ['edit.cut', '잘라내기', ['ctrl+x']], ['edit.clear', '선택 영역/레이어 지우기', ['delete', 'backspace']],
      ['sel.all', '전체 선택', ['ctrl+a']], ['sel.none', '선택 해제', ['ctrl+d']], ['sel.invert', '선택 반전', ['ctrl+shift+i']],
    ]],
    ['레이어', [
      ['layer.new', '새 레이어', ['ctrl+shift+n']], ['layer.dup', '레이어 복제', ['ctrl+j']], ['layer.del', '레이어 삭제', ['ctrl+shift+delete']],
      ['layer.merge', '아래 레이어와 병합', ['ctrl+e']], ['layer.up', '레이어 위로 옮기기', ['ctrl+]']], ['layer.down', '레이어 아래로 옮기기', ['ctrl+[']],
      ['layer.selUp', '위 레이어 선택', ['alt+]']], ['layer.selDown', '아래 레이어 선택', ['alt+[']],
    ]],
    ['화면', [
      ['view.zoomIn', '확대', ['ctrl+=']], ['view.zoomOut', '축소', ['ctrl+-']], ['view.fit', '화면에 맞추기 (회전 초기화)', ['ctrl+0']],
      ['view.actual', '실제 크기 100%', ['ctrl+1']], ['view.rotL', '왼쪽으로 15° 회전', ['q']], ['view.rotR', '오른쪽으로 15° 회전', ['w']],
      ['view.rotReset', '회전 초기화', ['r']], ['note.prev', '이전 노트', ['arrowleft']], ['note.next', '다음 노트', ['arrowright']],
      ['panel.layers', '레이어 패널', ['f7']], ['panel.brush', '브러시 패널', ['f8']], ['panel.color', '색상 패널', ['f6']],
    ]],
    // shown on the gallery (main screen); same keys may mean something else in the editor
    ['갤러리 (메인 화면)', [
      ['gallery.refresh', '새로고침', ['ctrl+r', 'f5']], ['gallery.selectAll', '전체 선택', ['ctrl+a']],
      ['gallery.delete', '선택한 노트를 휴지통으로', ['delete']], ['gallery.deleteProj', '선택한 노트의 편집파일만 삭제', ['shift+delete']],
      ['gallery.new', '새 노트', ['n']], ['gallery.openImage', '이미지 열기', ['o']],
    ]],
  ];
  const ALL = ACTIONS.flatMap(([, list]) => list);
  const scopeOf = id => (id.startsWith('gallery.') ? 'gallery' : 'editor');

  const CODE = {
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
    Quote: "'", Backquote: '`', Backslash: '\\', NumpadAdd: '=', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
    Space: 'space', Enter: 'enter', NumpadEnter: 'enter', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', Tab: 'tab',
    ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', Home: 'home', End: 'end',
    PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert',
  };
  const keyOf = e => {
    const c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
    if (/^(Digit|Numpad)\d$/.test(c)) return c.slice(-1);
    if (/^F\d{1,2}$/.test(c)) return c.toLowerCase();
    if (CODE[c]) return CODE[c];
    return (e.key || '').toLowerCase();
  };
  const MODS = new Set(['control', 'shift', 'alt', 'meta', 'os']);
  const comboOf = e => {
    const k = keyOf(e);
    if (!k || MODS.has(k) || /^(control|shift|alt|meta)(left|right)$/.test((e.code || '').toLowerCase())) return '';
    return [(e.ctrlKey || e.metaKey) && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', k].filter(Boolean).join('+');
  };
  const LABEL = { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', space: 'Space', enter: 'Enter', escape: 'Esc', delete: 'Del', backspace: 'Backspace' };
  const pretty = c => c.split('+').map(p => ({ ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' })[p] || LABEL[p] || (p.length === 1 ? p.toUpperCase() : p.toUpperCase())).join(' + ');

  const combosFor = id => {
    const user = App.settings.keys && App.settings.keys[id];
    if (user !== undefined) return user ? [user] : [];
    return (ALL.find(a => a[0] === id) || [0, 0, []])[2];
  };
  let index = null; // scope -> Map(combo -> action)
  const buildIndex = () => {
    index = { editor: new Map(), gallery: new Map() };
    for (const [id] of ALL) for (const c of combosFor(id)) { const m = index[scopeOf(id)]; if (!m.has(c)) m.set(c, id); }
  };

  App.keys = {
    ACTIONS, comboOf, pretty, combosFor,
    actionFor(combo, scope = 'editor') { if (!combo) return null; if (!index) buildIndex(); return index[scope].get(combo) || null; },
    set(id, combo) {
      const K = App.settings.keys || (App.settings.keys = {});
      // a key can only mean one thing per screen: take it away from the other action on the same screen
      if (combo) for (const [other] of ALL) if (other !== id && scopeOf(other) === scopeOf(id) && combosFor(other).includes(combo)) K[other] = combosFor(other).filter(c => c !== combo)[0] || '';
      K[id] = combo;
      index = null;
      App.saveSettings();
    },
    reset() { App.settings.keys = {}; index = null; App.saveSettings(); },

    openDialog() {
      const back = h('div', { class: 'modal-back' });
      const body = h('div', { class: 'keys-list' });
      let capture = null;
      const render = () => {
        body.replaceChildren(...ACTIONS.map(([group, list]) => h('div', { class: 'keys-group' },
          h('h4', null, group),
          ...list.map(([id, label]) => {
            const cs = combosFor(id);
            const btn = h('button', { class: 'key-btn' + (capture && capture.id === id ? ' rec' : ''), onclick: () => { capture = { id }; render(); } },
              capture && capture.id === id ? '키를 누르세요…' : (cs.length ? cs.map(pretty).join('  /  ') : '없음'));
            return h('div', { class: 'key-row' }, h('span', null, label), btn,
              h('button', { class: 'ib key-clear', title: '지우기', html: App.icon('x'), onclick: () => { this.set(id, ''); render(); } }));
          }))));
      };
      const onKey = e => {
        if (!capture) { if (e.key === 'Escape') close(); return; }
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { capture = null; render(); return; }
        const c = comboOf(e);
        if (!c) return; // modifier only – wait for the real key
        const clash = ALL.find(([other]) => other !== capture.id && scopeOf(other) === scopeOf(capture.id) && combosFor(other).includes(c));
        this.set(capture.id, c);
        if (clash) U.toast(`"${clash[1]}"에서 ${pretty(c)}를 빼고 옮겼어요`);
        capture = null;
        render();
      };
      const close = () => { document.removeEventListener('keydown', onKey, true); back.remove(); };
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
      back.append(h('div', { class: 'modal wide' },
        h('h3', null, '단축키 설정'),
        h('p', { class: 'hint' }, '바꿀 항목의 버튼을 누르고 원하는 키(조합)를 누르세요. Esc = 취소. 한글 입력 상태에서도 같은 키로 동작해요. Space(누르고 있으면 손 도구), Enter(변형 확정), Esc(취소)는 고정이에요.'),
        body,
        h('div', { class: 'modal-btns' },
          h('button', { class: 'btn', onclick: () => { this.reset(); render(); } }, '모두 기본값으로'),
          h('button', { class: 'btn primary', onclick: close }, '닫기'))));
      document.body.append(back);
      render();
    },
  };
})();
