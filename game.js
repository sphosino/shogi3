
// ── 初期化 ──
function init(){
  board=Array.from({length:9},()=>Array(9).fill(null));
  hand=[[],[],[]];
  turn=0; gover=false; winner=-1;
  selected=null; vmoves=[]; selHand=false; promoQ=null;
  eliminated=[false,false,false];
  lastMove=null; humanEliminated=false; gameGen++;
  moveCount=0;
  winType='normal';
  kifu=[];
  renderKifu();

  // P0 (下、前=上)
  // row8: 銀金玉金銀  row7: 飛・角  row6: 歩×5
  [[8,0,'GIN'],[8,1,'KIN'],[8,2,'OU'],[8,3,'KIN'],[8,4,'GIN'],
   [7,0,'HI'],[7,4,'KAKU']].forEach(([r,c,p])=>board[r][c]={p,o:0,pr:false});
  for(let c=0;c<=4;c++) board[6][c]={p:'FU',o:0,pr:false};
  hand[0].push('KY','KE');

  // P1 (上、前=下)
  // row0: 銀金玉金銀  row1: 角・飛(P0と逆)  row2: 歩×5
  [[0,0,'GIN'],[0,1,'KIN'],[0,2,'OU'],[0,3,'KIN'],[0,4,'GIN'],
   [1,0,'KAKU'],[1,4,'HI']].forEach(([r,c,p])=>board[r][c]={p,o:1,pr:false});
  for(let c=0;c<=4;c++) board[2][c]={p:'FU',o:1,pr:false};
  hand[1].push('KY','KE');

  // P2 (右、前=左) 中央(row4)に王が来るよう配置
  // col8: 銀金玉金銀  col7: 角・飛  col6: 歩×5
  [[2,8,'GIN'],[3,8,'KIN'],[4,8,'OU'],[5,8,'KIN'],[6,8,'GIN'],
   [2,7,'HI'],[6,7,'KAKU']].forEach(([r,c,p])=>board[r][c]={p,o:2,pr:false});
  for(let r=2;r<=6;r++) board[r][6]={p:'FU',o:2,pr:false};
  hand[2].push('KY','KE');

  viewPlayer = selfPlayMode ? 0 : humanPlayer;
  buildAttackMaps(board); // 初期盤面で双方向利き筋マップ構築
  if(!selfPlayMode) setStatus(pName(humanPlayer)+'の番です');
  render();
  // 人間がP0以外のとき、最初のAIターンをキック
  if(selfPlayMode || humanPlayer!==0) setTimeout(()=>kickAI(), selfPlayMode?0:AI_DELAY_MS);
}

function kickAI(){
  if(gover) return;
  // 通常モード: humanPlayerのターンはスキップ
  if(!selfPlayMode && turn===humanPlayer) return;
  const showBoard = !selfPlayMode || true;
  setStatus(pName(turn)+'が考え中...');
  if(showBoard) render();
  const _g=gameGen;
  // 自己対局モードはdelayなしで即実行（ただし描画反映のため最小delay）
  const delay = selfPlayMode ? 0 : AI_DELAY_MS;
  const thinkDelay = (currentDifficulty==='normal'||currentDifficulty==='hard') ? 50 : 16;
  setTimeout(()=>{
    if(_g!==gameGen||gover) return;
    setTimeout(()=>{
      if(_g!==gameGen||gover) return;
      try{
        const mv=aiMove(turn,board,hand,eliminated);
        if(mv){ applyMove(mv,turn); if(showBoard) render(); if(!gover) nextTurn(board); }
        else { if(!gover) nextTurn(board); }
      }catch(e){
        console.error('aiMove error:',e);
        if(!gover) nextTurn(board);
      }
    }, thinkDelay);
  },delay);
}

function setStatus(msg){document.getElementById('info').textContent=msg;}
function pName(o){ return o===humanPlayer?'あなた':PNAME_BASE[o]; }

// 将棋符号変換
const SUJI = ['９','８','７','６','５','４','３','２','１']; // col 0→９, col 8→１
const DAN  = ['一','二','三','四','五','六','七','八','九']; // row 0→一, row 8→九
function toSuji(c){ return SUJI[c]; }
function toDan(r){ return DAN[r]; }
function toFugo(mv, o){
  const pcName = mv.drop
    ? PC[mv.piece]
    : (board[mv.tr]?.[mv.tc] ? PC[board[mv.tr][mv.tc].p] : '') || PC[board[mv.fr]?.[mv.fc]?.p] || '？';
  const dest = toSuji(mv.tc) + toDan(mv.tr);
  const from = mv.drop ? '打' : '(' + toSuji(mv.fc) + toDan(mv.fr) + ')';
  const pro = mv.pro ? '成' : '';
  return dest + pcName + pro + from;
}

