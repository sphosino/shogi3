// ── 棋譜 ──
function renderKifu(){
  const el=document.getElementById('kifu-list');
  if(!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  // 最下部に戻ったら現在局の棋譜に切り替え
  if(selfPlayMode && kifuView !== null && atBottom){
    kifuView = null;
  }
  const displayKifu = (selfPlayMode && kifuView !== null) ? kifuView : kifu;
  el.innerHTML=displayKifu.map((k,i)=>{
    const cls=i===displayKifu.length-1?'latest':'';
    return '<div class="'+cls+'">'+
      '<span style="color:#806040;font-size:10px;">'+(i+1)+'.</span> '+
      '<span style="color:'+k.col+'">'+k.name+'</span> '+
      '<span style="color:#e8d095;">'+k.fugo+'</span>'+
      '</div>';
  }).join('');
  // 現在局表示中のみ自動スクロール
  if(!selfPlayMode || (kifuView === null && atBottom)) el.scrollTop=el.scrollHeight;
}

// ── 視点・Canvas ──
function setView(vp){ viewPlayer=vp; render(); }

function fitCanvas(){
  if(!canvas) return;
  const w=canvas.clientWidth;
  if(!w){ requestAnimationFrame(fitCanvas); return; }
  window._canvasScale = w / CW;
}

// ── プレイヤー設定 ──
function setHumanPlayer(p){
  humanPlayer=p; viewPlayer=p;
  [0,1,2].forEach(i=>PNAME[i]=PNAME_BASE[i]);
  PNAME[p]=PNAME_BASE[p]+'(あなた)';
  [0,1,2].forEach(i=>{
    const btn=document.getElementById('hb'+i);
    if(btn) btn.style.background=i===p?'#6a3500':'#3a1500';
  });
  if(editMode){
    gover=false; moveCount=0; kifu=[]; renderKifu(); turn=0; winType='normal'; lastMove=null; humanEliminated=eliminated[p]; gameGen++; render(); if(p!==0) setTimeout(()=>kickAI(), AI_DELAY_MS);
  } else if(!gover && moveCount > 0){
    // 停止後など局面が存在する場合はinitせず現局面から継続（editModeブランチと同じパターン）
    humanEliminated=eliminated[p];
    gover=false; kifu=[]; renderKifu();
    turn=0; winType='normal'; lastMove=null;
    gameGen++;
    selected=null; vmoves=[]; selHand=false; promoQ=null;
    render();
    if(p!==0) setTimeout(()=>kickAI(), AI_DELAY_MS);
  } else {
    init();
  }
}

// ── 自己対局モード ──
function setSelfPlayDiffBtns(locked){
  // 自己対局中はプレイヤー選択・難易度・共闘・盤面初期化ボタンを無効化
  ['init-btn',
   'diff-beginner','diff-easy','diff-normal','diff-hard',
   'col-on','col-off', 'sp-btn',
   'hb0','hb1','hb2'].forEach(id=>{
    const btn=document.getElementById(id);
    if(btn){ btn.disabled=locked; btn.style.opacity=locked?'0.35':'1'; }
  });
}
function toggleSelfPlay(){
  if(selfPlayMode){
    // 停止：パネルは残したまま、ボタンだけ変える
    selfPlayMode=false;

    // スクロールリスナーを掃除
    const _kl=document.getElementById('kifu-list');
    if(_kl&&_kl._spListener){ _kl.removeEventListener('scroll',_kl._spListener); _kl._spListener=null; }
    const cfg=DIFFICULTY_LEVELS[currentDifficulty];
    AI_SEARCH_DEPTH=cfg.depth;
    AI_NOISE=cfg.noise;
    setSelfPlayDiffBtns(false);
    document.getElementById('sp-btn').textContent='🤖 自己対局';
    document.getElementById('sp-stop-btn').textContent='✓ 停止済み';
    document.getElementById('sp-stop-btn').style.borderColor='#888';
    document.getElementById('sp-stop-btn').style.color='#888';
    document.getElementById('sp-stop-btn').disabled=true;
    document.getElementById('sp-status').textContent='停止中（結果は上記）';
    // 現在の局面・手番をそのまま維持（盤面リセットしない）
    humanPlayer=0;
    gameGen++; // キュー済みのkickAI/setTimeoutをすべて無効化
    document.getElementById('sp-resume-btn').style.display='inline-block';
    setTimeout(()=>fitCanvas(), 0); // レイアウト変化後にcanvasスケール再計算
    render();
  } else {
    // 開始：現在の難易度設定をそのまま使う
    selfPlayMode=true;
    selfPlayWins=[0,0,0];
    selfPlayTryWins=[0,0,0];
    selfPlayTryWinsBy=[0,0,0];
    selfPlayTryPiecesTotal=0;
    selfPlayTryPiecesCount=0;
    selfPlayDraws=0;
    selfPlayLimitWins=[0,0,0];
    selfPlayGames=0;
    selfPlayTotalMoves=0;
    document.getElementById('sp-panel').style.display='block';
    setTimeout(()=>fitCanvas(), 0); // sp-panel表示後にcanvasスケール再計算
    document.getElementById('sp-btn').textContent='⏹ 対局中...';
    document.getElementById('sp-stop-btn').textContent='■ 停止';
    document.getElementById('sp-stop-btn').style.borderColor='#ff4433';
    document.getElementById('sp-stop-btn').style.color='#ff4433';
    document.getElementById('sp-stop-btn').disabled=false;
    document.getElementById('sp-resume-btn').style.display='none';
    setSelfPlayDiffBtns(true); // 難易度ロック
    updateSpStats();
    // 現在の局面を開始局面として保存
    selfPlayStartBoard = board.map(r=>r.map(c=>c?{...c}:null));
    selfPlayStartHand  = hand.map(h=>h.slice());
    selfPlayStartElim  = eliminated.slice();
    // noise増加・三つ巴固定（humanPlayer=-1で共闘は誤動作するため）
    AI_NOISE=100;
    cpuCollusion=false;
    humanPlayer=-1;
    humanEliminated=false;
    startNextSelfPlay();
  }
}
function resumeSelfPlay(){
  if(selfPlayMode) return; // すでに動いていたら無視
  selfPlayMode = true;
  AI_NOISE = 100;
  cpuCollusion = false;
  humanPlayer = -1;
  humanEliminated = false;
  gameGen++;
  document.getElementById('sp-btn').textContent='⏹ 対局中...';
  document.getElementById('sp-stop-btn').textContent='■ 停止';
  document.getElementById('sp-stop-btn').style.borderColor='#ff4433';
  document.getElementById('sp-stop-btn').style.color='#ff4433';
  document.getElementById('sp-stop-btn').disabled=false;
  document.getElementById('sp-resume-btn').style.display='none';
  setSelfPlayDiffBtns(true);
  setTimeout(()=>fitCanvas(), 0); // レイアウト変化後にcanvasスケール再計算
  const pct=i=>{ const t=selfPlayGames; return t>0?Math.round(selfPlayWins[i]/t*100)+'%':'-%'; };
  document.getElementById('sp-status').textContent=`対局中... 青${pct(0)} 赤${pct(1)} 緑${pct(2)}`;
  // gover状態（1局終了後に停止）なら次局開始、そうでなければ現局面から再開
  if(gover){
    setTimeout(()=>startNextSelfPlay(), 0);
  } else {
    setTimeout(()=>kickAI(), 0);
  }
}
function updateSpStats(){
  const total=selfPlayGames;
  [0,1,2].forEach(i=>{
    document.getElementById('sp-w'+i).textContent=selfPlayWins[i];
    document.getElementById('sp-t'+i).textContent=selfPlayTryWins[i];
    document.getElementById('sp-l'+i).textContent=selfPlayLimitWins[i];
    document.getElementById('sp-p'+i).textContent=total>0?Math.round(selfPlayWins[i]/total*100)+'%':'0%';
  });
  document.getElementById('sp-wd').textContent=selfPlayDraws;
  document.getElementById('sp-avg').textContent=total>0?Math.round(selfPlayTotalMoves/total)+'手':'-';
  document.getElementById('sp-total').textContent=total+'局完了';
  const totalTryWins = selfPlayTryWins.reduce((s,v)=>s+v,0);
  const tryRate = total>0 ? Math.round(totalTryWins/total*100) : '-';
  const t3 = selfPlayTryWinsBy[2], t2 = selfPlayTryWinsBy[1], t1 = selfPlayTryWinsBy[0];
  const avgPieces = selfPlayTryPiecesCount > 0 ? Math.round(selfPlayTryPiecesTotal / selfPlayTryPiecesCount) : '-';
  document.getElementById('sp-tryrate').textContent=
    `入玉率: ${tryRate}%（${totalTryWins}/${total}局） 3人:${t3} 2人:${t2} 平均駒数:${avgPieces}`;
  const pct=i=>total>0?Math.round(selfPlayWins[i]/total*100)+'%':'-%';
  document.getElementById('sp-status').textContent=`対局中... 青${pct(0)} 赤${pct(1)} 緑${pct(2)}`;
}
function startNextSelfPlay(){
  if(!selfPlayMode) return;
  // 保存した初期局面から復元
  if(selfPlayStartBoard){
    board = selfPlayStartBoard.map(r=>r.map(c=>c?{...c}:null));
    hand  = selfPlayStartHand.map(h=>h.slice());
    eliminated = selfPlayStartElim.slice();
  } else {
    init();
  }
  gover=false; winner=-1; moveCount=0; winType='normal';
  turn=0; lastMove=null;
  humanEliminated=false; gameGen++;
  // 最下部でなければ今の棋譜を保持して閲覧継続、最下部なら即クリア
  const el=document.getElementById('kifu-list');
  const atBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  if(!atBottom && kifu.length > 0) kifuView = kifu.slice();
  else kifuView = null;
  kifu=[]; renderKifu(); render();
  setTimeout(()=>kickAI(), 0);
  watchSelfPlay(gameGen);
}
function isKifuAtBottom(){
  const el=document.getElementById('kifu-list');
  if(!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
function watchSelfPlay(gen){
  if(!selfPlayMode||gen!==gameGen) return;
  if(gover){
    selfPlayGames++;
    selfPlayTotalMoves+=moveCount;
    if(winner>=0 && winner<=2){
      selfPlayWins[winner]++;
      if(winType==='trywin'){
        selfPlayTryWins[winner]++;
        const alive = eliminated.filter(e=>!e).length;
        selfPlayTryWinsBy[alive-1]++;
        // 盤上+持ち駒の総駒数
        let totalPieces = 0;
        for(let r=0;r<9;r++) for(let c=0;c<9;c++) if(board[r][c]) totalPieces++;
        for(let o=0;o<3;o++) totalPieces += hand[o].length;
        selfPlayTryPiecesTotal += totalPieces;
        selfPlayTryPiecesCount++;
      };
      if(winType==='limit') selfPlayLimitWins[winner]++;
    } else {
      selfPlayDraws++;
    }
    updateSpStats();
    waitAndStartNext();
  } else {
    setTimeout(()=>watchSelfPlay(gen), 50);
  }
}
function waitAndStartNext(){
  if(!selfPlayMode) return;
  // 棋譜位置に関わらず次局へ進む（棋譜閲覧中でも対局は継続）
  setTimeout(()=>startNextSelfPlay(), 200);
}

// ── ターン管理 ──
function togglePrevThink(){
  const prevEl  = document.getElementById('prev-think-panel');
  const prevBtn = document.getElementById('prev-think-btn');
  if(!prevEl) return;
  const showing = prevEl.style.display !== 'none';
  prevEl.style.display = showing ? 'none' : 'block';
  if(prevBtn) prevBtn.textContent = showing ? '📋 直前の読み筋を見る' : '📋 直前の読み筋を閉じる';
}

function nextTurn(bd) {
  if (gover) return;

  let next = nextAliveOn(eliminated, turn);
  if (next === -1) {
    gover = true;
    setStatus('全員脱落？ 異常終了です');
    return;
  }

  turn = next;
  if(!selfPlayMode) render(); // 枠色更新

  if (!selfPlayMode && turn === humanPlayer) {
    if (!allMoves(humanPlayer,bd).length) {
      setStatus('手がありません（スキップ）');
      const _sg = gameGen;
      setTimeout(() => {
        if (_sg !== gameGen || gover) return;
        nextTurn(bd);
      }, AI_SKIP_DELAY_MS);
    } else {
      setStatus(PNAME[humanPlayer] + 'の番です');
    }
  } else {
    kickAI();
  }
}

// ── 投了（人間）──
// 投了した人は脱落扱いにする。玉は盤から取り除き、残りの駒は盤に残る（玉を取られて脱落したときと同じく、動かず利きもない）
function resignHuman(){
  if(gover || selfPlayMode || editMode || eliminated[humanPlayer]) return;
  if(!confirm('投了しますか？（脱落扱いになり、残りの2人の対局を観戦します）')) return;
  const p = humanPlayer;
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const x = board[r][c];
    if(x && x.o===p && x.p==='OU') board[r][c] = null;
  }
  eliminated[p] = true;
  humanEliminated = true;
  if(gameRecord) gameRecord.moves.push({o:p, resign:true});
  kifu.push({fugo:'投了', col:PCOL[p], name:PNAME_BASE[p]});
  renderKifu();
  buildAttackMaps(board);
  const alive = [0,1,2].filter(i=>!eliminated[i]);
  if(alive.length <= 1){
    gover = true; winner = alive[0];
    setStatus('投了しました。'+pName(winner)+'の勝ち');
    render();
    return;
  }
  setStatus('投了しました。残りの2人の対局を続けます');
  render();
  // 自分の手番なら次へ。CPUが考え中なら、その手のあと自動で次へ進む（脱落者は飛ばされる）
  if(turn === p) nextTurn(board);
}

// ── 棋譜のコピー ──
// 最初の局面・全部の手（学習AIの手には勝率予想 v つき）・符号・今の局面を JSON でクリップボードへ
function copyGameRecord(){
  const rec = {
    version: 1,
    difficulty: currentDifficulty,
    human: humanPlayer,
    start: gameRecord ? gameRecord.start : null,
    moves: gameRecord ? gameRecord.moves : [],
    fugo: kifu.map(k=>k.name+' '+k.fugo),
    final: {board, hand, eliminated, turn, moveCount, rule:keepAllPieces, gover, winner},
  };
  const text = JSON.stringify(rec);
  const done = ()=>setStatus('📋 棋譜をコピーしました（'+rec.moves.length+'手）');
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, ()=>fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done){
  const ta=document.createElement('textarea');
  ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); done(); }catch(e){ prompt('コピーしてください', text); }
  ta.remove();
}

