// ── 検討モード（Lizzie 風）──
// 対局の棋譜（gameRecord：最初の局面と全部の手）を並べ直して、好きな局面に戻れる。
// 学習AIで局面を解析すると、候補手を盤の上に「勝率・読んだ割合」つきで表示し、勝率の推移をグラフにする。
// 検討中は手番の人の駒を動かして変化を試せる（候補手の丸をクリックしても指せる）。「本譜に戻る」で実際の手順に戻る。
// 検討中は対局を止めておき、「検討をやめる」で元の局面に戻って対局を続ける。
let reviewMode = false;
const review = {
  live: null,        // 検討に入る前の対局の状態
  main: [],          // 本譜：main[k] = k手指した後の局面
  mainMoves: [],     // 本譜の手 [{o, mv, v, text}]
  line: [],          // 表示中の手順の局面（本譜、または途中から変化）
  lineMoves: [],     // line[i] → line[i+1] の手
  branch: null,      // 変化の分かれた手数（本譜なら null）
  idx: 0,            // 表示中の局面（line の番号）
  analysis: {},      // 局面ごとの学習AIの解析結果（rvKey で引く）
  auto: false,       // 局面を動かすたびに解析する
  want: null,        // 解析待ちの局面
  busy: false,
  dropPiece: null,   // 打とうとしている持ち駒
};

const rvClone = (x) => JSON.parse(JSON.stringify(x));
const rvEl = (id) => document.getElementById(id);
const rvKey = (p) => JSON.stringify([p.board, p.hand, p.eliminated, p.turn, p.moveCount]);
const rvSameMove = (a, b) => a && b && !!a.drop === !!b.drop && a.tr === b.tr && a.tc === b.tc &&
  (a.drop ? a.piece === b.piece : a.fr === b.fr && a.fc === b.fc && !!a.pro === !!b.pro);

function rvSnapshot() {
  return { board: rvClone(board), hand: rvClone(hand), eliminated: [...eliminated], turn, moveCount, lastMove: rvClone(lastMove), gover };
}

// 局面 p で o が mv を指した後の局面（対局の状態・棋譜・表示はそのまま）
function rvApply(p, mv, o, redrawKifu = true) {
  const save = { gameRecord, kifu, board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove, info: rvEl('info').textContent };
  ({ board, hand, eliminated, moveCount, lastMove } = rvClone(p));
  turn = o; gover = false;
  kifu = [{}]; gameRecord = { moves: [] };   // applyMove が本物の棋譜に書き足さないように
  try {
    if (mv) applyMove(mv, o);
    else {                                   // 投了：玉を盤から除いて脱落
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) { const x = board[r][c]; if (x && x.o === o && x.p === 'OU') board[r][c] = null; }
      eliminated[o] = true;
    }
    if (!gover) turn = nextAliveOn(eliminated, turn);
    return rvSnapshot();
  } finally {
    ({ gameRecord, kifu, board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove } = save);
    if (redrawKifu) renderKifu();   // applyMove が仮の棋譜で描き直したので、本物に戻す
    setStatus(save.info);
  }
}

