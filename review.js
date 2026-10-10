// ── 検討モード（Lizzie 風）──
// 対局の棋譜（gameRecord：最初の局面と全部の手）を並べ直して、好きな局面に戻れる。
// 学習AIで局面を解析すると、候補手を盤の上に「勝率・読んだ割合」つきで表示し、勝率の推移をグラフにする。
// 検討中は対局を止めておき、「検討をやめる」で元の局面に戻って対局を続ける。
let reviewMode = false;
const review = {
  live: null,        // 検討に入る前の対局の状態
  pos: [],           // pos[k] = k手指した後の局面
  idx: 0,            // 表示中の局面
  analysis: {},      // analysis[k] = 学習AIの解析結果
  auto: false,       // 局面を動かすたびに解析する
  want: null,        // 解析待ちの局面
  busy: false,
};

const rvClone = (x) => JSON.parse(JSON.stringify(x));
const rvEl = (id) => document.getElementById(id);

function rvSnapshot() {
  return { board: rvClone(board), hand: rvClone(hand), eliminated: [...eliminated], turn, moveCount, lastMove: rvClone(lastMove), gover };
}

// gameRecord を最初から並べ直して、各手の後の局面を作る（対局の状態・棋譜・表示は元に戻す）
function rvBuildPositions() {
  const rec = gameRecord;
  const save = { gameRecord, kifu, board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove, info: rvEl('info').textContent };
  board = rvClone(rec.start.board); hand = rvClone(rec.start.hand); eliminated = [...rec.start.eliminated];
  turn = rec.start.turn; moveCount = rec.start.moveCount; gover = false; lastMove = null;
  kifu = [{}]; gameRecord = { moves: [] };   // applyMove が本物の棋譜に書き足さないように
  const pos = [rvSnapshot()];
  try {
    for (const m of rec.moves) {
      turn = m.o;
      if (m.resign) {
        for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) { const x = board[r][c]; if (x && x.o === m.o && x.p === 'OU') board[r][c] = null; }
        eliminated[m.o] = true;
      } else {
        applyMove(m.mv, m.o);
      }
      if (!gover) turn = nextAliveOn(eliminated, turn);
      pos.push(rvSnapshot());
    }
  } finally {
    ({ gameRecord, kifu, board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove } = save);
    renderKifu();
    setStatus(save.info);
  }
  return pos;
}

function enterReview() {
  if (reviewMode) return true;
  if (selfPlayMode || editMode) return false;
  if (!gameRecord || !gameRecord.moves.length) { setStatus('検討できる棋譜がありません'); return false; }
  review.live = { board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove, info: rvEl('info').textContent };
  gameGen++;                       // 考え中のAIの手は捨てる（検討をやめたら考え直す）
  selected = null; vmoves = []; selHand = false; promoQ = null;
  review.pos = rvBuildPositions();
  review.analysis = {};
  reviewMode = true;
  rvEl('review-panel').style.display = '';
  rvEl('review-btn').textContent = '✕ 検討をやめる';
  showReviewPos(review.pos.length - 1);
  return true;
}

function exitReview(kick = true) {
  if (!reviewMode) return;
  reviewMode = false;
  review.want = null;
  const L = review.live;
  ({ board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove } = L);
  rvEl('review-panel').style.display = 'none';
  rvEl('review-btn').textContent = '🔍 検討';
  setStatus(L.info);
  render(); renderKifu();
  if (kick && !gover && turn !== humanPlayer && !eliminated[turn]) setTimeout(() => kickAI(), AI_DELAY_MS);
}

function toggleReview() { reviewMode ? exitReview() : enterReview(); }

function showReviewPos(k) {
  k = Math.max(0, Math.min(review.pos.length - 1, k));
  review.idx = k;
  const p = rvClone(review.pos[k]);
  ({ board, hand, eliminated, turn, moveCount, lastMove } = p);
  gover = p.gover;
  render();
  rvUpdatePanel();
  if (review.auto && !review.analysis[k]) rvAnalyze(k);
}

function reviewStep(d) { if (reviewMode) showReviewPos(review.idx + d); }
function reviewJump(k) { if (enterReview()) showReviewPos(k); }

// ── 解析（学習AIで候補手を調べる）──
function toggleReviewAuto() {
  review.auto = !review.auto;
  rvEl('review-auto').textContent = review.auto ? '🧠 解析中（局面を動かすと自動で解析）' : '🧠 解析する';
  rvEl('review-auto').style.borderColor = review.auto ? '#44ddff' : '#556';
  if (review.auto) rvAnalyze(review.idx, true);
}

