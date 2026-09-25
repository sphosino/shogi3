// ── インクリメンタル attackedBy (GAB) ──
// 影響キーだけ保存・復元するundo方式（全コピー不要）
let gAttackedBy = {}; // quickMoveScore用（rootのみ使用）

// ── 双方向利き筋マップ ──
// squareAttackers[sq] = [{fr,fc,owner,isSlide,dr,dc}, ...]  そのマスに利いている駒
// pieceReach[sq]      = [{tr,tc,isSlide,dr,dc}, ...]        その駒が利いているマス
let squareAttackers = new Array(81).fill(null).map(()=>[]);
let pieceReach      = new Array(81).fill(null).map(()=>[]);

// 駒1個の利き筋を計算（方向情報付き）
function computePieceReach(bd, r, c){
  const cell = bd[r][c];
  if(!cell) return [];
  const {p, o, pr} = cell;
  const result = [];

  const addStep = (dr, dc) => {
    const [rdr,rdc] = rotDir(dr,dc,o);
    const nr=r+rdr, nc=c+rdc;
    if(!inB(nr,nc) || bd[nr][nc]?.o===o) return;
    result.push({tr:nr, tc:nc, isSlide:false, dr:rdr, dc:rdc});
  };

  const addSlide = (dr, dc) => {
    let nr=r+dr, nc=c+dc;
    while(inB(nr,nc)){
      if(bd[nr][nc]?.o===o) break;
      result.push({tr:nr, tc:nc, isSlide:true, dr, dc});
      if(bd[nr][nc]) break;
      nr+=dr; nc+=dc;
    }
  };

  if(pr && ['FU','KY','KE','GIN'].includes(p)){
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]].forEach(([dr,dc])=>addStep(dr,dc));
    return result;
  }
  switch(p){
    case 'FU': addStep(-1,0); break;
    case 'KY':{
      const [kdr,kdc]=rotDir(-1,0,o);
      let knr=r+kdr, knc=c+kdc;
      while(inB(knr,knc)){
        if(bd[knr][knc]?.o===o) break;
        result.push({tr:knr, tc:knc, isSlide:true, dr:kdr, dc:kdc});
        if(bd[knr][knc]) break;
        knr+=kdr; knc+=kdc;
      }
      break;
    }
    case 'KE': [[-2,-1],[-2,1]].forEach(([dr,dc])=>addStep(dr,dc)); break;
    case 'GIN': [[-1,-1],[-1,0],[-1,1],[1,-1],[1,1]].forEach(([dr,dc])=>addStep(dr,dc)); break;
    case 'KIN': [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]].forEach(([dr,dc])=>addStep(dr,dc)); break;
    case 'HI':
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>addSlide(dr,dc));
      if(pr)[[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc])=>addStep(dr,dc));
      break;
    case 'KAKU':
      [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc])=>addSlide(dr,dc));
      if(pr)[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>addStep(dr,dc));
      break;
    case 'OU':
      for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++)
        if(dr||dc) addStep(dr,dc);
      break;
  }
  return result;
}

// 駒の利きをマップに登録
function addPieceToMaps(r, c, reach, owner){
  pieceReach[r*9+c] = reach;
  for(const {tr,tc,isSlide,dr,dc} of reach)
    squareAttackers[tr*9+tc].push({fr:r, fc:c, owner, isSlide, dr, dc});
}

// 駒の利きをマップから除去
function removePieceFromMaps(r, c){
  for(const {tr,tc} of pieceReach[r*9+c]){
    const sq = tr*9+tc;
    const arr = squareAttackers[sq];
    for(let i=arr.length-1;i>=0;i--)
      if(arr[i].fr===r && arr[i].fc===c){ arr.splice(i,1); break; }
  }
  pieceReach[r*9+c] = [];
}

// frが空いた → そこを通っていたslide駒の利きを伸ばす
function extendSlidesFrom(bd, r, c){
  for(const {fr,fc,owner,isSlide,dr,dc} of squareAttackers[r*9+c]){
    if(!isSlide) continue;
    let nr=r+dr, nc=c+dc;
    while(inB(nr,nc)){
      if(bd[nr][nc]?.o===owner) break;
      pieceReach[fr*9+fc].push({tr:nr,tc:nc,isSlide:true,dr,dc});
      squareAttackers[nr*9+nc].push({fr,fc,owner,isSlide:true,dr,dc});
      if(bd[nr][nc]) break;
      nr+=dr; nc+=dc;
    }
  }
}