// ── クリック ──
function handleClick(e){
  const rect=canvas.getBoundingClientRect();
  const _s=window._canvasScale||1;
  const mx=(e.clientX-rect.left)/_s, my=(e.clientY-rect.top)/_s;

  if(editMode){ editHandleClick(e); return; }
  if(promoQ){handlePromoClick(mx,my);return;}
  if(gover||turn!==humanPlayer){
    // 自分の番以外のクリックは選択状態をリセットして無視
    selected=null; vmoves=[]; selHand=false;
    return;
  }

  const bc=xyToBoard(mx,my);
  const hi=xyToHand0(mx,my);

  if(selected!==null||selHand){
    if(bc){
      const [tr,tc]=bc;
      const matching=vmoves.filter(m=>m.tr===tr&&m.tc===tc);
      if(matching.length){
        if(matching.length===2){promoQ={mvs:matching};render();return;}
        applyMove(matching[0],humanPlayer);
        selected=null;selHand=false;vmoves=[];
        render();
        if(!gover) nextTurn(board);
        return;
      }
    }
    selected=null;selHand=false;vmoves=[];
  }

  if(bc){
    const [r,c]=bc;
    const cell=board[r][c];
    if(cell?.o===humanPlayer){
      selected=[r,c];selHand=false;
      vmoves=allMoves(humanPlayer,board).filter(m=>!m.drop&&m.fr===r&&m.fc===c);
      // 玉の移動先に敵の利きがあれば warn フラグ（入玉・通常移動両方）
      if(cell.p==='OU'){
        vmoves = vmoves.map(m=>{
          if(squareAttackedBy(board,m.tr,m.tc,humanPlayer,eliminated))
            return {...m, warn:true};
          return m;
        });
      } else {
        // ピン駒チェック：動かすと玉が取られる手に warn フラグ
        vmoves = vmoves.map(m=>{
          const undo = applyMoveInPlace(board, hand, eliminated, m, humanPlayer);
          const exposed = !eliminated[humanPlayer] && kingWouldBeCaptured(board, humanPlayer, eliminated);
          undoMoveInPlace(board, hand, eliminated, m, humanPlayer, undo);
          return exposed ? {...m, warn:true} : m;
        });
      }
    }
  } else if(hi>=0){
    const uh=uniqueHand(humanPlayer);
    if(uh[hi]){
      selHand=true;selected=hi;
      const piece=uh[hi].p;
      vmoves=allMoves(humanPlayer,board).filter(m=>m.drop&&m.piece===piece);
    }
  }
  render();
}

