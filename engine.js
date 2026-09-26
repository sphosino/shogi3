// =====================================================================
// 探索エンジン v2（型付き配列版）
// UIの盤面（board[r][c] = {p,o,pr}）はそのまま。CPUが考えるときだけ整数表現に変換して探索する。
//   駒コード : 0=空, 1 + 持ち主*16 + 成り*8 + 駒種(0..7)   （駒種: 歩香桂銀金角飛玉）
//   指し手   : to | from<<7 | 成り<<14                      （from>=81 は打ち。駒種 = from-81）
//   利き     : 評価のたびに全駒から数え直す（E_cnt: 持ち主×マスの利き数, E_min: 利いている駒の最小価値）
// 旧エンジン（ai.js の aiMoveLegacy）と同じ評価・同じ探索になるように移植している。
// max^N / BRS は旧エンジンのみ対応。
// =====================================================================

const E_FU=0, E_KY=1, E_KE=2, E_GIN=3, E_KIN=4, E_KAKU=5, E_HI=6, E_OU=7;
const E_PT_NAMES = ['FU','KY','KE','GIN','KIN','KAKU','HI','OU'];
const E_CAN_PRO  = [1,1,1,1,0,1,1,0];
const E_DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
const E_MAXM  = 1024;  // 1局面あたりの指し手バッファ
const E_MAXPLY = 128;
const E_INF_VAL = 2147483647;

// ── 駒の動きテーブル ──
// E_RAY[dir*81+sq]  : sqからdir方向のマス列
// E_STEP[kind*81+sq]: 1マス動き（桂含む）の行き先    kind = 持ち主*16 + 成り*8 + 駒種
// E_SLIDE[kind]     : 走る方向（E_DIRSの番号）
const E_RAY = new Array(8*81), E_STEP = new Array(48*81), E_SLIDE = new Array(48);
(function(){
  for(let d=0; d<8; d++) for(let sq=0; sq<81; sq++){
    const [dr, dc] = E_DIRS[d], res = [];
    let r = ((sq/9)|0) + dr, c = sq%9 + dc;
    while(r>=0 && r<9 && c>=0 && c<9){ res.push(r*9+c); r+=dr; c+=dc; }
    E_RAY[d*81+sq] = Int8Array.from(res);
  }
  const GOLD = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]];
  const dirIdx = (dr, dc) => E_DIRS.findIndex(([a,b]) => a===dr && b===dc);
  for(let o=0;o<3;o++) for(let pr=0;pr<2;pr++) for(let pt=0;pt<8;pt++){
    const k = o*16 + pr*8 + pt;
    let steps = [], slides = [];
    if(pr && pt <= E_GIN) steps = GOLD;
    else switch(pt){
      case E_FU:   steps = [[-1,0]]; break;
      case E_KY:   slides = [rotDir(-1,0,o)]; break;
      case E_KE:   steps = [[-2,-1],[-2,1]]; break;
      case E_GIN:  steps = [[-1,-1],[-1,0],[-1,1],[1,-1],[1,1]]; break;
      case E_KIN:  steps = GOLD; break;
      case E_KAKU: slides = [[-1,-1],[-1,1],[1,-1],[1,1]]; if(pr) steps = [[1,0],[-1,0],[0,1],[0,-1]]; break;
      case E_HI:   slides = [[1,0],[-1,0],[0,1],[0,-1]]; if(pr) steps = [[-1,-1],[-1,1],[1,-1],[1,1]]; break;
      case E_OU:   for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++) if(dr||dc) steps.push([dr,dc]); break;
    }
    // 1マス動きは持ち主の向きに回転（走り駒の方向は香以外は対称なのでそのまま）
    const rsteps = (pt === E_OU || (pt === E_HI || pt === E_KAKU)) ? steps : steps.map(([dr,dc]) => rotDir(dr,dc,o));
    E_SLIDE[k] = Int8Array.from(slides.map(([dr,dc]) => dirIdx(dr+0, dc+0)));
    for(let sq=0; sq<81; sq++){
      const r = (sq/9)|0, c = sq%9, res = [];
      for(const [dr,dc] of rsteps){ const nr=r+dr, nc=c+dc; if(nr>=0&&nr<9&&nc>=0&&nc<9) res.push(nr*9+nc); }
      E_STEP[k*81+sq] = Int8Array.from(res);
    }
  }
})();

function eInZone(o, sq){ return o===0 ? sq < 27 : o===1 ? sq >= 54 : sq%9 <= 2; }
function eMustPromote(pt, o, sq){
  if(pt === E_FU || pt === E_KY){ return o===0 ? sq < 9 : o===1 ? sq >= 72 : sq%9 === 0; }
  if(pt === E_KE){ return o===0 ? sq < 18 : o===1 ? sq >= 63 : sq%9 <= 1; }
  return false;
}
function eIsEntrySq(o, sq){ return o===0 ? sq < 9 : o===1 ? sq >= 72 : sq%9 === 0; }

// ── 局面 ──
const E_board = new Int8Array(81);
const E_hand  = new Uint8Array(24);  // 持ち主*8 + 駒種
const E_elim  = new Uint8Array(3);
const E_king  = new Int8Array(3);    // 玉のマス（脱落なら-1）
const E_count = new Int16Array(3);   // 盤上＋持ち駒の枚数（消滅ありルール用）
let E_rule = 'all';
let E_zHi = 0, E_zLo = 0;
const E_VP = new Float64Array(8), E_VPRO = new Float64Array(8);  // 駒価値・成りの追加価値

