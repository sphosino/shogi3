// 三人将棋「みんなと指す」（room.html）。部屋はおかしならべと同じサーバー（api.mataasobo.com）の kind:'shogi3'
//   盤の描き方（render.js）・手の一覧（game.js の allMoves）・CPU（engine.js / 学習AI web/ai.js）は、ひとりで指す画面と同じものを使う
//   指した手はサーバーに送るだけ。盤はサーバーから来た局面（RV.state）をそのまま描く（サーバーが手を確かめる）
//   あき席（CPU）と時間切れの手は、CPU 担当（RV.cpuDriver：いちばん若い席の、つながっている人）のブラウザが考えて送る
'use strict';
const API = location.hostname === 'mataasobo.com' ? 'https://api.mataasobo.com' : 'http://127.0.0.1:8787';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLOR = ['青', '赤', '緑'];
const RULES = [['all', '常に持ち駒', '取った駒は自分の持ち駒'], ['next', 'お裾分け', '取った駒は残りのもう1人へ'], ['off', '消滅あり', '条件をみたさないと消える']];
const LIMITS = [30, 60, 180];
const STAMPS = [['hi', 'よろしく！'], ['nice', 'ナイス！'], ['doki', 'ドキッ'], ['eh', 'えっ！？'], ['ouch', 'やられた〜'], ['grr', 'ぐぬぬ'], ['thx', 'ありがと'], ['again', 'もう一局！']];
const CPU_MS = 2000; // CPU の考える時間
const ROOMID = (new URLSearchParams(location.search).get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- このブラウザの番号と名前（おかしならべと同じ保存場所） ----------
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
function me() {
  let p = null; try { p = localStorage.getItem('mataasobo-pid'); } catch (e) {}
  if (!/^[a-z0-9]{16,40}$/.test(p || '')) { p = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => ABC[b % ABC.length]).join(''); try { localStorage.setItem('mataasobo-pid', p); } catch (e) {} }
  return p;
}
const myName = () => { try { return localStorage.getItem('mataasobo-name') || ''; } catch (e) { return ''; } };
const saveName = (v) => { try { localStorage.setItem('mataasobo-name', v); } catch (e) {} };
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }

// ---------- 通信 ----------
let ws = null, queue = [], wait = 1000, retry = null;
function connect(id) {
  const open = () => {
    clearTimeout(retry);
    const s = ws = new WebSocket(API.replace(/^http/, 'ws') + '/rooms/' + id + '/ws?pid=' + me());
    s.onopen = () => { wait = 1000; queue.splice(0).forEach((m) => s.send(m)); };
    s.onmessage = (e) => { if (e.data === 'pong') return; try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    s.onclose = () => { if (s !== ws) return; retry = setTimeout(open, wait); wait = Math.min(wait * 2, 10000); };
  };
  open();
  setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 20000); // 生きていることを知らせる
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ws && ws.readyState > 1) { wait = 1000; open(); } });
}
function send(msg) { const s = JSON.stringify(msg); if (ws && ws.readyState === 1) ws.send(s); else queue.push(s); }

// ---------- サーバーから来た部屋の様子 ----------
let RV = null, rvAt = 0, roomErr = '', watching = false, lastGame = 0;
function onMsg(m) {
  if (m.t === 'stamp') { showStamp(m.p, m.k); return; }
  if (m.t === 'err') { pending = ''; if (m.msg !== '盤がずれています') toast(m.msg); if (!m.room) return; }
  if (!m.room) return;
  const before = RV;
  RV = m.room; rvAt = Date.now();
  if (RV.game !== lastGame && RV.phase === 'playing') { lastGame = RV.game; resultShown = false; }
  takeState();
  if (before && before.state && RV.state && RV.state.moves > before.state.moves) sound();
  draw();
  warmCpu();
  driveCpu();
}
// CPU 担当になったら、学習AIの準備（初回は数秒かかる）を先にすませておく
let warmed = false, warmP = null; // warmP：準備中の約束（LocalAI.init は二重に呼ぶと壊れる）
function warmCpu() {
  if (warmed || !RV || RV.you < 0 || RV.cpuDriver !== RV.you || !RV.seats.some((s) => s.empty) || !window.LocalAI || !window.ort) return;
  warmed = true;
  if (!LocalAI.ready && !LocalAI.failed) warmP = LocalAI.init().catch(() => { LocalAI.failed = true; });
}