function handlePromoClick(mx,my){
  const dw=260,dh=130,dx=(CW-dw)/2,dy=(CH-dh)/2;
  if(my>=dy+55&&my<=dy+93){
    let chosen=null;
    if(mx>=dx+18&&mx<=dx+113) chosen=promoQ.mvs.find(m=>m.pro);
    else if(mx>=dx+148&&mx<=dx+243) chosen=promoQ.mvs.find(m=>!m.pro);
    if(chosen){
      promoQ=null;
      applyMove(chosen,humanPlayer);
      selected=null;selHand=false;vmoves=[];
      render();
      if(!gover) nextTurn(board);
    }
  }
}

function xyToBoard(x,y){
  const pc=Math.floor((x-BX)/CS), pr=Math.floor((y-BY)/CS);
  if(!inB(pr,pc)) return null;
  const [lr,lc]=physToLog(pr,pc);
  return inB(lr,lc)?[lr,lc]:null;
}

function xyToHand0(x,y){
  const uh=uniqueHand(humanPlayer);if(!uh.length) return -1;
  const handY=BY+9*CS+14;
  if(y<handY||y>handY+CS) return -1;
  const sp=Math.min(66,500/Math.max(uh.length,1));
  const startX=(CW-uh.length*sp)/2;
  for(let i=0;i<uh.length;i++)
    if(x>=startX+i*sp&&x<startX+(i+1)*sp) return i;
  return -1;
}