// 指し手の適用と戻し用スタック（ply別）
const U_zHi = new Int32Array(E_MAXPLY), U_zLo = new Int32Array(E_MAXPLY);
const U_cap = new Int8Array(E_MAXPLY), U_recip = new Int8Array(E_MAXPLY);

function eZCell(sq, code){
  const k = code - 1;
  const i = sq*48 + (((k&7)*2) + ((k>>3)&1))*3 + (k>>4);
  E_zHi ^= ZB_HI[i]; E_zLo ^= ZB_LO[i];
}
function eZHand(o, pt, count){
  if(count <= 0 || count >= 20) return;
  const i = (o*8 + pt)*20 + count;
  E_zHi ^= ZH_HI[i]; E_zLo ^= ZH_LO[i];
}

// UIの盤面から読み込む
function eLoad(bd, hd, elim){
  for(let pt=0; pt<8; pt++){ E_VP[pt] = PV[E_PT_NAMES[pt]]; E_VPRO[pt] = PVP[E_PT_NAMES[pt]] || 0; }
  E_rule = keepAllPieces;
  E_zHi = 0; E_zLo = 0;
  E_king.fill(-1); E_count.fill(0); E_hand.fill(0);
  for(let o=0;o<3;o++) E_elim[o] = elim[o] ? 1 : 0;
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell = bd[r][c], sq = r*9+c;
    if(!cell){ E_board[sq] = 0; continue; }
    const pt = Z_PIECE_IDX[cell.p];
    const code = 1 + cell.o*16 + (cell.pr ? 8 : 0) + pt;
    E_board[sq] = code; eZCell(sq, code);
    E_count[cell.o]++;
    if(pt === E_OU) E_king[cell.o] = sq;
  }
  for(let o=0;o<3;o++) for(const p of hd[o]){
    const pt = Z_PIECE_IDX[p];
    const n = ++E_hand[o*8+pt];
    eZHand(o, pt, n);
    E_count[o]++;
  }
}

// sqに持ち主o以外の生存者の利きがあるか（入玉判定用・全駒走査）
function eSquareAttacked(sq, o){
  for(let s=0; s<81; s++){
    const c = E_board[s]; if(!c) continue;
    const k = c-1, e = k>>4;
    if(e === o || E_elim[e]) continue;
    const st = E_STEP[k*81+s];
    for(let i=0;i<st.length;i++) if(st[i] === sq) return true;
    const sd = E_SLIDE[k];
    for(let j=0;j<sd.length;j++){
      const ray = E_RAY[sd[j]*81+s];
      for(let i=0;i<ray.length;i++){ const t = ray[i]; if(t === sq) return true; if(E_board[t]) break; }
    }
  }
  return false;
}

// 指し手を適用。戻り値: 0=通常, 1=玉取り, 2=入玉勝ち
function eMake(m, o, ply){
  const to = m & 127, from = (m >> 7) & 127;
  U_zHi[ply] = E_zHi; U_zLo[ply] = E_zLo; U_cap[ply] = 0; U_recip[ply] = -1;
  if(from >= 81){
    const pt = from - 81, hi = o*8 + pt;
    eZHand(o, pt, E_hand[hi]);
    E_hand[hi]--;
    const code = 1 + o*16 + pt;
    E_board[to] = code; eZCell(to, code);
    return 0;
  }
  const mc = E_board[from], cap = E_board[to];
  eZCell(from, mc);
  let flags = 0;
  if(cap){
    eZCell(to, cap); U_cap[ply] = cap;
    const ck = cap-1, victim = ck>>4, cpt = ck&7;
    if(cpt === E_OU){
      E_elim[victim] = 1; E_king[victim] = -1; E_count[victim]--; flags = 1;
    } else {
      let recip = -1;
      if(E_rule === 'next'){
        for(let p=0;p<3;p++) if(!E_elim[p] && p !== o && p !== victim){ recip = p; break; }
        if(recip < 0) recip = o;
      } else if(E_rule === 'all' || E_rule === true){
        recip = o;
      } else {
        // 消滅あり：脱落者がいる／成り駒／相手玉が中央を越えている／相手の駒が3枚以上多い
        let add = E_elim[0] || E_elim[1] || E_elim[2] || (ck & 8);
        if(!add){
          const ks = E_king[victim];
          if(ks >= 0){
            const kr = (ks/9)|0, kc = ks%9;
            const beyond = victim===0 ? kr <= 4 : victim===1 ? kr >= 4 : kc <= 4;
            if(beyond || E_count[victim] - E_count[o] >= 3) add = 1;
          }
        }
        if(add) recip = o;
      }
      E_count[victim]--;
      if(recip >= 0){
        const hi = recip*8 + cpt, n = E_hand[hi] + 1;
        E_hand[hi] = n; eZHand(recip, cpt, n); E_count[recip]++;
        U_recip[ply] = recip;
      }
    }
  }
  const nc = (m & 16384) ? mc + 8 : mc;
  E_board[to] = nc; E_board[from] = 0; eZCell(to, nc);
  if(((mc-1) & 7) === E_OU){
    E_king[o] = to;
    if(flags === 0 && eIsEntrySq(o, to) && !eSquareAttacked(to, o)) flags = 2;
  }
  return flags;
}

function eUnmake(m, o, ply){
  const to = m & 127, from = (m >> 7) & 127;
  E_zHi = U_zHi[ply]; E_zLo = U_zLo[ply];
  if(from >= 81){ E_hand[o*8 + from - 81]++; E_board[to] = 0; return; }
  const nc = E_board[to], mc = (m & 16384) ? nc - 8 : nc;
  const cap = U_cap[ply];
  E_board[from] = mc; E_board[to] = cap;
  if(((mc-1) & 7) === E_OU) E_king[o] = from;
  if(cap){
    const ck = cap-1, victim = ck>>4, cpt = ck&7;
    E_count[victim]++;
    if(cpt === E_OU){ E_elim[victim] = 0; E_king[victim] = to; }
    else {
      const rc = U_recip[ply];
      if(rc >= 0){ E_hand[rc*8+cpt]--; E_count[rc]--; }
    }
  }
}