async function rvAnalyze(k, force = false) {
  if (!force && review.analysis[k]) return;
  review.want = k;
  if (review.busy) return;           // 解析は1つずつ（終わったら最新の希望の局面を解析する）
  review.busy = true;
  try {
    if (!(window.LocalAI && window.ort)) throw new Error('学習AIを読み込めません');
    if (!LocalAI.ready) { rvEl('review-info').textContent = '学習AIを準備中…'; await LocalAI.init(); }
    while (review.want !== null && reviewMode) {
      const j = review.want; review.want = null;
      const p = review.pos[j];
      if (p.gover) continue;
      if (review.idx === j) rvEl('review-info').textContent = `解析中…（${thinkMs / 1000}秒）`;
      const res = await LocalAI.think({ board: p.board, hand: p.hand, eliminated: p.eliminated, turn: p.turn, moveCount: p.moveCount,
                                        rule: gameRecord.start.rule, timeMs: thinkMs, topN: 8 });
      review.analysis[j] = res;
      if (reviewMode && review.idx === j) { render(); rvUpdatePanel(); }
    }
  } catch (e) {
    rvEl('review-info').textContent = '解析できませんでした：' + e.message;
  } finally {
    review.busy = false;
  }
}

// ── 表示 ──
function rvMoveText(m, bd) {
  if (!m) return 'パス';
  if (m.drop) return toSuji(m.tc) + toDan(m.tr) + PC[m.piece] + '打';
  const cell = bd[m.fr][m.fc];
  const name = cell ? (cell.pr ? (PCP[cell.p] || PC[cell.p]) : PC[cell.p]) : '?';
  return toSuji(m.tc) + toDan(m.tr) + name + (m.pro ? '成' : '') + '(' + toSuji(m.fc) + toDan(m.fr) + ')';
}

// 局面 k の勝率予想（解析したらその値、なければ対局中にAIが出した値）
function rvValueAt(k) {
  const a = review.analysis[k];
  if (a) return a.value;
  const m = gameRecord.moves[k];
  return m && m.v ? m.v : null;
}

