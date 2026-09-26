// 探索の計測：到達深さの分布と、探索木内の同一局面（置換）の出現率
// 使い方: node tools/measure-search.js --mode depth --games 8 --time 2000 > a.jsonl
//         node tools/measure-search.js --mode dup   --games 8 --time 6000 > b.jsonl
//         node tools/measure-search.js --summarize a.jsonl b.jsonl
//   depthモード: 計測なしで通常対局し、各手の到達深さを記録
//   dupモード  : minimaxRoundをラップして局面キーを数える（計測で遅くなるので思考時間を延ばす）
'use strict';
const os = require('os');
const vm = require('vm');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { makeContext, playGame } = require('./selfplay.js');

const DUP_HOOK = `
var __orig = minimaxRound, __iterMax = -1, __cur = null, __prev = null;
var __st = {}, __MAXKEYS = 1500000;
// 局面ハッシュ（Zobrist、32bit×2を53bit数値に合成）※文字列キーはメモリ不足で落ちるため
var __PI = {FU:0,KY:1,KE:2,GIN:3,KIN:4,KAKU:5,HI:6,OU:7};
var __rnd = (function(){ let s = 12345; return function(){ s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; }; })();
var __ZB1 = [], __ZB2 = [], __ZH1 = [], __ZH2 = [];
for(let i=0;i<81*48;i++){ __ZB1.push(__rnd()); __ZB2.push(__rnd()); }
for(let i=0;i<3*8*20;i++){ __ZH1.push(__rnd()); __ZH2.push(__rnd()); }
function __key(bd, hd, elim, tp){
  let h1 = tp + 1, h2 = (elim[0]?1:0) | (elim[1]?2:0) | (elim[2]?4:0);
  for(let r=0;r<9;r++){ const row = bd[r]; for(let c=0;c<9;c++){ const x = row[c]; if(!x) continue;
    const i = (r*9+c)*48 + (__PI[x.p]*2 + (x.pr?1:0))*3 + x.o; h1 ^= __ZB1[i]; h2 ^= __ZB2[i]; } }
  for(let o=0;o<3;o++){ const cnt = [0,0,0,0,0,0,0,0]; for(const p of hd[o]) cnt[__PI[p]]++;
    for(let p=0;p<8;p++) if(cnt[p]){ const i = (o*8+p)*20 + Math.min(cnt[p],19); h1 ^= __ZH1[i]; h2 ^= __ZH2[i]; } }
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 2097151);
}
minimaxRound = function(bd, hd, elim, depth, alpha, beta, turnPlayer, rootAI, pvArr, maxDepth){
  if(maxDepth !== __iterMax){ __prev = __cur; __cur = new Map(); __iterMax = maxDepth; }
  const ply = maxDepth - depth + 1; // root直下=1
  const k = __key(bd, hd, elim, turnPlayer);
  const s = __st[ply] || (__st[ply] = {nodes:0, dup:0, dupUsable:0, inPrev:0});
  s.nodes++;
  const seen = __cur.get(k);
  if(seen !== undefined){ s.dup++; if(seen >= depth) s.dupUsable++; }
  if((seen === undefined && __cur.size < __MAXKEYS) || seen < depth) __cur.set(k, depth);
  if(__prev && __prev.has(k)) s.inPrev++;
  return __orig.apply(this, arguments);
};
var __origAi = aiMove;
aiMove = function(){ __iterMax = -1; __cur = null; __prev = null; return __origAi.apply(this, arguments); };
`;

if(!isMainThread){
  const { mode, time } = workerData;
  const ctx = makeContext();
  const depths = [];
  ctx.console.log = s => { const m = /深さ:(\d+)/.exec(String(s)); if(m) depths.push(+m[1]); };
  if(mode === 'dup') vm.runInContext(DUP_HOOK, ctx);
  playGame(ctx, [{}, {}, {}], { AI_TIME_LIMIT_MS: time });
  parentPort.postMessage({ mode, depths, st: mode === 'dup' ? vm.runInContext('__st', ctx) : null });
  return;
}

// 集計：1局ごとのJSONL（{mode, depths, st}）をまとめる
function summarize(out){
  const hist = mode => {
    const h = {}; let n = 0, sum = 0;
    out.filter(o => o.mode === mode).forEach(o => o.depths.forEach(d => { h[d] = (h[d]||0) + 1; n++; sum += d; }));
    if(!n) return null;
    const pct = {}; for(const d of Object.keys(h)) pct[d] = +(h[d]/n*100).toFixed(1);
    return { games: out.filter(o => o.mode === mode).length, moves: n, avgDepth: +(sum/n).toFixed(2), pct };
  };
  const agg = {};
  out.filter(o => o.mode === 'dup').forEach(o => {
    for(const [ply, s] of Object.entries(o.st)){
      const a = agg[ply] || (agg[ply] = {nodes:0, dup:0, dupUsable:0, inPrev:0});
      for(const k of Object.keys(a)) a[k] += s[k];
    }
  });
  const dupTable = {};
  const T = {nodes:0, dup:0, dupUsable:0, inPrev:0};
  const pc = (x, n) => +(x/n*100).toFixed(2);
  for(const [ply, a] of Object.entries(agg)){
    for(const k of Object.keys(T)) T[k] += a[k];
    dupTable['ply' + ply] = { nodes: a.nodes, dupPct: pc(a.dup, a.nodes), usablePct: pc(a.dupUsable, a.nodes), inPrevIterPct: pc(a.inPrev, a.nodes) };
  }
  if(T.nodes) dupTable.total = { nodes: T.nodes, dupPct: pc(T.dup, T.nodes), usablePct: pc(T.dupUsable, T.nodes), inPrevIterPct: pc(T.inPrev, T.nodes) };
  return { depthNormal: hist('depth'), depthInDupMode: hist('dup'), dup: T.nodes ? dupTable : null };
}

(async () => {
  const av = process.argv.slice(2);
  // --summarize file.jsonl [file2.jsonl ...]
  if(av[0] === '--summarize'){
    const fs = require('fs');
    const out = [];
    for(const f of av.slice(1)) fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).forEach(l => out.push(JSON.parse(l)));
    console.log(JSON.stringify(summarize(out), null, 1));
    return;
  }
  // --mode depth|dup --games N --time ms  （1局ごとにJSONLを標準出力へ）
  const args = { mode: 'depth', games: 8, time: 2000 };
  for(let i=0;i<av.length;i+=2) args[av[i].replace(/^--/, '')] = av[i+1];
  const runs = Array.from({ length: +args.games }, () => ({ mode: args.mode, time: +args.time }));
  await Promise.all(runs.map(wd => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: wd, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    w.on('message', m => { process.stdout.write(JSON.stringify(m) + '\n'); res(); });
    w.on('error', e => { process.stderr.write('worker error: ' + e.message + '\n'); res(); });
  })));
})();