// 特別ルール: 被取得者が取得者より3個以上多ければ手駒にできる
// 追加条件①：被取得者の玉が中央（5段目/5列目）以上に進んでいる場合
// 追加条件②：成り駒を取った場合は、条件なしで手駒にできる
// 修正後：引数で盤面状態を受け取れるようにする

function canKeep(attackerO, victimO, victimPiece,bd,hd, elim){
  if (keepAllPieces === 'all' || keepAllPieces === true) return true;
  if (keepAllPieces === 'next') return false; // お裾分けモードは別処理
  if (elim.some(e=>e)) return true;
  if (victimPiece && victimPiece.pr) return true;

  // ★ 引数の bd を使用
  const [kr, kc] = findKingOn(bd, victimO);
  let isBeyondCenter = false;
  if (kr !== -1) {
    if (victimO === 0) isBeyondCenter = (kr <= 4);
    else if (victimO === 1) isBeyondCenter = (kr >= 4);
    else if (victimO === 2) isBeyondCenter = (kc <= 4);
  }
  if (isBeyondCenter) return true;

  // ★ 引数の bd, hd を使用
  return (countPiecesOn(bd,hd, victimO) - countPiecesOn(bd,hd,attackerO) >= 3);
}

// ── 合法手生成 ──
function rawMoves(bd,r,c,attackedBy){
  const cell=bd[r][c]; if(!cell) return [];
  const {p,o,pr}=cell, res=[];

  const push=(nr,nc)=>{
    res.push([nr,nc]);
    if(attackedBy){
      const key=nr*9+nc;
      if(!attackedBy[key]) attackedBy[key]=new Map();
      const pv=PV[p]||0;
      const cur=attackedBy[key].get(o);
      attackedBy[key].set(o, cur===undefined ? pv : Math.min(cur, pv));
    }
  };

  const step=(dr,dc)=>{
    const [rdr,rdc]=rotDir(dr,dc,o);
    const nr=r+rdr,nc=c+rdc;
    if(!inB(nr,nc)||bd[nr][nc]?.o===o) return;
    push(nr,nc);
  };

  const slide=(dr,dc)=>{
    let nr=r+dr,nc=c+dc;
    while(inB(nr,nc)){
      if(bd[nr][nc]?.o===o) break;
      push(nr,nc);
      if(bd[nr][nc]) break;
      nr+=dr; nc+=dc;
    }
  };

  // 成り駒（金将動き）
  if(pr&&['FU','KY','KE','GIN'].includes(p)){
    [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]].forEach(([dr,dc])=>step(dr,dc));
    return res;
  }

  switch(p){
    case 'FU': step(-1,0); break;
    case 'KY': { // 香車: 前方スライド
      const [kdr,kdc]=rotDir(-1,0,o);
      let knr=r+kdr,knc=c+kdc;
      while(inB(knr,knc)){
        if(bd[knr][knc]?.o===o) break;
        res.push([knr,knc]);
        if(bd[knr][knc]) break;
        knr+=kdr; knc+=kdc;
      }
      break;
    }
    case 'KE': // 桂馬: 前方2+樱19ジャンプ
      [[-2,-1],[-2,1]].forEach(([dr,dc])=>step(dr,dc)); break;
    case 'GIN':
      [[-1,-1],[-1,0],[-1,1],[1,-1],[1,1]].forEach(([dr,dc])=>step(dr,dc)); break;
    case 'KIN':
      [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]].forEach(([dr,dc])=>step(dr,dc)); break;
    case 'HI':
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>slide(dr,dc));
      if(pr)[[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc])=>step(dr,dc)); break;
    case 'KAKU':
      [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc])=>slide(dr,dc));
      if(pr)[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>step(dr,dc)); break;
    case 'OU':
      for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++)
        if(dr||dc) step(dr,dc);
      break;
  }
  return res;
}

function inPromoZone(o,r,c){
  if(o===0) return r<=2;   // P0の敵陣: 上3行
  if(o===1) return r>=6;   // P1の敵陣: 下3行
  return c<=2;             // P2の敵陣: 左3列
}