// サーバーの局面を、render.js / game.js が見ている変数にうつす
function takeState() {
  const st = RV.state;
  humanPlayer = RV.you >= 0 ? RV.you : 0; // 見ているだけの人は青の側から
  viewPlayer = RV.you >= 0 ? RV.you : 0;
  RV.seats.forEach((s, i) => { PNAME[i] = s.empty ? 'CPU' : s.name; });
  if (!st) return;
  board = structuredClone(st.board); hand = structuredClone(st.hand); eliminated = st.elim.slice();
  turn = st.turn; moveCount = st.moves; gover = st.over; winner = st.winner;
  keepAllPieces = st.rule === 'off' ? false : st.rule;
  humanEliminated = humanPlayer >= 0 && !!eliminated[humanPlayer];
  lastMove = lastMoveOf(st);
  buildAttackMaps(board);
  if (pending !== st.moves + ':' + RV.game) { selected = null; vmoves = []; selHand = false; promoQ = null; }
}
// 直前の手（盤の下に「▶ 赤 ７六歩」と出す）
function lastMoveOf(st) {
  const x = st.log[st.log.length - 1]; if (!x || x.resign || !x.mv) return null;
  const mv = x.mv, cell = st.board[mv.tr][mv.tc];
  const name = cell ? (cell.pr && PCP[cell.p] ? PCP[cell.p] : PC[cell.p]) : PC[mv.piece] || '';
  const fugo = toSuji(mv.tc) + toDan(mv.tr) + name + (mv.drop ? '打' : '(' + toSuji(mv.fc) + toDan(mv.fr) + ')');
  return { ...mv, o: x.o, fugo };
}
// 席の名前（あなた・CPU）
const seatName = (i) => (!RV.seats[i] || RV.seats[i].empty ? 'CPU（' + COLOR[i] + '）' : RV.seats[i].name) + (i === RV.you ? '（あなた）' : '');
window.pName = (o) => (RV ? seatName(o) : PNAME_BASE[o]);
// 盤のまわりの名前は HTML に出すので、盤には直前の手だけを書く
window.drawPlayerLabels = function () {
  if (!lastMove || !lastMove.fugo) return;
  const col = PCOL[lastMove.o];
  ctx.textAlign = 'center'; ctx.fillStyle = col; ctx.font = 'bold 15px serif';
  ctx.fillText('▶ ' + (RV ? seatName(lastMove.o) : '') + ' ' + lastMove.fugo, CW / 2, CH - 10);
};
window.renderKifu = () => {};

// ---------- 今の番の残り時間 ----------
const leftMs = () => (RV && RV.phase === 'playing' && RV.turnLeft != null ? RV.turnLeft - (Date.now() - rvAt) : null);
let timeoutSent = '';
setInterval(() => {
  if (!RV || RV.phase !== 'playing') return;
  drawClocks();
  const l = leftMs(), key = RV.game + ':' + RV.state.moves;
  // 締め切りを過ぎたら、座っている人のだれかが知らせる（その1手は CPU が代わりに指す）
  if (l !== null && l < -300 && RV.you >= 0 && timeoutSent !== key) { timeoutSent = key; send({ t: 'timeout' }); }
}, 250);

