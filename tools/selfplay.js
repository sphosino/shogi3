// 自己対局ハーネス（Node.js / ブラウザ不要）
// 使い方:
//   node tools/selfplay.js --games 132 --time 2000 --cand '{"AI_MOBILITY_SCALE":40}'
//   node tools/selfplay.js --games 132 --time 2000 --baseRef HEAD      # 作業ツリーのエンジン vs コミット済みエンジン
//   node tools/selfplay.js --games 132 --time 2000 --baseRef abc123 --base '{"AI_DANGER_SCALE":0.8}'
// 1局ごとに「候補(cand)1席 vs 基準(base)2席」で対局し、候補の席をローテーションする。
// 互角なら候補の勝率は約33.3%。
// 候補は常に作業ツリーのコード。--baseRef を指定すると基準席はそのgitリビジョンのコードで指す。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const SRC_FILES = ['constants.js', 'game.js', 'attack-maps.js', 'ai.js'];

function parseArgs(argv){
  const a = { games: 60, time: 500, workers: Math.max(1, os.cpus().length - 2),
              base: '{}', cand: '{}', rule: 'all', baseRef: '', quiet: false };
  for(let i=0;i<argv.length;i++){
    const k = argv[i].replace(/^--/, '');
    if(k === 'quiet'){ a.quiet = true; continue; }
    a[k] = argv[++i];
  }
  a.games = +a.games; a.time = +a.time; a.workers = +a.workers;
  a.base = JSON.parse(a.base); a.cand = JSON.parse(a.cand);
  return a;
}

// ソース読み込み（ref指定時は git show で取得）
function loadSources(ref){
  return SRC_FILES.map(f => ({
    f,
    src: ref ? execFileSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
             : fs.readFileSync(path.join(ROOT, f), 'utf8'),
  }));
}

// ── vmコンテキストにゲームを読み込む ──
function makeContext(sources){
  sources = sources || loadSources('');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: (...x) => process.stderr.write(x.join(' ') + '\n') },
    performance, Math, JSON, Date, Set, Map, Array, Object, Infinity, NaN,
    Int32Array, Uint32Array, Int8Array, Uint8Array, Int16Array, Float64Array, Float32Array,
    setTimeout: noop, clearTimeout: noop,
    document: { getElementById: () => null },
    window: {},
    CanvasRenderingContext2D: function(){},
  };
  sandbox.CanvasRenderingContext2D.prototype = { roundRect: noop };
  const ctx = vm.createContext(sandbox);
  for(const { f, src: raw } of sources){
    let src = raw;
    // AI_* 定数を差し替え可能にする
    if(f === 'constants.js') src = src.replace(/^const (AI_\w+)/mg, 'let $1');
    vm.runInContext(src, ctx, { filename: f });
  }
  // 画面系スタブ
  vm.runInContext(`render = function(){}; renderKifu = function(){}; setStatus = function(){};`, ctx);
  return ctx;
}

function setParams(ctx, params){
  for(const [k, v] of Object.entries(params)){
    if(!/^AI_\w+$/.test(k)) throw new Error('unknown param ' + k);
    vm.runInContext(`${k} = ${JSON.stringify(v)};`, ctx);
  }
}

// 対局状態を別コンテキストへ写す（基準エンジンに考えさせるため）
const SYNC_VARS = ['board', 'hand', 'eliminated', 'turn', 'moveCount', 'keepAllPieces',
                   'humanPlayer', 'humanEliminated', 'cpuCollusion'];
function syncState(from, to){
  const snap = vm.runInContext(`JSON.stringify({${SYNC_VARS.join(',')}})`, from);
  to.__snap = snap;
  vm.runInContext(`(function(){ const s = JSON.parse(__snap); ${SYNC_VARS.map(v => `${v} = s.${v};`).join(' ')} })()`, to);
}

