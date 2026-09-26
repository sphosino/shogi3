
// ── 静的評価スコア計算 ──

// 駒価値（成りの追加価値込み）を高速に引くためのキャッシュ
const _VAL_PLAIN = PV, _VAL_PRO = {};
for(const k of Object.keys(PV)) _VAL_PRO[k] = PV[k] + (PVP[k]||0);
function cellValue(cell){ return cell.pr ? _VAL_PRO[cell.p] : _VAL_PLAIN[cell.p]; }

// 各プレイヤーの生評価値（raw）を計算
// raw は長さ3の配列（脱落者の要素は呼び出し側で上書き）
function calcRawScores(b, h, elim){
  const alive = [];
  for(let o=0;o<3;o++) if(!elim[o]) alive.push(o);
  let ps0=0, ps1=0, ps2=0, mb0=0, mb1=0, mb2=0, dg0=0, dg1=0, dg2=0;
  let k0=-1, k1=-1, k2=-1;
  const e0=elim[0], e1=elim[1], e2=elim[2];

  // 1パスで駒価値・mobility（差分更新済みの pieceReach を利用）・王位置・被脅威を集計
  for(let r=0;r<9;r++){
    const row = b[r];
    for(let c=0;c<9;c++){
      const cell = row[c];
      if(!cell) continue;
      const sq = r*9+c, o = cell.o, isElim = o===0?e0:o===1?e1:e2;
      // mobility：利きのうち味方の駒がいないマスの数（利きマップは味方のマスも含むため除く）
      const reach = pieceReach[sq];
      let reachLen = 0;
      for(let i=0;i<reach.length;i++){ const t = b[reach[i].tr][reach[i].tc]; if(!t || t.o !== o) reachLen++; }
      if(cell.p === 'OU'){
        if(o===0){ k0=sq; if(!isElim) mb0+=reachLen; }
        else if(o===1){ k1=sq; if(!isElim) mb1+=reachLen; }
        else { k2=sq; if(!isElim) mb2+=reachLen; }
        continue;
      }
      const v = cellValue(cell);
      if(isElim){ if(o===0) ps0+=v; else if(o===1) ps1+=v; else ps2+=v; continue; }

      // dangerScore：SEE的な被脅威ペナルティ（守り駒があれば減衰）
      const attackers = squareAttackers[sq];
      let minEnemyVal = Infinity, hasAlly = false;
      for(let i=0;i<attackers.length;i++){
        const a = attackers[i], ao = a.owner;
        if(ao !== o){
          if(ao===0?e0:ao===1?e1:e2) continue; // 脱落者の駒は動かない
          const av = _VAL_PLAIN[b[a.fr][a.fc].p];
          if(av < minEnemyVal) minEnemyVal = av;
        } else hasAlly = true;
      }
      let d = 0;
      if(minEnemyVal !== Infinity){
        const myVal = _VAL_PLAIN[cell.p];
        // 守り駒がいれば guardRatio で減衰
        const guardRatio = hasAlly ? Math.max(0.1, 1 - minEnemyVal / (myVal + minEnemyVal)) : 1.0;
        d = myVal * AI_DANGER_SCALE * guardRatio;
      }
      if(o===0){ ps0+=v; mb0+=reachLen; dg0+=d; }
      else if(o===1){ ps1+=v; mb1+=reachLen; dg1+=d; }
      else { ps2+=v; mb2+=reachLen; dg2+=d; }
    }
  }
  const pieceScore = [ps0, ps1, ps2], mobility = [mb0, mb1, mb2], danger = [dg0, dg1, dg2], kingPos = [k0, k1, k2];
  for(let o=0;o<3;o++){
    const ho = h[o];
    for(let i=0;i<ho.length;i++) pieceScore[o] += _VAL_PLAIN[ho[i]] * AI_HAND_BONUS_RATE;
  }

  const raw = [0, 0, 0];
  for(let o=0;o<3;o++){
    if(elim[o]) continue;
    let entry = 0, safety = 0;
    if(kingPos[o] >= 0){
      const kr = (kingPos[o]/9)|0, kc = kingPos[o]%9;
      const dist = o===0 ? kr : o===1 ? 8-kr : kc;
      if(dist < 4) entry = ((1 << (4-dist)) - 1) * AI_ENTRY_MULT;
      // kingSafety：王周囲8マスの安全率（自利き数 / (敵利き数+1)）の加重合計
      const fdr = o===0 ? -1 : o===1 ? 1 : 0;
      const fdc = o===2 ? -1 : 0;
      for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
        if(!dr && !dc) continue;
        const nr=kr+dr, nc=kc+dc;
        if(nr<0||nr>=9||nc<0||nc>=9) continue;
        const isFront = (dr===fdr && (fdr!==0||dc===fdc));
        const w = isFront ? 1.3 : 1.0;
        let allyCount = 0, enemyCount = 0;
        const arr = squareAttackers[nr*9+nc];
        for(let i=0;i<arr.length;i++){
          const ao = arr[i].owner;
          if(ao === o) allyCount++;
          else if(!elim[ao]) enemyCount++;
        }
        safety += (allyCount / (enemyCount + 1)) * w;
      }
    }
    raw[o] = pieceScore[o]
           + mobility[o] * AI_MOBILITY_SCALE
           + entry
           - danger[o]
           + safety * AI_KING_SAFETY_MULT;
  }
  return {raw, alive};
}