// ── 指し手生成 ──
const E_MV = new Int32Array(E_MAXPLY * E_MAXM);
const E_SC = new Float64Array(E_MAXPLY * E_MAXM);
const E_KEY = new Float64Array(E_MAXM);
const E_TMP = new Int32Array(E_MAXM);
const E_QBUF = new Int32Array(E_MAXM);  // 静かな手の退避用
const E_QUIET = new Uint8Array(E_MAXPLY * E_MAXM);

function ePush(n, from, to, o, pt, canPro, fromZone){
  const base = (from << 7) | to;
  if(canPro && (fromZone || eInZone(o, to))){
    if(!eMustPromote(pt, o, to)) E_MV[n++] = base;
    E_MV[n++] = base | 16384;
  } else E_MV[n++] = base;
  return n;
}

// 共闘モード：CPU同士は取り合わない
function eColludeBlock(o, victim){
  return cpuCollusion && !humanEliminated && o !== humanPlayer && victim !== humanPlayer && !E_elim[victim];
}

// 合法手（玉の自殺手を含む擬似合法手）をE_MV[base..]に書き込み、終端を返す
// noDrops=true なら打ち手を生成しない（打ち手は必ず静かな手なので futility 時は不要）
function eGenMoves(o, base, noDrops){
  let n = base;
  for(let sq=0; sq<81; sq++){
    const c = E_board[sq]; if(!c) continue;
    const k = c-1; if((k>>4) !== o) continue;
    const pt = k&7, canPro = !(k&8) && E_CAN_PRO[pt] === 1;
    const fromZone = canPro && eInZone(o, sq);
    const st = E_STEP[k*81+sq];
    for(let i=0;i<st.length;i++){
      const t = st[i], tc = E_board[t];
      if(tc){ const v = (tc-1)>>4; if(v === o || eColludeBlock(o, v)) continue; }
      n = ePush(n, sq, t, o, pt, canPro, fromZone);
    }
    const sd = E_SLIDE[k];
    for(let j=0;j<sd.length;j++){
      const ray = E_RAY[sd[j]*81+sq];
      for(let i=0;i<ray.length;i++){
        const t = ray[i], tc = E_board[t];
        if(tc){
          const v = (tc-1)>>4;
          if(v !== o && !eColludeBlock(o, v)) n = ePush(n, sq, t, o, pt, canPro, fromZone);
          break;
        }
        n = ePush(n, sq, t, o, pt, canPro, fromZone);
      }
    }
  }
  // 持ち駒打ち
  let hasHand = false;
  for(let pt=0; pt<7; pt++) if(E_hand[o*8+pt]){ hasHand = true; break; }
  if(hasHand && !noDrops){
    // 二歩：P0/P1は筋（列）、P2は段（行）
    let fuLines = 0;
    if(E_hand[o*8+E_FU]){
      const fuCode = 1 + o*16 + E_FU;
      for(let sq=0; sq<81; sq++) if(E_board[sq] === fuCode) fuLines |= 1 << (o === 2 ? (sq/9)|0 : sq%9);
    }
    for(let pt=0; pt<7; pt++){
      if(!E_hand[o*8+pt]) continue;
      const fromCode = (81 + pt) << 7;
      for(let sq=0; sq<81; sq++){
        if(E_board[sq]) continue;
        if(pt <= E_KE && eMustPromote(pt, o, sq)) continue;
        if(pt === E_FU && (fuLines & (1 << (o === 2 ? (sq/9)|0 : sq%9)))) continue;
        E_MV[n++] = fromCode | sq;
      }
    }
  }
  return n;
}

function eHasHand(o){
  for(let pt=0; pt<7; pt++) if(E_hand[o*8+pt]) return true;
  return false;
}

// ── 利きの集計（評価・並べ替え・駒取り判定で使う）──
const E_cnt = new Uint8Array(3*81);    // 持ち主*81+マス：利いている駒の数（味方の駒がいるマスも含む）
const E_min = new Int32Array(3*81);    // 持ち主*81+マス：利いている駒の最小価値（成りを除いた駒価値）
const E_mob = new Int32Array(3);       // 持ち主ごとの mobility（味方のいないマスへの利きの数）

function eComputeAttacks(){
  E_cnt.fill(0); E_min.fill(E_INF_VAL);
  E_mob[0] = 0; E_mob[1] = 0; E_mob[2] = 0;
  for(let sq=0; sq<81; sq++){
    const c = E_board[sq]; if(!c) continue;
    const k = c-1, o = k>>4;
    if(E_elim[o]) continue;  // 脱落者の駒は動かない
    const val = E_VP[k&7], base = o*81;
    let mob = 0;
    const st = E_STEP[k*81+sq];
    for(let i=0;i<st.length;i++){
      const t = st[i], idx = base + t;
      E_cnt[idx]++; if(val < E_min[idx]) E_min[idx] = val;
      const tc = E_board[t];
      if(!tc || ((tc-1)>>4) !== o) mob++;
    }
    const sd = E_SLIDE[k];
    for(let j=0;j<sd.length;j++){
      const ray = E_RAY[sd[j]*81+sq];
      for(let i=0;i<ray.length;i++){
        const t = ray[i], idx = base + t;
        E_cnt[idx]++; if(val < E_min[idx]) E_min[idx] = val;
        const tc = E_board[t];
        if(tc){ if(((tc-1)>>4) !== o) mob++; break; }
        mob++;
      }
    }
    E_mob[o] += mob;
  }
}