// seatCtx[o]: 席oが考えるコンテキスト（seatCtx[0..2]のうち master が盤面の正本）
function playGame(master, seatParams, defaults, seatCtx){
  seatCtx = seatCtx || [master, master, master];
  vm.runInContext(`humanPlayer = 0; selfPlayMode = false; cpuCollusion = false; init();`, master);
  const get = expr => vm.runInContext(expr, master);
  let plies = 0, guard = 0;
  while(!get('gover') && guard++ < 2000){
    const o = get('turn');
    const c = seatCtx[o];
    setParams(c, defaults);
    setParams(c, seatParams[o]);
    let mv;
    if(c === master) mv = get('aiMove(turn, board, hand, eliminated)');
    else {
      syncState(master, c);
      mv = vm.runInContext('aiMove(turn, board, hand, eliminated)', c);
      if(mv) mv = JSON.parse(JSON.stringify(mv));
    }
    if(mv){ master.__mv = mv; get('applyMove(__mv, turn)'); plies++; }
    if(get('gover')) break;
    const nxt = get('nextAliveOn(eliminated, turn)');
    if(nxt === -1) break;
    get(`turn = ${nxt}`);
  }
  const elim = get('eliminated');
  return { winner: get('winner'), winType: get('winType'), plies, elimOrder: elim.slice() };
}

module.exports = { loadSources, makeContext, setParams, playGame, syncState };

if(!isMainThread && workerData && workerData.jobs){
  const { jobs, base, cand, time, rule, baseSources } = workerData;
  const candCtx = makeContext();
  const baseCtx = baseSources ? makeContext(baseSources) : candCtx;
  const ruleVal = JSON.stringify(rule === 'all' ? 'all' : rule === 'next' ? 'next' : false);
  vm.runInContext(`keepAllPieces = ${ruleVal};`, candCtx);
  const defaults = { AI_TIME_LIMIT_MS: time };
  // 変更したキーを基準値に戻すための完全な値（同一コンテキスト時のみ必要）
  const keys = new Set([...Object.keys(base), ...Object.keys(cand)]);
  const baseFull = {}, candDefault = {};
  for(const k of keys){
    baseFull[k] = k in base ? base[k] : vm.runInContext(k, baseCtx);
    candDefault[k] = vm.runInContext(k, candCtx);
  }
  const candFull = baseCtx === candCtx ? { ...baseFull, ...cand } : { ...candDefault, ...cand };
  for(const job of jobs){
    const seatParams = [0,1,2].map(s => s === job.candSeat ? candFull : baseFull);
    const seatCtx = [0,1,2].map(s => s === job.candSeat ? candCtx : baseCtx);
    const r = playGame(candCtx, seatParams, defaults, seatCtx);
    parentPort.postMessage({ ...r, candSeat: job.candSeat, id: job.id });
  }
  return;
}

// ── メイン：ワーカーに対局を配って集計 ──
if(isMainThread && require.main === module) (async () => {
  const a = parseArgs(process.argv.slice(2));
  const baseSources = a.baseRef ? loadSources(a.baseRef) : null;
  const jobs = [];
  for(let i=0;i<a.games;i++) jobs.push({ id: i, candSeat: i % 3 });
  const nW = Math.min(a.workers, jobs.length);
  const chunks = Array.from({ length: nW }, () => []);
  jobs.forEach((j, i) => chunks[i % nW].push(j));

  const results = [];
  const t0 = Date.now();
  await Promise.all(chunks.map(chunk => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: { jobs: chunk, base: a.base, cand: a.cand, time: a.time, rule: a.rule, baseSources } });
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
    baseRef: a.baseRef || undefined, base: a.base, cand: a.cand, games: n, time: a.time, rule: a.rule,
    candWins, candRate: +(p*100).toFixed(1), zVsEven: +((p - 1/3)/se).toFixed(2),
    seatWins, winTypes: types, avgPlies: +avgPlies.toFixed(1),
    elapsedSec: Math.round((Date.now() - t0)/1000),
  };
  console.log(JSON.stringify(summary));
})();