// raw・alive・vpを受け取り、戦力比正規化＋enemyWeightを適用したスコアを返す
function calcWeightedScore(raw, alive, vp){
  if(alive.length === 2){
    const enemy = alive[0] === vp ? alive[1] : alive[0];
    return raw[vp] - raw[enemy];
  }
  if(alive.length < 2) return raw[vp];
  const e0 = vp===0 ? 1 : 0, e1 = vp===2 ? 1 : 2;
  const rv = raw[vp], ra = raw[e0], rb = raw[e1];
  // 順位（同点は元の安定ソート順＝プレイヤー番号順）
  let top = 0;
  if(raw[1] > raw[top]) top = 1;
  if(raw[2] > raw[top]) top = 2;
  let w0, w1;
  if(top === vp){
    // 自分が1位：弱い敵ほど重み大（止め刺し優先）
    w0 = 1.0 + Math.max(0, rv - ra) / (rv + 1) * AI_FINISH_MULT;
    w1 = 1.0 + Math.max(0, rv - rb) / (rv + 1) * AI_FINISH_MULT;
  } else {
    // 自分が2位・3位：1位への連合係数
    const dominance = raw[top] - (raw[0] + raw[1] + raw[2] - raw[top]);
    const coalition = Math.min(1, Math.max(0, dominance / AI_COALITION_THRESHOLD));
    w0 = e0 === top ? 1.0 + coalition * AI_COALITION_MULT : 1.0;
    w1 = e1 === top ? 1.0 + coalition * AI_COALITION_MULT : 1.0;
  }
  // 三人：戦力比 × enemyWeight を正規化して合計=1.0に（拮抗=0基準）
  const r0 = Math.max(ra, 1), r1 = Math.max(rb, 1);
  const rawW0 = r0 * w0, rawW1 = r1 * w1;
  const wTotal = rawW0 + rawW1;
  return rv - ra * (rawW0/wTotal) - rb * (rawW1/wTotal);
}

// max^n用：生スコアオブジェクトを返す（各ノードが自分視点で再解釈するため）
function evalRawMaxN(b, h, elim){
  leafEvalCount++;
  let nAlive = 0;
  for(let o=0;o<3;o++) if(!elim[o]) nAlive++;
  if(nAlive <= 1){
    const raw = [0,0,0], alive = [];
    for(let o=0;o<3;o++){ if(elim[o]) raw[o] = -PV.OU; else { raw[o] = PV.OU; alive.push(o); } }
    return {raw, alive};
  }
  const res = calcRawScores(b, h, elim);
  for(let o=0;o<3;o++) if(elim[o]) res.raw[o] = -PV.OU;
  return res;
}

// ── 静的評価 ──
// 共闘モード: CPU連合 vs 人間 / 人間脱落後 CPU同士
// 自由対局モード: 各自が全員を敵とする「パラノイド」評価
function evalStatic(b, h, elim, vp){
  leafEvalCount++;
  const alive = [0,1,2].filter(o=>!elim[o]);
  if(alive.length <= 1){
    return alive[0] === vp ? PV['OU'] : -PV['OU'];
  }

  // ── 自由対局モード（三つ巴）──
  if(!cpuCollusion){
    if(elim[vp]) return -PV['OU'];
    const {raw} = calcRawScores(b, h, elim);
    return calcWeightedScore(raw, alive, vp);
  }

  // ── 共闘モード ──
  const pieceScore = pieceScores(b, h, [0,1,2]);
  const humanIsElim = elim[humanPlayer];

  if(humanIsElim){
    const c1=alive[0], c2=alive[1];
    let score = pieceScore[c1] - pieceScore[c2]
              + calcEntryBonus(b,c1) - calcEntryBonus(b,c2);
    return vp === c1 ? score : -score;
  } else {
    const hu = humanPlayer;
    const liveCpus = alive.filter(o=>o!==hu);
    let score = pieceScore.reduce((acc, cur, i) => acc + (i === hu ? -cur : cur), 0);
    liveCpus.forEach(cpu => score += calcEntryBonus(b, cpu));
    return score;
  }
}

// ── 内部ノード用の手の並べ替え＋スライス ──
// 駒取り（MVV-LVA）→キラー・成り・逃げる手の順。スライス後も駒取りと入玉手は必ず残す
function orderAndSliceMoves(bd, moves, turnPlayer, depth, sliceRate){
  const n = moves.length;
  const isCap = new Array(n), isEntry = new Array(n);
  for(let i=0;i<n;i++){
    const mv = moves[i];
    isCap[i] = !mv.drop && !!bd[mv.tr][mv.tc];
    isEntry[i] = !mv.drop && bd[mv.fr][mv.fc].p === 'OU' &&
      ((turnPlayer===0&&mv.tr===0)||(turnPlayer===1&&mv.tr===8)||(turnPlayer===2&&mv.tc===0));
  }
  // 末端直前の全探索：ソートせず駒取りだけ先頭に寄せる
  if(depth === 1 && sliceRate === 0){
    const caps = [], rest = [];
    for(let i=0;i<n;i++) (isCap[i] ? caps : rest).push(moves[i]);
    caps.sort((a,b)=>(PV[bd[b.tr][b.tc].p]||0)-(PV[bd[a.tr][a.tc].p]||0));
    return caps.concat(rest);
  }
  const scored = new Array(n);
  for(let i=0;i<n;i++){
    const mv = moves[i];
    const piece = mv.drop ? mv.piece : bd[mv.fr][mv.fc].p;
    const myVal = PV[piece] || 0;
    let s;
    if(isCap[i]){
      // 駒取り：MVV-LVA（高価値駒を安価駒で取るほど優先）
      s = 10000 + (PV[bd[mv.tr][mv.tc].p] || 0) - myVal * 0.1 + (mv.pro ? (PVP[piece]||0) : 0);
    } else {
      s = isKiller(depth, mv) ? 800 : 0;                 // キラームーブ
      if(mv.pro) s += PVP[piece] || 0;                  // 成り
      if(mv.drop) s -= myVal * AI_QMS_HAND_COST;        // 打ち手コスト
      else {
        for(const a of squareAttackers[mv.fr*9+mv.fc]) if(a.owner !== turnPlayer){ s += myVal * AI_DANGER_SCALE; break; } // 逃げる
      }
      for(const a of squareAttackers[mv.tr*9+mv.tc]) if(a.owner !== turnPlayer){ s -= myVal * AI_DANGER_SCALE; break; } // 危険マス
    }
    scored[i] = {mv, s, i};
  }
  scored.sort((a,b)=>b.s-a.s);
  const keep = sliceRate > 0 ? Math.max(1, Math.ceil(n * (1 - sliceRate))) : n;
  slicedMoveCount += n - keep;
  const res = [];
  for(let k=0;k<n;k++){
    const {mv, i} = scored[k];
    if(k < keep || isCap[i] || isEntry[i]) res.push(mv);
  }
  return res;
}

