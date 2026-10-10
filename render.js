// ── 描画 ──
function render(){
  ctx.clearRect(0,0,CW,CH);

  // 背景
  const bg=ctx.createRadialGradient(CW/2,CH/2,0,CW/2,CH/2,550);
  bg.addColorStop(0,'#1c0a00');bg.addColorStop(1,'#060200');
  ctx.fillStyle=bg;ctx.fillRect(0,0,CW,CH);

  drawBoard();
  drawAllPieces();
  if(typeof reviewMode!=='undefined' && reviewMode) drawReviewOverlay(); // 検討モードの候補手（review.js）

  drawAllHands();
  drawPlayerLabels();
  if(promoQ) drawPromoDialog();
}

function drawBoard(){
  ctx.shadowColor='#0009';ctx.shadowBlur=20;ctx.shadowOffsetX=4;ctx.shadowOffsetY=5;
  const g=ctx.createLinearGradient(BX,BY,BX+9*CS,BY+9*CS);
  g.addColorStop(0,'#edd88a');g.addColorStop(0.5,'#d4a848');g.addColorStop(1,'#c49030');
  ctx.fillStyle=g;ctx.fillRect(BX,BY,9*CS,9*CS);
  ctx.shadowBlur=0;ctx.shadowOffsetX=0;ctx.shadowOffsetY=0;

  // ゾーン色
  ctx.fillStyle='rgba(68,136,255,0.07)';
  ctx.fillRect(BX+CS,BY+6*CS,5*CS,3*CS);
  ctx.fillStyle='rgba(255,68,51,0.07)';
  ctx.fillRect(BX+CS,BY,5*CS,3*CS);
  ctx.fillStyle='rgba(51,204,85,0.07)';
  ctx.fillRect(BX+6*CS,BY+CS,3*CS,5*CS);

  // グリッド
  ctx.strokeStyle='#7a4818';ctx.lineWidth=1;
  for(let i=0;i<=9;i++){
    ctx.beginPath();ctx.moveTo(BX+i*CS,BY);ctx.lineTo(BX+i*CS,BY+9*CS);ctx.stroke();
    ctx.beginPath();ctx.moveTo(BX,BY+i*CS);ctx.lineTo(BX+9*CS,BY+i*CS);ctx.stroke();
  }
  ctx.strokeStyle='#4a2808';ctx.lineWidth=3;
  ctx.strokeRect(BX,BY,9*CS,9*CS);

  // 星目
  [[2,2],[2,6],[4,4],[6,2],[6,6]].forEach(([r,c])=>{
    ctx.fillStyle='#4a2808';
    ctx.beginPath();ctx.arc(BX+c*CS,BY+r*CS,4,0,Math.PI*2);ctx.fill();
  });

  // ターン枠
  if(!gover){
    ctx.strokeStyle=PCOL[turn];ctx.lineWidth=3.5;
    ctx.shadowColor=PCOL[turn];ctx.shadowBlur=12;
    ctx.strokeRect(BX-4,BY-4,9*CS+8,9*CS+8);
    ctx.shadowBlur=0;
  }
}

function drawPentagon(cx,cy,w,h){
  ctx.beginPath();
  ctx.moveTo(cx,cy-h/2);
  ctx.lineTo(cx+w/2,cy-h*0.13);
  ctx.lineTo(cx+w/2,cy+h/2);
  ctx.lineTo(cx-w/2,cy+h/2);
  ctx.lineTo(cx-w/2,cy-h*0.13);
  ctx.closePath();
}

function drawPieceAt(cx,cy,cell,small=false){
  const w=small?38:42,h=small?44:48;
  const {p,o,pr}=cell;
  const angle=DRAW_ANGLE[o]+VIEW_ROT[viewPlayer];
  const ch=pr?(PCP[p]||PC[p]):PC[p];

  ctx.save();
  ctx.translate(cx,cy);
  ctx.rotate(angle);

  ctx.shadowColor='#0006';ctx.shadowBlur=5;ctx.shadowOffsetY=2;
  const grad=ctx.createLinearGradient(0,-h/2,0,h/2);
  grad.addColorStop(0,'#fffaf0');grad.addColorStop(1,'#e8d095');
  drawPentagon(0,0,w,h);
  ctx.fillStyle=grad;ctx.fill();
  ctx.shadowBlur=0;ctx.shadowOffsetY=0;

  drawPentagon(0,0,w,h);
  ctx.strokeStyle=PCOL[o];ctx.lineWidth=2;ctx.stroke();

  ctx.fillStyle=pr?'#cc2000':'#1a0800';
  ctx.font=`bold ${small?16:17}px 'Hiragino Mincho Pro','Yu Mincho',serif`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(ch,0,1);
  ctx.restore();
}