// trが塞がった → そこを通り抜けていたslide駒の利きを止める
function stopSlidesAt(bd, r, c){
  for(const {fr,fc,isSlide,dr,dc} of squareAttackers[r*9+c]){
    if(!isSlide) continue;
    let nr=r+dr, nc=c+dc;
    while(inB(nr,nc)){
      const sq=nr*9+nc;
      const arr=squareAttackers[sq];
      for(let i=arr.length-1;i>=0;i--)
        if(arr[i].fr===fr && arr[i].fc===fc){ arr.splice(i,1); break; }
      const pr2=pieceReach[fr*9+fc];
      for(let i=pr2.length-1;i>=0;i--)
        if(pr2[i].tr===nr && pr2[i].tc===nc){ pr2.splice(i,1); break; }
      if(bd[nr][nc]) break;
      nr+=dr; nc+=dc;
    }
  }
}

// 全局面からマップを初期構築
function buildAttackMaps(bd){
  squareAttackers = new Array(81).fill(null).map(()=>[]);
  pieceReach      = new Array(81).fill(null).map(()=>[]);
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    if(!bd[r][c]) continue;
    const reach = computePieceReach(bd,r,c);
    addPieceToMaps(r,c,reach,bd[r][c].o);
  }
}

// ── デバッグ用：差分マップとフルスキャンを比較 ──
let DEBUG_ATTACK_MAPS = false; // trueにすると毎apply/undoで検証
let inAISearch = false; // AI思考中フラグ

// ── キラームーブ（depth別に静かな手を2つ記録）──
const MAX_KILLER_DEPTH = 20;
let killers = Array.from({length: MAX_KILLER_DEPTH}, () => [null, null]);

function resetKillers(){ killers = Array.from({length: MAX_KILLER_DEPTH}, () => [null, null]); }

function registerKiller(depth, mv){
  if(depth < 0 || depth >= MAX_KILLER_DEPTH) return;
  if(mv.drop) return; // 打ち手は登録しない
  const key = `${mv.fr},${mv.fc},${mv.tr},${mv.tc}`;
  if(killers[depth][0] && `${killers[depth][0].fr},${killers[depth][0].fc},${killers[depth][0].tr},${killers[depth][0].tc}` === key) return;
  killers[depth][1] = killers[depth][0];
  killers[depth][0] = mv;
}

function isKiller(depth, mv){
  if(depth < 0 || depth >= MAX_KILLER_DEPTH || mv.drop) return false;
  return killers[depth].some(k => k && k.fr===mv.fr && k.fc===mv.fc && k.tr===mv.tr && k.tc===mv.tc);
}

function validateAttackMaps(bd, label=''){
  // フルスキャンで正解マップを作成
  const refSA = new Array(81).fill(null).map(()=>[]);
  const refPR = new Array(81).fill(null).map(()=>[]);
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    if(!bd[r][c]) continue;
    const reach = computePieceReach(bd,r,c);
    refPR[r*9+c] = reach;
    for(const {tr,tc,isSlide,dr,dc} of reach)
      refSA[tr*9+tc].push({fr:r, fc:c, owner:bd[r][c].o, isSlide, dr, dc});
  }

  let errors = 0;

  // squareAttackersの比較
  for(let sq=0;sq<81;sq++){
    const got = squareAttackers[sq];
    const ref = refSA[sq];
    if(got.length !== ref.length){
      const r=Math.floor(sq/9), c=sq%9;
      console.warn(`[${label}] squareAttackers[${r},${c}] 件数不一致: got=${got.length} ref=${ref.length}`);
      console.warn('  got:', JSON.stringify(got));
      console.warn('  ref:', JSON.stringify(ref));
      errors++;
      if(errors > 5) break;
      continue;
    }
    for(const re of ref){
      const found = got.some(g => g.fr===re.fr && g.fc===re.fc && g.owner===re.owner && g.dr===re.dr && g.dc===re.dc);
      if(!found){
        const r=Math.floor(sq/9), c=sq%9;
        console.warn(`[${label}] squareAttackers[${r},${c}] 要素なし:`, JSON.stringify(re));
        console.warn('  got:', JSON.stringify(got));
        errors++;
        if(errors > 5) break;
      }
    }
  }

  // pieceReachの比較
  for(let sq=0;sq<81;sq++){
    const r=Math.floor(sq/9), c=sq%9;
    if(!bd[r][c]) continue;
    const got = pieceReach[sq];
    const ref = refPR[sq];
    if(got.length !== ref.length){
      console.warn(`[${label}] pieceReach[${r},${c}](${bd[r][c].p}) 件数不一致: got=${got.length} ref=${ref.length}`);
      console.warn('  got:', JSON.stringify(got));
      console.warn('  ref:', JSON.stringify(ref));
      errors++;
      if(errors > 5) break;
    }
  }

  if(errors === 0) console.log(`[${label}] OK attackMaps正常`);
  return errors === 0;
}