function uniqueHand(o){
  const m={};
  hand[o].forEach(p=>m[p]=(m[p]||0)+1);
  return Object.entries(m).map(([p,n])=>({p,n}));
}

// ── 盤面編集モード ──
const EDIT_PIECES = ['OU','HI','KAKU','KIN','GIN','KE','KY','FU'];
const EDIT_COLORS = ['#4488ff','#ff4433','#33cc55'];

function toggleEditMode(){
  editMode = !editMode;
  const btn = document.getElementById('edit-btn');
  const panel = document.getElementById('edit-panel');
  if(editMode){
    // 現在の局面を編集用にコピー
    editElim = eliminated.slice();
    btn.style.background = '#2a2a6a';
    btn.style.borderColor = '#aaaaff';
    btn.style.color = '#ffffff';
    btn.textContent = '✏️ 編集中...';
    panel.style.display = 'block';
    // 脱落チェックボックス同期
    [0,1,2].forEach(o=>{
      const cb = document.getElementById('elim'+o);
      if(cb) cb.checked = editElim[o];
    });
    renderEditPalette();
    renderEditHand();
    gover = false; // 編集中はゲームオーバー解除
  } else {
    btn.style.background = '#1a1a3a';
    btn.style.borderColor = '#8888ff';
    btn.style.color = '#aaaaff';
    btn.textContent = '✏️ 盤面編集';
    panel.style.display = 'none';
    editSelected = null;
  }
  render();
}