function drawAllPieces(){
  for(let r=0;r<9;r++) for(let c=0;c<9;c++){
    const cell=board[r][c];if(!cell) continue;
    const [pr,pc]=logToPhys(r,c);
    const cx=BX+pc*CS+CS/2, cy=BY+pr*CS+CS/2;

    // 直前の移動元（薄く残影）
    if(lastMove&&!lastMove.drop&&lastMove.fr===r&&lastMove.fc===c){
      ctx.fillStyle='rgba(255,220,80,0.12)';
      ctx.fillRect(BX+pc*CS+1,BY+pr*CS+1,CS-2,CS-2);
    }
    // 直前の移動先（オーナー色でグロー）
    if(lastMove&&lastMove.tr===r&&lastMove.tc===c){
      const col=PCOL[lastMove.o];
      ctx.save();
      ctx.shadowColor=col; ctx.shadowBlur=18;
      ctx.strokeStyle=col; ctx.lineWidth=2.5;
      ctx.strokeRect(BX+pc*CS+2,BY+pr*CS+2,CS-4,CS-4);
      ctx.restore();
      ctx.save();
      ctx.fillStyle=col+'cc';
      [[0,0],[1,0],[0,1],[1,1]].forEach(([ci,ri])=>{
        const px=BX+pc*CS+(ci*(CS-1)), py=BY+pr*CS+(ri*(CS-1));
        const sx=ci===0?1:-1, sy=ri===0?1:-1;
        ctx.beginPath();
        ctx.moveTo(px,py);
        ctx.lineTo(px+sx*9,py);
        ctx.lineTo(px,py+sy*9);
        ctx.closePath();
        ctx.fill();
      });
      ctx.restore();
    }

    // 選択中マス（操作プレイヤーの駒のみ）
    if(!selHand&&selected&&selected[0]===r&&selected[1]===c&&cell?.o===humanPlayer){
      ctx.fillStyle='rgba(255,255,0,0.28)';
      ctx.fillRect(BX+pc*CS+1,BY+pr*CS+1,CS-2,CS-2);
    }
    // 編集モードの選択ハイライト
    if(editMode && editSelected?.type==='board' && editSelected.fr===r && editSelected.fc===c){
      ctx.fillStyle='rgba(180,180,255,0.4)';
      ctx.fillRect(BX+pc*CS+1,BY+pr*CS+1,CS-2,CS-2);
    }
    // 脱落プレイヤーの駒はグレーアウト
    if(eliminated[cell.o]){
      ctx.save();ctx.globalAlpha=0.3;
      drawPieceAt(cx,cy,cell);
      ctx.restore();
    } else {
      drawPieceAt(cx,cy,cell);
    }
  }

  // 移動候補マスのハイライト
  vmoves.forEach(m=>{
    const [pr,pc]=logToPhys(m.tr,m.tc);
    const cx=BX+pc*CS, cy=BY+pr*CS;
    const cap=!m.drop&&board[m.tr]?.[m.tc];
    if(m.warn){
      // 入玉マスに敵の利きあり → 黄色警告
      ctx.fillStyle='rgba(255,200,0,0.28)';ctx.fillRect(cx+1,cy+1,CS-2,CS-2);
      ctx.strokeStyle='#ffcc00';ctx.lineWidth=2.5;ctx.strokeRect(cx+1,cy+1,CS-2,CS-2);
      ctx.fillStyle='#ffcc00';ctx.font='bold 14px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText('⚠',cx+CS/2,cy+CS/2);
    } else if(cap){
      ctx.fillStyle='rgba(255,80,0,0.22)';ctx.fillRect(cx+1,cy+1,CS-2,CS-2);
      ctx.strokeStyle='#ff6600';ctx.lineWidth=2.5;ctx.strokeRect(cx+1,cy+1,CS-2,CS-2);
    } else {
      ctx.fillStyle='rgba(100,220,100,0.12)';ctx.fillRect(cx+1,cy+1,CS-2,CS-2);
      ctx.fillStyle='rgba(80,210,80,0.75)';
      ctx.beginPath();ctx.arc(cx+CS/2,cy+CS/2,8,0,Math.PI*2);ctx.fill();
    }
  });
}