// applyMoveInPlace後にマップを差分更新
function updateMapsApply(bd, mv, o, undo){
  if(mv.drop){
    // Case C: 打ち手
    stopSlidesAt(bd, mv.tr, mv.tc);
    const reach = computePieceReach(bd, mv.tr, mv.tc);
    addPieceToMaps(mv.tr, mv.tc, reach, o);
    return;
  }
  const hadCapture = !!undo.toCell;
  if(hadCapture){
    // Case B: 駒取り
    removePieceFromMaps(mv.tr, mv.tc);       // 取られた駒の利きを除去
    removePieceFromMaps(mv.fr, mv.fc);       // 移動した駒の古い利きを除去
    extendSlidesFrom(bd, mv.fr, mv.fc);      // frが空いた → slide延長
    // tr はもとから塞がっていた → stopSlides不要
    const reach = computePieceReach(bd, mv.tr, mv.tc);
    addPieceToMaps(mv.tr, mv.tc, reach, o);
  } else {
    // Case A: 空マス移動
    removePieceFromMaps(mv.fr, mv.fc);       // 移動した駒の古い利きを除去
    extendSlidesFrom(bd, mv.fr, mv.fc);      // frが空いた → slide延長
    stopSlidesAt(bd, mv.tr, mv.tc);          // trが塞がった → slide止める
    const reach = computePieceReach(bd, mv.tr, mv.tc);
    addPieceToMaps(mv.tr, mv.tc, reach, o);
  }
}

// undoMoveInPlace後にマップを差分更新
function updateMapsUndo(bd, mv, o, undo){
  if(undo.drop){
    // Case C undo: 打ち手を戻す
    removePieceFromMaps(mv.tr, mv.tc);       // 打った駒の利きを除去
    extendSlidesFrom(bd, mv.tr, mv.tc);      // trが空いた → slide延長
    return;
  }
  const hadCapture = !!undo.toCell;
  if(hadCapture){
    // Case B undo: 駒取りを戻す
    removePieceFromMaps(mv.tr, mv.tc);       // 移動駒の利きを除去
    // tr はまだ塞がっている（取られた駒が戻る）→ stopSlides不要
    stopSlidesAt(bd, mv.fr, mv.fc);          // frが塞がった → slide止める
    const reachFr = computePieceReach(bd, mv.fr, mv.fc);
    addPieceToMaps(mv.fr, mv.fc, reachFr, undo.fromCell.o);
    const reachTr = computePieceReach(bd, mv.tr, mv.tc);
    addPieceToMaps(mv.tr, mv.tc, reachTr, undo.toCell.o);
  } else {
    // Case A undo: 空マス移動を戻す
    removePieceFromMaps(mv.tr, mv.tc);       // 移動駒の利きを除去
    extendSlidesFrom(bd, mv.tr, mv.tc);      // trが空いた → slide延長
    stopSlidesAt(bd, mv.fr, mv.fc);          // frが塞がった → slide止める
    const reach = computePieceReach(bd, mv.fr, mv.fc);
    addPieceToMaps(mv.fr, mv.fc, reach, undo.fromCell.o);
  }
}

// ── attackedBy フルスキャン（root用・互換） ──
function buildAttackedBy(bd){
  const ab = {};
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    if(!bd[r][c]) continue;
    rawMoves(bd, r, c).forEach(([dr,dc])=>{
      const k = dr*9+dc;
      if(!ab[k]) ab[k] = new Map();
      const o = bd[r][c].o, pv = PV[bd[r][c].p]||0;
      const cur = ab[k].get(o);
      ab[k].set(o, cur===undefined ? pv : Math.min(cur, pv));
    });
  }
  return ab;
}

