// 探索ベンチマーク：固定局面集を固定深さで読み、時間・局面数・指し手を記録する
// 使い方:
//   node tools/bench.js --gen 6                        # 自己対局から局面集 tools/bench-positions.json を作る
//   node tools/bench.js --depth 3 --out a.json         # 作業ツリーのエンジンで計測
//   node tools/bench.js --depth 3 --ref HEAD --out b.json
//   node tools/bench.js --compare b.json a.json        # 指し手の一致率・速度比
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { loadSources, makeContext, setParams } = require('./selfplay.js');

const POS_FILE = path.join(__dirname, 'bench-positions.json');
const STATE_VARS = ['board', 'hand', 'eliminated', 'turn', 'moveCount'];

function moveKey(m){ return m ? (m.drop ? `${m.piece}*${m.tr}${m.tc}` : `${m.fr}${m.fc}-${m.tr}${m.tc}${m.pro?'+':''}`) : 'null'; }

if(!isMainThread){
  const { mode } = workerData;
  if(mode === 'gen'){
    const ctx = makeContext();
    const get = e => vm.runInContext(e, ctx);
    get('humanPlayer=0; cpuCollusion=false; keepAllPieces="all"; init();');
    setParams(ctx, { AI_TIME_LIMIT_MS: 400 });
    const out = [];
    let ply = 0;
    while(!get('gover') && ply < 400){
      if(ply >= 6 && ply % 9 === workerData.offset % 9) out.push(JSON.parse(get(`JSON.stringify({${STATE_VARS.join(',')}})`)));
      const mv = get('aiMove(turn, board, hand, eliminated)');
      if(mv){ ctx.__mv = mv; get('applyMove(__mv, turn)'); }
      ply++;
      if(get('gover')) break;
      get('turn = nextAliveOn(eliminated, turn)');
    }
    parentPort.postMessage(out);
    return;
  }
  // mode === 'run'
  const { positions, depth, sources, params } = workerData;
  const ctx = makeContext(sources);
  let lastLog = '';
  ctx.console.log = s => { lastLog = String(s); };
  setParams(ctx, { AI_NOISE: 0, AI_TIME_LIMIT_MS: 1e9, AI_MAX_DEPTH: depth, ...params });
  const res = [];
  for(const { idx, pos } of positions){
    ctx.__pos = JSON.stringify(pos);
    vm.runInContext(`(function(){ const s = JSON.parse(__pos); ${STATE_VARS.map(v => `${v} = s.${v};`).join(' ')} })()`, ctx);
    vm.runInContext('humanPlayer=0; cpuCollusion=false; humanEliminated=false; keepAllPieces="all";', ctx);
    const t = performance.now();
    const mv = vm.runInContext('aiMove(turn, board, hand, eliminated)', ctx);
    const ms = performance.now() - t;
    const m = /深さ:(\d+) \/ 末端eval:(\d+) \/ 手生成:(\d+)/.exec(lastLog);
    const info = vm.runInContext('typeof lastSearchInfo !== "undefined" ? JSON.stringify(lastSearchInfo) : "null"', ctx);
    const si = JSON.parse(info);
    res.push({ idx, ms, move: moveKey(mv), depth: m ? +m[1] : -1, leaf: m ? +m[2] : 0, gen: m ? +m[3] : 0,
               turn: pos.turn, depthBest: si ? si.depthBest : null });
  }
  parentPort.postMessage(res);
  return;
}

function runWorkers(datas){
  return Promise.all(datas.map(wd => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: wd });
    w.on('message', res); w.on('error', rej);
  })));
}

(async () => {
  const av = process.argv.slice(2);
  const a = {};
  for(let i=0;i<av.length;i++){ const k = av[i].replace(/^--/, ''); a[k] = av[i+1] && !av[i+1].startsWith('--') ? av[++i] : true; }

  if(a.gen){
    const n = +a.gen;
    const outs = await runWorkers(Array.from({ length: n }, (_, i) => ({ mode: 'gen', offset: i })));
    const all = outs.flat();
    fs.writeFileSync(POS_FILE, JSON.stringify(all));
    console.log(`局面 ${all.length} 件を ${POS_FILE} に保存`);
    return;
  }

  if(a.compare){
    const A = JSON.parse(fs.readFileSync(a.compare, 'utf8'));
    const B = JSON.parse(fs.readFileSync(av[av.length-1], 'utf8'));
    const same = A.results.filter((r, i) => r.move === B.results[i].move).length;
    console.log(JSON.stringify({
      A: A.summary, B: B.summary,
      moveAgreePct: +(same / A.results.length * 100).toFixed(1),
      speedupTime: +(A.summary.totalMs / B.summary.totalMs).toFixed(2),
      nodeRatio: +((A.summary.leaf + A.summary.gen) / (B.summary.leaf + B.summary.gen)).toFixed(2),
    }, null, 1));
    return;
  }

  const depth = +(a.depth || 3);
  const positions = JSON.parse(fs.readFileSync(POS_FILE, 'utf8')).map((pos, idx) => ({ idx, pos }));
  const limit = a.limit ? +a.limit : positions.length;
  const use = positions.slice(0, limit);
  const nW = Math.min(+(a.workers || Math.max(1, os.cpus().length - 2)), use.length);
  const chunks = Array.from({ length: nW }, () => []);
  use.forEach((p, i) => chunks[i % nW].push(p));
  const sources = loadSources(a.ref && a.ref !== true ? a.ref : '');
  const params = a.params ? JSON.parse(a.params) : {};
  const t0 = Date.now();
  const outs = await runWorkers(chunks.map(c => ({ mode: 'run', positions: c, depth, sources, params })));
  const results = outs.flat().sort((x, y) => x.idx - y.idx);
  const summary = {
    ref: a.ref || 'worktree', depth, positions: results.length,
    totalMs: Math.round(results.reduce((s, r) => s + r.ms, 0)),
    maxMs: Math.round(Math.max(...results.map(r => r.ms))),
    leaf: results.reduce((s, r) => s + r.leaf, 0), gen: results.reduce((s, r) => s + r.gen, 0),
    wallSec: Math.round((Date.now() - t0) / 1000),
  };
  // 評価の安定性：深さd-1→dで最善値がどれだけ動くか（d=2..）。テンポ補正が合っていれば小さくなる
  const stab = {};
  for(const r of results){
    if(!r.depthBest) continue;
    for(let d=2; d<=r.depthBest.length; d++){
      const x = r.depthBest[d-1], y = r.depthBest[d-2];
      if(Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue; // 勝敗確定値は除外
      const s = stab['d'+(d-1)+'to'+d] || (stab['d'+(d-1)+'to'+d] = { n: 0, sum: 0, abs: 0 });
      s.n++; s.sum += x - y; s.abs += Math.abs(x - y);
    }
  }
  for(const k of Object.keys(stab)){ const s = stab[k]; stab[k] = { n: s.n, meanDiff: Math.round(s.sum/s.n), meanAbs: Math.round(s.abs/s.n) }; }
  summary.stability = stab;
  if(a.out) fs.writeFileSync(a.out, JSON.stringify({ summary, results }));
  console.log(JSON.stringify(summary));
})();