function drawHandRow(o, side){
  // side: 'bottom'|'top'|'right'|'left'
  const uh=uniqueHand(o); if(!uh.length) return;
  const sp=Math.min(54,480/Math.max(uh.length,1));
  const isVert=(side==='right'||side==='left');
  const startX=(CW-uh.length*sp)/2;
  const col=PCOL[o];

  ctx.font='bold 13px serif'; ctx.fillStyle=col+'cc'; ctx.textAlign='center';
  if(side==='bottom'){
    ctx.fillText('持ち駒',CW/2,BY+9*CS+14);
    uh.forEach(({p,n},i)=>{
      const cx=startX+i*sp+sp/2, cy=BY+9*CS+50;
      const isSel=selHand&&o===humanPlayer&&selected===i;
      if(isSel){ctx.fillStyle='rgba(255,255,80,0.25)';ctx.fillRect(cx-25,cy-26,50,50);}
      drawPieceAt(cx,cy,{p,o,pr:false},true);
      if(n>1){ctx.fillStyle=col;ctx.font='bold 13px monospace';ctx.textAlign='center';ctx.fillText('×'+n,cx+18,cy+18);}
    });
  } else if(side==='top'){
    ctx.fillText('持ち駒',CW/2,15);
    uh.forEach(({p,n},i)=>{
      const cx=startX+i*sp+sp/2, cy=48;
      drawPieceAt(cx,cy,{p,o,pr:false},true);
      if(n>1){ctx.fillStyle=col;ctx.font='bold 13px monospace';ctx.textAlign='center';ctx.fillText('×'+n,cx+18,cy+18);}
    });
  } else if(side==='right'){
    ctx.textAlign='right'; ctx.fillText('持',CW-8,BY+CS*1.5);
    uh.forEach(({p,n},i)=>{
      const cx=CW-52, cy=BY+CS*2+i*50+25;
      drawPieceAt(cx,cy,{p,o,pr:false},true);
      if(n>1){ctx.fillStyle=col;ctx.font='bold 13px monospace';ctx.textAlign='center';ctx.fillText('×'+n,cx+15,cy+18);}
    });
  } else { // left
    ctx.textAlign='left'; ctx.fillText('持',12,BY+CS*1.5);
    uh.forEach(({p,n},i)=>{
      const cx=50, cy=BY+CS*2+i*50+25;
      drawPieceAt(cx,cy,{p,o,pr:false},true);
      if(n>1){ctx.fillStyle=col;ctx.font='bold 13px monospace';ctx.textAlign='center';ctx.fillText('×'+n,cx+15,cy+18);}
    });
  }
}
function drawAllHands(){
  // 自己対局モードはviewPlayer基準で固定描画（humanPlayer=-1のため）
  if(selfPlayMode){
    drawHandRow(0,'bottom');
    drawHandRow(1,'top');
    drawHandRow(2,'right');
    return;
  }
  // 操作プレイヤーの手駒は常に下
  drawHandRow(humanPlayer,'bottom');
  if(viewPlayer===0){
    if(humanPlayer!==1) drawHandRow(1,'top');
    if(humanPlayer!==2) drawHandRow(2,'right');
  } else if(viewPlayer===1){
    if(humanPlayer!==0) drawHandRow(0,'top');
    if(humanPlayer!==2) drawHandRow(2,'left');
  } else { // viewPlayer===2
    if(humanPlayer!==0) drawHandRow(0,'left');
    if(humanPlayer!==1) drawHandRow(1,'right');
  }
}

function drawPlayerLabels(){
  const counts=[countPieces(0),countPieces(1),countPieces(2)];
  function drawLabel(text,sub,x,y,col,align){
    ctx.textAlign=align;
    ctx.fillStyle=col;
    ctx.font='bold 16px sans-serif';
    ctx.fillText(text,x,y);
    ctx.fillStyle=col+'aa';
    ctx.font='13px monospace';
    ctx.fillText(sub,x,y+19);
  }
  drawLabel(PNAME[0]+(eliminated[0]?' ☠':''),`駒数: ${counts[0]}`,12,CH-30,PCOL[0],'left');
  drawLabel(PNAME[1]+(eliminated[1]?' ☠':''),`駒数: ${counts[1]}`,12,22,PCOL[1],'left');
  drawLabel(PNAME[2]+(eliminated[2]?' ☠':''),`駒数: ${counts[2]}`,CW-12,CH-30,PCOL[2],'right');
  // 直前の手を符号で表示
  if(lastMove&&lastMove.fugo){
    const col=PCOL[lastMove.o];
    ctx.textAlign='center';
    ctx.fillStyle=col;
    ctx.font='bold 15px serif';
    ctx.shadowColor=col; ctx.shadowBlur=6;
    ctx.fillText('▶ '+pName(lastMove.o)+' '+lastMove.fugo, CW/2, CH-10);
    ctx.shadowBlur=0;
  }
  // 視点表示
  const viewNames=['P0視点','P1視点','P2視点'];
  ctx.textAlign='right'; ctx.fillStyle='#806040aa'; ctx.font='11px monospace';
  ctx.fillText('👁 '+viewNames[viewPlayer], CW-12, 22);
}

function drawPromoDialog(){
  ctx.fillStyle='rgba(0,0,0,0.75)';ctx.fillRect(0,0,CW,CH);
  const dw=260,dh=130,dx=(CW-dw)/2,dy=(CH-dh)/2;

  // ダイアログ背景
  ctx.beginPath();ctx.roundRect(dx,dy,dw,dh,8);
  ctx.fillStyle='#f5e8c8';ctx.fill();
  ctx.strokeStyle='#7a4010';ctx.lineWidth=2.5;ctx.stroke();

  // タイトル
  ctx.fillStyle='#2a1000';ctx.font='bold 18px serif';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText('成りますか？',dx+dw/2,dy+30);

  // 成るボタン（左）
  ctx.beginPath();ctx.roundRect(dx+18,dy+55,95,38,5);
  ctx.fillStyle='#7a3000';ctx.fill();
  ctx.fillStyle='#f5e8c8';ctx.font='bold 16px serif';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText('成る',dx+65,dy+74);

  // 成らないボタン（右）
  ctx.beginPath();ctx.roundRect(dx+148,dy+55,95,38,5);
  ctx.fillStyle='#2a4070';ctx.fill();
  ctx.fillStyle='#f5e8c8';ctx.font='bold 15px serif';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText('成らない',dx+195,dy+74);
}