// ── 置換表（前の反復の最善手で並べ替え＋αβ境界値で打ち切り）──
// 三人だと同一局面の再出現は少ないが、反復深化の前回結果を次の反復の並べ替えに使うのが主目的
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
const TT_SIZE = 1 << 20, TT_MASK = TT_SIZE - 1;
const ttKeyHi = new Int32Array(TT_SIZE), ttKeyLo = new Int32Array(TT_SIZE);
const ttVal = new Float64Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE), ttGen = new Int32Array(TT_SIZE);
let ttCurGen = 0;          // aiMoveごとに進める（評価はrootAI視点なので探索をまたいで使わない）
let searchAborted = false; // 時間切れで打ち切った探索の値は置換表に入れない

// 指し手を整数に符号化（0は「なし」）
function mvCode(mv){
  return mv.drop ? (1 << 20) | (Z_PIECE_IDX[mv.piece] << 8) | (mv.tr*9+mv.tc)
                 : ((mv.fr*9+mv.fc) << 8) | (mv.tr*9+mv.tc) | (mv.pro ? 1 << 16 : 0);
}

// ── ヒストリー（βカットを起こした静かな手の統計）──
const histTable = new Int32Array(3 * 88 * 81);
function histIdx(o, mv){
  return (o*88 + (mv.drop ? 81 + Z_PIECE_IDX[mv.piece] : mv.fr*9+mv.fc))*81 + mv.tr*9+mv.tc;
}

// ── テンポ補正：末端で誰の手番かに応じた点数（rootAI視点）──
function tempoBonus(tp, rootAI, elim){
  if(cpuCollusion || tp < 0 || rootAI < 0) return 0;
  if(tp === rootAI) return AI_TEMPO_SELF;
  const nAlive = (elim[0]?0:1) + (elim[1]?0:1) + (elim[2]?0:1);
  if(nAlive <= 2) return -AI_TEMPO_SELF;
  return tp === nextAliveOn(elim, rootAI) ? -AI_TEMPO_NEXT : -AI_TEMPO_PREV;
}

// 手番側の玉に敵の利きがあるか（利きマップ使用）
function kingAttackedOn(bd, o, elim){
  const [kr, kc] = findKingOn(bd, o);
  if(kr < 0) return false;
  for(const a of squareAttackers[kr*9+kc]) if(a.owner !== o && !elim[a.owner]) return true;
  return false;
}

// ── スカラー探索用の並べ替え ──
// 置換表の手 → 駒取り(MVV-LVA) → 入玉 → 成り → キラー → ヒストリー＋局面ヒューリスティック
// 戻り値: [{mv, code, quiet}]  quiet=駒取り・成り・入玉以外（futility/LMRの対象）
function orderMovesScalar(bd, moves, turnPlayer, depth, sliceRate, ttBest){
  const n = moves.length;
  const scored = new Array(n);
  for(let i=0;i<n;i++){
    const mv = moves[i];
    const code = mvCode(mv);
    const piece = mv.drop ? mv.piece : bd[mv.fr][mv.fc].p;
    const target = mv.drop ? null : bd[mv.tr][mv.tc];
    const entry = !mv.drop && piece === 'OU' &&
      ((turnPlayer===0&&mv.tr===0)||(turnPlayer===1&&mv.tr===8)||(turnPlayer===2&&mv.tc===0));
    const myVal = PV[piece] || 0;
    let s, quiet = false;
    if(code === ttBest) s = 1e10;
    else if(target) s = 1e9 + (PV[target.p]||0) * 16 - myVal / 10 + (mv.pro ? (PVP[piece]||0) : 0);
    else if(entry) s = 5e8;
    else if(mv.pro) s = 1e8 + (PVP[piece]||0);
    else {
      quiet = true;
      s = isKiller(depth, mv) ? 9e6 : Math.min(histTable[histIdx(turnPlayer, mv)], 8e6);
      if(mv.drop) s -= myVal * AI_QMS_HAND_COST;
      else {
        for(const a of squareAttackers[mv.fr*9+mv.fc]) if(a.owner !== turnPlayer){ s += myVal * AI_DANGER_SCALE; break; } // 逃げる
      }
      for(const a of squareAttackers[mv.tr*9+mv.tc]) if(a.owner !== turnPlayer){ s -= myVal * AI_DANGER_SCALE; break; } // 危険マス
    }
    scored[i] = {mv, code, quiet, s};
  }
  scored.sort((a,b)=>b.s-a.s);
  if(AI_USE_SLICE && sliceRate > 0){
    const keep = Math.max(1, Math.ceil(n * (1 - sliceRate)));
    const res = [];
    for(let k=0;k<n;k++) if(k < keep || !scored[k].quiet) res.push(scored[k]);
    slicedMoveCount += n - res.length;
    return res;
  }
  return scored;
}

// ── 静止探索（駒取りのみ延長して水平線効果を抑える） ──
const AI_QS_DEPTH = 4;

// 駒取り手のみ生成（利きマップ使用）。成れるなら成りを選ぶ
function captureMoves(bd, o, elim){
  const res = [];
  for(let sq=0;sq<81;sq++){
    const r=(sq/9)|0, c=sq%9;
    const cell = bd[r][c];
    if(!cell || cell.o !== o) continue;
    for(const {tr,tc} of pieceReach[sq]){
      const target = bd[tr][tc];
      if(!target || target.o === o) continue;
      // 共闘モード：CPU同士は取り合わない（movesOnlyと同じ制約）
      if(cpuCollusion && !humanEliminated && o!==humanPlayer && target.o!==humanPlayer && !elim[target.o]) continue;
      const victimVal = target.p === 'OU' ? PV.OU : (PV[target.p]||0) + (target.pr ? (PVP[target.p]||0) : 0);
      const myVal = (PV[cell.p]||0) + (cell.pr ? (PVP[cell.p]||0) : 0);
      // 損な取り（紐付きの駒を高い駒で取る）は静止探索では読まない
      if(target.p !== 'OU' && myVal > victimVal && !elim[target.o]){
        let defended = false;
        for(const a of squareAttackers[tr*9+tc]) if(a.owner === target.o){ defended = true; break; }
        if(defended) continue;
      }
      const canPro = !cell.pr && (cell.p==='FU'||cell.p==='KY'||cell.p==='KE'||cell.p==='GIN'||cell.p==='KAKU'||cell.p==='HI');
      const pro = canPro && (inPromoZone(o,r,c) || inPromoZone(o,tr,tc));
      res.push({fr:r, fc:c, tr, tc, pro, drop:false,
        _s: victimVal * 16 - myVal / 100});
    }
  }
  res.sort((a,b)=>b._s-a._s);
  return res;
}

