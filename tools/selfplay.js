// 自己対局ハーネス（Node.js / ブラウザ不要）
// 使い方:
//   node tools/selfplay.js --games 132 --time 2000 --cand '{"AI_MOBILITY_SCALE":40}'
//   node tools/selfplay.js --games 132 --time 2000 --baseRef HEAD      # 作業ツリーのエンジン vs コミット済みエンジン
//   node tools/selfplay.js --games 132 --time 2000 --baseRef abc123 --base '{"AI_DANGER_SCALE":0.8}'
//   打ち切り判定: --adj off|shadow|on  --adjThreshold 3000 --adjPlies 30
//     候補の席が脱落 → 候補の負けで確定
//     生存者の駒価値（盤上＋持ち駒）で1位と2位の差が adjThreshold 以上の状態が adjPlies 手続く → 1位の勝ち
//     shadow は判定を記録するだけで最後まで指す（判定の当たり率を確かめる用）
//   --dump file.jsonl で1局ごとの結果を書き出す（shadow時は毎手の [駒価値1位の席, 2位との差, 脱落ビット] も含む）
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
const SRC_FILES = ['constants.js', 'game.js', 'attack-maps.js', 'ai.js', 'engine.js'];

function parseArgs(argv){
  const a = { games: 60, time: 500, workers: Math.max(1, os.cpus().length - 2),
              base: '{}', cand: '{}', rule: 'all', baseRef: '', quiet: false,
              adj: 'off', adjThreshold: 3000, adjPlies: 30, dump: '' };
  for(let i=0;i<argv.length;i++){
    const k = argv[i].replace(/^--/, '');
    if(k === 'quiet'){ a.quiet = true; continue; }
    a[k] = argv[++i];
  }
  a.games = +a.games; a.time = +a.time; a.workers = +a.workers;
  a.adjThreshold = +a.adjThreshold; a.adjPlies = +a.adjPlies;
  a.base = JSON.parse(a.base); a.cand = JSON.parse(a.cand);
  return a;
}

// ソース読み込み（ref指定時は git show で取得）
// 古いリビジョンに無いファイル（engine.js など）は読み飛ばす
function loadSources(ref){
  const out = [];
  for(const f of SRC_FILES){
    try{
      out.push({ f, src: ref ? execFileSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
                            : fs.readFileSync(path.join(ROOT, f), 'utf8') });
    }catch(e){ if(!ref) throw e; }
  }
  return out;
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
// adj: { mode:'off'|'shadow'|'on', threshold, plies, candSeat }  打ち切り判定（ファイル先頭の説明参照）
function playGame(master, seatParams, defaults, seatCtx, adj){
  seatCtx = seatCtx || [master, master, master];
  adj = adj || { mode: 'off' };
  vm.runInContext(`humanPlayer = 0; selfPlayMode = false; cpuCollusion = false; init();`, master);
  const get = expr => vm.runInContext(expr, master);
  let plies = 0, guard = 0;
  let streak = 0, streakLeader = -1;
  const rec = { candOutPly: -1, matWinner: -1, matPly: -1, traj: adj.mode === 'shadow' ? [] : undefined };
  let adjudicated = null;
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

    if(adj.mode !== 'off'){
      const st = JSON.parse(get(`JSON.stringify({ elim: eliminated, sc: pieceScores(board, hand, [0,1,2]) })`));
      // 候補の席が脱落 → 候補の負けで確定
      if(adj.candSeat >= 0 && st.elim[adj.candSeat] && rec.candOutPly < 0){
        rec.candOutPly = plies;
        if(adj.mode === 'on'){ adjudicated = { winner: -1, winType: 'adj_candOut' }; break; }
      }
      // 駒価値の差が大きく開いた状態が続く → 1位の勝ち
      const alive = [0,1,2].filter(p => !st.elim[p]).sort((x, y) => st.sc[y] - st.sc[x]);
      const lead = alive.length >= 2 ? st.sc[alive[0]] - st.sc[alive[1]] : 0;
      if(rec.traj) rec.traj.push([alive[0], Math.round(lead), (st.elim[0]?1:0) | (st.elim[1]?2:0) | (st.elim[2]?4:0)]);
      if(rec.matPly < 0){
        if(lead >= adj.threshold){
          if(streakLeader === alive[0]) streak++; else { streakLeader = alive[0]; streak = 1; }
        } else { streak = 0; streakLeader = -1; }
        if(streak >= adj.plies){
          rec.matWinner = alive[0]; rec.matPly = plies;
          if(adj.mode === 'on'){ adjudicated = { winner: alive[0], winType: 'adj_material' }; break; }
        }
      }
    }

    const nxt = get('nextAliveOn(eliminated, turn)');
    if(nxt === -1) break;
    get(`turn = ${nxt}`);
  }
  const elim = get('eliminated');
  const res = adjudicated
    ? { winner: adjudicated.winner, winType: adjudicated.winType, plies, elimOrder: elim.slice() }
    : { winner: get('winner'), winType: get('winType'), plies, elimOrder: elim.slice() };
  if(adj.mode !== 'off') Object.assign(res, rec);
  return res;
}

module.exports = { loadSources, makeContext, setParams, playGame, syncState };

if(!isMainThread && workerData && workerData.jobs){
  const { jobs, base, cand, time, rule, baseSources, adj } = workerData;
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
    const r = playGame(candCtx, seatParams, defaults, seatCtx, { ...adj, candSeat: job.candSeat });
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
    const w = new Worker(__filename, { workerData: { jobs: chunk, base: a.base, cand: a.cand, time: a.time, rule: a.rule, baseSources,
      adj: { mode: a.adj, threshold: a.adjThreshold, plies: a.adjPlies } } });
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

  if(a.dump) fs.writeFileSync(a.dump, results.map(r => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
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
  if(a.adj !== 'off'){
    summary.adj = { mode: a.adj, threshold: a.adjThreshold, plies: a.adjPlies };
    if(a.adj === 'shadow'){
      // 判定の検証：候補脱落で打ち切れた局・駒差判定の当たり率・判定までの手数
      const out = results.filter(r => r.candOutPly >= 0);
      const mat = results.filter(r => r.matPly >= 0);
      const matHit = mat.filter(r => r.matWinner === r.winner).length;
      const avg = xs => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
      summary.adj.candOut = { games: out.length, avgPly: avg(out.map(r => r.candOutPly)), avgFullPly: avg(out.map(r => r.plies)),
                              candWonAnyway: out.filter(r => r.winner === r.candSeat).length };
      summary.adj.material = { games: mat.length, hitRate: mat.length ? +(matHit / mat.length * 100).toFixed(1) : null,
                               avgPly: avg(mat.map(r => r.matPly)), avgFullPly: avg(mat.map(r => r.plies)) };
      // 両方を使ったときに打ち切れる手数（最初に成立した方）
      const cut = results.map(r => {
        const c = [r.candOutPly, r.matPly].filter(x => x >= 0);
        return c.length ? Math.min(...c) : r.plies;
      });
      summary.adj.estPlyRatio = +(cut.reduce((s, x) => s + x, 0) / results.reduce((s, r) => s + r.plies, 0)).toFixed(2);
    }
  }
  console.log(JSON.stringify(summary));
})();