// 持ち主oの玉に生存している敵の利きがあるか（eComputeAttacks後に使う）
function eKingAttacked(o){
  const ks = E_king[o];
  if(ks < 0) return false;
  for(let e=0;e<3;e++) if(e !== o && !E_elim[e] && E_cnt[e*81+ks]) return true;
  return false;
}

// ── 評価（旧 calcRawScores / evalStatic と同じ値）──
const E_raw = [0, 0, 0];
const E_ALIVE = [];  // 脱落状態ビット → 生存者配列
for(let m=0;m<8;m++){ const a=[]; for(let o=0;o<3;o++) if(!(m & (1<<o))) a.push(o); E_ALIVE.push(a); }

function eCalcRaw(){
  let ps0=0, ps1=0, ps2=0, dg0=0, dg1=0, dg2=0;
  const el0 = E_elim[0], el1 = E_elim[1], el2 = E_elim[2];
  for(let sq=0; sq<81; sq++){
    const c = E_board[sq]; if(!c) continue;
    const k = c-1, pt = k&7;
    if(pt === E_OU) continue;
    const o = k>>4;
    const v = (k & 8) ? E_VP[pt] + E_VPRO[pt] : E_VP[pt];
    if(o===0) ps0+=v; else if(o===1) ps1+=v; else ps2+=v;
    if(o===0 ? el0 : o===1 ? el1 : el2) continue;
    // 被脅威：生存している敵の最小価値の利き。守り駒がいれば減衰
    let minE = E_INF_VAL;
    for(let e=0;e<3;e++){
      if(e === o || E_elim[e]) continue;
      const mv = E_min[e*81+sq];
      if(mv < minE) minE = mv;
    }
    if(minE !== E_INF_VAL){
      const myVal = E_VP[pt];
      const guard = E_cnt[o*81+sq] ? Math.max(0.1, 1 - minE / (myVal + minE)) : 1.0;
      const d = myVal * AI_DANGER_SCALE * guard;
      if(o===0) dg0+=d; else if(o===1) dg1+=d; else dg2+=d;
    }
  }
  for(let o=0;o<3;o++){
    let hs = 0;
    for(let pt=0; pt<7; pt++){ const n = E_hand[o*8+pt]; if(n) hs += E_VP[pt] * AI_HAND_BONUS_RATE * n; }
    if(o===0) ps0+=hs; else if(o===1) ps1+=hs; else ps2+=hs;
  }
  for(let o=0;o<3;o++){
    if(E_elim[o]){ E_raw[o] = 0; continue; }
    let entry = 0, safety = 0;
    const ks = E_king[o];
    if(ks >= 0){
      const kr = (ks/9)|0, kc = ks%9;
      const dist = o===0 ? kr : o===1 ? 8-kr : kc;
      if(dist < 4) entry = ((1 << (4-dist)) - 1) * AI_ENTRY_MULT;
      const fdr = o===0 ? -1 : o===1 ? 1 : 0;
      const fdc = o===2 ? -1 : 0;
      for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
        if(!dr && !dc) continue;
        const nr = kr+dr, nc = kc+dc;
        if(nr<0||nr>=9||nc<0||nc>=9) continue;
        const isFront = (dr===fdr && (fdr!==0||dc===fdc));
        const w = isFront ? 1.3 : 1.0;
        const n = nr*9+nc;
        let enemy = 0;
        for(let e=0;e<3;e++) if(e !== o && !E_elim[e]) enemy += E_cnt[e*81+n];
        safety += (E_cnt[o*81+n] / (enemy + 1)) * w;
      }
    }
    const ps = o===0 ? ps0 : o===1 ? ps1 : ps2;
    const dg = o===0 ? dg0 : o===1 ? dg1 : dg2;
    E_raw[o] = ps + E_mob[o] * AI_MOBILITY_SCALE + entry - dg + safety * AI_KING_SAFETY_MULT;
  }
}

function eEntryBonus(o){
  const ks = E_king[o];
  if(ks < 0) return 0;
  const kr = (ks/9)|0, kc = ks%9;
  const dist = o===0 ? kr : o===1 ? 8-kr : kc;
  return (Math.pow(2, Math.max(0, 4-dist)) - 1) * AI_ENTRY_MULT;
}

// 共闘モード用：駒価値合計（旧 pieceScores と同じ）
function ePieceScore(o){
  let s = 0;
  for(let sq=0; sq<81; sq++){
    const c = E_board[sq]; if(!c) continue;
    const k = c-1; if((k>>4) !== o || (k&7) === E_OU) continue;
    s += (k & 8) ? E_VP[k&7] + E_VPRO[k&7] : E_VP[k&7];
  }
  for(let pt=0; pt<7; pt++){ const n = E_hand[o*8+pt]; if(n) s += E_VP[pt] * AI_HAND_BONUS_RATE * n; }
  return s;
}

// 静的評価（rootAI=vp視点）。三つ巴では eComputeAttacks() 済みであること
function eEvalCur(vp){
  leafEvalCount++;
  const em = E_elim[0] | (E_elim[1]<<1) | (E_elim[2]<<2);
  const alive = E_ALIVE[em];
  if(alive.length <= 1) return alive[0] === vp ? PV.OU : -PV.OU;
  if(!cpuCollusion){
    if(E_elim[vp]) return -PV.OU;
    eCalcRaw();
    return calcWeightedScore(E_raw, alive, vp);
  }
  const hu = humanPlayer;
  if(E_elim[hu]){
    const c1 = alive[0], c2 = alive[1];
    const score = ePieceScore(c1) - ePieceScore(c2) + eEntryBonus(c1) - eEntryBonus(c2);
    return vp === c1 ? score : -score;
  }
  let score = 0;
  for(let o=0;o<3;o++) score += o === hu ? -ePieceScore(o) : ePieceScore(o);
  for(const cpu of alive) if(cpu !== hu) score += eEntryBonus(cpu);
  return score;
}
function eEvalFresh(vp){ eComputeAttacks(); return eEvalCur(vp); }

