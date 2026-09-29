# システム構成

## 方針

- **速さが要る所はRust**：ルール・MCTS・自己対局の進行。数百局を同時に進める。
- **ネットの推論と学習はPython（PyTorch）**：Rust のモジュール（PyO3）を Python から呼び、評価が必要な局面をまとめて受け取って PyTorch で推論し、結果を返す。
- **既存のJSは照合元・画面として残す**。ブラウザの画面から、ローカルの対局サーバー経由で学習AIを呼ぶ。

当初は「Rust の自己対局プロセスが ONNX Runtime で推論し、Python を経由しない」予定だった。実装してみると、Python 側でまとめて推論する方式で十分速かった（推論が数万局面/秒、時間の大半はGPU）ので、ONNX は使っていない。ブラウザだけで動かす段階になったら ONNX を検討する。

## ディレクトリ構成

```
shogi3/
├── *.js, shogi3.html, tools/        … ゲーム画面と手作りエンジン。Rust の照合元
├── docs/                            … この設計書と結果
├── engine-rs/                       … Rust ワークスペース
│   ├── core/   (shogi3-core)        … 盤面・指し手生成・指す・終局判定・ハッシュ。3ルール対応
│   ├── mcts/   (shogi3-mcts)        … 3人用MCTS（PUCT）、評価器インターフェース、駒価値の足場（MaterialEval）、
│   │                                  比較用の簡単なプレイヤー（ランダム・駒得優先）、examples/arena.rs
│   └── py/     (shogi3_rs)          … Python モジュール。Driver（自己対局・評価対局）と Searcher（1局面の探索）
├── python/
│   ├── shogi3ml/                    … model.py（ネット）、features.py（局面→入力）、data.py（シャード・データ窓）、
│   │                                  train.py（損失）、selfplay.py（Driver を PyTorch の推論で回す）
│   └── scripts/                     … train_loop.py（学習ループ）、pretrain_scaffold.py（蒸留）、eval_models.py（評価）、
│                                      analyze_games.py（分析）、play_server.py（対局サーバー）、bench_selfplay.py、check_value.py
├── runs/<実行名>/                    … 実行ごとの成果物（git管理外）
│   ├── config.json / pretrain_config.json
│   ├── models/genNNNN.pt            … 世代ごとのモデル
│   ├── selfplay/genNNNN.npz         … 世代ごとの自己対局データ（scaffold_NN.npz は足場の対局）
│   ├── log.txt, eval.jsonl, eval_extra.jsonl, value_check.jsonl
└── gpu_sleep_guard.ps1              … 学習中のスリープ・省電力を止める
（照合用データは engine-rs/core/tests/fixtures/ に `node tools/gen-fixtures.js` で作る。git管理外）
```

## データの流れ（学習ループ、同期版）

```
 世代 g のモデル（PyTorch, GPU）
    │
    ▼
 自己対局：shogi3_rs.Driver（Rust）が 512局を同時に進める
    next_batch() → 評価待ちの局面（109バイト×B）と合法手
    Python が入力チャンネルを作って推論 → submit(方策, 価値)
    … 1000局終わるまで繰り返す
    │ take_finished() → 学習データ（局面ごと）＋対局の要約
    ▼
 runs/<run>/selfplay/gen{g}.npz
    │
    ▼
 学習：直近60万局面のデータ窓から、新しい局面数に比例したステップ数だけ学習 → 世代 g+1
    │
    ▼
 数世代ごとに評価対局（同じ Driver を「1体 vs 2体・席を回す」設定で使う）
```

- 自己対局と学習は交互に回す（同期版）。GPU 1枚で足りている。
- 局面は 109 バイトの小さな形で Rust と Python の間を渡す（[self_play.md](self_play.md) の学習データ）。

## 対局サーバー（ブラウザから学習AIと対局）

- `play_server.py` がリポジトリ直下のファイルを配信し、`POST /api/move` で指し手を返す。
- ブラウザ（`game.js` の `netMove`）が、盤・持ち駒・脱落・手番・手数・ルールを JSON で送る。
- サーバーは局面を109バイトにして `shogi3_rs.Searcher` で800回探索する（ネットの評価は1局面ずつ Python が返す）。最善手と3人の勝率予想を返す。
- 学習中は site-packages の `shogi3_rs` が使用中で上書きできないため、サーバーは `engine-rs/target/play/` に置いた別のコピーを優先して読む。

## JSとの照合

- `tools/gen-fixtures.js` が JS 実装（`applyMove` / `allMoves`）で乱数の対局を指し、毎手の合法手・指した手・指した後の局面（ダイジェスト）と終局結果を書き出す。進め方を3種類（駒取り優先／玉を前進／玉を取らない）に分け、脱落・入玉・500手制限をすべて通す。
- `engine-rs/core/tests/js_fixtures.rs` がこれを1手ずつ再生して照合する。取り駒ルール3種すべて（各300局、計約14万手）で一致。

## 比較相手

- 駒価値の足場の MCTS（`scaffold:訪問数`）、1手読みの駒得優先（`greedy`）、ランダム（`random`）は Rust にある。
- 過去の世代・別の実行のネット（`gen:N`、`ext:実行名:N`）。
- 手作りエンジン（`engine.js`）との対局は未実装（open_questions.md #4）。

## 速度（実測、RTX 3080）

- 自己対局の推論：6ブロック×96ch で約5万局面/秒、10ブロック×128ch で約3万局面/秒（1世代1000局がそれぞれ約7.5分・約13〜16分）。
- 学習：10ブロック×128ch でバッチ256が約40ステップ/秒。1世代の学習は約15秒で、時間のほとんどは自己対局。
- 詳しくは [results.md](results.md)。