// 三つ巴（max^n）用静止探索：各手番は自分視点でスタンドパット or 駒取りを選ぶ
function qsearchMaxN(bd, hd, elim, turnPlayer, qdepth){
  const stand = evalRawMaxN(bd, hd, elim);
  if(qdepth <= 0 || turnPlayer < 0 || stand.alive.length <= 1) return stand;
  let best = stand, bestScore = calcWeightedScore(stand.raw, stand.alive, turnPlayer);
  const caps = captureMoves(bd, turnPlayer, elim);
  for(const mv of caps){
    const undo = applyMoveInPlace(bd, hd, elim, mv, turnPlayer);
    let child;
    if(undo.tryWin) child = undo.entryWin ? entryWinMaxN(turnPlayer, elim) : evalRawMaxN(bd, hd, elim);
    else child = qsearchMaxN(bd, hd, elim, nextAliveOn(elim, turnPlayer), qdepth-1);
    undoMoveInPlace(bd, hd, elim, mv, turnPlayer, undo);
    const s = calcWeightedScore(child.raw, child.alive, turnPlayer);
    if(s > bestScore){ bestScore = s; best = child; }
    if(undo.tryWin) break; // 玉取りが最善
  }
  return best;
}

// ── 三つ巴の探索方式 ──
// 'maxn'    : 各手番が自分の評価を最大化（枝刈りがほぼ効かず浅い）
// 'paranoid': 自分以外の2人が結託して自分の評価を最小化すると仮定（αβが効く）
// 'brs'     : Best Reply Search。相手2人の手をまとめて、自分に最も痛い1手だけを考える
let AI_THREEWAY_SEARCH = 'paranoid';

// スカラー探索（共闘・パラノイド・BRS）を使うか
function useScalarSearch(){ return cpuCollusion || AI_THREEWAY_SEARCH !== 'maxn'; }

// スカラー探索で turnPlayer が最小化側か
function isMinNode(turnPlayer, rootAI, elim){
  if(!cpuCollusion) return turnPlayer !== rootAI;
  if(humanEliminated){
    const liveCpus = [0,1,2].filter(o=>!elim[o]);
    return liveCpus.length >= 2 && turnPlayer === liveCpus[1];
  }
  return turnPlayer === humanPlayer;
}

// 入玉勝ちの終局値（入玉は即勝利なので盤面評価ではなく勝敗で返す）
function entryWinScalar(winner, rootAI){
  if(cpuCollusion && !humanEliminated) return winner !== humanPlayer ? PV.OU : -PV.OU;
  return winner === rootAI ? PV.OU : -PV.OU;
}
function entryWinMaxN(winner, elim){
  const raw = [-PV.OU, -PV.OU, -PV.OU], alive = [];
  for(let o=0;o<3;o++) if(!elim[o]) alive.push(o);
  raw[winner] = PV.OU;
  return {raw, alive};
}

// スカラー探索用静止探索：rootAI視点の値でαβ
function qsearchParanoid(bd, hd, elim, turnPlayer, alpha, beta, rootAI, qdepth){
  const stand = evalStatic(bd, hd, elim, rootAI) + tempoBonus(turnPlayer, rootAI, elim);
  if(qdepth <= 0 || turnPlayer < 0 || elim.filter(e=>!e).length <= 1) return stand;
  const isMin = isMinNode(turnPlayer, rootAI, elim);
  let best = stand;
  if(isMin){ if(best <= alpha) return best; beta = Math.min(beta, best); }
  else     { if(best >= beta)  return best; alpha = Math.max(alpha, best); }
  const caps = captureMoves(bd, turnPlayer, elim);
  for(const mv of caps){
    const undo = applyMoveInPlace(bd, hd, elim, mv, turnPlayer);
    const s = undo.tryWin
      ? (undo.entryWin ? entryWinScalar(turnPlayer, rootAI) : evalStatic(bd, hd, elim, rootAI) + tempoBonus(nextAliveOn(elim, turnPlayer), rootAI, elim))
      : qsearchParanoid(bd, hd, elim, nextAliveOn(elim, turnPlayer), alpha, beta, rootAI, qdepth-1);
    undoMoveInPlace(bd, hd, elim, mv, turnPlayer, undo);
    if(isMin){ if(s < best) best = s; beta = Math.min(beta, s); }
    else     { if(s > best) best = s; alpha = Math.max(alpha, s); }
    if(beta <= alpha) break;
  }
  return best;
}