// ---------- CPU の手（CPU 担当のブラウザだけ） ----------
let thinking = '', busy = false; // busy：考えている最中（学習AIは同時に2つ考えられない）
function cpuTurnNow() {
  if (!RV || RV.phase !== 'playing' || RV.you < 0 || RV.cpuDriver !== RV.you) return false;
  const s = RV.seats[RV.state.turn];
  return s.empty || (RV.auto && RV.state.turn !== RV.you);
}
async function driveCpu() {
  if (!cpuTurnNow()) return;
  const st = RV.state, key = RV.game + ':' + st.moves;
  if (thinking === key || busy) return;
  thinking = key; busy = true;
  try { await thinkAndSend(st, key); } finally { busy = false; }
  driveCpu(); // 考えているあいだに次の CPU の番が来ていたら続ける
}
async function thinkAndSend(st, key) {
  const t0 = Date.now();
  let mv = null;
  const req = { board: structuredClone(st.board), hand: structuredClone(st.hand), eliminated: st.elim.slice(), turn: st.turn, moveCount: st.moves, rule: keepAllPieces, timeMs: CPU_MS };
  try {
    if (warmP) await warmP;
    const res = await askNet(req); // 学習AI（GPU、なければ CPU で動かす）
    if (res && res.move) mv = res.move;
  } catch (e) { console.warn('学習AIが使えないので、手作りの CPU で指します', e); }
  if (!mv) {
    try { mv = aiMove(st.turn, structuredClone(st.board), structuredClone(st.hand), st.elim.slice()); } catch (e) { console.error(e); }
  }
  if (Date.now() - t0 < 600) await new Promise((r) => setTimeout(r, 600 - (Date.now() - t0))); // 速すぎると見えないので少し待つ
  if (!RV || RV.game + ':' + RV.state.moves !== key) return; // その間に盤が進んだ
  if (!mv) { const all = allMoves(st.turn, board); mv = all[Math.floor(Math.random() * all.length)]; }
  if (mv) send({ t: 'act', game: RV.game, n: st.moves, a: plainMove(mv) });
}
const plainMove = (m) => (m.drop ? { drop: true, piece: m.piece, tr: m.tr, tc: m.tc } : { fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc, pro: !!m.pro });
// askNet が「考え中…」を書く setStatus は、部屋の画面では使わない
window.setStatus = () => {};

// ---------- 盤のクリック（ひとりで指す画面の handleClick と同じ選び方。指す手はサーバーへ送る） ----------
let pending = ''; // 送ったけれどまだサーバーから返ってきていない手（二重送信よけ）
function myTurn() { return RV && RV.phase === 'playing' && RV.you >= 0 && RV.state.turn === RV.you && !RV.state.elim[RV.you]; }
function play(mv) {
  pending = RV.state.moves + ':' + RV.game;
  send({ t: 'act', game: RV.game, n: RV.state.moves, a: plainMove(mv) });
  selected = null; selHand = false; vmoves = []; promoQ = null;
  render();
}
function onBoardClick(e) {
  if (!RV || !RV.state) return;
  const rect = canvas.getBoundingClientRect(), sc = rect.width / CW;
  const mx = (e.clientX - rect.left) / sc, my = (e.clientY - rect.top) / sc;
  if (promoQ) {
    const dw = 260, dh = 130, dx = (CW - dw) / 2, dy = (CH - dh) / 2;
    if (my >= dy + 55 && my <= dy + 93) {
      const ch = mx >= dx + 18 && mx <= dx + 113 ? promoQ.mvs.find((m) => m.pro) : mx >= dx + 148 && mx <= dx + 243 ? promoQ.mvs.find((m) => !m.pro) : null;
      if (ch) { play(ch); return; }
    }
    promoQ = null; render(); return;
  }
  if (!myTurn() || pending === RV.state.moves + ':' + RV.game) { selected = null; vmoves = []; selHand = false; render(); return; }
  const bc = xyToBoard(mx, my), hi = xyToHand0(mx, my);
  if (selected !== null || selHand) {
    if (bc) {
      const ms = vmoves.filter((m) => m.tr === bc[0] && m.tc === bc[1]);
      if (ms.length === 2) { promoQ = { mvs: ms }; render(); return; }
      if (ms.length === 1) { play(ms[0]); return; }
    }
    selected = null; selHand = false; vmoves = [];
  }
  if (bc) {
    const [r, c] = bc, cell = board[r][c];
    if (cell?.o === humanPlayer) {
      selected = [r, c]; selHand = false;
      vmoves = allMoves(humanPlayer, board).filter((m) => !m.drop && m.fr === r && m.fc === c).map((m) => {
        // 玉が取られる場所・動かすと玉が取られる手に印（warn）をつける
        if (cell.p === 'OU') return squareAttackedBy(board, m.tr, m.tc, humanPlayer, eliminated) ? { ...m, warn: true } : m;
        const undo = applyMoveInPlace(board, hand, eliminated, m, humanPlayer);
        const exposed = kingWouldBeCaptured(board, humanPlayer, eliminated);
        undoMoveInPlace(board, hand, eliminated, m, humanPlayer, undo);
        return exposed ? { ...m, warn: true } : m;
      });
    }
  } else if (hi >= 0) {
    const uh = uniqueHand(humanPlayer);
    if (uh[hi]) { selHand = true; selected = hi; vmoves = allMoves(humanPlayer, board).filter((m) => m.drop && m.piece === uh[hi].p); }
  }
  render();
}
// ひとりで指す画面（ui.js）にある、クリックの位置を盤・持ち駒に直す関数
function xyToBoard(x, y) {
  const pc = Math.floor((x - BX) / CS), pr = Math.floor((y - BY) / CS);
  if (!inB(pr, pc)) return null;
  const [lr, lc] = physToLog(pr, pc);
  return inB(lr, lc) ? [lr, lc] : null;
}
function xyToHand0(x, y) {
  if (humanPlayer < 0) return -1;
  const uh = uniqueHand(humanPlayer); if (!uh.length) return -1;
  const handY = BY + 9 * CS + 14;
  if (y < handY || y > handY + CS) return -1;
  const sp = Math.min(66, 500 / Math.max(uh.length, 1)), startX = (CW - uh.length * sp) / 2;
  for (let i = 0; i < uh.length; i++) if (x >= startX + i * sp && x < startX + (i + 1) * sp) return i;
  return -1;
}
function uniqueHand(o) { const m = {}; (hand[o] || []).forEach((p) => { m[p] = (m[p] || 0) + 1; }); return Object.entries(m).map(([p, n]) => ({ p, n })); }