function eAliveCount(){ return 3 - E_elim[0] - E_elim[1] - E_elim[2]; }

// ── 並べ替え ──
// E_SC[i] のスコア降順に E_MV / E_QUIET を並べ替える（同点は元の順）
const E_TMPQ = new Uint8Array(E_MAXM);
function eSortMoves(base, end){
  const n = end - base;
  if(n <= 1) return;
  if(n <= 16){
    // 少数なら挿入ソート
    for(let i=base+1;i<end;i++){
      const m = E_MV[i], sc = E_SC[i], q = E_QUIET[i];
      let j = i - 1;
      while(j >= base && E_SC[j] < sc){ E_MV[j+1] = E_MV[j]; E_SC[j+1] = E_SC[j]; E_QUIET[j+1] = E_QUIET[j]; j--; }
      E_MV[j+1] = m; E_SC[j+1] = sc; E_QUIET[j+1] = q;
    }
    return;
  }
  for(let i=0;i<n;i++){
    // スコアを整数化してキーに詰める（大きい順＝キー小さい順、同点は元の順）
    E_KEY[i] = (2e10 - Math.round(E_SC[base+i])) * 1024 + i;
    E_TMP[i] = E_MV[base+i];
    E_TMPQ[i] = E_QUIET[base+i];
  }
  const keys = E_KEY.subarray(0, n);
  keys.sort();
  for(let i=0;i<n;i++){
    const idx = keys[i] % 1024;
    E_MV[base+i] = E_TMP[idx];
    E_QUIET[base+i] = E_TMPQ[idx];
    E_SC[base+i] = 2e10 - Math.floor(keys[i] / 1024);
  }
}

// キラー（残り深さ別2手、成りの有無は区別しない）
const E_KILL = new Int32Array(64*2);
function eIsKiller(depth, m){
  if(depth < 0 || depth >= 64) return false;
  const k = m & ~16384;
  return (E_KILL[depth*2] & ~16384) === k && E_KILL[depth*2] !== 0 || (E_KILL[depth*2+1] & ~16384) === k && E_KILL[depth*2+1] !== 0;
}
function eRegisterKiller(depth, m){
  if(depth < 0 || depth >= 64 || ((m >> 7) & 127) >= 81) return;
  if((E_KILL[depth*2] & ~16384) === (m & ~16384)) return;
  E_KILL[depth*2+1] = E_KILL[depth*2];
  E_KILL[depth*2] = m;
}

function eHistIdx(o, m){ return (o*88 + ((m >> 7) & 127))*81 + (m & 127); }

// 生存している敵の利きがあるか（eComputeAttacks後）
function eEnemyAttacks(o, sq){
  for(let e=0;e<3;e++) if(e !== o && !E_elim[e] && E_cnt[e*81+sq]) return true;
  return false;
}

// 旧 orderMovesScalar と同じ優先順位（置換表の手 → 駒取り → 入玉 → 成り → キラー → ヒストリー＋局面ヒューリスティック）
// 段階的に並べる：まず「静かでない手」（置換表の手・駒取り・入玉・成り）を前に集めて並べ、
// 静かな手は後ろに寄せておき、必要になったら eOrderQuiet で点数を付けて並べる（すぐ枝刈りされる局面の無駄を省く）
// 戻り値: 静かな手の開始位置
function eOrderTactical(base, end, tp, ttBest){
  let w = base;  // 静かな手は一旦 E_QBUF に退避
  let nq = 0;
  for(let i=base;i<end;i++){
    const m = E_MV[i], to = m & 127, from = (m >> 7) & 127;
    const drop = from >= 81;
    const pt = drop ? from - 81 : (E_board[from]-1) & 7;
    let s;
    if(m === ttBest) s = 1e10;
    else if(!drop && E_board[to]) s = 1e9 + E_VP[(E_board[to]-1)&7] * 16 - E_VP[pt] / 10 + ((m & 16384) ? E_VPRO[pt] : 0);
    else if(pt === E_OU && eIsEntrySq(tp, to)) s = 5e8;
    else if(m & 16384) s = 1e8 + E_VPRO[pt];
    else { E_QBUF[nq++] = m; continue; }
    E_MV[w] = m; E_SC[w] = s; E_QUIET[w] = 0; w++;
  }
  eSortMoves(base, w);
  for(let i=0;i<nq;i++){ E_MV[w+i] = E_QBUF[i]; E_QUIET[w+i] = 1; }
  return w;
}