// ── スカラーαβ探索（パラノイド／共闘）──
// 値はrootAI視点。isMin=相手側（値を下げたい）ノード。fail-soft。
function searchScalar(bd, hd, elim, depth, alpha, beta, turnPlayer, rootAI, pvArr, maxDepth, t0, timeLimit, sliceRate, isMin){
  const alpha0 = alpha, beta0 = beta;

  // 置換表を引く
  let ttIdx = -1, kHi = 0, kLo = 0, ttBest = 0;
  if(AI_USE_TT){
    const zi = turnPlayer*8 + (elim[0]?1:0) + (elim[1]?2:0) + (elim[2]?4:0);
    kHi = zHi ^ ZT_HI[zi]; kLo = zLo ^ ZT_LO[zi];
    ttIdx = kLo & TT_MASK;
    if(ttGen[ttIdx] === ttCurGen && ttKeyHi[ttIdx] === kHi && ttKeyLo[ttIdx] === kLo){
      ttBest = ttMove[ttIdx];
      if(ttDepth[ttIdx] >= depth){
        const v = ttVal[ttIdx], f = ttFlag[ttIdx];
        if(f === TT_EXACT || (f === TT_LOWER && v >= beta) || (f === TT_UPPER && v <= alpha)) return v;
      }
    }
  }

  // futility：末端付近で静的評価が窓から大きく外れていれば、静かな手は読まない
  let futile = false, futileVal = 0;
  if(AI_USE_FUTILITY && depth <= 2 && !cpuCollusion){
    const margin = depth === 1 ? AI_FUTILITY_MARGIN1 : AI_FUTILITY_MARGIN2;
    const stand = evalStatic(bd, hd, elim, rootAI) + tempoBonus(turnPlayer, rootAI, elim);
    if(isMin ? stand - margin >= beta : stand + margin <= alpha){
      if(!kingAttackedOn(bd, turnPlayer, elim)){ futile = true; futileVal = isMin ? stand - margin : stand + margin; }
    }
  }

  const raw = movesOnly(bd, hd, turnPlayer, elim);
  depthMoveGen[depth] = (depthMoveGen[depth]||0) + raw.length;
  depthNodeCount[depth] = (depthNodeCount[depth]||0) + 1;
  const entries = orderMovesScalar(bd, raw, turnPlayer, depth, sliceRate, ttBest);

  const wantPV = pvArr && maxDepth - depth < 2; // 読み筋表示は上の方だけ
  let best = isMin ? Infinity : -Infinity, bestCode = 0, searched = 0;
  for(let i=0;i<entries.length;i++){
    const e = entries[i], mv = e.mv;
    if(futile && e.quiet && e.code !== ttBest){
      if(isMin ? futileVal < best : futileVal > best) best = futileVal;
      continue;
    }
    const pvPiece = wantPV ? (mv.drop ? mv.piece : bd[mv.fr][mv.fc].p) : null;
    const pvPr = wantPV ? (!mv.drop && !!bd[mv.fr][mv.fc].pr) : false;

    const undo = applyMoveInPlace(bd, hd, elim, mv, turnPlayer);
    let score;
    const childPV = wantPV ? [] : null;
    if(undo.tryWin){
      // 玉取り or 入玉：終局扱い（玉取りは脱落後の局面を正規評価）
      score = undo.entryWin ? entryWinScalar(turnPlayer, rootAI)
                            : evalStatic(bd, hd, elim, rootAI) + tempoBonus(nextAliveOn(elim, turnPlayer), rootAI, elim);
    } else {
      const nxt = nextAliveOn(elim, turnPlayer);
      // LMR：後ろの方の静かな手は1手浅く読み、窓を更新しそうなら読み直す
      const reduce = (AI_USE_LMR && depth >= AI_LMR_MIN_DEPTH && e.quiet && searched >= AI_LMR_MIN_MOVES &&
                      e.code !== ttBest && !isKiller(depth, mv)) ? 1 : 0;
      score = minimaxRound(bd, hd, elim, depth-1-reduce, alpha, beta, nxt, rootAI, childPV, maxDepth, t0, timeLimit, -1, -Infinity, sliceRate);
      if(reduce && (isMin ? score < beta : score > alpha)){
        if(childPV) childPV.length = 0;
        score = minimaxRound(bd, hd, elim, depth-1, alpha, beta, nxt, rootAI, childPV, maxDepth, t0, timeLimit, -1, -Infinity, sliceRate);
      }
    }
    undoMoveInPlace(bd, hd, elim, mv, turnPlayer, undo);
    searched++;
    depthMoveExplore[depth] = (depthMoveExplore[depth]||0) + 1;

    if(isMin ? score < best : score > best){
      best = score; bestCode = e.code;
      if(wantPV){ pvArr.length=0; pvArr.push({...mv,pvPiece,pvPr,pvOwner:turnPlayer},...(childPV||[])); }
    }
    if(isMin) beta = Math.min(beta, score); else alpha = Math.max(alpha, score);
    if(beta <= alpha){
      pruneCount++;
      if(e.quiet){ registerKiller(depth, mv); histTable[histIdx(turnPlayer, mv)] += depth*depth; }
      break;
    }
    if(t0 && performance.now() - t0 >= timeLimit){ searchAborted = true; break; }
  }
  // 合法手なし
  if(best === Infinity || best === -Infinity) best = evalStatic(bd, hd, elim, rootAI) + tempoBonus(turnPlayer, rootAI, elim);

  if(ttIdx >= 0 && !searchAborted && (ttGen[ttIdx] !== ttCurGen || depth >= ttDepth[ttIdx] || (ttKeyHi[ttIdx] === kHi && ttKeyLo[ttIdx] === kLo))){
    ttGen[ttIdx] = ttCurGen; ttKeyHi[ttIdx] = kHi; ttKeyLo[ttIdx] = kLo;
    ttVal[ttIdx] = best; ttDepth[ttIdx] = depth; ttMove[ttIdx] = bestCode;
    ttFlag[ttIdx] = best <= alpha0 ? TT_UPPER : best >= beta0 ? TT_LOWER : TT_EXACT;
  }
  return best;
}