function mustPromote(p,o,tr,tc){
  if(p==='FU'||p==='KY'){
    if(o===0) return tr===0;
    if(o===1) return tr===8;
    return tc===0;
  }
  if(p==='KE'){
    if(o===0) return tr<=1;
    if(o===1) return tr>=7;
    return tc<=1;
  }
  return false;
}

function allMoves(o,bd){
  if(eliminated[o]) return [];
  const res=[];

  // 盤上の駒
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell=bd[r][c];
    if(!cell||cell.o!==o) continue;
    rawMoves(bd,r,c).forEach(([tr,tc])=>{
      const canPro=!cell.pr&&['FU','KY','KE','GIN','KAKU','HI'].includes(cell.p);
      const inZone=canPro&&(inPromoZone(o,r,c)||inPromoZone(o,tr,tc));
      const must=mustPromote(cell.p,o,tr,tc);
      const base={fr:r,fc:c,tr,tc,drop:false};
      if(inZone){
        if(must) res.push({...base,pro:true});
        else{ res.push({...base,pro:false}); res.push({...base,pro:true}); }
      } else res.push({...base,pro:false});
    });
  }

  // 持ち駒打ち
  const seen=new Set();
  hand[o].forEach(piece=>{
    if(seen.has(piece)) return; seen.add(piece);
    for(let r=0;r<9;r++) for(let c=0;c<9;c++){
      if(bd[r][c]) continue;
      // KY,KE: 行き所なしチェック
      if(piece==='KY'||piece==='KE'){
        if(mustPromote(piece,o,r,c)) continue;
      }
      // FU: 二歩・行き所なしチェック
      if(piece==='FU'){
        if(mustPromote('FU',o,r,c)) continue;
        let nifu=false;
        if(o===0||o===1){
          for(let rr=0;rr<9;rr++){const cl=bd[rr][c];if(cl?.o===o&&cl?.p==='FU'&&!cl?.pr){nifu=true;break;}}
        } else {
          for(let cc=0;cc<9;cc++){const cl=bd[r][cc];if(cl?.o===o&&cl?.p==='FU'&&!cl?.pr){nifu=true;break;}}
        }
        if(nifu) continue;
      }
      res.push({fr:-1,fc:-1,tr:r,tc:c,piece,pro:false,drop:true});
    }
  });
  return res;
}