function enterReview() {
  if (reviewMode) return true;
  if (selfPlayMode || editMode) return false;
  review.live = { board, hand, eliminated, turn, moveCount, gover, winner, winType, humanEliminated, lastMove, info: rvEl('info').textContent };
  gameGen++;                       // 考え中のAIの手は捨てる（検討をやめたら考え直す）
  selected = null; vmoves = []; selHand = false; promoQ = null;
  // まだ1手も指していない（新しい対局で棋譜が空）なら、今の局面を開始局面にする
  const rec = gameRecord && gameRecord.moves.length && kifu.length ? gameRecord
    : { start: { board: rvClone(board), hand: rvClone(hand), eliminated: [...eliminated], turn, moveCount, rule: keepAllPieces }, moves: [] };
  review.rule = rec.start.rule;
  let p = { board: rvClone(rec.start.board), hand: rvClone(rec.start.hand), eliminated: [...rec.start.eliminated], turn: rec.start.turn, moveCount: rec.start.moveCount, lastMove: null, gover: false };
  review.main = [p];
  review.mainMoves = [];
  rec.moves.forEach((m, i) => {
    p = rvApply(p, m.resign ? null : m.mv, m.o, false);
    review.main.push(p);
    review.mainMoves.push({ o: m.o, mv: m.mv, v: m.v, text: kifu[i] ? kifu[i].fugo : '' });
  });
  renderKifu();
  review.line = review.main; review.lineMoves = review.mainMoves; review.branch = null;
  review.analysis = {};
  reviewMode = true;
  rvEl('review-panel').style.display = '';
  rvEl('review-btn').textContent = '✕ 検討をやめる';
  showReviewPos(review.line.length - 1);
  return true;
}

function exitReview(kick = true) {
  if (!reviewMode) return;
  reviewMode = false;
  review.want = null; review.dropPiece = null;
  selected = null; vmoves = []; selHand = false;
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
  k = Math.max(0, Math.min(review.line.length - 1, k));
  review.idx = k;
  review.dropPiece = null; selected = null; vmoves = []; selHand = false;
  const p = rvClone(review.line[k]);
  ({ board, hand, eliminated, turn, moveCount, lastMove } = p);
  gover = p.gover;
  render();
  rvUpdatePanel();
  if (review.auto && !review.analysis[rvKey(review.line[k])]) rvAnalyze();
}

function reviewStep(d) { if (reviewMode) showReviewPos(review.idx + d); }
function reviewJump(k) {
  if (!enterReview()) return;
  if (review.branch !== null) rvBackToMain(false);
  showReviewPos(k);
}

function rvBackToMain(show = true) {
  const b = review.branch;
  review.line = review.main; review.lineMoves = review.mainMoves; review.branch = null;
  if (show) showReviewPos(b === null ? review.idx : b);
}

// ── 変化：検討中に手を指す ──
function rvPlayMove(mv) {
  const i = review.idx, p = review.line[i], o = p.turn;
  const nxt = review.lineMoves[i];
  if (nxt && rvSameMove(nxt.mv, mv)) { showReviewPos(i + 1); return; }   // 今の手順と同じ手なら1手進むだけ
  const np = rvApply(p, mv, o);
  review.line = review.line.slice(0, i + 1).concat([np]);
  review.lineMoves = review.lineMoves.slice(0, i).concat([{ o, mv, text: rvMoveText(mv, p.board) }]);
  if (review.branch === null || i < review.branch) review.branch = i;
  showReviewPos(i + 1);
}

// 盤のクリック（ui.js の handleClick から呼ぶ）。手番の人の駒を選んで動かす／候補手の丸をクリックで指す
function reviewClick(mx, my) {
  const p = review.line[review.idx];
  if (p.gover) return;
  const o = p.turn, bc = xyToBoard(mx, my);
  if (review.dropPiece) {
    const mv = bc && vmoves.find((m) => m.tr === bc[0] && m.tc === bc[1]);
    review.dropPiece = null; vmoves = [];
    if (mv) { rvPlayMove(mv); return; }
    render(); rvRenderHand(); return;
  }
  if (selected && bc) {
    const ms = vmoves.filter((m) => m.tr === bc[0] && m.tc === bc[1]);
    if (ms.length) {
      const mv = ms.length === 2 ? (confirm('成りますか？') ? ms.find((m) => m.pro) : ms.find((m) => !m.pro)) : ms[0];
      selected = null; vmoves = [];
      rvPlayMove(mv); return;
    }
  }
  selected = null; vmoves = [];
  if (bc) {
    const cell = board[bc[0]][bc[1]];
    if (cell && cell.o === o) {
      selected = [bc[0], bc[1]]; selHand = false;
      vmoves = allMoves(o, board).filter((m) => !m.drop && m.fr === bc[0] && m.fc === bc[1]);
    } else {
      const a = review.analysis[rvKey(p)];
      const c = a && a.top.find((x) => x.move && x.move.tr === bc[0] && x.move.tc === bc[1]);
      if (c) { rvPlayMove(c.move); return; }
    }
  }
  render();
}