// ── 探索（三つ巴=max^n/パラノイド/BRS / 共闘=パラノイド） ──
function minimaxRound(bd, hd, elim, depth, alpha, beta, turnPlayer, rootAI=-1, pvArr=null, maxDepth=depth, t0=0, timeLimit=Infinity, callerPlayer=-1, callerAlpha=-Infinity, sliceRate=0){
  const scalar = useScalarSearch();

  if(turnPlayer === -1 || elim.filter(e=>!e).length <= 1){
    if(scalar) return evalStatic(bd, hd, elim, rootAI);
    return evalRawMaxN(bd, hd, elim);
  }
  if(scalar && !cpuCollusion && elim[rootAI]) return -PV.OU; // 自分が脱落
  if(depth <= 0){
    if(scalar) return qsearchParanoid(bd, hd, elim, turnPlayer, alpha, beta, rootAI, AI_QS_DEPTH);
    return qsearchMaxN(bd, hd, elim, turnPlayer, AI_QS_DEPTH);
  }

  // ── スカラー（αβ）──
  if(scalar){
    const isMin = isMinNode(turnPlayer, rootAI, elim);
    // BRS：最小化ノードでは生存している相手全員の手をまとめて生成
    const brs = !cpuCollusion && AI_THREEWAY_SEARCH === 'brs' && isMin;
    if(!brs) return searchScalar(bd, hd, elim, depth, alpha, beta, turnPlayer, rootAI, pvArr, maxDepth, t0, timeLimit, sliceRate, isMin);
    let moves;
    if(brs){
      const lists = [];
      for(let p=0;p<3;p++){
        if(p === rootAI || elim[p]) continue;
        const pm = orderAndSliceMoves(bd, movesOnly(bd, hd, p, elim), p, depth, sliceRate);
        for(const m of pm) m.mover = p;
        lists.push(pm);
      }
      // 2人の手を交互に並べる（どちらの好手も早めに読む）
      moves = [];
      const maxLen = Math.max(0, ...lists.map(l=>l.length));
      for(let i=0;i<maxLen;i++) for(const l of lists) if(i < l.length) moves.push(l[i]);
      depthMoveGen[depth] = (depthMoveGen[depth]||0) + moves.length;
      depthNodeCount[depth] = (depthNodeCount[depth]||0) + 1;
    } else {
      moves = movesOnly(bd, hd, turnPlayer, elim);
      depthMoveGen[depth] = (depthMoveGen[depth]||0) + moves.length;
      depthNodeCount[depth] = (depthNodeCount[depth]||0) + 1;
      moves = orderAndSliceMoves(bd, moves, turnPlayer, depth, sliceRate);
    }
    depthMoveExplore[depth] = (depthMoveExplore[depth]||0) + moves.length;

    let best = isMin ? Infinity : -Infinity;
    for(const mv of moves){
      const mover = brs ? mv.mover : turnPlayer;
      const pvPiece = mv.drop ? mv.piece : (bd[mv.fr]?.[mv.fc]?.p || '?');
      const pvPr = mv.drop ? false : !!(bd[mv.fr]?.[mv.fc]?.pr);

      const undo = applyMoveInPlace(bd, hd, elim, mv, mover);
      let score;
      const childPV = pvArr ? [] : null;
      if(undo.tryWin){
        // 玉取り or 入玉：終局扱い（玉取りは脱落後の局面を正規評価）
        score = undo.entryWin ? entryWinScalar(mover, rootAI) : evalStatic(bd, hd, elim, rootAI);
      } else {
        // BRS：相手の手の次は必ず自分の手番
        const nxt = (brs && !elim[rootAI]) ? rootAI : nextAliveOn(elim, mover);
        score = minimaxRound(bd, hd, elim, depth-1, alpha, beta, nxt, rootAI, childPV, maxDepth, t0, timeLimit, -1, -Infinity, sliceRate);
      }
      undoMoveInPlace(bd, hd, elim, mv, mover, undo);
      if(isMin ? score < best : score > best){
        best = score;
        if(pvArr){ pvArr.length=0; pvArr.push({...mv,pvPiece,pvPr,pvOwner:mover},...(childPV||[])); }
      }
      if(isMin) beta = Math.min(beta, score); else alpha = Math.max(alpha, score);
      if(beta <= alpha){ pruneCount++; if(!mv.drop && !undo.toCell) registerKiller(depth, mv); break; }
      if(t0 && performance.now() - t0 >= timeLimit) break;
    }
    if(best === Infinity || best === -Infinity) return evalStatic(bd, hd, elim, rootAI); // 合法手なし
    return best;
  }

  // ── 三つ巴：max^n（生スコアを返し、各ノードが自分視点で解釈）──
  {
    let moves = movesOnly(bd, hd, turnPlayer, elim);
    depthMoveGen[depth] = (depthMoveGen[depth]||0) + moves.length;
    depthNodeCount[depth] = (depthNodeCount[depth]||0) + 1;
    moves = orderAndSliceMoves(bd, moves, turnPlayer, depth, sliceRate);
    depthMoveExplore[depth] = (depthMoveExplore[depth]||0) + moves.length;

    let bestRaw = null, bestScoreForMe = -Infinity;
    for(const mv of moves){
      const pvPiece = mv.drop ? mv.piece : (bd[mv.fr]?.[mv.fc]?.p || '?');
      const pvPr = mv.drop ? false : !!(bd[mv.fr]?.[mv.fc]?.pr);

      const undo = applyMoveInPlace(bd, hd, elim, mv, turnPlayer);

      if(undo.tryWin){
        // 玉取り or 入玉：自分にとって最善なので即採用
        const res = undo.entryWin ? entryWinMaxN(turnPlayer, elim) : evalRawMaxN(bd, hd, elim);
        undoMoveInPlace(bd, hd, elim, mv, turnPlayer, undo);
        if(pvArr){ pvArr.length=0; pvArr.push({...mv,pvPiece,pvPr,pvOwner:turnPlayer}); }
        return res;
      }
      const nxt = nextAliveOn(elim, turnPlayer);
      const childPV = pvArr ? [] : null;
      // 子ノードへ：自分（turnPlayer）を呼び出し元として渡し、自分のbestScoreForMeを下限として渡す
      const {raw: childRaw, alive: childAlive} = minimaxRound(
        bd, hd, elim, depth-1, alpha, beta, nxt, rootAI, childPV, maxDepth, t0, timeLimit,
        turnPlayer, bestScoreForMe, sliceRate
      );
      undoMoveInPlace(bd, hd, elim, mv, turnPlayer, undo);

      // 自分視点で解釈して最善手を更新
      const scoreForMe = calcWeightedScore(childRaw, childAlive, turnPlayer);
      if(scoreForMe > bestScoreForMe){
        bestScoreForMe = scoreForMe;
        bestRaw = {raw: childRaw, alive: childAlive};
        if(pvArr){ pvArr.length=0; pvArr.push({...mv,pvPiece,pvPr,pvOwner:turnPlayer},...(childPV||[])); }
      }

      // α-β枝刈り：親視点で「このノードはどうせ選ばれない」なら打ち切り
      // callerPlayerの視点でのbestがcallerAlpha以下 → 親はすでに別の手で better を持っている
      if(callerPlayer >= 0 && bestRaw){
        const scoreForCaller = calcWeightedScore(bestRaw.raw, bestRaw.alive, callerPlayer);
        pruneCount++; if(scoreForCaller <= callerAlpha){ if(!mv.drop && !undo.toCell) registerKiller(depth, mv); break; }
      }

      if(t0 && performance.now() - t0 >= timeLimit) break;
    }
    return bestRaw ?? evalRawMaxN(bd, hd, elim);
  }
}

// 動いた後に王がすぐ取られるかチェック（自爆防止）

// 指定マスが敵の利きにあるかチェック
function squareAttackedBy(bd, r, c, o, elim){
  for(let er=0;er<9;er++) for(let ec=0;ec<9;ec++){
    const cell=bd[er][ec];
    if(!cell||cell.o===o||elim[cell.o]) continue;
    if(rawMoves(bd,er,ec).some(([mr,mc])=>mr===r&&mc===c)) return true;
  }
  return false;
}