// 合法手生成（手のみ・内部ノード用）
function movesOnly(bd,hd,o,elim){
  if(elim[o]) return [];
  const _t = performance.now();
  moveGenCount++;
  const res=[];
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell=bd[r][c]; if(!cell||cell.o!==o) continue;
    const dests=rawMoves(bd,r,c);
    dests.forEach(([tr,tc])=>{
      const target=bd[tr][tc];
      if(cpuCollusion && !humanEliminated &&
         o!==humanPlayer && 
         target && 
         target.o!==humanPlayer &&
         !elim[target.o])
         return;
      const canPro=!cell.pr&&['FU','KY','KE','GIN','KAKU','HI'].includes(cell.p);
      const inZone=canPro&&(inPromoZone(o,r,c)||inPromoZone(o,tr,tc));
      const must=mustPromote(cell.p,o,tr,tc);
      const base={fr:r,fc:c,tr,tc,drop:false};
      if(inZone){ if(must) res.push({...base,pro:true}); else{res.push({...base,pro:false});res.push({...base,pro:true});} }
      else res.push({...base,pro:false});
    });
  }
  const seen=new Set();
  hd[o].forEach(piece=>{
    if(seen.has(piece)) return; seen.add(piece);
    for(let r=0;r<9;r++) for(let c=0;c<9;c++){
      if(bd[r][c]) continue;
      if((piece==='KY'||piece==='KE')&&mustPromote(piece,o,r,c)) continue;
      if(piece==='FU'&&mustPromote('FU',o,r,c)) continue;
      if(piece==='FU'){
        let nifu=false;
        if(o===0||o===1){ for(let rr=0;rr<9;rr++){const cl=bd[rr][c];if(cl?.o===o&&cl?.p==='FU'&&!cl?.pr){nifu=true;break;}} }
        else{ for(let cc=0;cc<9;cc++){const cl=bd[r][cc];if(cl?.o===o&&cl?.p==='FU'&&!cl?.pr){nifu=true;break;}} }
        if(nifu) continue;
      }
      res.push({fr:-1,fc:-1,tr:r,tc:c,piece,pro:false,drop:true});
    }
  });
  return res;
}

// 合法手生成（root用・attackedBy付き）
function allMovesOn(bd,hd,o,elim){
  const moves = movesOnly(bd,hd,o,elim);
  const attackedBy = buildAttackedBy(bd);
  gAttackedBy = attackedBy;
  return {moves, attackedBy};
}