// ---------- 音（手が指されたとき） ----------
let actx = null;
function sound() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.08);
    g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.14);
  } catch (e) {}
}

// ---------- 画面 ----------
// 盤の手前・向こう・横のだれが座っているか（render.js の drawAllHands と同じ並び）
function sides() {
  const v = viewPlayer;
  return v === 0 ? { top: 1, side: 2, sideName: '右' } : v === 1 ? { top: 0, side: 2, sideName: '左' } : { top: 1, side: 0, sideName: '左' };
}
function plHTML(i, where) {
  const s = RV.seats[i], st = RV.state, out = st && st.elim[i];
  return `<div class="pl${st && !st.over && st.turn === i ? ' turn' : ''}${out ? ' out' : ''}${i === RV.you ? ' me' : ''}" id="pl${i}" style="--c:${PCOL[i]}">
    <span class="dot" style="--c:${PCOL[i]};background:${PCOL[i]}"></span>
    <span class="nm">${esc(seatName(i))}${out ? ' ☠' : ''}${!s.empty && !s.online ? '<small class="where">（るす）</small>' : ''}</span>
    ${where ? `<span class="where">${where}</span>` : ''}<span class="tm" id="tm${i}"></span>${popHTML(i)}</div>`;
}
function drawClocks() {
  for (let i = 0; i < 3; i++) {
    const el = $('tm' + i); if (!el) continue;
    const st = RV.state;
    if (!st || st.over || st.turn !== i) { el.textContent = ''; continue; }
    const l = leftMs();
    if (l === null) { el.textContent = RV.seats[i].empty || RV.auto ? '考え中…' : ''; el.classList.remove('low'); continue; }
    const sec = Math.max(0, Math.ceil(l / (RV.secMs || 1000)));
    el.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    el.classList.toggle('low', sec <= 10);
  }
}
let lobbyHTML = '', resultShown = false;
function draw() {
  const inRoom = !!ROOMID;
  $('rooms').hidden = inRoom;
  if (!inRoom) return;
  const playing = RV && RV.state && (RV.you >= 0 || watching) && RV.phase !== 'lobby';
  renderLobby(!playing);
  $('game').hidden = !playing;
  $('result').hidden = !(playing && RV.phase === 'over');
  if (!playing) return;
  const sd = sides();
  $('topPl').innerHTML = plHTML(sd.top, '') + plHTML(sd.side, sd.sideName);
  $('mePl').innerHTML = RV.you >= 0 ? plHTML(RV.you, '') : plHTML(0, '');
  drawClocks();
  const st = RV.state;
  $('info').textContent = st.over ? '' : RV.you >= 0 && st.elim[RV.you] ? '脱落しました。残りの2人の対局を見ています'
    : myTurn() ? 'あなたの番です' : seatName(st.turn) + ' の番です';
  // スタンプ（座っている人だけ）
  const sb = $('stamps');
  if (RV.you >= 0 && !sb.childElementCount) {
    sb.innerHTML = STAMPS.map(([k, t]) => `<button type="button" data-k="${k}">${t}</button>`).join('');
    sb.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { send({ t: 'stamp', k: b.dataset.k }); showStamp(RV.you, b.dataset.k); }));
  } else if (RV.you < 0) sb.innerHTML = '';
  $('gameBtns').innerHTML = RV.you >= 0
    ? `${st.over || st.elim[RV.you] ? '' : '<button class="btn" type="button" id="resign">投了</button>'}<button class="btn" type="button" id="leave">部屋を出る</button>`
    : RV.seats.some((s) => s.empty) ? '<button class="btn primary" type="button" id="joinNow">CPUと交代して参加する</button>' : '';
  on('resign', () => { if ($('resign').dataset.sure) { send({ t: 'resign', game: RV.game }); return; } $('resign').dataset.sure = 1; $('resign').textContent = 'ほんとうに投了する'; });
  on('leave', () => { send({ t: 'leave' }); location.href = 'room.html'; });
  on('joinNow', () => { watching = false; send({ t: 'join', name: myName() || 'ゲスト' }); });
  render();
  if (RV.phase === 'over') renderResult();
}
const on = (id, f) => { const b = $(id); if (b) b.addEventListener('click', f); };

