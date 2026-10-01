# 三人将棋

9×9盤で3人が同時に対局する将棋です。2つの部分からなります。

1. **ブラウザのゲーム**（`shogi3.html` と JS）：人が遊ぶ画面と、手作りの評価関数で指すCPU。
2. **自己対局で学習したAI**（`engine-rs/` の Rust と `python/` の PyTorch）：AlphaZero / KataGo 系の方式（MCTS＋ニューラルネット）で、ルールと勝敗だけから学習したAI。手作りのCPUよりずっと強い。ブラウザの難易度「🧠 学習AI」で対戦できる（下記）。

ルールは [RULES.md](RULES.md)、学習AIの設計と結果は [docs/](docs/README.md) を参照。

## 遊び方

### 手作りのCPUと対局する

`shogi3.html` をブラウザで開く（サーバー不要）。

### 学習AIと対局する

学習したネットはGPUで動かすので、ローカルのサーバーを起動してから開く。

```
python/.venv/Scripts/python.exe python/scripts/play_server.py --run pmix --gen 101
```

`http://localhost:8765/shogi3.html` を開き、難易度で **🧠 学習AI** を選ぶ。1手あたり800回探索する（GPUが空いていれば1手1〜3秒）。F12のコンソールに、AIが指すたびに3人の勝率予想が出る。

- `--run` / `--gen` で使うネットを選ぶ（省略すると `--run` の最新の世代）。
- 取り駒ルール3種すべてで指せる。ルールはネットにも入力として渡す（[docs/ai_architecture.md](docs/ai_architecture.md)）。
- サーバーにつながらないとき（ファイルを直接開いたときなど）は、中級の手作りCPUが代わりに指す。

## ファイル構成

```
shogi3.html, shogi3.css   画面
constants.js              定数・グローバル変数（難易度「学習AI」の設定もここ）
game.js                   初期化・合法手生成・手の適用・学習AIへの問い合わせ（netMove）
attack-maps.js            利き筋マップ
ai.js, engine.js          手作りのCPU（評価関数＋探索）
render.js, ui.js          描画・操作

engine-rs/                Rust
  core/                   ルール（盤・指し手生成・終局判定）。JS実装と完全一致を確認済み
  mcts/                   3人用MCTS、駒価値の足場の評価器
  py/                     Python から呼ぶモジュール shogi3_rs（自己対局ドライバ・1局面の探索）
python/
  shogi3ml/               ネット・入力の作り方・学習データ・損失
  scripts/                学習ループ・蒸留・評価・分析・対局サーバー
runs/                     学習の成果物（モデル・自己対局データ・ログ。git管理外）
docs/                     設計書と結果
tools/                    JS用の道具（手作りCPUの自己対局・ベンチ・Rust照合用データ作成）
gpu_sleep_guard.ps1       長時間の学習中にPCがスリープ・省電力にならないようにする
```

## 学習AIの環境構築

- Rust（cargo）、Python 3.12、NVIDIA GPU（RTX 3080 で開発）。
- Python の仮想環境は `python/.venv`。PyTorch（CUDA版）と maturin を入れる。
- Rust のモジュールをビルドして仮想環境に入れる：

```
cd engine-rs/py
VIRTUAL_ENV=../../python/.venv ../../python/.venv/Scripts/maturin.exe develop --release
```

- 学習中は、読み込まれている `shogi3_rs` を上書きできない。対局サーバーは `engine-rs/target/play/` に置いた別のコピーを優先して読む（`maturin build` した wheel を展開して置く）。

## 学習を回す

リポジトリ直下で実行する。ログは `runs/<実行名>/log.txt`、評価は `eval.jsonl`。

```
# 今の本線：3つのルールを混ぜて、p5c 世代25から学習（docs/training.md）
python/.venv/Scripts/python.exe python/scripts/train_loop.py --run pmix --rule mix --init p5c:25 --gens 20 \
  --games-per-gen 1000 --window 600000 --lr 0.005 --lr-warm 0.002 --lr-warm-gens 3 \
  --eval-every 5 --eval-games 150 --eval-vs gen:1

# 評価（1体 vs 同じ相手2体、席は毎局入れ替え。互角なら33.3%）
python/.venv/Scripts/python.exe python/scripts/eval_models.py --run p5c --gen 25 --vs ext:p4:51 gen:1 --games 300

# 自己対局データの分析（席の有利不利・脱落・駒得と勝率）
python/.venv/Scripts/python.exe python/scripts/analyze_games.py --run p4
```

離席中に長く回すときは、先に `gpu_sleep_guard.ps1` を起動しておく。Windows が学習プロセスを省電力（Eコア・低クロック）に回して約4倍遅くなるのと、自動スリープで止まるのを防ぐ。

## 手作りのCPU（参考）

学習AIの前に作った、評価関数＋探索のCPU。ブラウザの難易度 入門〜上級 はこちら。

| 項目 | 内容 |
|---|---|
| 探索 | 反復深化 minimax（三つ巴時はパラノイド探索。`AI_THREEWAY_SEARCH` で max^N / BRS に切替可）|
| 静止探索 | 末端で駒取りのみを最大4手延長 |
| 枝刈り | α-β法 + 置換表 + futility枝刈り + LMR + ランク別スライス |
| 評価 | 駒価値 + モビリティ + 王安全度 + 入玉距離ボーナス |

パラメータ比較（候補1席 vs 基準2席）：

```
node tools/selfplay.js --games 132 --time 2000 --cand '{"AI_DANGER_SCALE":0.4}'
```

`--time` は実際の思考時間より200ms長く指定する（2000 = 中級）。

## Gen101で見えた、3人将棋らしい一局

学習を世代101まで進めたところ、人間が対局していて「明らかに3人将棋のことを考えている」と感じる一局があった。

青（人間）は序盤、桂馬をすぐに取って駒得した。ところが、その後の展開が普通の2人将棋とは違った。

- 赤が青の駒に両取りを仕掛ける。
- 青は桂馬を放置した結果、赤の成桂から王手を受ける。
- 青はその成桂を取って王手を解消する。
- しかし、青の次の手番は緑。緑から見ると、青玉を取れる状況になっていた。
- 緑は赤の成桂を取るよりも、青玉を取ることを選ぶ。
- その間に赤は緑の陣へ駒を打ち込んでおり、緑が青を倒した直後、その駒を赤が回収する。

結果として、**赤が青を直接倒すのではなく、青と緑の争いを利用して最後に利益を得る「漁夫の利」**のような展開になった。

この一局を通じて、人間側にも「自分の前の相手からの王手は自分で対応できるが、自分の次の相手からの王手は危険」という3人将棋特有の感覚が生まれた。王手そのものだけでなく、**王手を受けた直後に誰の手番が来るか**が重要になる。

また、これは「駒得したから安全」とは限らないことも示している。3人のうち一人が突出すると、残り2人の利害が一時的に噛み合い、そのプレイヤーを攻撃する状況が生まれることがある。

Gen101の評価値だけを見れば、従来世代からの伸びは大きく見えなかった。しかし実際に人間が対局すると、こうした**3人ゲーム特有の因果関係や、他プレイヤー同士の争いを利用する手**が初めてはっきり感じられた。これは、このAIの学習で特に印象に残った出来事の一つである。
