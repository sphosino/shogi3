// 結果を X にシェアする（ひとりで指す画面 shogi3.html と、みんなと指す画面 room.html で使う）
//   スマホなど、画像つきで共有できるブラウザでは、盤の画像つきで「共有」を開く。できなければ X の投稿画面を開く（文とリンクだけ）
//   ひとりで指す画面では、対局が終わると盤の下に「結果をXでシェア」が出る（render のあとに見ている）
'use strict';
const Share = (() => {
  const SEAT = EN ? ['Blue', 'Red', 'Green'] : ['青将', '赤将', '緑将'];
  const HOW = EN ? { normal: 'king capture', trywin: 'king entry', limit: '500-move limit', king: 'king capture', try: 'king entry' }
    : { normal: '玉取り', trywin: '入玉', limit: '500手', king: '玉取り', try: '入玉' };
  const TAG = L(' #三人将棋', ' #ThreePlayerShogi');
  // 盤の画像をつけて共有。できなければ X の投稿画面
  async function post(text, url, where) {
    if (typeof gtag === 'function') gtag('event', 'share_result', { where });
    try {
      const cv = document.getElementById('c');
      const blob = cv && await new Promise((r) => cv.toBlob(r, 'image/png'));
      const file = blob && new File([blob], 'shogi3.png', { type: 'image/png' });
      // 画像つきの共有はスマホ（指で触る端末）だけ。パソコンは Windows の共有の画面より、X の投稿画面のほうが自然
      const phone = window.matchMedia && matchMedia('(pointer: coarse)').matches;
      if (phone && file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ text: text + '\n' + url, files: [file] });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 共有の画面を閉じただけ
    }
    window.open('https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank', 'noopener');
  }

  // ---------- ひとりで指す画面 ----------
  let out = [], seenGen = -1, prevElim = [false, false, false], skipGen = -1, box = null;
  // 誰がどの順で脱落したかを覚える（順位に使う）
  function watch() {
    if (typeof gameGen === 'undefined' || !eliminated) return;
    if (gameGen !== seenGen) { seenGen = gameGen; out = []; prevElim = [false, false, false]; }
    eliminated.forEach((e, i) => { if (e && !prevElim[i]) out.push(i); });
    prevElim = eliminated.slice();
    update();
  }
  function soloText() {
    const me = humanPlayer, color = SEAT[me], how = HOW[winType] || HOW.normal, n = moveCount;
    const d = DIFFICULTY_LEVELS[currentDifficulty] || {};
    const opp = d.net ? L('学習AI', 'the neural AI') : L(`CPU（${d.label || ''}）`, `the CPU (${d.label || ''})`);
    const k = out.indexOf(me); // 脱落した順（0 が最初）
    const place = k === 0 ? 3 : k === 1 ? 2 : null;
    if (EN) {
      if (winner === me) return `I beat 2 × ${opp} at Three-Player Shogi! (${color} · ${how} · ${n} moves)`;
      return place ? `I took on ${opp} at Three-Player Shogi and placed ${place === 2 ? '2nd' : '3rd'} (${color} · ${n} moves)` : `I lost to ${opp} at Three-Player Shogi… (${color} · ${SEAT[winner]} won by ${how} · ${n} moves)`;
    }
    if (winner === me) return `三人将棋で、${opp} 2人に勝った！（${color}・${how}・${n}手）`;
    return place ? `三人将棋で、${opp}に挑んで${place}位でした（${color}・${n}手）` : `三人将棋で、${opp}に負けた…（${color}・${SEAT[winner]}が${how}で勝ち・${n}手）`;
  }
  function update() {
    // 決着したとき、または自分が脱落したとき（投了・玉を取られた。順位はそこで決まる。CPUどうしの続きは見ていられる）
    const done = (gover && winner >= 0) || (humanPlayer >= 0 && eliminated[humanPlayer]);
    const show = done && humanPlayer >= 0 && !selfPlayMode && moveCount > 0 && gameGen !== skipGen &&
      !(typeof reviewMode !== 'undefined' && reviewMode);
    if (!box) {
      const wrap = document.getElementById('canvas-wrap'); if (!wrap) return;
      box = document.createElement('div'); box.id = 'shareBox';
      box.style.cssText = 'margin-top:10px;display:none;justify-content:center';
      box.innerHTML = `<button type="button" class="on" id="share-btn">${L('🎉 結果をXでシェア', '🎉 Share your result on X')}</button>`;
      wrap.after(box);
      document.getElementById('share-btn').onclick = () => post(soloText() + TAG, 'https://mataasobo.com/shogi3/', 'solo');
    }
    box.style.display = show ? 'flex' : 'none'; // hidden 属性は display の指定に負けるので、display で切りかえる
  }
  function hookSolo() {
    if (typeof render !== 'function') return;
    const r0 = render;
    window.render = function () { r0.apply(this, arguments); try { watch(); } catch (e) {} };
    // 棋譜を読みこんだ局面（検討用）では出さない
    if (typeof loadGameRecordText === 'function') {
      const l0 = loadGameRecordText;
      window.loadGameRecordText = function () { const v = l0.apply(this, arguments); skipGen = gameGen; update(); return v; };
    }
  }

  // ---------- みんなと指す画面（room.js が決着の画面で呼ぶ） ----------
  // st：サーバーの局面、place：順位（1〜3）、you：自分の席
  function roomText(st, place, you) {
    const how = HOW[st.winType] || HOW.normal;
    if (EN) return place === 1
      ? `Played Three-Player Shogi with friends and came 1st! (${SEAT[you]} · ${how} · ${st.moves} moves)`
      : `Played Three-Player Shogi with friends and came ${place === 2 ? '2nd' : '3rd'} (${SEAT[you]} · ${st.moves} moves)`;
    return place === 1
      ? `ともだちと三人将棋を指して、1位でした！（${SEAT[you]}・${how}・${st.moves}手）`
      : `ともだちと三人将棋を指して、${place}位でした（${SEAT[you]}・${st.moves}手）`;
  }
  function postRoom(st, place, you) { return post(roomText(st, place, you) + TAG, 'https://mataasobo.com/shogi3/room.html', 'room'); }

  return { hookSolo, postRoom, post };
})();
if (document.getElementById('btnRow')) Share.hookSolo(); // ひとりで指す画面のときだけ
