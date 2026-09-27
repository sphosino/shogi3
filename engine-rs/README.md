# engine-rs

三人将棋の自己対局学習用のRustコード（設計は `../docs/`）。

| クレート | 内容 | 状態 |
|---|---|---|
| `core` (shogi3-core) | ルールエンジン：盤面・指し手生成・指す・終局判定・ハッシュ | 実装済み・JS実装と照合済み |
| `mcts` (shogi3-mcts) | 3人用MCTS・足場の評価器・比較用エージェント（ランダム／1手読みの駒得優先） | 実装済み |
| `selfplay` / `arena` / `py` | 自己対局・評価対局・Pythonバインディング | 未着手 |

## テスト（JS実装との照合）

照合データはJS実装（`game.js` の `applyMove` / `allMoves`）から作る。リポジトリ直下で：

```
node tools/gen-fixtures.js --games 300
cd engine-rs
cargo test --release -- --nocapture
```

取り駒ルール3種それぞれ300局（約14万手）を1手ずつ再生し、合法手の集合・指した後の局面・終局結果（勝者・終局の種類・手数）が一致するかを確かめる。

## 速度

```
cargo run --release --example perf -- 3000
```

ランダムに終局まで指す（合法手生成＋指す）：1スレッドで約157万手/秒（i7-13700KF）。

## 評価対局

```
cargo run --release --example arena -- --cand mcts:400 --base greedy --games 60 --threads 16
```

測る側1席 vs 比較相手2席（席は毎局入れ替え）。エージェント：`random` / `greedy`（1手読みの駒得優先）/ `mcts:訪問数`（足場の評価器）/ `mctsu:訪問数`（事前確率を一様にした足場）。

フェーズ2の結果（60局、足場の評価器）：

| 対戦 | 勝率（互角＝33%） |
|---|---|
| greedy vs random | 98.3% |
| mcts:100 vs random | 100% |
| mcts:100 vs greedy | 81.7% |
| mcts:400 vs greedy | 88.3% |
| mcts:1600 vs greedy | 95.0% |

1局の時間：mcts:400 で約1秒（1スレッド、足場の評価器）。