function clearEditBoard(){
  // 盤面を空に、持ち駒も全消去
  for(let r=0;r<9;r++) for(let c=0;c<9;c++) board[r][c] = null;
  hand[0] = []; hand[1] = []; hand[2] = [];
  editSelected = null;
  renderEditHand();
  render();
}

function setTwoPlayerPreset(){
  // 盤面を空にして二人将棋（P0 vs P1）の初期配置をセット、P2(緑)をelim
  clearEditBoard();

  // P0（下・青）通常将棋の後手配置
  [[8,0,'KY'],[8,1,'KE'],[8,2,'GIN'],[8,3,'KIN'],[8,4,'OU'],
   [8,5,'KIN'],[8,6,'GIN'],[8,7,'KE'],[8,8,'KY'],
   [7,1,'HI'],[7,7,'KAKU']].forEach(([r,c,p])=>board[r][c]={p,o:0,pr:false});
  for(let c=0;c<=8;c++) board[6][c]={p:'FU',o:0,pr:false};

  // P1（上・赤）通常将棋の先手配置
  [[0,0,'KY'],[0,1,'KE'],[0,2,'GIN'],[0,3,'KIN'],[0,4,'OU'],
   [0,5,'KIN'],[0,6,'GIN'],[0,7,'KE'],[0,8,'KY'],
   [1,7,'HI'],[1,1,'KAKU']].forEach(([r,c,p])=>board[r][c]={p,o:1,pr:false});
  for(let c=0;c<=8;c++) board[2][c]={p:'FU',o:1,pr:false};

  // P2(緑)をelim、青赤のelimを解除
  eliminated[2] = true;  editElim[2] = true;
  eliminated[0] = false; editElim[0] = false;
  eliminated[1] = false; editElim[1] = false;
  const cb0 = document.getElementById('elim0'); if(cb0) cb0.checked = false;
  const cb1 = document.getElementById('elim1'); if(cb1) cb1.checked = false;
  const cb2 = document.getElementById('elim2'); if(cb2) cb2.checked = true;

  hand[0] = []; hand[1] = []; hand[2] = [];
  renderEditHand();
  render();
}

