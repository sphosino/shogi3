# engine-rs

三人将棋の自己対局学習用のRustコード（設計は `../docs/`）。

| クレート | 内容 | 状態 |
|---|---|---|
| `core` (shogi3-core) | ルールエンジン：盤面・指し手生成・指す・終局判定・ハッシュ | 実装済み・JS実装と照合済み |
| `mcts` | 3人用MCTS | 未着手 |
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