// 静かな手 [qs, end) に点数を付けて並べる
function eOrderQuiet(qs, end, tp, depth){
  let e1 = -1, e2 = -1;
  for(let e=0;e<3;e++) if(e !== tp && !E_elim[e]){ if(e1 < 0) e1 = e; else e2 = e; }
  const b1 = e1 < 0 ? -1 : e1*81, b2 = e2 < 0 ? -1 : e2*81;
  for(let i=qs;i<end;i++){
    const m = E_MV[i], to = m & 127, from = (m >> 7) & 127;
    const drop = from >= 81;
    const pt = drop ? from - 81 : (E_board[from]-1) & 7;
    const myVal = E_VP[pt];
    let s;
    if(drop) s = Math.min(histTable[eHistIdx(tp, m)], 8e6) - myVal * AI_QMS_HAND_COST;
    else {
      s = eIsKiller(depth, m) ? 9e6 : Math.min(histTable[eHistIdx(tp, m)], 8e6);
      if((b1 >= 0 && E_cnt[b1+from]) || (b2 >= 0 && E_cnt[b2+from])) s += myVal * AI_DANGER_SCALE;  // 逃げる
    }
    if((b1 >= 0 && E_cnt[b1+to]) || (b2 >= 0 && E_cnt[b2+to])) s -= myVal * AI_DANGER_SCALE;     // 危険マス
    E_SC[i] = s;
  }
  eSortMoves(qs, end);
}

// root用：全部並べる
function eOrderMoves(base, end, tp, depth, ttBest){
  const qs = eOrderTactical(base, end, tp, ttBest);
  eOrderQuiet(qs, end, tp, depth);
  return end;
}

// ── 静止探索（駒取りのみ）──
function eGenCaptures(o, base){
  let n = base;
  for(let sq=0; sq<81; sq++){
    const c = E_board[sq]; if(!c) continue;
    const k = c-1; if((k>>4) !== o) continue;
    const pt = k&7, canPro = !(k&8) && E_CAN_PRO[pt] === 1;
    const myVal = (k & 8) ? E_VP[pt] + E_VPRO[pt] : E_VP[pt];
    const fromZone = canPro && eInZone(o, sq);
    const st = E_STEP[k*81+sq], sd = E_SLIDE[k];
    for(let pass=0; pass<2; pass++){
      const nRays = pass === 0 ? 1 : sd.length;
      for(let j=0;j<nRays;j++){
        const list = pass === 0 ? st : E_RAY[sd[j]*81+sq];
        for(let i=0;i<list.length;i++){
          const t = list[i], tc = E_board[t];
          if(!tc) continue;
          const tk = tc-1, victim = tk>>4, vpt = tk&7;
          if(victim !== o && !eColludeBlock(o, victim)){
            const victimVal = vpt === E_OU ? PV.OU : ((tk & 8) ? E_VP[vpt] + E_VPRO[vpt] : E_VP[vpt]);
            // 損な取り（紐付きの駒を高い駒で取る）は読まない
            if(!(vpt !== E_OU && myVal > victimVal && !E_elim[victim] && E_cnt[victim*81+t])){
              const pro = canPro && (fromZone || eInZone(o, t));
              E_MV[n] = (sq << 7) | t | (pro ? 16384 : 0);
              E_SC[n] = victimVal * 16 - myVal / 100;
              E_QUIET[n] = 0;
              n++;
            }
          }
          if(pass === 1) break;  // 走り駒は最初の駒で止まる
        }
      }
    }
  }
  eSortMoves(base, n);
  return n;
}

function eQsearch(tp, alpha, beta, rootAI, qdepth, ply){
  eComputeAttacks();
  const stand = eEvalCur(rootAI) + tempoBonus(tp, rootAI, E_elim);
  if(qdepth <= 0 || tp < 0 || eAliveCount() <= 1) return stand;
  const isMin = isMinNode(tp, rootAI, E_elim);
  let best = stand;
  if(isMin){ if(best <= alpha) return best; beta = Math.min(beta, best); }
  else     { if(best >= beta)  return best; alpha = Math.max(alpha, best); }
  const base = ply * E_MAXM;
  const end = eGenCaptures(tp, base);
  for(let i=base;i<end;i++){
    const m = E_MV[i];
    const flags = eMake(m, tp, ply);
    let s;
    if(flags === 2) s = entryWinScalar(tp, rootAI);
    else if(flags === 1) s = eEvalFresh(rootAI) + tempoBonus(nextAliveOn(E_elim, tp), rootAI, E_elim);
    else s = eQsearch(nextAliveOn(E_elim, tp), alpha, beta, rootAI, qdepth-1, ply+1);
    eUnmake(m, tp, ply);
    if(isMin){ if(s < best) best = s; beta = Math.min(beta, s); }
    else     { if(s > best) best = s; alpha = Math.max(alpha, s); }
    if(beta <= alpha) break;
  }
  return best;
}