function kingWouldBeCaptured(bd, o, elim){
  const [kr,kc]=findKingOn(bd,o);
  if(kr<0) return false;
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell=bd[r][c];
    if(!cell||cell.o===o||elim[cell.o]) continue;
    if(rawMoves(bd,r,c).some(([mr,mc])=>mr===kr&&mc===kc)) return true;
  }
  return false;
}

// 直近の探索情報（ベンチマーク・デバッグ用）：各深さの最善値
let lastSearchInfo = { depthBest: [], reachedDepth: 0 };

function aiMoveLegacy(o,bd,hd,elim){
  leafEvalCount   = 0;
  moveGenCount    = 0;
  pruneCount      = 0;
  slicedMoveCount = 0;
  depthMoveGen     = {};
  depthMoveExplore = {};
  depthNodeCount   = {};
  orderingHits     = 0;
  orderingTotal    = 0;
  orderingRankSum  = 0;
  const t0 = performance.now();
  inAISearch = true;
  resetKillers();
  histTable.fill(0);
  ttCurGen++;
  searchAborted = false;
  lastSearchInfo = { depthBest: [], reachedDepth: 0 };
  buildAttackMaps(bd); // 双方向利き筋マップ初期構築
  zobristInit(bd, hd);
  let {moves, attackedBy: rootAttackedBy}=allMovesOn(bd,hd,o,elim);

  if(!moves.length) return null;

  moves.sort((a,b) => quickMoveScore(bd,b,o,rootAttackedBy) - quickMoveScore(bd,a,o,rootAttackedBy));

  const inCheck = kingWouldBeCaptured(bd, o, elim);

  // 王手回避手：王手時のみ計算（コスト削減）
  const evasions = inCheck ? moves.filter(mv => {
    const undo = applyMoveInPlace(bd, hd, elim, mv, o);
    const safe = !elim[o] && !kingWouldBeCaptured(bd, o, elim);
    undoMoveInPlace(bd, hd, elim, mv, o, undo);
    return safe;
  }) : [];

  // 入玉手（1段目到達）も必ずcandidatesに含める
  const entryMoves = moves.filter(mv =>
    !mv.drop && bd[mv.fr]?.[mv.fc]?.p === 'OU' &&
    ((o===0 && mv.tr===0) || (o===1 && mv.tr===8) || (o===2 && mv.tc===0))
  );

  const baseCands = inCheck
    ? (evasions.length ? evasions : moves)
    : moves; // rootは全候補

  // 入玉手をcandidatesに追加（重複除去）
  const candSet = new Set(baseCands.map(m => `${m.fr},${m.fc},${m.tr},${m.tc},${m.pro?1:0},${m.drop?m.piece:''}`));
  const candidates = baseCands.concat(
    entryMoves.filter(m => !candSet.has(`${m.fr},${m.fc},${m.tr},${m.tc},${m.pro?1:0},${m.drop?m.piece:''}`))
  );

  let best=null, bestScore=-Infinity, bestPV=[];
  const allResults = [];

  // ── 反復深化（時間制限ベース） ──
  const useTimeLimit = true;
  const timeLimit = AI_TIME_LIMIT_MS - 200; // 200msバッファ
  const depthLimit = AI_MAX_DEPTH;

  let orderedCands = candidates.slice();
  let lastCompleteResults = null;
  let reachedDepth = 0;
  const depthTimes = []; // 各depth完了時の経過ms

  for(let d = 1; d <= depthLimit; d++){
    // 時間切れチェック（depth=1は必ず完了させる）
    if(useTimeLimit && d > 1 && performance.now() - t0 >= timeLimit) break;

    const iterResults = [];
    let timedOut = false;
    let iterBest = -Infinity;

    for(let mvIdx=0; mvIdx < orderedCands.length; mvIdx++){
      const mv = orderedCands[mvIdx];
      // rank別sliceRate: rank1-3=0%, rank4-5=30%, rank6-7=40%, 以降10%ずつ増加、下限10%
      const sliceRate = mvIdx <= 2 ? 0.0 : Math.min(0.9, 0.3 + Math.floor((mvIdx - 3) / 2) * 0.1);
      const pvPiece = mv.drop ? mv.piece : (bd[mv.fr]?.[mv.fc]?.p || '?');
      const pvPr = mv.drop ? false : !!(bd[mv.fr]?.[mv.fc]?.pr);
      const undo = applyMoveInPlace(bd, hd, elim, mv, o);
      if(undo.tryWin){
        if(!undo.entryWin || !squareAttackedBy(bd,mv.tr,mv.tc,o,elim)){
          undoMoveInPlace(bd, hd, elim, mv, o, undo); return mv;
        }
      }
      if(!undo.entryWin && !elim[o] && kingWouldBeCaptured(bd, o, elim)){ undoMoveInPlace(bd, hd, elim, mv, o, undo); continue; }
      const nxt = nextAliveOn(elim, o);
      const childPV = [];
      // 既に見つけた最善値（ノイズ幅だけ余裕を持たせる）を下限として渡し、明らかに劣る手は早めに打ち切る
      const rootAlpha = iterBest === -Infinity ? -Infinity : iterBest - AI_NOISE - 1;
      const result = useScalarSearch()
        ? minimaxRound(bd, hd, elim, d, rootAlpha, Infinity, nxt, o, childPV, d, t0, useTimeLimit ? timeLimit : Infinity, -1, -Infinity, sliceRate)
        : minimaxRound(bd, hd, elim, d, -Infinity, Infinity, nxt, o, childPV, d, t0, useTimeLimit ? timeLimit : Infinity, o, rootAlpha, sliceRate);
      // cpuCollusion=スカラー、maxN={raw,alive}オブジェクト
      const rawV = (result && typeof result === 'object' && result.raw)
        ? calcWeightedScore(result.raw, result.alive, o)
        : result;
      undoMoveInPlace(bd, hd, elim, mv, o, undo);
      // 探索途中で時間切れになった手の値は不正確なので採用しない
      if(useTimeLimit && d > 1 && performance.now() - t0 >= timeLimit){ timedOut = true; break; }
      if(rawV > iterBest) iterBest = rawV;
      iterResults.push({mv, rawV, pvPiece, pvPr,
        pv: [{...mv, pvPiece, pvPr, pvOwner:o}, ...childPV]});

      // 手ごとに時間チェック（次の手に入る前に時間切れなら中断）
      if(useTimeLimit && performance.now() - t0 >= timeLimit){
        timedOut = true; break;
      }
    }

    // このdepthが時間切れで中断された場合は結果を使わない（depth=1だけは部分結果でも使う）
    if(timedOut && d > 1) break;

    // 詰みなど合法手がない場合
    if(iterResults.length === 0) break;

    // 完了した深さの結果でムーブオーダリング更新
    iterResults.sort((a,b) => b.rawV - a.rawV);
    // オーダリング成功率：最善手が何位だったか記録
    const bestMvKey = m => `${m.fr},${m.fc},${m.tr},${m.tc},${m.pro?1:0},${m.drop?m.piece:''}`;
    const bestKey = bestMvKey(iterResults[0].mv);
    const prevRank = orderedCands.findIndex(m => bestMvKey(m) === bestKey);
    if(prevRank >= 0){
      orderingTotal++;
      orderingRankSum += prevRank + 1;
      if(prevRank === 0) orderingHits++;
    }
    // 深さ別展開手数（rootは全候補）
    orderedCands = iterResults.map(r => r.mv);
    lastCompleteResults = iterResults;
    reachedDepth = d;
    lastSearchInfo.depthBest.push(iterResults[0].rawV);
    lastSearchInfo.reachedDepth = d;
    depthTimes.push(`d${d}:${(performance.now()-t0).toFixed(0)}ms`);
  }

  // 最後に完了した深さの結果からbest・allResultsを確定
  if(lastCompleteResults){
    for(const r of lastCompleteResults){
      const v = r.rawV + (Math.random()-0.5)*AI_NOISE;
      if(v > bestScore){ bestScore=v; best=r.mv; bestPV=r.pv; }
      allResults.push({score: r.rawV, pv: r.pv});
    }
  }

  reportSearch(o, t0, reachedDepth, depthTimes, allResults);
  inAISearch = false;
  return best ?? candidates[0] ?? null;
}