// ── 手を適用 ──
function applyMove(mv,o){
  moveCount++;
  // 500手制限：駒価値で順位決定
  if(moveCount >= MAX_MOVES){
    const scores = pieceScores(board, hand, [0,1,2]);
    const alive = [0,1,2].filter(i=>!eliminated[i]);
    const best = alive.reduce((a,b)=>scores[a]>=scores[b]?a:b);
    winType='limit'; gover=true; winner=best;
    const msg = `⏱ ${MAX_MOVES}手制限！駒価値: 青${scores[0]} 赤${scores[1]} 緑${scores[2]} → ${['青将','赤将','緑将'][best]}の勝ち！`;
    setStatus(msg);
    render();
    return;
  }
  if(mv.drop){
    const idx=hand[o].indexOf(mv.piece);
    hand[o].splice(idx,1);
    board[mv.tr][mv.tc]={p:mv.piece,o,pr:false};
    const _fugo0=toSuji(mv.tc)+toDan(mv.tr)+PC[mv.piece]+'打';
    lastMove={tr:mv.tr,tc:mv.tc,o,drop:true,fugo:_fugo0};
    kifu.push({fugo:_fugo0,col:PCOL[o],name:PNAME_BASE[o]});
    renderKifu();
    return;
  }

  const cell=board[mv.fr][mv.fc];
  const cap=board[mv.tr][mv.tc];

  if(cap){
    if(cap.p==='OU'){
      // 王を取った: そのプレイヤー脱落
      board[mv.tr][mv.tc]={p:cell.p,o,pr:mv.pro||cell.pr};
      board[mv.fr][mv.fc]=null;
      eliminated[cap.o]=true;
      if(cap.o===humanPlayer) humanEliminated=true;
      const alive=eliminated.filter(e=>!e).length;
      // lastMove / 棋譜を更新
      const _fugoKing=toSuji(mv.tc)+toDan(mv.tr)+PC[cell.p]+'('+toSuji(mv.fc)+toDan(mv.fr)+')';
      lastMove={tr:mv.tr,tc:mv.tc,fr:mv.fr,fc:mv.fc,o,fugo:_fugoKing};
      kifu.push({fugo:_fugoKing,col:PCOL[o],name:PNAME_BASE[o]});
      renderKifu();
      if(alive<=1){
        gover=true; winner=o;
        setStatus('🎉 '+pName(o)+'の勝ち！');
      } else {
        setStatus(pName(cap.o)+'が脱落！残り'+alive+'人'+(cap.o===humanPlayer?' CPU同士の対局へ':''));
      }
      render();
      return;
    }
    // 取り駒ルール適用
    if(keepAllPieces === 'next'){
      // お裾分けモード：第三者の持ち駒になる（2人なら自分が受け取る）
      const others = [0,1,2].filter(p => !eliminated[p] && p !== o && p !== cap.o);
      const nextP = others.length > 0 ? others[0] : o;
      hand[nextP].push(cap.p);
    } else if(eliminated[cap.o] || canKeep(o,cap.o,cap,board,hand,eliminated)){
      hand[o].push(cap.p);
    }
    // else: 消える
  }

  board[mv.tr][mv.tc]={p:cell.p,o,pr:mv.pro||cell.pr};
  board[mv.fr][mv.fc]=null;
  const _fugo1=toSuji(mv.tc)+toDan(mv.tr)+(mv.pro?(PCP[cell.p]||PC[cell.p]):PC[cell.p])+(mv.pro?'':'')+'('+toSuji(mv.fc)+toDan(mv.fr)+')';
  lastMove={tr:mv.tr,tc:mv.tc,fr:mv.fr,fc:mv.fc,o,fugo:_fugo1};
  kifu.push({fugo:_fugo1,col:PCOL[o],name:PNAME_BASE[o]});
  renderKifu();

  // トライルール：王が敵陣に入ったら勝ち（ただし敵の利きがないマスに限る）
  if(cell.p==='OU'){
    const tr2=mv.tr, tc2=mv.tc;
    let tryWin=false;
    if(o===0 && tr2<=0) tryWin=true;
    if(o===1 && tr2>=8) tryWin=true;
    if(o===2 && tc2<=0) tryWin=true;
    if(tryWin){
      if(squareAttackedBy(board, tr2, tc2, o, eliminated)){
        // 利きあり→入玉不可、通常の手として続行
      } else {
        winType='trywin'; gover=true; winner=o;
        setStatus('🏯 入玉！'+pName(o)+'の勝ち！');
        render();
        return;
      }
    }
  }
}

// ── applyMoveInPlace / undoMoveInPlace ──
// minimaxの内部ノードでボードコピーの代わりに使う
// 戻り値のundoオブジェクトをundoMoveInPlaceに渡すと完全に元に戻る
function applyMoveInPlace(bd, hd, elim, mv, o) {
  const undo = {tryWin: false, entryWin: false, handAdded: null, handAddedTo: -1, handIdx: -1, elimIdx: -1, drop: mv.drop};

  if (mv.drop) {
    const idx = hd[o].indexOf(mv.piece);
    hd[o].splice(idx, 1);
    bd[mv.tr][mv.tc] = {p: mv.piece, o, pr: false};
    undo.handIdx = idx;
    updateMapsApply(bd, mv, o, undo);
    return undo;
  }

  const fromCell = bd[mv.fr][mv.fc];
  const toCell   = bd[mv.tr][mv.tc];
  undo.fromCell = fromCell; // 元オブジェクト参照を保存
  undo.toCell   = toCell;

  // 王を取る → tryWin + elim更新
  if (toCell && toCell.p === 'OU') {
    bd[mv.tr][mv.tc] = {p: fromCell.p, o, pr: mv.pro || fromCell.pr};
    bd[mv.fr][mv.fc] = null;
    undo.elimIdx = toCell.o;
    elim[toCell.o] = true;
    undo.tryWin = true;
    updateMapsApply(bd, mv, o, undo);
    return undo;
  }

  // 通常の取得：持ち駒に加えるか判定
  if (toCell) {
    let recipient = -1; // 持ち駒を受け取るプレイヤー（-1=消滅）
    if (keepAllPieces === 'next') {
      // お裾分けモード：第三者へ（2人なら自分が受け取る＝普通将棋）
      const others = [0,1,2].filter(p => !elim[p] && p !== o && p !== toCell.o);
      recipient = others.length > 0 ? others[0] : o;
    } else if (keepAllPieces === 'all' || keepAllPieces === true) {
      recipient = o;
    } else {
      // 消滅ありモード：条件判定
      let addToHand = false;
      if (elim.some(e=>e)) {
        addToHand = true;
      } else if (toCell.pr) {
        addToHand = true;
      } else {
        const [kr, kc] = findKingOn(bd, toCell.o);
        if (kr !== -1) {
          let isBeyondCenter = false;
          if      (toCell.o === 0) isBeyondCenter = (kr <= 4);
          else if (toCell.o === 1) isBeyondCenter = (kr >= 4);
          else if (toCell.o === 2) isBeyondCenter = (kc <= 4);
          if (isBeyondCenter) {
            addToHand = true;
          } else {
            const diff = countPiecesOn(bd, hd, toCell.o) - countPiecesOn(bd, hd, o);
            if (diff >= 3) addToHand = true;
          }
        }
      }
      if (addToHand) recipient = o;
    }
    if (recipient >= 0) {
      hd[recipient].push(toCell.p);
      undo.handAdded = toCell.p;
      undo.handAddedTo = recipient;
    }
  }

  // 駒移動
  bd[mv.tr][mv.tc] = {p: fromCell.p, o, pr: mv.pro || fromCell.pr};
  bd[mv.fr][mv.fc] = null;

  if (fromCell.p === 'OU') {
    if ((o===0 && mv.tr<=0) || (o===1 && mv.tr>=8) || (o===2 && mv.tc<=0)) {
      if(!squareAttackedBy(bd, mv.tr, mv.tc, o, elim)){
          undo.tryWin = true;
          undo.entryWin = true;
      }
    }
  }

  updateMapsApply(bd, mv, o, undo);
  if(DEBUG_ATTACK_MAPS && inAISearch) validateAttackMaps(bd, `apply ${mv.drop?'drop':mv.fr+','+mv.fc+'→'+mv.tr+','+mv.tc}`);
  return undo;
}

