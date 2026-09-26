// 自己対局ハーネス（Node.js / ブラウザ不要）
// 使い方:
//   node tools/selfplay.js --games 120 --time 500 --cand '{"AI_MOBILITY_SCALE":40}'
//   node tools/selfplay.js --games 120 --base '{"AI_THREEWAY_SEARCH":"brs"}' --cand '{}'
// 1局ごとに「候補(cand)1席 vs 基準(base)2席」で対局し、候補の席をローテーションする。
// 互角なら候補の勝率は約33.3%。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const SRC_FILES = ['constants.js', 'game.js', 'attack-maps.js', 'ai.js'];

// 調整対象パラメータ（constants.js の const を let に置き換えて差し替え可能にする）
const TUNABLE = [
  'AI_MOBILITY_SCALE', 'AI_DANGER_SCALE', 'AI_ENTRY_MULT', 'AI_ENTRY_BLOCK_RATE',
  'AI_KING_SAFETY_MULT', 'AI_HAND_BONUS_RATE', 'AI_COALITION_THRESHOLD',
  'AI_COALITION_MULT', 'AI_FINISH_MULT', 'AI_QMS_HAND_COST',
];
const EXTRA = ['AI_NOISE', 'AI_TIME_LIMIT_MS', 'AI_THREEWAY_SEARCH'];

function parseArgs(argv){
  const a = { games: 60, time: 500, workers: Math.max(1, os.cpus().length - 2),
              base: '{}', cand: '{}', rule: 'all', seed: 0, quiet: false };
  for(let i=0;i<argv.length;i++){
    const k = argv[i].replace(/^--/, '');
    if(k === 'quiet'){ a.quiet = true; continue; }
    a[k] = argv[++i];
  }
  a.games = +a.games; a.time = +a.time; a.workers = +a.workers;
  a.base = JSON.parse(a.base); a.cand = JSON.parse(a.cand);
  return a;
}

// ── ワーカー：vmコンテキストにゲームを読み込んで対局 ──
function makeContext(){
  const noop = () => {};
  const elStub = null;
  const sandbox = {
    console: { log: noop, warn: noop, error: (...x) => process.stderr.write(x.join(' ') + '\n') },
    performance, Math, JSON, Date, Set, Map, Array, Object, Infinity, NaN,
    setTimeout: noop, clearTimeout: noop,
    document: { getElementById: () => elStub },
    window: {},
    CanvasRenderingContext2D: function(){},
  };
  sandbox.CanvasRenderingContext2D.prototype = { roundRect: noop };
  const ctx = vm.createContext(sandbox);
  for(const f of SRC_FILES){
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if(f === 'constants.js'){
      for(const name of TUNABLE) src = src.replace(new RegExp(`^const (${name})\\b`, 'm'), 'let $1');
    }
    vm.runInContext(src, ctx, { filename: f });
  }
  // 画面系スタブ
  vm.runInContext(`render = function(){}; renderKifu = function(){}; setStatus = function(){};`, ctx);
  return ctx;
}

function setParams(ctx, params){
  for(const [k, v] of Object.entries(params)){
    if(!TUNABLE.includes(k) && !EXTRA.includes(k)) throw new Error('unknown param ' + k);
    vm.runInContext(`${k} = ${JSON.stringify(v)};`, ctx);
  }
}

function playGame(ctx, seatParams, defaults){
  vm.runInContext(`humanPlayer = 0; selfPlayMode = false; cpuCollusion = false; init();`, ctx);
  const get = expr => vm.runInContext(expr, ctx);
  let plies = 0, guard = 0;
  while(!get('gover') && guard++ < 2000){
    const o = get('turn');
    setParams(ctx, defaults);
    setParams(ctx, seatParams[o]);
    const mv = get('aiMove(turn, board, hand, eliminated)');
    if(mv){ ctx.__mv = mv; get('applyMove(__mv, turn)'); plies++; }
    if(get('gover')) break;
    const nxt = get('nextAliveOn(eliminated, turn)');
    if(nxt === -1) break;
    get(`turn = ${nxt}`);
  }
  const elim = get('eliminated');
  return { winner: get('winner'), winType: get('winType'), plies, elimOrder: elim.slice() };
}

if(!isMainThread){
  const { jobs, base, cand, time, rule } = workerData;
  const ctx = makeContext();
  vm.runInContext(`keepAllPieces = ${JSON.stringify(rule === 'all' ? 'all' : rule === 'next' ? 'next' : false)};`, ctx);
  const defaults = { AI_TIME_LIMIT_MS: time };
  // 基準パラメータの完全な値（候補で変更したキーを基準値に戻すため）
  const baseFull = {};
  for(const k of new Set([...Object.keys(base), ...Object.keys(cand)])){
    baseFull[k] = k in base ? base[k] : vm.runInContext(k, ctx);
  }
  const candFull = { ...baseFull, ...cand };
  for(const job of jobs){
    const seatParams = [0,1,2].map(s => s === job.candSeat ? candFull : baseFull);
    const r = playGame(ctx, seatParams, defaults);
    parentPort.postMessage({ ...r, candSeat: job.candSeat, id: job.id });
  }
  return;
}

// ── メイン：ワーカーに対局を配って集計 ──
(async () => {
  const a = parseArgs(process.argv.slice(2));
  const jobs = [];
  for(let i=0;i<a.games;i++) jobs.push({ id: i, candSeat: i % 3 });
  const nW = Math.min(a.workers, jobs.length);
  const chunks = Array.from({ length: nW }, () => []);
  jobs.forEach((j, i) => chunks[i % nW].push(j));

  const results = [];
  const t0 = Date.now();
  await Promise.all(chunks.map(chunk => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: { jobs: chunk, base: a.base, cand: a.cand, time: a.time, rule: a.rule } });
    w.on('message', m => {
      results.push(m);
      if(!a.quiet){
        const c = results.filter(r => r.winner === r.candSeat).length;
        process.stderr.write(`\r${results.length}/${a.games} 候補勝ち ${c} (${(c/results.length*100).toFixed(1)}%)   `);
      }
    });
    w.on('error', rej);
    w.on('exit', res);
  })));
  if(!a.quiet) process.stderr.write('\n');

  const n = results.length;
  const candWins = results.filter(r => r.winner === r.candSeat).length;
  const seatWins = [0,0,0]; results.forEach(r => { if(r.winner >= 0) seatWins[r.winner]++; });
  const types = {}; results.forEach(r => { types[r.winType] = (types[r.winType]||0) + 1; });
  const avgPlies = results.reduce((s, r) => s + r.plies, 0) / n;
  const p = candWins / n, se = Math.sqrt((1/3)*(2/3)/n);
  const summary = {
    base: a.base, cand: a.cand, games: n, time: a.time, rule: a.rule,
    candWins, candRate: +(p*100).toFixed(1), zVsEven: +((p - 1/3)/se).toFixed(2),
    seatWins, winTypes: types, avgPlies: +avgPlies.toFixed(1),
    elapsedSec: Math.round((Date.now() - t0)/1000),
  };
  console.log(JSON.stringify(summary));
})();