// 思考結果の表示（perf-info・読み筋パネル・console）。旧エンジン・新エンジン共用
function reportSearch(o, t0, reachedDepth, depthTimes, allResults){
  const elapsed = (performance.now() - t0).toFixed(0);
  const perfEl  = document.getElementById('perf-info');
  const thinkEl = document.getElementById('think-panel');

  // 深さ別平均分岐数
  const branchInfo = Object.keys(depthNodeCount).sort((a,b)=>a-b).map(d => {
    const avg = depthMoveGen[d] ? (depthMoveGen[d] / depthNodeCount[d]).toFixed(1) : '-';
    const exp = depthMoveExplore[d] ? (depthMoveExplore[d] / depthNodeCount[d]).toFixed(1) : '-';
    return `d${d}:生${avg}/展${exp}`;
  }).join(', ');
  const orderingAvg = orderingTotal > 0 ? (orderingRankSum / orderingTotal).toFixed(1) : '-';
  const orderingHitRate = orderingTotal > 0 ? Math.round(orderingHits / orderingTotal * 100) : '-';

  const perfStr = `${['青','赤','緑'][o]}将 ${elapsed}ms 深さ:${reachedDepth} / 末端eval:${leafEvalCount} / 手生成:${moveGenCount} / 枝刈:${pruneCount} / slice除外:${slicedMoveCount}`;
  const orderStr = `  オーダリング: 平均順位${orderingAvg}位 1位率${orderingHitRate}%`;
  const branchStr = `  分岐[${branchInfo}]`;
  const timeStr   = `  時間[${depthTimes.join(', ')}]`;

  if(perfEl) perfEl.textContent = perfStr;
  console.log(perfStr + '\n' + orderStr + '\n' + branchStr + '\n' + timeStr);

  if(thinkEl && allResults.length > 0){
    allResults.sort((a,b) => b.score - a.score);
    const BADGE = ['🥇','🥈','🥉','4位','5位','6位','7位','8位','9位','10位'];
    const pvLabel = m => {
      const col = ['青','赤','緑'][m.pvOwner];
      const pc  = m.drop ? (PC[m.pvPiece]||'?') : ((m.pvPr||m.pro)&&PCP[m.pvPiece])?PCP[m.pvPiece]:(PC[m.pvPiece]||'?');
      const dst = toSuji(m.tc)+toDan(m.tr);
      const frm = m.drop ? '打' : `(${toSuji(m.fc)}${toDan(m.fr)})`;
      return `${col}:${dst}${pc}${frm}`;
    };
    const oName = ['青','赤','緑'][o];
    const header = `<div style="color:#445;font-size:10px;margin-bottom:2px">▼ 読み筋ランキング（${oName}将） ${elapsed}ms</div>`;
    const rows = allResults.slice(0,10).map((r,i) => {
      const badge = BADGE[i]||`${i+1}位`;
      const moveStr = pvLabel(r.pv[0]);
      const scoreStr = (r.score>=0?'+':'')+Math.round(r.score);
      const cont = r.pv.slice(1,4).map(pvLabel).join('<span style="color:#333">→</span>');
      const rowColor = i===0?'#ffdd44':i===1?'#88aaff':i===2?'#66bb77':'#555';
      return `<div style="color:${rowColor}">${badge} <b>${moveStr}</b> <span style="color:#667">[${scoreStr}]</span>${cont?' <span style="color:#333">▷</span> <span style="color:#778;font-size:10px">'+cont+'</span>':''}</div>`;
    }).join('');
    const newHtml = header + rows;

    // 現在の内容を「直前の読み筋」として退避してから更新
    const prevEl  = document.getElementById('prev-think-panel');
    const prevBtn = document.getElementById('prev-think-btn');
    if(prevEl && thinkEl.innerHTML){
      prevEl.innerHTML = thinkEl.innerHTML.replace('▼ 読み筋ランキング', '📋 直前の読み筋');
      if(prevBtn){
        prevBtn.style.display = 'inline-block';
        // 直前パネルが開いていたら内容を更新してそのまま表示継続
        if(prevEl.style.display === 'none') prevEl.style.display = 'none';
      }
    }

    thinkEl.innerHTML = newHtml;
    thinkEl.style.display = 'block';
  } else if(thinkEl){
    thinkEl.style.display = 'none';
  }

}