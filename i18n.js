// 言葉（2026-10-25）：日本語と英語。ひとりで指す画面（shogi3.html）と、みんなと指す画面（room.html）で、いちばん先に読みこむ
//   ?lang=en・?lang=ja で選ぶと、このブラウザに覚える（また遊ぼのゲームで共通の mataasobo-lang）。選んでいなければブラウザの言語（日本語以外は英語）
//   画面の決まった字は data-en（title は data-en-title、aria-label は data-en-label）、動きで変わる字は L('日本語','English')
//   tools/selfplay.js などは constants.js をそのまま Node で動かすので、L と EN は globalThis に置く（ないときは constants.js が日本語にする）
(function () {
  let l = null;
  try {
    l = new URLSearchParams(location.search).get('lang');
    if (l === 'en' || l === 'ja') localStorage.setItem('mataasobo-lang', l); else l = localStorage.getItem('mataasobo-lang');
  } catch (e) {}
  const lang = l === 'en' || l === 'ja' ? l : /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en';
  const EN = lang === 'en';
  globalThis.EN = EN;
  globalThis.L = (ja, en) => (EN ? en : ja);
  document.documentElement.lang = lang;
  if (EN) {
    document.title = document.title.replace('三人将棋 みんなと指す｜また遊ぼ', 'Three-Player Shogi: Play Online').replace('三人将棋', 'Three-Player Shogi');
    document.querySelectorAll('[data-en]').forEach((e) => { e.innerHTML = e.dataset.en; });
    document.querySelectorAll('[data-en-title]').forEach((e) => { e.title = e.dataset.enTitle; });
    document.querySelectorAll('[data-en-label]').forEach((e) => e.setAttribute('aria-label', e.dataset.enLabel));
  }
  // 言葉の切りかえ：画面の右上に小さく
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'langBtn'; b.textContent = EN ? '日本語' : 'EN'; b.setAttribute('aria-label', EN ? '日本語にする' : 'English');
  b.style.cssText = 'position:absolute;top:8px;right:8px;z-index:50;font:700 13px var(--ui,sans-serif);padding:4px 12px;border-radius:999px;border:2px solid #f1dcc6;background:#fffdf9;color:#4a2f22;cursor:pointer';
  b.onclick = () => { const u = new URLSearchParams(location.search); u.set('lang', EN ? 'ja' : 'en'); location.search = u; };
  // ひとりで指す画面では、いちばん上の「みんなと指す」の帯にかぶらないよう、その上に右寄せで置く
  const top = document.querySelector('.online-link');
  if (top) { b.style.position = 'static'; b.style.display = 'block'; b.style.margin = '0 0 6px auto'; top.before(b); }
  else document.body.appendChild(b);
})();
