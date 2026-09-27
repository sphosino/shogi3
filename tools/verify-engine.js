// 新エンジン(engine.js)と旧エンジン(ai.js)の照合テスト
// 使い方: node tools/verify-engine.js [--walks 60] [--search 30]
//   1. 指し手生成の集合が一致するか（共闘モード有無）
//   2. 指す・戻すで盤面・持ち駒・脱落・玉取り/入玉判定が一致し、元に戻るか（取り駒ルール3種）
//   3. 静的評価が一致するか（三つ巴・共闘、各プレイヤー視点）
//   4. 枝刈りなしの深さ2探索で最善値が一致するか
//   5. 王手判定・王手になる打ち手の生成が総当たりと一致するか（新エンジン内の照合）
'use strict';
const vm = require('vm');
const path = require('path');
const { makeContext, setParams } = require('./selfplay.js');
const positions = require(path.join(__dirname, 'bench-positions.json'));

const args = { walks: 60, search: 30, plies: 30 };
const av = process.argv.slice(2);
for(let i=0;i<av.length;i+=2) args[av[i].replace(/^--/, '')] = +av[i+1];

const ctx = makeContext();
const run = s => vm.runInContext(s, ctx);
let seed = 12345;
ctx.__rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };

// 旧形式の指し手 → 新エンジンの整数コード
run(`
function oldToCode(mv){
  const to = mv.tr*9+mv.tc;
  if(mv.drop) return ((81 + Z_PIECE_IDX[mv.piece]) << 7) | to;
  return ((mv.fr*9+mv.fc) << 7) | to | (mv.pro ? 16384 : 0);
}
function loadPos(p){ board = JSON.parse(JSON.stringify(p.board)); hand = JSON.parse(JSON.stringify(p.hand)); eliminated = p.eliminated.slice(); turn = p.turn; }
function boardMismatch(){
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell = board[r][c], code = E_board[r*9+c];
    const exp = cell ? 1 + cell.o*16 + (cell.pr?8:0) + Z_PIECE_IDX[cell.p] : 0;
    if(exp !== code) return 'board ' + r + ',' + c + ' old=' + exp + ' new=' + code;
  }
  for(let o=0;o<3;o++) for(let pt=0;pt<7;pt++){
    const n = handCount(hand[o], E_PT_NAMES[pt]);
    if(n !== E_hand[o*8+pt]) return 'hand ' + o + ' ' + pt + ' old=' + n + ' new=' + E_hand[o*8+pt];
  }
  for(let o=0;o<3;o++) if(!!eliminated[o] !== !!E_elim[o]) return 'elim ' + o;
  return null;
}
`);

ctx.__stackArr = [];
const fails = {};
function fail(kind, msg){ fails[kind] = (fails[kind] || 0) + 1; if(fails[kind] <= 3) console.log('  NG ' + kind + ': ' + msg); }
const counts = { gen: 0, make: 0, evalv: 0, search: 0 };