function setEditElim(o, val){
  editElim[o] = val;
  eliminated[o] = val;
  render();
}

function renderEditPalette(){
  const el = document.getElementById('edit-palette');
  if(!el) return;
  el.innerHTML = '';
  [0,1,2].forEach(o=>{
    EDIT_PIECES.forEach(p=>{
      // 通常
      const btn = document.createElement('button');
      btn.textContent = PC[p];
      btn.title = `${['青','赤','緑'][o]}・${PC[p]}`;
      btn.style.cssText = `background:${EDIT_COLORS[o]}22;border:1px solid ${EDIT_COLORS[o]}88;color:${EDIT_COLORS[o]};padding:3px 6px;border-radius:3px;cursor:pointer;font-size:13px;min-width:28px;`;
      btn.onclick = ()=>{ editSelected={type:'palette',p,o,pr:false}; renderEditPalette(); renderEditHand(); };
      if(editSelected?.type==='palette'&&editSelected.p===p&&editSelected.o===o&&!editSelected.pr)
        btn.style.outline='2px solid #fff';
      el.appendChild(btn);
      // 成り駒（OU・KIN以外）
      if(p!=='OU'&&p!=='KIN'&&PCP[p]){
        const btn2 = document.createElement('button');
        btn2.textContent = PCP[p];
        btn2.title = `${['青','赤','緑'][o]}・${PCP[p]}（成）`;
        btn2.style.cssText = `background:${EDIT_COLORS[o]}33;border:1px dashed ${EDIT_COLORS[o]}88;color:${EDIT_COLORS[o]};padding:3px 6px;border-radius:3px;cursor:pointer;font-size:13px;min-width:28px;`;
        btn2.onclick = ()=>{ editSelected={type:'palette',p,o,pr:true}; renderEditPalette(); renderEditHand(); };
        if(editSelected?.type==='palette'&&editSelected.p===p&&editSelected.o===o&&editSelected.pr)
          btn2.style.outline='2px solid #fff';
        el.appendChild(btn2);
      }
    });
    // 区切り
    if(o<2){ const sep=document.createElement('div'); sep.style.cssText='width:100%;height:1px;background:#333;margin:3px 0;'; el.appendChild(sep); }
  });
}

function renderEditHand(){
  const el = document.getElementById('edit-hand');
  if(!el) return;
  el.innerHTML = '';
  [0,1,2].forEach(o=>{
    const div = document.createElement('div');
    div.style.cssText = `border:1px solid ${EDIT_COLORS[o]}55;border-radius:4px;padding:4px 6px;min-width:100px;`;
    const title = document.createElement('div');
    title.textContent = ['🔵青','🔴赤','🟢緑'][o];
    title.style.cssText = `color:${EDIT_COLORS[o]};font-size:11px;margin-bottom:3px;text-align:center;`;
    div.appendChild(title);
    // 駒種ごとに+/-
    ['HI','KAKU','KIN','GIN','KE','KY','FU'].forEach(p=>{
      const cnt = hand[o].filter(x=>x===p).length;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:3px;margin:1px 0;';
      const minus = document.createElement('button');
      minus.textContent='-'; minus.style.cssText='padding:0 5px;font-size:12px;cursor:pointer;background:#333;border:1px solid #666;color:#fff;border-radius:2px;';
      minus.onclick=()=>{ const i=hand[o].indexOf(p); if(i>=0){hand[o].splice(i,1);} renderEditHand(); render(); };
      const plus = document.createElement('button');
      plus.textContent='+'; plus.style.cssText='padding:0 5px;font-size:12px;cursor:pointer;background:#333;border:1px solid #666;color:#fff;border-radius:2px;';
      plus.onclick=()=>{ hand[o].push(p); renderEditHand(); render(); };
      const label = document.createElement('span');
      label.textContent = `${PC[p]}×${cnt}`;
      label.style.cssText = `color:${EDIT_COLORS[o]};font-size:12px;min-width:36px;`;
      row.appendChild(minus); row.appendChild(label); row.appendChild(plus);
      div.appendChild(row);
    });
    el.appendChild(div);
  });
}

