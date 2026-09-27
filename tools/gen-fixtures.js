// Rust版ルールエンジンの照合用データを、JS実装（game.js の applyMove / allMoves）から作る
// 使い方: node tools/gen-fixtures.js [--games 60] [--out engine-rs/core/tests/fixtures]
//
// 取り駒ルール3種それぞれで、初期局面からの対局と、途中局面（tools/bench-positions.json）からの対局を
// 乱数で指し進め、毎手について次を記録する：
//   legal   : 合法手の数と、並べた合法手コードのダイジェスト
//   move    : 指した手（engine.js と同じ整数コード: to | from<<7 | 成り<<14、from>=81 は打ち）
//   after   : 指した後の局面ダイジェスト（盤・持ち駒・脱落・手番）
// 対局の終わりに、勝者・終局の種類・手数を記録する。
// ダイジェストは FNV-1a 32bit（Rust側と同じ計算）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeContext } = require('./selfplay.js');

const args = { games: 60, out: path.join(__dirname, '..', 'engine-rs', 'core', 'tests', 'fixtures') };
const av = process.argv.slice(2);
for(let i=0;i<av.length;i+=2) args[av[i].replace(/^--/, '')] = av[i+1];
args.games = +args.games;

const ctx = makeContext();
const run = s => vm.runInContext(s, ctx);
run(`
var __seed = 1;
function __rand(){ __seed = (Math.imul(__seed, 1103515245) + 12345) >>> 0; return (__seed >>> 8) / 16777216; }
function fnvStart(){ return 0x811c9dc5; }
function fnvByte(h, b){ return Math.imul(h ^ (b & 255), 16777619) >>> 0; }
function moveCode(mv){
  const to = mv.tr*9+mv.tc;
  if(mv.drop) return ((81 + Z_PIECE_IDX[mv.piece]) << 7) | to;
  return ((mv.fr*9+mv.fc) << 7) | to | (mv.pro ? 16384 : 0);
}
// 盤81バイト（駒コード）＋持ち駒3×7＋脱落3＋手番
function stateDigest(){
  let h = fnvStart();
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const x = board[r][c];
    h = fnvByte(h, x ? 1 + x.o*16 + (x.pr?8:0) + Z_PIECE_IDX[x.p] : 0);
  }
  const names = ['FU','KY','KE','GIN','KIN','KAKU','HI'];
  for(let o=0;o<3;o++) for(const p of names) h = fnvByte(h, handCount(hand[o], p));
  for(let o=0;o<3;o++) h = fnvByte(h, eliminated[o] ? 1 : 0);
  h = fnvByte(h, turn);
  return h;
}
function movesDigest(codes){
  let h = fnvStart();
  for(const c of codes){ h = fnvByte(h, c & 255); h = fnvByte(h, c >> 8); }
  return h;
}
// 対局の進め方（__mode）：脱落・入玉・500手制限・各取り駒ルールの分岐をすべて通すため
//   0: 駒取りを優先（玉取りによる脱落が多い）
//   1: 玉を前に進める（入玉が起きる）
//   2: 玉を取らない（500手制限まで続く）
var __mode = 0;
function kingForward(m){
  const o = board[m.fr][m.fc].o;
  return o === 0 ? m.tr < m.fr : o === 1 ? m.tr > m.fr : m.tc < m.fc;
}
function pickMove(ms){
  const rnd = a => a[Math.floor(__rand() * a.length)];
  if(__mode === 2){
    const safe = ms.filter(m => m.drop || !board[m.tr][m.tc] || board[m.tr][m.tc].p !== 'OU');
    if(safe.length) ms = safe;
  }
  if(__mode === 1){
    const fwd = ms.filter(m => !m.drop && board[m.fr][m.fc].p === 'OU' && kingForward(m));
    if(fwd.length && __rand() < 0.6) return rnd(fwd);
  }
  const caps = ms.filter(m => !m.drop && board[m.tr][m.tc]);
  if(caps.length && __rand() < (__mode === 0 ? 0.5 : 0.15)) return rnd(caps);
  return rnd(ms);
}
function playRecorded(){
  const plies = [];
  let guard = 0;
  while(!gover && guard++ < 2000){
    const ms = allMoves(turn, board);
    const codes = ms.map(moveCode).sort((a,b)=>a-b);
    if(!ms.length){
      // 指せる手がなければ手番を飛ばす（UIの nextTurn と同じ）
      plies.push({ n: 0, legal: movesDigest(codes), move: -1, after: 0 });
      turn = nextAliveOn(eliminated, turn);
      if(turn < 0) break;
      continue;
    }
    const mv = pickMove(ms);
    applyMove(mv, turn);
    if(!gover) turn = nextAliveOn(eliminated, turn);
    plies.push({ n: ms.length, legal: movesDigest(codes), move: moveCode(mv), after: stateDigest() });
  }
  return { plies, winner, winType, moveCount };
}
`);

const positions = require(path.join(__dirname, 'bench-positions.json'));
fs.mkdirSync(args.out, { recursive: true });
const ruleName = r => r === 'all' ? 'all' : r === 'next' ? 'next' : 'vanish';

for(const rule of ['all', 'next', false]){
  const games = [];
  for(let g=0; g<args.games; g++){
    ctx.__rule = rule; ctx.__seedInit = 1000 + g * 7919 + (rule === 'all' ? 0 : rule === 'next' ? 1 : 2);
    ctx.__modeInit = Math.floor(g / 2) % 3;
    let start;
    if(g % 2 === 0){
      // 初期局面から
      start = null;
      run(`__seed = __seedInit; __mode = __modeInit; humanPlayer = 0; selfPlayMode = false; cpuCollusion = false; keepAllPieces = __rule; init();`);
    } else {
      // 途中局面から
      start = positions[(g * 13) % positions.length];
      ctx.__p = JSON.stringify(start);
      run(`__seed = __seedInit; __mode = __modeInit; humanPlayer = 0; selfPlayMode = false; cpuCollusion = false; keepAllPieces = __rule; init();
           (function(){ const s = JSON.parse(__p); board = s.board; hand = s.hand; eliminated = s.eliminated; turn = s.turn; moveCount = s.moveCount; })();`);
    }
    const startState = JSON.parse(run(`JSON.stringify({ board, hand, eliminated, turn, moveCount })`));
    const res = run('playRecorded()');
    games.push({ start: startState, plies: res.plies, winner: res.winner, winType: res.winType, moveCount: res.moveCount });
  }
  const file = path.join(args.out, `games_${ruleName(rule)}.json`);
  fs.writeFileSync(file, JSON.stringify({ rule: ruleName(rule), games }));
  const plies = games.reduce((s, g) => s + g.plies.length, 0);
  const types = {}; games.forEach(g => types[g.winType] = (types[g.winType] || 0) + 1);
  console.log(`${file}: ${games.length}局 ${plies}手 終局=${JSON.stringify(types)}`);
}
