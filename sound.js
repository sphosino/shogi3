// 音（2026-10-29）：BGM（sound/bgm.mp3）を流す。i18n.js のあとに読みこむ
//   最初は鳴らさない。言葉の切りかえの横の🔇/🔊ボタンでオンにした人だけ鳴る。オン／オフはまた遊ぼのゲームで共通の mataasobo-sound に覚える
//   ブラウザは人が一度どこかを押すまで音を鳴らせないので、オンのまま開いたときは、最初に押されたときに鳴らし始める
//   タブを隠したら止め、戻ったら続きから鳴らす
(function () {
  const KEY = 'mataasobo-sound';
  let on = false;
  try { on = localStorage.getItem(KEY) === 'on'; } catch (e) {}
  const bgm = new Audio('sound/bgm.mp3');
  bgm.loop = true; bgm.volume = 0.35; bgm.preload = 'none';
  const play = () => { if (on && !document.hidden) bgm.play().catch(() => {}); };
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'soundBtn';
  const show = () => {
    b.textContent = on ? '🔊' : '🔇';
    b.setAttribute('aria-label', on ? L('音を消す', 'Sound off') : L('音を出す', 'Sound on'));
    b.title = b.getAttribute('aria-label');
  };
  b.style.cssText = 'font:700 13px var(--ui,sans-serif);padding:4px 10px;border-radius:999px;border:2px solid #f1dcc6;background:#fffdf9;color:#4a2f22;cursor:pointer;line-height:1.2';
  b.onclick = () => {
    on = !on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    show();
    if (on) play(); else bgm.pause();
  };
  show();
  // 言葉の切りかえ（i18n.js の langBtn）と並べて置く
  const lb = document.getElementById('langBtn');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;align-items:center';
  if (lb && lb.style.position === 'static') {   // ひとりで指す画面：いちばん上に右寄せ
    wrap.style.margin = '0 0 6px auto';
    lb.before(wrap); lb.style.display = 'inline-block'; lb.style.margin = '0';
    wrap.append(b, lb);
  } else {                                       // みんなと指す画面：右上の角に
    wrap.style.cssText += ';position:absolute;top:8px;right:8px;z-index:50';
    document.body.appendChild(wrap);
    if (lb) { lb.style.position = 'static'; wrap.append(b, lb); } else wrap.append(b);
  }
  if (on) {
    const start = () => { play(); document.removeEventListener('pointerdown', start, true); document.removeEventListener('keydown', start, true); };
    document.addEventListener('pointerdown', start, true);
    document.addEventListener('keydown', start, true);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) bgm.pause(); else play(); });
})();