// ── αβ探索（旧 minimaxRound のスカラー部分＋searchScalar と同じ）──
function eSearch(depth, alpha, beta, tp, rootAI, ply, maxDepth, t0, timeLimit, sliceRate, pvArr){
  if(tp === -1 || eAliveCount() <= 1) return eEvalFresh(rootAI);
  if(!cpuCollusion && E_elim[rootAI]) return -PV.OU;
  if(depth <= 0) return eQsearch(tp, alpha, beta, rootAI, AI_QS_DEPTH, ply);

  const isMin = isMinNode(tp, rootAI, E_elim);
  const alpha0 = alpha, beta0 = beta;

  // 置換表
  let ttIdx = -1, kHi = 0, kLo = 0, ttBest = 0;
  if(AI_USE_TT){
    const zi = tp*8 + E_elim[0] + E_elim[1]*2 + E_elim[2]*4;
    kHi = E_zHi ^ ZT_HI[zi]; kLo = E_zLo ^ ZT_LO[zi];
    ttIdx = kLo & TT_MASK;
    if(ttGen[ttIdx] === ttCurGen && ttKeyHi[ttIdx] === kHi && ttKeyLo[ttIdx] === kLo){
      ttBest = ttMove[ttIdx];
      if(ttDepth[ttIdx] >= depth){
        const v = ttVal[ttIdx], f = ttFlag[ttIdx];
        if(f === TT_EXACT || (f === TT_LOWER && v >= beta) || (f === TT_UPPER && v <= alpha)) return v;
      }
    }
  }

  eComputeAttacks();

  // futility
  let futile = false, futileVal = 0;
  if(AI_USE_FUTILITY && depth <= 2 && !cpuCollusion){
    const margin = depth === 1 ? AI_FUTILITY_MARGIN1 : AI_FUTILITY_MARGIN2;
    const stand = eEvalCur(rootAI) + tempoBonus(tp, rootAI, E_elim);
    if(isMin ? stand - margin >= beta : stand + margin <= alpha){
      if(!eKingAttacked(tp)){ futile = true; futileVal = isMin ? stand - margin : stand + margin; }
    }
  }

  const base = ply * E_MAXM;
  const genEnd = eGenMoves(tp, base, futile);
  moveGenCount++;
  depthMoveGen[depth] = (depthMoveGen[depth]||0) + (genEnd - base);
  depthNodeCount[depth] = (depthNodeCount[depth]||0) + 1;
  const qStart = eOrderTactical(base, genEnd, tp, ttBest);
  const nTactical = qStart - base, nAll = genEnd - base;
  // 静かな手：futility時は読まない（値は futileVal とみなす）。それ以外は必要になった時点で並べる
  let end = futile ? qStart : genEnd;
  let quietReady = futile;
  // 旧方式の足切り：root順位に応じて静かな手を削る（駒取り・成り・入玉は残す）
  let quietKeep = genEnd - qStart;
  if(AI_USE_SLICE && sliceRate > 0){
    const keep = Math.max(1, Math.ceil(nAll * (1 - sliceRate)));
    quietKeep = Math.max(0, Math.min(quietKeep, keep - nTactical));
    if(!futile){ slicedMoveCount += (genEnd - qStart) - quietKeep; end = qStart + quietKeep; }
  }

  const wantPV = pvArr && maxDepth - depth < 2;
  let best = isMin ? Infinity : -Infinity, bestMove = 0, searched = 0;
  if(futile && (genEnd > qStart || eHasHand(tp))) best = futileVal;
  for(let i=base;i<end;i++){
    if(i === qStart && !quietReady){
      // 静かな手を並べる（足切り前の全静かな手を並べてから先頭 quietKeep 手を使う）
      // 子の探索で利きの集計が上書きされているので取り直す
      if(i > base) eComputeAttacks();
      eOrderQuiet(qStart, genEnd, tp, depth);
      quietReady = true;
    }
    const m = E_MV[i], quiet = E_QUIET[i];
    let pvEntry = null;
    if(wantPV){
      const from = (m >> 7) & 127;
      pvEntry = from >= 81 ? { m, pt: from-81, pr: false, owner: tp }
                           : { m, pt: (E_board[from]-1) & 7, pr: !!((E_board[from]-1) & 8), owner: tp };
    }
    const flags = eMake(m, tp, ply);
    let score;
    const childPV = wantPV ? [] : null;
    if(flags === 2) score = entryWinScalar(tp, rootAI);
    else if(flags === 1) score = eEvalFresh(rootAI) + tempoBonus(nextAliveOn(E_elim, tp), rootAI, E_elim);
    else {
      const nxt = nextAliveOn(E_elim, tp);
      const reduce = (AI_USE_LMR && depth >= AI_LMR_MIN_DEPTH && quiet && searched >= AI_LMR_MIN_MOVES && !eIsKiller(depth, m)) ? 1 : 0;
      score = eSearch(depth-1-reduce, alpha, beta, nxt, rootAI, ply+1, maxDepth, t0, timeLimit, sliceRate, childPV);
      if(reduce && (isMin ? score < beta : score > alpha)){
        if(childPV) childPV.length = 0;
        score = eSearch(depth-1, alpha, beta, nxt, rootAI, ply+1, maxDepth, t0, timeLimit, sliceRate, childPV);
      }
    }
    eUnmake(m, tp, ply);
    searched++;
    depthMoveExplore[depth] = (depthMoveExplore[depth]||0) + 1;

    if(isMin ? score < best : score > best){
      best = score; bestMove = m;
      if(wantPV){ pvArr.length = 0; pvArr.push(pvEntry, ...childPV); }
    }
    if(isMin) beta = Math.min(beta, score); else alpha = Math.max(alpha, score);
    if(beta <= alpha){
      pruneCount++;
      if(quiet){ eRegisterKiller(depth, m); histTable[eHistIdx(tp, m)] += depth*depth; }
      break;
    }
    if(t0 && performance.now() - t0 >= timeLimit){ searchAborted = true; break; }
  }
  if(best === Infinity || best === -Infinity) best = eEvalFresh(rootAI) + tempoBonus(tp, rootAI, E_elim);

  if(ttIdx >= 0 && !searchAborted && (ttGen[ttIdx] !== ttCurGen || depth >= ttDepth[ttIdx] || (ttKeyHi[ttIdx] === kHi && ttKeyLo[ttIdx] === kLo))){
    ttGen[ttIdx] = ttCurGen; ttKeyHi[ttIdx] = kHi; ttKeyLo[ttIdx] = kLo;
    ttVal[ttIdx] = best; ttDepth[ttIdx] = depth; ttMove[ttIdx] = bestMove;
    ttFlag[ttIdx] = best <= alpha0 ? TT_UPPER : best >= beta0 ? TT_LOWER : TT_EXACT;
  }
  return best;
}

