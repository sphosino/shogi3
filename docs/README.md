# 三人将棋 自己対局学習AI 設計書

手作りの評価関数＋α-β探索（`engine.js`）から、AlphaZero / KataGo 系の自己対局学習（MCTS＋ニューラルネット）へ移行するための設計書。
コードを書く前に、仕様・構成・実験計画をここで固める。

## 文書一覧

| 文書 | 内容 |
|---|---|
| [research_plan.md](research_plan.md) | 目的・研究の問い・仮説・フェーズ分けと完了条件 |
| [game_spec.md](game_spec.md) | ルールの完全な仕様（現行JS実装を正とする） |
| [system_design.md](system_design.md) | 技術構成・ディレクトリ構成・コンポーネント間のデータの流れ |
| [ai_architecture.md](ai_architecture.md) | ネットの入力・出力（方策・価値・補助ターゲット）・本体構造 |
| [self_play.md](self_play.md) | 3人用MCTS・自己対局・KataGo式の効率化・学習データ形式 |
| [training.md](training.md) | 学習ループ・損失・リプレイバッファ・モデル管理 |
| [evaluation.md](evaluation.md) | 強さの測り方・比較相手・マイルストーン |
| [experiments.md](experiments.md) | 研究実験（席の有利不利・戦力比と勝率など）とログ要件 |
| [open_questions.md](open_questions.md) | 未確定事項・設計上のリスク・研究上のバイアス |

## これまでの経緯（要約）

- 手作りエンジンは、三人だとパラノイド探索（相手2人が組む前提）かmax^N（枝刈りが効かない）しか選べない。高速化して中級2秒で深さ4.5まで読めるようにしたが、深さを1増やしても勝率は33%→41%程度しか伸びなかった。
- 探索方式の比較（中級2秒、1席 vs パラノイド2席、132局）：max^N 10.6%、BRS（Best-Reply Search）36.4%。
- 係数の調整は1件の確認に約75分（132局）かかり、効率が悪い。
- 以上から、評価と相手の振る舞いの予測を、自己対局から学習させる方式に切り替える。

## 前提環境

- GPU: RTX 3080（VRAM 10GB）、CPU: i7-13700KF（16コア/24スレッド）、RAM 32GB、Windows 11
- Rust 導入済み、Python 3.12（PyTorch は未導入）