function editHandleClick(e){
  const rect = canvas.getBoundingClientRect();
  const _s = window._canvasScale||1;
  const mx = (e.clientX-rect.left)/_s, my = (e.clientY-rect.top)/_s;
  const bc = xyToBoard(mx,my);
  if(!bc) return;
  const [r,c] = bc;

  if(e.button===2){ // 右クリック：削除
    board[r][c] = null;
    render(); return;
  }

  if(editSelected?.type==='palette'){
    // 駒がいるマスをクリックしたら駒選択モードに切り替え、空マスなら配置
    if(board[r][c]){
      editSelected = {type:'board', fr:r, fc:c};
    } else {
      board[r][c] = {p: editSelected.p, o: editSelected.o, pr: editSelected.pr};
    }
    render(); return;
  }

  if(editSelected?.type==='board'){
    // 移動先
    const {fr,fc} = editSelected;
    if(r===fr && c===fc){ editSelected=null; render(); return; } // 同じマスでキャンセル
    board[r][c] = board[fr][fc];
    board[fr][fc] = null;
    editSelected = null;
    render(); return;
  }

  // 盤面の駒を選択
  if(board[r][c]){
    editSelected = {type:'board', fr:r, fc:c};
    render();
  }
}

function setHumanPlayerFromEdit(p){
  if(editMode){
    eliminated = editElim.slice();
    const wasEdit = true;
    toggleEditMode();
    // init()をスキップして現在の盤面からスタート
    humanPlayer=p; viewPlayer=p;
    [0,1,2].forEach(i=>PNAME[i]=PNAME_BASE[i]);
    PNAME[p]=PNAME_BASE[p]+'(あなた)';
    [0,1,2].forEach(i=>{
      const btn=document.getElementById('hb'+i);
      if(btn) btn.style.background=i===p?'#6a3500':'#3a1500';
    });
    gover=false; moveCount=0; kifu=[]; renderKifu();
    turn=0; winType='normal'; lastMove=null;
    humanEliminated=eliminated[p]; gameGen++;
    selected=null; vmoves=[]; selHand=false; promoQ=null;
    render();
    if(selfPlayMode||p!==0) setTimeout(()=>kickAI(), AI_DELAY_MS);
  } else {
    setHumanPlayer(p);
  }
}

// ── ゲーム設定 ──
function setCpuCollusion(val){
  cpuCollusion = val;
  const onBtn  = document.getElementById('col-on');
  const offBtn = document.getElementById('col-off');
  const desc   = document.getElementById('col-desc');
  if(onBtn){
    onBtn.style.background  = val  ? '#7a3a00' : '#2a1200';
    onBtn.style.border      = val  ? '1px solid #ffaa44' : '1px solid #804010';
    onBtn.style.color       = val  ? '#ffe090' : '#c0a060';
    onBtn.style.boxShadow   = val  ? '0 0 10px rgba(255,170,50,0.4)' : 'none';
  }
  if(offBtn){
    offBtn.style.background = !val ? '#003a70' : '#2a1200';
    offBtn.style.border     = !val ? '1px solid #44aaff' : '1px solid #804010';
    offBtn.style.color      = !val ? '#aaddff' : '#c0a060';
    offBtn.style.boxShadow  = !val ? '0 0 10px rgba(50,150,255,0.4)' : 'none';
  }
  if(desc){
    desc.innerHTML = val
      ? '🤝 <span style="color:#ff4433">CPU①</span>・<span style="color:#33bb55">CPU②</span>が連携してプレイヤーを集中攻撃します'
      : '⚔ <span style="color:#ff4433">CPU①</span>・<span style="color:#33bb55">CPU②</span>もそれぞれ自分の勝利を目指す完全三つ巴戦です';
  }
  // ルール説明の警告文も更新
  const warn = document.getElementById('collusion-warning');
  if(warn){
    warn.innerHTML = val
      ? '⚠️ <span style="color:#ff4433">CPU①</span>・<span style="color:#33bb55">CPU②</span>は共闘してあなたを狙ってきます。'
      : '⚔️ <span style="color:#ff4433">CPU①</span>・<span style="color:#33bb55">CPU②</span>は<span style="color:#ffcc44">それぞれ自分の勝利</span>を目指します。';
  }
}