// 手番の人の持ち駒（クリックで打つ駒を選ぶ）
function rvRenderHand() {
  const p = review.line[review.idx], el = rvEl('review-hand');
  if (p.gover) { el.innerHTML = ''; return; }
  const cnt = {};
  p.hand[p.turn].forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
  const keys = Object.keys(cnt);
  el.innerHTML = `<span style="color:${PCOL[p.turn]}">${PNAME_BASE[p.turn]}の持ち駒：</span>` + (keys.length ? keys.map((x) =>
    `<button onclick="rvSelectDrop('${x}')" style="${review.dropPiece === x ? 'border-color:#ff4;color:#ff4;' : ''}">${PC[x]}${cnt[x] > 1 ? '×' + cnt[x] : ''}</button>`).join(' ') : 'なし') +
    '<span style="color:#678;margin-left:6px;">（駒を選んで盤のマスをクリック）</span>';
}

function rvSelectDrop(piece) {
  const p = review.line[review.idx];
  review.dropPiece = review.dropPiece === piece ? null : piece;
  selected = null;
  vmoves = review.dropPiece ? allMoves(p.turn, board).filter((m) => m.drop && m.piece === piece) : [];
  render(); rvRenderHand();
}

// ── 解析（学習AIで候補手を調べる）──
function toggleReviewAuto() {
  review.auto = !review.auto;
  rvEl('review-auto').textContent = review.auto ? '🧠 解析中（局面を動かすと自動で解析）' : '🧠 解析する';
  rvEl('review-auto').style.borderColor = review.auto ? '#44ddff' : '#556';
  if (review.auto) rvAnalyze(true);
}

async function rvAnalyze(force = false) {
  const p0 = review.line[review.idx];
  if (!force && review.analysis[rvKey(p0)]) return;
  review.want = p0;
  if (review.busy) return;           // 解析は1つずつ（終わったら最新の希望の局面を解析する）
  review.busy = true;
  try {
    if (!(window.LocalAI && window.ort)) throw new Error('学習AIを読み込めません');
    if (!LocalAI.ready) { rvEl('review-info').textContent = '学習AIを準備中…'; await LocalAI.init(); }
    while (review.want && reviewMode) {
      const p = review.want; review.want = null;
      if (p.gover) continue;
      if (review.line[review.idx] === p) rvEl('review-info').textContent = `解析中…（${thinkMs / 1000}秒）`;
      const res = await LocalAI.think({ board: p.board, hand: p.hand, eliminated: p.eliminated, turn: p.turn, moveCount: p.moveCount,
                                        rule: review.rule, timeMs: thinkMs, topN: 8 });
      review.analysis[rvKey(p)] = res;
      if (reviewMode && review.line[review.idx] === p) { render(); rvUpdatePanel(); }
      else if (reviewMode) rvDrawGraph();
    }
  } catch (e) {
    rvEl('review-info').textContent = '解析できませんでした：' + e.message;
  } finally {
    review.busy = false;
  }
}

// ── 表示 ──
function rvMoveText(m, bd) {
  if (!m) return '投了';
  if (m.drop) return toSuji(m.tc) + toDan(m.tr) + PC[m.piece] + '打';
  const cell = bd[m.fr][m.fc];
  const name = cell ? (cell.pr ? (PCP[cell.p] || PC[cell.p]) : PC[cell.p]) : '?';
  return toSuji(m.tc) + toDan(m.tr) + name + (m.pro ? '成' : '') + '(' + toSuji(m.fc) + toDan(m.fr) + ')';
}