function renderLobby(show) {
  const el = $('lobby');
  if (!show) { el.hidden = true; lobbyHTML = ''; return; }
  let h;
  if (!RV) h = `<h2>${roomErr ? '部屋が見つかりません' : '部屋につないでいます…'}</h2>${roomErr ? `<p class="note">${esc(roomErr)}</p><a class="btn primary" href="room.html">部屋の一覧へ</a>` : ''}`;
  else {
    const url = location.origin + location.pathname + '?room=' + RV.id, you = RV.you, lobby = RV.phase === 'lobby', host = you === 0;
    const seats = RV.seats.map((s, i) => `<div class="seat"><span class="dot" style="--c:${PCOL[i]};background:${PCOL[i]}"></span><span class="nm${s.empty ? ' empty' : ''}">${COLOR[i]}：${s.empty ? (lobby ? 'あき（始めたらCPU）' : 'CPU') : esc(s.name) + (i === you ? '（あなた）' : '')}</span><span class="on${s.online ? ' y' : ''}">${s.empty ? '' : s.online ? '● いる' : 'るす'}</span></div>`).join('');
    const nameBox = `<label>あなたの名前<input id="myName" maxlength="8" placeholder="なまえ" value="${esc(you >= 0 ? RV.seats[you].name : myName())}"></label>`;
    const ruleRow = `<label>取った駒${host ? '' : '（部屋を作った人が決めます）'}<div class="choices">${RULES.map(([k, n, d]) => `<button type="button" data-rule="${k}" class="${RV.rule === k ? 'on' : ''}"${host ? '' : ' disabled'}>${n}<small>${d}</small></button>`).join('')}</div></label>`;
    const limitRow = `<label>1手の持ち時間${host ? '' : '（部屋を作った人が決めます）'}<div class="choices">${LIMITS.map((t) => `<button type="button" data-sec="${t}" class="${RV.limit === t ? 'on' : ''}"${host ? '' : ' disabled'}>${t < 60 ? t + '秒' : t / 60 + '分'}</button>`).join('')}</div></label>`;
    let body;
    if (you >= 0) {
      const msg = '三人将棋を指そう！ ' + url;
      body = nameBox + `<label>① このリンクを友達に送る<div class="invite"><input id="inv" readonly value="${esc(url)}"><button class="btn" id="copy" type="button">コピー</button></div></label>
        <div class="btnrow"><a class="btn" href="https://line.me/R/share?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">LINEで送る</a><a class="btn" href="https://x.com/intent/post?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Xで呼ぶ</a></div>
        <p class="note">② 友達がリンクを開いて「参加する」を押すと、上に名前が出ます</p>` + ruleRow + limitRow
        + (host ? `<label class="check"><input type="checkbox" id="listed"${RV.listed ? ' checked' : ''}>部屋の一覧に出す（だれでも参加できる）</label>
            <button class="btn primary" id="go" type="button">③ はじめる</button><p class="note">そろわなくても始められます。空いた席にはCPUが入ります。先手は青です</p>`
          : `<p class="note">③ ${esc(RV.seats[0].name)} さんが「はじめる」を押すのを待っています</p>`);
    } else if (RV.seats.some((s) => s.empty)) {
      body = lobby
        ? `<p class="note">${esc(RV.seats.find((s) => !s.empty)?.name || 'だれか')} さんの部屋に招待されました</p>` + nameBox + '<button class="btn primary" id="join" type="button">参加する</button>'
        : `<p class="note">${RV.kicked ? '時間切れが続いたので、CPUが代わりに指しています。CPUと交代すれば、続きから指せます' : 'もう対局が始まっています。CPUの席と交代して、途中から参加できます'}</p>` + nameBox
          + '<div class="btnrow"><button class="btn primary" id="join" type="button">CPUと交代して参加する</button><button class="btn" id="watch" type="button">見るだけ</button></div>';
    } else body = `<p class="note">この部屋は満員です${lobby ? '' : '。対局を見ることはできます'}</p><div class="btnrow">${lobby ? '' : '<button class="btn primary" id="watch" type="button">見るだけ</button>'}<a class="btn" href="room.html">部屋の一覧へ</a></div>`;
    h = `<h2>${lobby ? (RV.seats[0].empty ? '' : esc(RV.seats[0].name) + ' の部屋') : '対局中です'}</h2><div class="seats">${seats}</div>${body}`;
  }
  if (h === lobbyHTML && !el.hidden) return; // 同じなら描き直さない（入力中の名前が消えないように）
  const focused = document.activeElement && document.activeElement.id === 'myName', typed = focused ? document.activeElement.value : null;
  lobbyHTML = h; el.innerHTML = h; el.hidden = false;
  const nb = $('myName');
  if (nb) {
    if (focused) { nb.value = typed; nb.focus(); }
    nb.addEventListener('input', () => saveName(nb.value.trim()));
    nb.addEventListener('change', () => { const v = nb.value.trim(); saveName(v); if (RV && RV.you >= 0 && v) send({ t: 'join', name: v }); });
  }
  on('copy', () => { const i = $('inv'); i.select(); (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).then(() => toast('コピーしました'), () => { document.execCommand('copy'); toast('コピーしました'); }); });
  on('go', () => { gtag('event', 'shogi_room_start', { seated: RV.seats.filter((s) => !s.empty).length }); send({ t: 'start' }); });
  on('watch', () => { watching = true; draw(); });
  on('join', () => { const v = ($('myName').value || '').trim() || 'ゲスト'; saveName(v); gtag('event', 'shogi_room_join'); send({ t: 'join', name: v }); });
  el.querySelectorAll('button[data-rule]').forEach((b) => b.addEventListener('click', () => send({ t: 'rule', rule: b.dataset.rule })));
  el.querySelectorAll('button[data-sec]').forEach((b) => b.addEventListener('click', () => send({ t: 'limit', sec: +b.dataset.sec })));
  const ls = $('listed'); if (ls) ls.addEventListener('change', () => send({ t: 'listed', on: ls.checked }));
}