for(const rule of ['all', 'next', false]){
  ctx.__rule = rule;
  for(let w=0; w<args.walks; w++){
    const p = positions[(w * 37 + (rule === 'all' ? 0 : rule === 'next' ? 11 : 23)) % positions.length];
    ctx.__p = p;
    run(`loadPos(__p); keepAllPieces = __rule; humanPlayer = 0; humanEliminated = false; cpuCollusion = false;
         buildAttackMaps(board); zobristInit(board, hand); eLoad(board, hand, eliminated);`);
    const stack = [];
    let tp = run('turn');
    for(let ply=0; ply<args.plies; ply++){
      if(run('eliminated.filter(e=>!e).length') <= 1) break;
      // 1. 指し手生成（三つ巴・共闘）
      for(const coll of [false, true]){
        ctx.__coll = coll; ctx.__tp = tp;
        const r = run(`(function(){
          cpuCollusion = __coll; humanEliminated = !!eliminated[humanPlayer];
          const a = movesOnly(board, hand, __tp, eliminated).map(oldToCode).sort((x,y)=>x-y);
          const end = eGenMoves(__tp, 0);
          const b = Array.from(E_MV.subarray(0, end)).sort((x,y)=>x-y);
          cpuCollusion = false; humanEliminated = false;
          if(a.length !== b.length) return 'count old=' + a.length + ' new=' + b.length;
          for(let i=0;i<a.length;i++) if(a[i] !== b[i]) return 'diff at ' + i + ' old=' + a[i] + ' new=' + b[i];
          return null;
        })()`);
        counts.gen++;
        if(r) fail('movegen', `rule=${rule} coll=${coll} tp=${tp} ${r}`);
      }
      // 3. 評価（三つ巴・共闘、生存者それぞれの視点）
      for(const coll of [false, true]){
        ctx.__coll = coll;
        const r = run(`(function(){
          cpuCollusion = __coll; humanEliminated = !!eliminated[humanPlayer];
          const out = [];
          for(let vp=0; vp<3; vp++){
            if(eliminated[vp]) continue;
            const a = evalStatic(board, hand, eliminated, vp);
            const b = eEvalFresh(vp);
            if(Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a))) out.push('vp' + vp + ' old=' + a + ' new=' + b);
          }
          cpuCollusion = false; humanEliminated = false;
          return out.length ? out.join(' / ') : null;
        })()`);
        counts.evalv++;
        if(r) fail('eval', `rule=${rule} coll=${coll} ${r}`);
      }
      // 5. 王手判定（eGivesCheck）と王手になる打ち手の生成（eGenCheckDrops）を総当たりと照合
      ctx.__tp = tp;
      const rc = run(`(function(){
        // 指す前から相手の玉に利いている局面（玉を取れる）は王手判定の対象外
        eComputeAttacks();
        for(let e=0;e<3;e++) if(e !== __tp && !E_elim[e] && E_king[e] >= 0 && E_cnt[__tp*81+E_king[e]]) return { n: 0, bad: 0, msg: null };
        const end = eGenMoves(__tp, 0);
        const moves = Array.from(E_MV.subarray(0, end));
        let bad = 0, n = 0, msg = null;
        const checkDrops = [];
        for(const m of moves){
          const pred = eGivesCheck(m, __tp, -1);
          eMake(m, __tp, 100);
          eComputeAttacks();
          let actual = false;
          for(let e=0;e<3;e++) if(e !== __tp && !E_elim[e] && E_king[e] >= 0 && E_cnt[__tp*81+E_king[e]]) actual = true;
          eUnmake(m, __tp, 100);
          n++;
          if(pred !== actual){ bad++; if(!msg) msg = 'move ' + m + ' pred=' + pred + ' actual=' + actual; }
          if(actual && ((m >> 7) & 127) >= 81) checkDrops.push(m);
        }
        const dEnd = eGenCheckDrops(__tp, 0, -1);
        const gen = Array.from(E_MV.subarray(0, dEnd)).sort((a,b)=>a-b);
        checkDrops.sort((a,b)=>a-b);
        if(gen.length !== checkDrops.length || gen.some((x,i)=>x !== checkDrops[i])){
          bad++; msg = (msg ? msg + ' / ' : '') + 'checkDrops gen=' + gen.length + ' expected=' + checkDrops.length;
        }
        return { n, bad, msg };
      })()`);
      counts.check = (counts.check || 0) + rc.n;
      if(rc.bad) fail('check', `rule=${rule} tp=${tp} ${rc.msg}`);
      // 2. ランダムな手を両方で指す
      ctx.__tp = tp;
      const r = run(`(function(){
        const ms = movesOnly(board, hand, __tp, eliminated);
        if(!ms.length) return { none: true };
        const mv = ms[Math.floor(__rand() * ms.length)];
        const code = oldToCode(mv);
        const undo = applyMoveInPlace(board, hand, eliminated, mv, __tp);
        const ply = __stackLen;
        const flags = eMake(code, __tp, ply);
        const oldFlags = undo.entryWin ? 2 : undo.tryWin ? 1 : 0;
        __stack.push([mv, code, __tp, undo, ply]);
        const mm = boardMismatch();
        return { flagsOk: flags === oldFlags, flags, oldFlags, mm };
      })()`.replace('__stackLen', String(stack.length)).replace('__stack.push', 'globalThis.__stackArr.push'));
      if(r.none) break;
      counts.make++;
      if(!r.flagsOk) fail('flags', `rule=${rule} old=${r.oldFlags} new=${r.flags}`);
      if(r.mm) fail('make', `rule=${rule} ${r.mm}`);
      stack.push(1);
      const nxt = run(`nextAliveOn(eliminated, ${tp})`);
      if(nxt < 0) break;
      tp = nxt;
    }
    // 全部戻す
    const r = run(`(function(){
      const h = [E_zHi, E_zLo];
      while(globalThis.__stackArr.length){
        const [mv, code, t, undo, ply] = globalThis.__stackArr.pop();
        undoMoveInPlace(board, hand, eliminated, mv, t, undo);
        eUnmake(code, t, ply);
      }
      const mm = boardMismatch();
      const cur = [E_zHi, E_zLo]; eLoad(board, hand, eliminated);
      if(mm) return mm;
      if(cur[0] !== E_zHi || cur[1] !== E_zLo) return 'hash not restored';
      return null;
    })()`);
    if(r) fail('unmake', `rule=${rule} ${r}`);
  }
}
// 4. 探索（枝刈りなし・深さ2）
setParams(ctx, { AI_NOISE: 0, AI_TIME_LIMIT_MS: 1e9, AI_MAX_DEPTH: 2, AI_USE_FUTILITY: 0, AI_USE_LMR: 0, AI_USE_SLICE: 0, AI_USE_TT: 1, AI_CHECK_EXT: 0, AI_QS_PASS: 0 });
for(let i=0; i<args.search; i++){
  ctx.__p = positions[(i * 53) % positions.length];
  const r = run(`(function(){
    loadPos(__p); keepAllPieces = 'all'; cpuCollusion = false; humanEliminated = false;
    const t1 = performance.now();
    aiMoveLegacy(turn, board, hand, eliminated); const a = lastSearchInfo.depthBest.slice();
    const t2 = performance.now();
    loadPos(__p);
    engineMove(turn, board, hand, eliminated); const b = lastSearchInfo.depthBest.slice();
    const t3 = performance.now();
    return { a, b, oldMs: t2-t1, newMs: t3-t2 };
  })()`);
  counts.search++;
  counts.oldMs = (counts.oldMs || 0) + r.oldMs; counts.newMs = (counts.newMs || 0) + r.newMs;
  const same = r.a.length === r.b.length && r.a.every((x, k) => Math.abs(x - r.b[k]) <= 1e-6 * Math.max(1, Math.abs(x)));
  if(!same) fail('search', `pos=${i} old=${JSON.stringify(r.a)} new=${JSON.stringify(r.b)}`);
}

console.log(JSON.stringify({ checks: { movegen: counts.gen, make: counts.make, eval: counts.evalv, check: counts.check, search: counts.search },
  fails, searchSpeedup: counts.newMs ? +(counts.oldMs / counts.newMs).toFixed(2) : null }));
process.exit(Object.keys(fails).length ? 1 : 0);