// 表示中の手順の k 番目の局面の勝率予想（解析したらその値、本譜なら対局中にAIが出した値）
function rvValueAt(k) {
  const a = review.analysis[rvKey(review.line[k])];
  if (a) return a.value;
  if (review.branch !== null && k > review.branch) return null;
  const m = review.mainMoves[k];
  return m && m.v ? m.v : null;
}

function rvUpdatePanel() {
  const k = review.idx, N = review.line.length - 1, p = review.line[k], b = review.branch;
  const last = k > 0 ? review.lineMoves[k - 1] : null;
  const inVar = b !== null && k > b;
  rvEl('review-pos').textContent = (inVar ? '【変化】' : '') + `${k} / ${N}手目` +
    (last ? `　${PNAME_BASE[last.o]} ${last.text}` : '　開始局面') + (p.gover ? '　（終局）' : `　→ ${PNAME_BASE[p.turn]}の番`);
  // 本譜の棋譜の行をハイライト（変化中は分かれたところ）
  const hk = b !== null ? Math.min(k, b) : k;
  document.querySelectorAll('#kifu-list > div').forEach((d, i) => d.classList.toggle('review-cur', i === hk - 1));
  const cur = document.querySelector('#kifu-list > div.review-cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  // 変化の手順
  const vEl = rvEl('review-var');
  if (b !== null) {
    vEl.innerHTML = `<span style="color:#fc8;">変化（${b}手目から）：</span>` + review.lineMoves.slice(b).map((m, j) =>
      `<span onclick="showReviewPos(${b + j + 1})" style="cursor:pointer;${b + j + 1 === k ? 'background:#3a2a10;' : ''}color:${PCOL[m.o]}">${b + j + 1}.${m.text}</span>`).join(' ') +
      ` <button onclick="rvBackToMain()">↩ 本譜に戻る</button>`;
  } else vEl.innerHTML = '';
  rvRenderHand();
  // 候補手の一覧
  const a = review.analysis[rvKey(p)], info = rvEl('review-info'), list = rvEl('review-cands');
  if (a) {
    const tot = a.top.reduce((s, x) => s + x.visits, 0) || 1, t = p.turn;
    info.textContent = `解析：${a.visits}回読んで ${a.sec}秒　局面の勝率予想 青${Math.round(a.value[0] * 100)}% 赤${Math.round(a.value[1] * 100)}% 緑${Math.round(a.value[2] * 100)}%`;
    list.innerHTML = a.top.map((x, i) => {
      const v = x.value ? `${PNAME_BASE[t]}の勝率 <b>${Math.round(x.value[t] * 100)}%</b>（青${Math.round(x.value[0] * 100)} 赤${Math.round(x.value[1] * 100)} 緑${Math.round(x.value[2] * 100)}）` : '';
      return `<div onclick="rvPlayMove(review.analysis[rvKey(review.line[review.idx])].top[${i}].move)" style="cursor:pointer" title="この手を指して変化を見る">` +
        `<span style="color:${i ? '#9fb' : '#4df'}">${i + 1}. ${rvMoveText(x.move, p.board)}</span>　読み ${Math.round(x.visits / tot * 100)}%　${v}</div>`;
    }).join('');
  } else {
    const v = rvValueAt(k);
    if (!review.auto) info.textContent = v ? `対局中の勝率予想 青${Math.round(v[0] * 100)}% 赤${Math.round(v[1] * 100)}% 緑${Math.round(v[2] * 100)}%` : '「🧠 解析する」で、この局面の候補手を学習AIが調べます';
    list.innerHTML = '';
  }
  rvDrawGraph();
}

// 盤の上の候補手（render から呼ぶ）
function drawReviewOverlay() {
  if (!reviewMode) return;
  const k = review.idx, p = review.line[k], a = review.analysis[rvKey(p)];
  const cellXY = (r, c) => { const [pr, pc] = logToPhys(r, c); return [BX + pc * CS + CS / 2, BY + pr * CS + CS / 2]; };
  // この手順で次に指された手（点線の枠）
  const next = review.lineMoves[k];
  if (next && next.mv) {
    const [x, y] = cellXY(next.mv.tr, next.mv.tc);
    ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = PCOL[next.o]; ctx.lineWidth = 2.5;
    ctx.strokeRect(x - CS / 2 + 3, y - CS / 2 + 3, CS - 6, CS - 6); ctx.restore();
  }
  if (!a || selected || review.dropPiece) return;   // 駒を選んでいる間は候補手を隠す
  const tot = a.top.reduce((s, x) => s + x.visits, 0) || 1, t = p.turn;
  const R = 21;
  // 盤上の駒を動かす手は、動かす元から矢印（上位5手。よく読んだ手ほど太い）。円より先に描いて下に敷く
  a.top.slice(0, 5).forEach((c, i) => {
    if (!c.move || c.move.drop) return;
    const [fx, fy] = cellXY(c.move.fr, c.move.fc), [x, y] = cellXY(c.move.tr, c.move.tc);
    const dx = x - fx, dy = y - fy, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const ex = x - ux * R, ey = y - uy * R;                 // 円の縁で止める
    const w = 2 + 5 * Math.min(1, (c.visits / tot) * 1.5);
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = i === 0 ? 'rgba(0,229,255,0.75)' : 'rgba(120,230,170,0.6)';
    ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(ex - ux * w, ey - uy * w); ctx.stroke();
    const h = 7 + w;                                        // 矢じり
    ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ux * h - uy * h * 0.6, ey - uy * h + ux * h * 0.6);
    ctx.lineTo(ex - ux * h + uy * h * 0.6, ey - uy * h - ux * h * 0.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  });
  // マスごとに候補をまとめる（読んだ順）
  const groups = {};
  a.top.forEach((c, i) => { if (c.move) (groups[c.move.tr * 9 + c.move.tc] = groups[c.move.tr * 9 + c.move.tc] || []).push({ c, i }); });
  const nameOf = (m) => {
    if (m.drop) return PC[m.piece] + '打';
    const cell = p.board[m.fr][m.fc];
    return cell ? (cell.pr ? (PCP[cell.p] || PC[cell.p]) : PC[cell.p]) + (m.pro ? '成' : '') : '';
  };
  const pct = (c) => (c.value ? Math.round(c.value[t] * 100) + '%' : '-');
  Object.values(groups).forEach((g) => {
    const { c, i } = g[0];
    const [x, y] = cellXY(c.move.tr, c.move.tc);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (g.length === 1) {
      // 候補が1つのマス：丸に勝率（上）と読んだ割合（下）、右上に駒の名前
      const share = c.visits / tot;
      ctx.globalAlpha = 0.55 + 0.4 * Math.min(1, share * 2);
      ctx.fillStyle = i === 0 ? '#00b8d4' : '#2e7d5b';
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = i === 0 ? '#aaf6ff' : '#9fd8b8'; ctx.lineWidth = i === 0 ? 2.5 : 1.2; ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px sans-serif'; ctx.fillText(pct(c), x, y - 5);
      ctx.font = '10px sans-serif'; ctx.fillText(Math.round(share * 100) + '%', x, y + 9);
      const label = nameOf(c.move);
      ctx.font = 'bold 12px serif';
      const lw = ctx.measureText(label).width + 6, lx = x + 14, ly = y - 17;
      ctx.fillStyle = 'rgba(20,12,0,0.8)'; ctx.fillRect(lx - lw / 2, ly - 8, lw, 16);
      ctx.fillStyle = c.move.drop ? '#ffe9a0' : '#fff';
      ctx.fillText(label, lx, ly + 1);
    } else {
      // 候補がいくつかあるマス：小さな札を縦に並べる（最大3つ。それ以上は「他n」）。濃さ＝読んだ割合
      const rows = g.length > 3 ? 3 : g.length, rh = 16, top = y - (rows * rh) / 2;
      for (let j = 0; j < rows; j++) {
        const yy = top + j * rh + rh / 2;
        if (j === 2 && g.length > 3) {
          ctx.fillStyle = 'rgba(20,12,0,0.85)'; ctx.fillRect(x - CS / 2 + 2, yy - rh / 2 + 1, CS - 4, rh - 2);
          ctx.fillStyle = '#cde'; ctx.font = '10px sans-serif'; ctx.fillText(`他${g.length - 2}`, x, yy + 1);
          continue;
        }
        const { c: cj, i: ij } = g[j], share = cj.visits / tot;
        ctx.globalAlpha = 0.6 + 0.4 * Math.min(1, share * 2);
        ctx.fillStyle = ij === 0 ? '#00b8d4' : '#2e7d5b';
        ctx.fillRect(x - CS / 2 + 2, yy - rh / 2 + 1, CS - 4, rh - 2);
        ctx.globalAlpha = 1;
        if (ij === 0) { ctx.strokeStyle = '#aaf6ff'; ctx.lineWidth = 1.5; ctx.strokeRect(x - CS / 2 + 2, yy - rh / 2 + 1, CS - 4, rh - 2); }
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = cj.move.drop ? '#ffe9a0' : '#fff';
        ctx.fillText(`${nameOf(cj.move)} ${pct(cj)}`, x, yy + 1);
      }
    }
    ctx.restore();
  });
}

// 勝率の推移グラフ（3人分。表示中の手順）
function rvDrawGraph() {
  const cv = rvEl('review-graph'); if (!cv) return;
  const W = cv.width, H = cv.height, g = cv.getContext('2d'), N = review.line.length - 1;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0b0b16'; g.fillRect(0, 0, W, H);
  const X = (k) => (N ? k / N : 0) * (W - 8) + 4, Y = (v) => H - v * (H - 6) - 3;
  if (review.branch !== null) { g.fillStyle = '#1e1608'; g.fillRect(X(review.branch), 0, W - X(review.branch), H); }   // 変化の部分
  g.strokeStyle = '#2a2a44'; g.lineWidth = 1;
  [0.25, 0.5, 0.75].forEach((y) => { g.beginPath(); g.moveTo(0, H * y); g.lineTo(W, H * y); g.stroke(); });
  g.fillStyle = '#556'; g.font = '10px sans-serif'; g.fillText('50%', 3, H * 0.5 - 2);
  for (let o = 0; o < 3; o++) {
    g.strokeStyle = PCOL[o]; g.lineWidth = 1.8; g.beginPath();
    let started = false;
    for (let k = 0; k <= N; k++) {
      const v = rvValueAt(k); if (!v) continue;
      if (!started) { g.moveTo(X(k), Y(v[o])); started = true; } else g.lineTo(X(k), Y(v[o]));
    }
    g.stroke();
  }
  g.fillStyle = '#4df';            // 解析した局面に小さな印
  review.line.forEach((p, k) => { if (review.analysis[rvKey(p)]) g.fillRect(X(k) - 1, H - 4, 2, 4); });
  g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(X(review.idx), 0); g.lineTo(X(review.idx), H); g.stroke();
}

function rvGraphClick(e) {
  const cv = rvEl('review-graph'), r = cv.getBoundingClientRect();
  const N = review.line.length - 1;
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
  else if (e.key === 'End') { showReviewPos(review.line.length - 1); e.preventDefault(); }
  else if (e.key === 'Escape' && review.branch !== null) { rvBackToMain(); e.preventDefault(); }
});

(function () {
  const st = document.createElement('style');
  st.textContent = '#kifu-list > div { cursor: pointer; } #kifu-list > div.review-cur { background: #1d3a4a; outline: 1px solid #4df; }' +
    '#review-panel button { font-size: 12px; padding: 3px 10px; background: #0a1420; border: 1px solid #556; color: #cde; border-radius: 4px; cursor: pointer; }' +
    '#review-cands > div:hover { background: #10202c; }';
  document.head.appendChild(st);
})();