// 決着：順位・勝ち方・「もう一局」・検討へ
const WIN_TYPE = { king: '玉を取って決着', try: '入玉で決着', limit: '500手で、駒の価値の合計で決着' };
function renderResult() {
  const st = RV.state, el = $('result'), you = RV.you, n = RV.seats.filter((s) => !s.empty).length;
  const meSeat = RV.seats[you], k = RV.seats.filter((s) => s.voted).length;
  const resigned = st.log.some((x) => x.resign) && st.winType === 'king';
  const rows = (RV.ranking || []).map((p, r) => `<div class="seat"><b>${r + 1}位</b><span class="dot" style="--c:${PCOL[p]};background:${PCOL[p]}"></span><span class="nm">${esc(seatName(p))}</span><span class="on">${RV.wins[p]}勝</span></div>`).join('');
  const againBtn = !meSeat ? '' : meSeat.voted ? `<button class="btn primary" type="button" disabled>みんなを待っています（${k}/${n}）</button>`
    : `<button class="btn primary" type="button" id="again">${n > 1 ? `この${n}人でもう一局` : 'もう一局'}${k ? `（${k}/${n}）` : ''}</button>`;
  el.innerHTML = `<div class="big" style="color:${PCOL[st.winner]}">${esc(seatName(st.winner))} の勝ち！</div>
    <p class="note" style="text-align:center">${resigned ? '投了と玉取りで決着' : WIN_TYPE[st.winType] || ''}・${st.moves}手</p>
    <div class="rank">${rows}</div><div class="btnrow">${againBtn}<button class="btn" type="button" id="review">この対局を検討する</button></div>`;
  on('again', () => send({ t: 'again' }));
  on('review', openReview);
  if (!resultShown) { resultShown = true; gtag('event', 'shogi_room_over', { win: st.winType, moves: st.moves }); }
}
// 棋譜を「ひとりで指す」画面にわたして、検討画面で開く（shogi3.html#review）
function openReview() {
  const s0 = initialState();
  const rec = { title: 'みんなと指した対局', start: { board: s0.board, hand: s0.hand, eliminated: [false, false, false], turn: 0, moveCount: 0, rule: keepAllPieces },
    moves: RV.state.log, human: RV.you >= 0 ? RV.you : undefined, players: RV.seats.map((s, i) => seatName(i).replace('（あなた）', '')) };
  try { localStorage.setItem('shogi3-review', JSON.stringify(rec)); } catch (e) { toast('棋譜を渡せませんでした'); return; }
  window.open('shogi3.html#review', '_blank');
}
// 対局の最初の局面（game.js の init と同じ並び）
function initialState() {
  const b = Array.from({ length: 9 }, () => Array(9).fill(null));
  const put = (r, c, p, o) => { b[r][c] = { p, o, pr: false }; };
  [[8, 0, 'GIN'], [8, 1, 'KIN'], [8, 2, 'OU'], [8, 3, 'KIN'], [8, 4, 'GIN'], [7, 0, 'HI'], [7, 4, 'KAKU']].forEach(([r, c, p]) => put(r, c, p, 0));
  for (let c = 0; c <= 4; c++) put(6, c, 'FU', 0);
  [[0, 0, 'GIN'], [0, 1, 'KIN'], [0, 2, 'OU'], [0, 3, 'KIN'], [0, 4, 'GIN'], [1, 0, 'KAKU'], [1, 4, 'HI']].forEach(([r, c, p]) => put(r, c, p, 1));
  for (let c = 0; c <= 4; c++) put(2, c, 'FU', 1);
  [[2, 8, 'GIN'], [3, 8, 'KIN'], [4, 8, 'OU'], [5, 8, 'KIN'], [6, 8, 'GIN'], [2, 7, 'HI'], [6, 7, 'KAKU']].forEach(([r, c, p]) => put(r, c, p, 2));
  for (let r = 2; r <= 6; r++) put(r, 6, 'FU', 2);
  return { board: b, hand: [['KY', 'KE'], ['KY', 'KE'], ['KY', 'KE']] };
}