// elim配列を使った次の生存プレイヤー取得
function nextAliveOn(elim, current){
  let next = (current + 1) % 3;
  for(let i=0; i<3; i++){
    if(!elim[next]) return next;
    next = (next + 1) % 3;
  }
  return -1;
}
// 候補手ソート用スコア（minimax全ノードで呼ばれるので軽量に）
function quickMoveScore(bd, mv, owner, attackedBy={}) {
  // attackedByで危険チェック（一発判定・軽量）
  const isDanger = (r, c, o) => {
    const key = r*9+c;
    if(!attackedBy[key]) return false;
    return [...attackedBy[key].keys()].some(eo => eo !== o);
  };

  if(mv.drop){
    const tempBd = bd.map(r => r.slice());
    tempBd[mv.tr] = tempBd[mv.tr].slice();
    tempBd[mv.tr][mv.tc] = {p: mv.piece, o: owner ?? -1, pr: false};
    const dests = rawMoves(tempBd, mv.tr, mv.tc);
    const mobilityGain = dests.length * AI_MOBILITY_SCALE;
    const myVal = PV[mv.piece] || 0;
    const dangerPenalty = isDanger(mv.tr, mv.tc, owner??-1) ? myVal * AI_DANGER_SCALE : 0;
    const handCost = myVal * AI_QMS_HAND_COST;
    return mobilityGain - dangerPenalty - handCost;
  }
  const target = bd[mv.tr][mv.tc];
  if(target) return 10000 + (PV[target.p]||0) - ((PV[bd[mv.fr][mv.fc].p]||0) * 0.1) + (mv.pro ? 50 : 0);

  const piece = bd[mv.fr][mv.fc];
  const before = rawMoves(bd, mv.fr, mv.fc).length;
  const tempBd = bd.map(r => r.slice());
  tempBd[mv.tr] = tempBd[mv.tr].slice();
  tempBd[mv.fr] = tempBd[mv.fr].slice();
  tempBd[mv.tr][mv.tc] = {p: piece.p, o: piece.o, pr: mv.pro || piece.pr};
  tempBd[mv.fr][mv.fc] = null;
  const after = rawMoves(tempBd, mv.tr, mv.tc);
  const mobilityDelta = (after.length - before) * AI_MOBILITY_SCALE;

  const myVal = PV[piece.p] || 0;
  const escapBonus    = isDanger(mv.fr, mv.fc, piece.o) ? myVal * AI_DANGER_SCALE : 0;
  const dangerPenalty = isDanger(mv.tr, mv.tc, piece.o) ? myVal * AI_DANGER_SCALE : 0;

  // 角道・飛車道を開けるボーナス
  let openRoadBonus = 0;
  const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  for(const [dr,dc] of DIRS){
    let br = mv.fr+dr, bc = mv.fc+dc;
    while(br>=0&&br<9&&bc>=0&&bc<9){
      const cell = bd[br][bc];
      if(!cell){ br+=dr; bc+=dc; continue; }
      if(cell.o === piece.o && (cell.p==='HI'||cell.p==='KAKU'||cell.p==='RYU'||cell.p==='UMA'||cell.p==='KY')){
        const fdr=-dr, fdc=-dc;
        const isRook = cell.p==='HI'||cell.p==='RYU';
        const isBishop = cell.p==='KAKU'||cell.p==='UMA';
        const isLance = cell.p==='KY';
        const lanceDir = cell.o===0?[-1,0]:cell.o===1?[1,0]:[0,-1];
        const isDiag = Math.abs(dr)===1&&Math.abs(dc)===1;
        const isAxis = dr===0||dc===0;
        const isLanceDir = isLance && dr===lanceDir[0] && dc===lanceDir[1];
        if((isRook&&isAxis)||(isBishop&&isDiag)||isLanceDir){
          let fr2 = mv.fr+fdr, fc2 = mv.fc+fdc;
          let opened = 0;
          while(fr2>=0&&fr2<9&&fc2>=0&&fc2<9){
            if(tempBd[fr2][fc2]) break;
            opened++;
            fr2+=fdr; fc2+=fdc;
          }
          openRoadBonus += opened * AI_MOBILITY_SCALE;
        }
      }
      break;
    }
  }

  let entryBlockBonus = 0;
  for(let eo=0; eo<3; eo++){
    if(eo === owner) continue;
    const [ekr, ekc] = findKingOn(bd, eo);
    if(ekr < 0) continue;
    const advancing =
      (eo===0 && ekr <= 4) ||
      (eo===1 && ekr >= 4) ||
      (eo===2 && ekc <= 4);
    if(!advancing) continue;
    const pathSquares = new Set();
    if(eo===0){
      for(let r=0; r<ekr; r++) for(let dc=-1;dc<=1;dc++){
        const c=ekc+dc; if(c>=0&&c<9) pathSquares.add(r*9+c);
      }
    } else if(eo===1){
      for(let r=ekr+1; r<9; r++) for(let dc=-1;dc<=1;dc++){
        const c=ekc+dc; if(c>=0&&c<9) pathSquares.add(r*9+c);
      }
    } else {
      for(let c=0; c<ekc; c++) for(let dr=-1;dr<=1;dr++){
        const r=ekr+dr; if(r>=0&&r<9) pathSquares.add(r*9+c);
      }
    }
    const covered = after.filter(([r,c]) => pathSquares.has(r*9+c)).length;
    if(covered > 0){
      const dist = eo===0 ? ekr : eo===1 ? 8-ekr : ekc;
      entryBlockBonus += covered * Math.max(1, 5-dist) * AI_ENTRY_MULT * AI_ENTRY_BLOCK_RATE;
    }
  }

  return (mv.pro ? (PVP[piece.p]||0) * 0.5 : 0) + mobilityDelta + openRoadBonus + entryBlockBonus + escapBonus - dangerPenalty;
}
