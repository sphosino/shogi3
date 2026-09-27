//! 三人将棋の3人用MCTS（設計は docs/self_play.md）。
//!
//! - 価値は3人それぞれの勝率の3つ組。各ノードで手番の人が自分の成分を最大化する（符号反転しない）。
//! - 評価器（ネット、または駒価値からの足場）は [`Evaluator`] で差し替える。
//! - 推論をまとめられるように、探索は「葉を選ぶ（[`Search::select`]）」と「評価を反映する（[`Search::expand`]）」に分けてある。

pub mod agents;
pub mod eval;
pub mod rng;
pub mod search;

pub use agents::{Agent, GreedyAgent, MctsAgent, RandomAgent};
pub use eval::{EvalOut, Evaluator, MaterialEval};
pub use rng::Rng;
pub use search::{Leaf, Search, SearchConfig, PASS};