// スタンプ：名前の上に吹き出し。名前の欄は手が指されるたびに描き直すので、出ているスタンプは覚えておく
const pops = {};
const popHTML = (p) => (pops[p] && Date.now() < pops[p].until ? `<div class="pop" style="animation-delay:-${Date.now() - pops[p].at}ms">${esc(pops[p].t)}</div>` : '');
function showStamp(p, k) {
  const card = $('pl' + p), t = (STAMPS.find((x) => x[0] === k) || [])[1];
  if (!card || !t) return;
  pops[p] = { t, at: Date.now(), until: Date.now() + 2200 };
  card.querySelector('.pop')?.remove();
  card.insertAdjacentHTML('beforeend', popHTML(p));
}

// ---------- 部屋の一覧（room.html を ?room なしで開いたとき） ----------
let roomsTimer = null;
async function showRooms() {
  const el = $('rooms');
  const paint = (list, err) => {
    const tag = (r) => (r.phase === 'lobby' ? '<span class="tag wait">人待ち</span>' : r.seats.includes(null) ? '<span class="tag join">途中参加OK</span>' : r.phase === 'over' ? '<span class="tag">終わったところ</span>' : '<span class="tag">対局中</span>');
    const rows = list === null ? `<p class="note">${esc(err || 'さがしています…')}</p>`
      : list.length ? list.map((r) => `<a class="roomrow" href="?room=${r.id}"><span class="who">${esc((r.seats.find(Boolean) || { name: 'だれか' }).name)} の部屋<small class="note" style="margin-left:6px">${(RULES.find((x) => x[0] === r.rule) || RULES[0])[1]}・1手${r.limit < 60 ? r.limit + '秒' : r.limit / 60 + '分'}</small></span>${tag(r)}<span class="seatsm">${r.seats.map((s, i) => `<span style="color:${PCOL[i]}">${s ? esc(s.name) + (s.online ? '' : '（るす）') : 'あき'}</span>`).join('<span>・</span>')}</span></a>`).join('')
      : '<p class="note">まだ部屋がありません。作って友達を呼んでみよう</p>';
    el.innerHTML = `<h2>みんなと指す</h2><p class="note">部屋を作ってリンクを送ると、ともだちと3人で指せます。空いた席にはCPUが入ります。</p>
      <button class="btn primary" id="mkroom" type="button">＋ 部屋を作る</button><div class="seats">${rows}</div>
      <a class="btn" href="shogi3.html">ひとりで指す（CPUと対局・検討）</a>`;
    on('mkroom', makeRoom);
  };
  el.hidden = false;
  paint(null);
  const load = async () => {
    try { const r = await fetch(API + '/rooms?kind=shogi3'); paint((await r.json()).rooms); }
    catch (e) { paint(null, '一覧を取れませんでした。通信を確かめてください'); }
    roomsTimer = setTimeout(load, 5000);
  };
  load();
}
async function makeRoom() {
  gtag('event', 'shogi_room_create'); toast('部屋を作っています…');
  try {
    const r = await fetch(API + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: me(), name: myName() || 'ゲスト', kind: 'shogi3' }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    location.href = '?room=' + j.id;
  } catch (e) { toast('部屋を作れませんでした。少し時間をおいて、もう一度ためしてください'); }
}

// ---------- はじめ ----------
window.addEventListener('DOMContentLoaded', () => {
  canvas = $('c'); ctx = canvas.getContext('2d'); canvas.width = CW; canvas.height = CH;
  canvas.addEventListener('click', onBoardClick);
  // CPU：学習AIが使えなければ、手作りの CPU（中級・2秒）
  currentDifficulty = 'net'; netTimeMs = CPU_MS; AI_TIME_LIMIT_MS = CPU_MS;
  AI_SEARCH_DEPTH = DIFFICULTY_LEVELS.normal.depth; AI_NOISE = DIFFICULTY_LEVELS.normal.noise;
  if (!ROOMID) { showRooms(); return; }
  draw();
  connect(ROOMID);
  // 部屋がない（ID がちがう）ときは、WebSocket がつながらないので一覧へ案内する
  setTimeout(() => { if (!RV) { roomErr = 'リンクが古いか、まちがっているかもしれません'; draw(); } }, 6000);
});