function setKeepAllPieces(val){
  keepAllPieces = val;
  const onBtn   = document.getElementById('keep-on');
  const nextBtn = document.getElementById('keep-next');
  const offBtn  = document.getElementById('keep-off');
  const desc    = document.getElementById('keep-rule-desc-main');
  [['keep-on','all'],['keep-next','next'],['keep-off',false]].forEach(([id, v])=>{
    const btn = document.getElementById(id);
    if(!btn) return;
    const active = val === v;
    btn.style.background = active ? '#004a00' : '#2a1200';
    btn.style.border     = active ? '1px solid #44ff88' : '1px solid #804010';
    btn.style.color      = active ? '#aaffcc' : '#c0a060';
    btn.style.boxShadow  = active ? '0 0 10px rgba(50,255,100,0.4)' : 'none';
  });
  // 消滅ありだけ色を変える
  if(offBtn && val === false){
    offBtn.style.background = '#3a1a00';
    offBtn.style.border     = '1px solid #ffaa44';
    offBtn.style.color      = '#ffe090';
    offBtn.style.boxShadow  = '0 0 10px rgba(255,170,50,0.4)';
  }
  if(desc){
    if(val === 'all' || val === true)
      desc.innerHTML = '取った駒は<span class="highlight">常に持ち駒</span>になります。';
    else if(val === 'next')
      desc.innerHTML = '取った駒は<span class="highlight">第三者の持ち駒</span>になります🎁（2人になったら取った側が受け取り）';
    else
      desc.innerHTML = '通常、取った駒は<span class="highlight">消滅</span>します。以下の場合のみ持ち駒になります。<ul style="margin:6px 0 0 16px;color:#b09070;font-size:12px;line-height:1.8;"><li><span class="highlight">脱落したプレイヤーがいる</span>とき</li><li><span class="highlight">成り駒</span>を取ったとき</li><li>相手より駒が<span class="highlight">3個以上少ない</span>とき</li><li><span class="highlight">玉が5段目以上</span>に進んでいる相手から取ったとき</li></ul>';
  }
}

function setDifficulty(level){
  const cfg = DIFFICULTY_LEVELS[level];
  if(!cfg) return;
  currentDifficulty = level;
  AI_SEARCH_DEPTH      = cfg.depth;
  AI_NOISE             = cfg.noise;
  AI_TIME_LIMIT_MS     = cfg.timeMs;
  // ボタンハイライト更新
  Object.keys(DIFFICULTY_LEVELS).forEach(k=>{
    const btn=document.getElementById('diff-'+k);
    if(btn){
      const active = k===level;
      btn.style.background   = active ? '#7a3a00' : '#2a1200';
      btn.style.border       = active ? '1px solid #ffaa44' : '1px solid #804010';
      btn.style.color        = active ? '#ffe090' : '#c0a060';
      btn.style.boxShadow    = active ? '0 0 10px rgba(255,170,50,0.4)' : 'none';
    }
  });
  // 難易度ラベル更新
  const lbl = document.getElementById('diff-label');
  if(lbl) lbl.textContent = cfg.emoji+' 難易度: '+cfg.label;
}

window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('c');
  ctx = canvas.getContext('2d');
  canvas.width = CW; canvas.height = CH;
  canvas.addEventListener('click', handleClick);
  canvas.addEventListener('contextmenu', e=>{ e.preventDefault(); if(editMode) editHandleClick(e); });
  window.addEventListener('resize', fitCanvas);
  fitCanvas();
  setDifficulty(currentDifficulty);
  setCpuCollusion(false);
  setKeepAllPieces('all');
  setHumanPlayer(0);
});