function undoMoveInPlace(bd, hd, elim, mv, o, undo) {
  if (undo.drop) {
    bd[mv.tr][mv.tc] = null;
    hd[o].splice(undo.handIdx, 0, mv.piece); // 元のインデックスに戻す
    updateMapsUndo(bd, mv, o, undo);
    return;
  }

  // 盤面を元に戻す
  bd[mv.fr][mv.fc] = undo.fromCell;
  bd[mv.tr][mv.tc] = undo.toCell;

  // 持ち駒を元に戻す
  if (undo.handAdded !== null && undo.handAddedTo >= 0) {
    const idx = hd[undo.handAddedTo].lastIndexOf(undo.handAdded);
    if (idx >= 0) hd[undo.handAddedTo].splice(idx, 1);
  }

  // elimを元に戻す
  if (undo.elimIdx >= 0) {
    elim[undo.elimIdx] = false;
  }

  updateMapsUndo(bd, mv, o, undo);
  if(DEBUG_ATTACK_MAPS && inAISearch) validateAttackMaps(bd, `undo ${mv.drop?'drop':mv.fr+','+mv.fc+'←'+mv.tr+','+mv.tc}`);
}

function countPieces(o){
  let n = hand[o].length;
  for(let r=0;r<9;r++) for(let c=0;c<9;c++) if(board[r][c]?.o===o) n++;
  return n;
}
function countPiecesOn(b,h,o){
  let n=h[o].length;
  for(let r=0;r<9;r++) for(let c=0;c<9;c++) if(b[r][c]?.o===o) n++;
  return n;
}

function findKingOn(b,o){
  for(let r=0;r<9;r++) for(let c=0;c<9;c++)
    if(b[r][c]?.p==='OU'&&b[r][c]?.o===o) return [r,c];
  return [-1,-1];
}

// 駒価値合計を各プレイヤー分まとめて返す
function pieceScores(b, h, owners) {
  const scoresMap = {};
  owners.forEach(o => scoresMap[o] = 0);
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell = b[r][c];
    if(cell && owners.includes(cell.o) && cell.p !== 'OU')
      scoresMap[cell.o] += (PV[cell.p]||0) + (cell.pr ? (PVP[cell.p]||0) : 0);
  }
  owners.forEach(o => {
    if(h[o]) h[o].forEach(p => scoresMap[o] += (PV[p]||0) * AI_HAND_BONUS_RATE);
  });
  return owners.map(o => scoresMap[o]);
}


function calcEntryBonus(b, o){
  const [kr,kc] = findKingOn(b, o);
  if(kr<0) return 0;
  const dist = o===0 ? kr : o===1 ? 8-kr : kc;
  return (Math.pow(2, Math.max(0, 4-dist)) - 1) * AI_ENTRY_MULT;
}
