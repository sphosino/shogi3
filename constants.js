
// =====================================================================
// 三人将棋
// P0: 下→上 (forward = dr:-1, dc:0)
// P1: 上→下 (forward = dr:+1, dc:0)
// P2: 右→左 (forward = dr:0,  dc:-1)
// =====================================================================

const CS=56, BX=115, BY=115, CW=760, CH=760;
let canvas, ctx;

// ── AI定数 ──
// 難易度設定テーブル
const DIFFICULTY_LEVELS = {
  beginner: { label:'入門', depth:1, noise:200, emoji:'🌱', timeMs:500  },
  easy:     { label:'初級', depth:3, noise:80,  emoji:'🌿', timeMs:1000 },
  normal:   { label:'中級', depth:4, noise:60,  emoji:'⚔️', timeMs:2000 },
  hard:     { label:'上級', depth:5, noise:20,  emoji:'🔥', timeMs:4000 },
};
const AI_MAX_DEPTH = 12; // 反復深化の上限深さ（時間切れで実際はこれより浅く終わる）
let currentDifficulty = 'normal';

// ── AI探索パラメータ（難易度別に上書き） ──
let AI_SEARCH_DEPTH         = DIFFICULTY_LEVELS.normal.depth;
let AI_NOISE                = DIFFICULTY_LEVELS.normal.noise;
let AI_TIME_LIMIT_MS        = DIFFICULTY_LEVELS.normal.timeMs; // 人間対局時の思考時間制限

// ── AI評価関数定数 ──
const AI_MOBILITY_SCALE      = 30;    // モビリティ1マスあたりの点数
const AI_DANGER_SCALE        = 0.4;   // 狙われている駒へのペナルティ係数（駒価値 × この値）※自己対局で0.8→0.4の勝率(互角=33.3%): 思考0.2秒 39.6%(528局) / 中級2秒 35.9%(396局)
const AI_ENTRY_MULT          = 450;   // 入玉距離ボーナス係数（2段目≒3150点、3段目≒450点）
const AI_ENTRY_BLOCK_RATE    = 0.03;  // 入玉阻止ボーナス係数 ※大きすぎると詰め手より阻止利きを優先して千日手になる
const AI_KING_SAFETY_MULT    = 200;   // 王安全度スコア係数（安全率×重み）
const AI_HAND_BONUS_RATE     = 1.3;   // 持ち駒の価値倍率（盤上より少し高評価）

// ── 三つ巴戦略定数 ──
const AI_COALITION_THRESHOLD = 1500;  // 連合発動の独走スコア差しきい値
const AI_COALITION_MULT      = 0.5;   // 連合時の上位プレイヤーへの重み増加量
const AI_FINISH_MULT         = 0.4;   // 1位が弱い敵を狙う際の重み増加量

// ── テンポ（末端局面で誰の手番か）──
// 静的評価は手番を見ないので、読みを止めた深さで評価がぶれる。末端の手番に応じて補正する（rootAI視点）
const AI_TEMPO_SELF          = 0;     // 自分の手番（2人残りのときは相手手番で -この値）
const AI_TEMPO_NEXT          = 0;     // 自分の次の相手の手番（相手2人が自分より先に指す）→ -この値
const AI_TEMPO_PREV          = 0;     // 自分の前の相手の手番（相手1人が自分より先に指す）→ -この値

// ── 探索エンジン ──
const AI_USE_ENGINE2         = 1;     // 1=型付き配列版エンジン(engine.js)、0=旧エンジン(ai.js)。max^N/BRSは常に旧エンジン

// ── 探索の枝刈り・並べ替え（1=有効, 0=無効）──
const AI_USE_TT              = 1;     // 置換表（前の反復の最善手を先に読む＋境界値で打ち切り）
const AI_USE_FUTILITY        = 1;     // 末端付近で、静かな手では形勢が変わりそうにないとき読まない
const AI_FUTILITY_MARGIN1    = 400;   // 残り深さ1の余裕幅
const AI_FUTILITY_MARGIN2    = 900;   // 残り深さ2の余裕幅
const AI_USE_LMR             = 1;     // 後ろの方の静かな手は1手浅く読み、良さそうなら読み直す
const AI_LMR_MIN_DEPTH       = 2;     // LMRを使う最小の残り深さ
const AI_LMR_MIN_MOVES       = 4;     // この手数を読んだ後の手からLMR対象
const AI_USE_SLICE           = 1;     // root順位に応じた静かな手の足切り（旧方式）
const AI_CHECK_EXT           = 0;     // 王手を静かな手扱いしない（LMR・futilityで削らない）※新エンジンのみ
const AI_QS_PASS             = 0;     // 静止探索で、後の人が玉を取れるときは「何もしない」でも手番を回して読む ※新エンジンのみ

// ── quickMoveScore定数 ──
const AI_QMS_HAND_COST       = 0.3;   // 持ち駒を打つコスト率（不要な打ちを抑制）

// ── UI定数 ──
const AI_DELAY_MS      = 400;  // AI着手後の表示待機(ms)
const AI_SKIP_DELAY_MS = 800;  // スキップ時の待機(ms)