// ── 指し手の変換 ──
function eMoveToObj(m){
  const to = m & 127, from = (m >> 7) & 127;
  const tr = (to/9)|0, tc = to%9;
  if(from >= 81) return { fr:-1, fc:-1, tr, tc, piece: E_PT_NAMES[from-81], pro:false, drop:true };
  return { fr:(from/9)|0, fc:from%9, tr, tc, pro: !!(m & 16384), drop:false };
}
function ePvToObj(e){
  return { ...eMoveToObj(e.m), pvPiece: E_PT_NAMES[e.pt], pvPr: e.pr, pvOwner: e.owner };
}

// ── root ──
function engineMove(o, bd, hd, elim){
  leafEvalCount = 0; moveGenCount = 0; pruneCount = 0; slicedMoveCount = 0;
  depthMoveGen = {}; depthMoveExplore = {}; depthNodeCount = {};
  orderingHits = 0; orderingTotal = 0; orderingRankSum = 0;
  const t0 = performance.now();
  E_KILL.fill(0);
  histTable.fill(0);
  ttCurGen++;
  searchAborted = false;
  lastSearchInfo = { depthBest: [], reachedDepth: 0 };
  eLoad(bd, hd, elim);

  const end = eGenMoves(o, 0);
  if(end === 0) return null;
  eComputeAttacks();
  const inCheck = eKingAttacked(o);
  eOrderMoves(0, end, o, AI_MAX_DEPTH, 0);
  let moves = Array.from(E_MV.subarray(0, end));

  // 王手回避手：王手時のみ
  let candidates = moves;
  if(inCheck){
    const evasions = moves.filter(m => {
      eMake(m, o, 0);
      eComputeAttacks();
      const safe = !E_elim[o] && !eKingAttacked(o);
      eUnmake(m, o, 0);
      return safe;
    });
    if(evasions.length){
      // 入玉手（1段目到達）は必ず候補に残す
      const entry = moves.filter(m => { const f = (m>>7)&127; return f < 81 && ((E_board[f]-1)&7) === E_OU && eIsEntrySq(o, m & 127); });
      candidates = evasions.concat(entry.filter(m => !evasions.includes(m)));
    }
  }

  const timeLimit = AI_TIME_LIMIT_MS - 200; // 200msバッファ
  let orderedCands = candidates.slice();
  let lastCompleteResults = null, reachedDepth = 0;
  const depthTimes = [];

  for(let d = 1; d <= AI_MAX_DEPTH; d++){
    if(d > 1 && performance.now() - t0 >= timeLimit) break;
    const iterResults = [];
    let timedOut = false, iterBest = -Infinity;
    for(let idx=0; idx<orderedCands.length; idx++){
      const m = orderedCands[idx];
      // rank別sliceRate: rank1-3=0%, rank4-5=30%, rank6-7=40%, 以降10%ずつ増加、上限90%
      const sliceRate = idx <= 2 ? 0.0 : Math.min(0.9, 0.3 + Math.floor((idx - 3) / 2) * 0.1);
      const from = (m >> 7) & 127;
      const pvEntry = from >= 81 ? { m, pt: from-81, pr: false, owner: o }
                                 : { m, pt: (E_board[from]-1) & 7, pr: !!((E_board[from]-1) & 8), owner: o };
      const flags = eMake(m, o, 0);
      if(flags){ eUnmake(m, o, 0); return eMoveToObj(m); }  // 玉取り・入玉勝ちは即指す
      eComputeAttacks();
      if(!E_elim[o] && eKingAttacked(o)){ eUnmake(m, o, 0); continue; }  // 自殺手
      const nxt = nextAliveOn(E_elim, o);
      const childPV = [];
      const rootAlpha = iterBest === -Infinity ? -Infinity : iterBest - AI_NOISE - 1;
      const v = eSearch(d, rootAlpha, Infinity, nxt, o, 1, d, t0, timeLimit, sliceRate, childPV);
      eUnmake(m, o, 0);
      if(d > 1 && performance.now() - t0 >= timeLimit){ timedOut = true; break; }
      if(v > iterBest) iterBest = v;
      iterResults.push({ m, rawV: v, pv: [pvEntry, ...childPV] });
      if(performance.now() - t0 >= timeLimit){ timedOut = true; break; }
    }
    if(timedOut && d > 1) break;
    if(iterResults.length === 0) break;
    iterResults.sort((a,b) => b.rawV - a.rawV);
    const prevRank = orderedCands.indexOf(iterResults[0].m);
    if(prevRank >= 0){ orderingTotal++; orderingRankSum += prevRank + 1; if(prevRank === 0) orderingHits++; }
    orderedCands = iterResults.map(r => r.m);
    lastCompleteResults = iterResults;
    reachedDepth = d;
    depthTimes.push(`d${d}:${(performance.now()-t0).toFixed(0)}ms`);
    lastSearchInfo.depthBest.push(iterResults[0].rawV);
    lastSearchInfo.reachedDepth = d;
  }

  let best = null, bestScore = -Infinity;
  const allResults = [];
  if(lastCompleteResults){
    for(const r of lastCompleteResults){
      const v = r.rawV + (Math.random()-0.5)*AI_NOISE;
      if(v > bestScore){ bestScore = v; best = r.m; }
      allResults.push({ score: r.rawV, pv: r.pv.map(ePvToObj) });
    }
  }
  reportSearch(o, t0, reachedDepth, depthTimes, allResults);
  if(best !== null) return eMoveToObj(best);
  return candidates.length ? eMoveToObj(candidates[0]) : null;
}

// ── CPUの着手（エンジン選択）──
function aiMove(o, bd, hd, elim){
  if(!AI_USE_ENGINE2 || (!cpuCollusion && AI_THREEWAY_SEARCH !== 'paranoid')) return aiMoveLegacy(o, bd, hd, elim);
  return engineMove(o, bd, hd, elim);
}