function rvUpdatePanel() {
  const k = review.idx, N = review.pos.length - 1, p = review.pos[k];
  const last = k > 0 ? kifu[k - 1] : null;
  rvEl('review-pos').textContent = `${k} / ${N}手目` + (last ? `　${last.name} ${last.fugo}` : '　開始局面') + (p.gover ? '　（終局）' : `　→ ${PNAME_BASE[p.turn]}の番`);
  // 棋譜の行をハイライト
  document.querySelectorAll('#kifu-list > div').forEach((d, i) => d.classList.toggle('review-cur', i === k - 1));
  const cur = document.querySelector('#kifu-list > div.review-cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  // 候補手の一覧
  const a = review.analysis[k], info = rvEl('review-info'), list = rvEl('review-cands');
  if (a) {
    const tot = a.top.reduce((s, x) => s + x.visits, 0) || 1, t = p.turn;
    info.textContent = `解析：${a.visits}回読んで ${a.sec}秒　局面の勝率予想 青${Math.round(a.value[0] * 100)}% 赤${Math.round(a.value[1] * 100)}% 緑${Math.round(a.value[2] * 100)}%`;
    list.innerHTML = a.top.map((x, i) => {
      const v = x.value ? `${PNAME_BASE[t]}の勝率 <b>${Math.round(x.value[t] * 100)}%</b>（青${Math.round(x.value[0] * 100)} 赤${Math.round(x.value[1] * 100)} 緑${Math.round(x.value[2] * 100)}）` : '';
      return `<div><span style="color:${i ? '#9fb' : '#4df'}">${i + 1}. ${rvMoveText(x.move, p.board)}</span>　読み ${Math.round(x.visits / tot * 100)}%　${v}</div>`;
    }).join('');
  } else {
    const v = rvValueAt(k);
    info.textContent = review.auto ? info.textContent : (v ? `対局中の勝率予想 青${Math.round(v[0] * 100)}% 赤${Math.round(v[1] * 100)}% 緑${Math.round(v[2] * 100)}%` : '「🧠 解析する」で、この局面の候補手を学習AIが調べます');
    list.innerHTML = '';
  }
  rvDrawGraph();
}

// 盤の上の候補手（render から呼ぶ）
function drawReviewOverlay() {
  if (!reviewMode) return;
  const k = review.idx, a = review.analysis[k], p = review.pos[k];
  const cellXY = (r, c) => { const [pr, pc] = logToPhys(r, c); return [BX + pc * CS + CS / 2, BY + pr * CS + CS / 2]; };
  // 実際に指された次の手（点線の枠）
  const next = gameRecord.moves[k];
  if (next && next.mv) {
    const [x, y] = cellXY(next.mv.tr, next.mv.tc);
    ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = PCOL[next.o]; ctx.lineWidth = 2.5;
    ctx.strokeRect(x - CS / 2 + 3, y - CS / 2 + 3, CS - 6, CS - 6); ctx.restore();
  }
  if (!a) return;
  const tot = a.top.reduce((s, x) => s + x.visits, 0) || 1, t = p.turn;
  const seen = new Set();
  a.top.forEach((c, i) => {
    if (!c.move) return;
    const key = c.move.tr * 9 + c.move.tc;
    if (seen.has(key)) return;           // 同じマスへの手は、いちばん読んだ手だけ描く
    seen.add(key);
    const [x, y] = cellXY(c.move.tr, c.move.tc);
    const share = c.visits / tot;
    ctx.save();
    if (i === 0 && !c.move.drop) {       // 最善手は動かす元から矢印のように線を引く
      const [fx, fy] = cellXY(c.move.fr, c.move.fc);
      ctx.strokeStyle = 'rgba(0,229,255,0.55)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.globalAlpha = 0.55 + 0.4 * Math.min(1, share * 2);
    ctx.fillStyle = i === 0 ? '#00b8d4' : '#2e7d5b';
    ctx.beginPath(); ctx.arc(x, y, 21, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = i === 0 ? '#aaf6ff' : '#9fd8b8'; ctx.lineWidth = i === 0 ? 2.5 : 1.2; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(c.value ? Math.round(c.value[t] * 100) + '%' : '-', x, y - 5);
    ctx.font = '10px sans-serif';
    ctx.fillText(Math.round(share * 100) + '%', x, y + 9);
    if (c.move.drop) {                   // 打つ手は駒の名前を角に
      ctx.font = 'bold 11px serif'; ctx.fillStyle = '#ffe9a0';
      ctx.fillText(PC[c.move.piece], x + 16, y - 16);
    }
    ctx.restore();
  });
}

// 勝率の推移グラフ（3人分）
function rvDrawGraph() {
  const cv = rvEl('review-graph'); if (!cv) return;
  const W = cv.width, H = cv.height, g = cv.getContext('2d'), N = review.pos.length - 1;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0b0b16'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2a2a44'; g.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((y) => { g.beginPath(); g.moveTo(0, H * y); g.lineTo(W, H * y); g.stroke(); });
  g.fillStyle = '#556'; g.font = '10px sans-serif'; g.fillText('50%', 3, H * 0.5 - 2);
  const X = (k) => (N ? k / N : 0) * (W - 8) + 4, Y = (v) => H - v * (H - 6) - 3;
  for (let o = 0; o < 3; o++) {
    g.strokeStyle = PCOL[o]; g.lineWidth = 1.8; g.beginPath();
    let started = false;
    for (let k = 0; k <= N; k++) {
      const v = rvValueAt(k); if (!v) continue;
      if (!started) { g.moveTo(X(k), Y(v[o])); started = true; } else g.lineTo(X(k), Y(v[o]));
    }
    g.stroke();
  }
  // 解析した局面に小さな印
  g.fillStyle = '#4df';
  Object.keys(review.analysis).forEach((k) => g.fillRect(X(+k) - 1, H - 4, 2, 4));
  g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(review.idx), 0); g.lineTo(X(review.idx), H); g.stroke();
}

function rvGraphClick(e) {
  const cv = rvEl('review-graph'), r = cv.getBoundingClientRect();
  const N = review.pos.length - 1;
  showReviewPos(Math.round(((e.clientX - r.left) / r.width * cv.width - 4) / (cv.width - 8) * N));
}

// ── 対局の操作をする前に、検討をやめて元の局面に戻す ──
['init', 'setHumanPlayer', 'setHumanPlayerFromEdit', 'toggleEditMode', 'toggleSelfPlay', 'resignHuman'].forEach((name) => {
  const orig = window[name];
  if (typeof orig !== 'function') return;
  window[name] = function (...args) { if (reviewMode) exitReview(false); return orig.apply(this, args); };
});

window.addEventListener('keydown', (e) => {
  if (!reviewMode || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') { reviewStep(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { reviewStep(1); e.preventDefault(); }
  else if (e.key === 'Home') { showReviewPos(0); e.preventDefault(); }
  else if (e.key === 'End') { showReviewPos(review.pos.length - 1); e.preventDefault(); }
});

(function () {
  const st = document.createElement('style');
  st.textContent = '#kifu-list > div { cursor: pointer; } #kifu-list > div.review-cur { background: #1d3a4a; outline: 1px solid #4df; }' +
    '#review-panel button { font-size: 12px; padding: 3px 10px; background: #0a1420; border: 1px solid #556; color: #cde; border-radius: 4px; cursor: pointer; }';
  document.head.appendChild(st);
})();