// ── パフォーマンス計測カウンター ──
let leafEvalCount    = 0; // 末端ノード評価回数（葉ノード数）
let moveGenCount     = 0; // 合法手生成呼び出し回数（内部ノード数）
let pruneCount       = 0; // αβ/maxN枝刈り回数
let slicedMoveCount  = 0; // rankスライスで除外した手数
let depthMoveGen     = {}; // 深さ別：生成手数合計
let depthMoveExplore = {}; // 深さ別：実際に展開した手数合計
let depthNodeCount   = {}; // 深さ別：ノード数
let orderingHits     = 0;  // rootで1位の手が最善手だった回数
let orderingTotal    = 0;  // rootでの反復深化完了回数
let orderingRankSum  = 0;  // 最善手の順位合計（平均計算用）
let tEval           = 0;  // 評価にかかった時間(ms)

// ── 駒の価値・名前テーブル ──
const PV  = {FU:100, KY:300, KE:350, GIN:400, KIN:500, KAKU:800, HI:900, OU:10000000};
const PVP = {FU:400, KY:200, KE:150, GIN:100, KAKU:500, HI:450}; // 成り駒の追加価値
const PC  = {FU:'歩', KY:'香', KE:'桂', GIN:'銀', KIN:'金', HI:'飛', KAKU:'角', OU:'玉'};
const PCP = {FU:'と', KY:'杏', KE:'今', GIN:'全', KAKU:'馬', HI:'龍'};
const PCOL     = ['#4488ff', '#ff4433', '#33cc55'];
const PNAME_BASE = ['青将', '赤将', '緑将'];
const PNAME    = PNAME_BASE.slice(); // humanPlayerに応じて動的更新
const DRAW_ANGLE = [0, Math.PI, -Math.PI/2]; // 駒の向き（プレイヤー別）

// ── ゲーム状態 ──
let board, hand, turn, gover, winner;
let winType = 'normal';
let moveCount = 0;
const MAX_MOVES = 500;
let selected, vmoves, selHand, promoQ, lastMove;
let eliminated;
let viewPlayer  = 0;
let humanPlayer = 0;
let humanEliminated = false;
let cpuCollusion = false;
let keepAllPieces = true; // 'all'=常に持ち駒、'next'=次のプレイヤーへ、false=消滅あり
let gameGen = 0;
let kifu = [];
let kifuView = null; // null=現在局を表示、配列=閲覧中の古い棋譜

// ── 自己対局モード ──
let selfPlayMode  = false;
let selfPlayGames = 0;
let selfPlayTotalMoves = 0;
let selfPlayDraws = 0;
let selfPlayWins       = [0, 0, 0]; // 勝利数
let selfPlayLimitWins  = [0, 0, 0]; // 500手制限勝ち
let selfPlayTryWins    = [0, 0, 0]; // 入玉勝ち
let selfPlayTryWinsBy  = [0, 0, 0]; // 入玉時残り人数別
let selfPlayTryPiecesTotal = 0;     // 入玉時総駒数累計
let selfPlayTryPiecesCount = 0;     // 入玉回数
let selfPlayStartBoard = null;      // 自己対局開始局面
let selfPlayStartHand  = null;
let selfPlayStartElim  = null;

// ── 盤面編集モード ──
let editMode     = false;
let editSelected = null; // {type:'board',r,c} or {type:'palette',p,o,pr} or {type:'hand',o,p}
let editElim     = [false, false, false];

// ── roundRect polyfill ──
if(!CanvasRenderingContext2D.prototype.roundRect){
  CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,r){
    this.beginPath();
    this.moveTo(x+r,y);this.lineTo(x+w-r,y);
    this.arcTo(x+w,y,x+w,y+r,r);this.lineTo(x+w,y+h-r);
    this.arcTo(x+w,y+h,x+w-r,y+h,r);this.lineTo(x+r,y+h);
    this.arcTo(x,y+h,x,y+h-r,r);this.lineTo(x,y+r);
    this.arcTo(x,y,x+r,y,r);this.closePath();
  };
}

// ── ユーティリティ ──
function inB(r,c){return r>=0&&r<9&&c>=0&&c<9;}

// 各プレイヤーの前進方向に合わせて差分を回転
function rotDir(dr,dc,o){
  if(o===0) return [dr,dc];         // forward=up  → identity
  if(o===1) return [-dr,-dc];       // forward=down → 180°
  return [-dc,dr];                  // forward=left → 90°CCW
}

// ── 視点変換 ──
// 論理座標 → 物理(画面)座標
function logToPhys(r, c){
  if(viewPlayer===0) return [r, c];
  if(viewPlayer===1) return [8-r, 8-c];
  return [c, 8-r]; // P2: 右側が手前
}
// 物理(画面)座標 → 論理座標（クリック用）
function physToLog(pr, pc){
  if(viewPlayer===0) return [pr, pc];
  if(viewPlayer===1) return [8-pr, 8-pc];
  return [8-pc, pr];
}
// 視点ごとの駒の回転追加量
const VIEW_ROT = [0, Math.PI, Math.PI/2];