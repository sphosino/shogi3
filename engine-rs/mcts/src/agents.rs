//! 対局させるプレイヤー（比較相手を含む）。docs/evaluation.md

use crate::eval::{Evaluator, MaterialEval};
use crate::rng::Rng;
use crate::search::{Search, SearchConfig, PASS};
use shogi3_core::{Move, Position};

pub trait Agent {
    /// 手番の人の手を選ぶ（None = 指せる手がない）
    fn choose(&mut self, pos: &Position) -> Option<Move>;
    fn name(&self) -> String;
}

/// 合法手から一様に選ぶ
pub struct RandomAgent {
    rng: Rng,
    buf: Vec<Move>,
}

impl RandomAgent {
    pub fn new(seed: u64) -> Self {
        RandomAgent { rng: Rng::new(seed), buf: Vec::new() }
    }
}

impl Agent for RandomAgent {
    fn choose(&mut self, pos: &Position) -> Option<Move> {
        self.buf.clear();
        pos.gen_moves(&mut self.buf);
        (!self.buf.is_empty()).then(|| self.buf[self.rng.below(self.buf.len())])
    }
    fn name(&self) -> String {
        "random".into()
    }
}

/// 1手読みの駒得優先：勝てる手があれば指す。なければ「自分の駒価値 − 他の生存者の駒価値の最大」が最大の手（同点は乱数）
pub struct GreedyAgent {
    rng: Rng,
    buf: Vec<Move>,
}

impl GreedyAgent {
    pub fn new(seed: u64) -> Self {
        GreedyAgent { rng: Rng::new(seed), buf: Vec::new() }
    }
}

impl Agent for GreedyAgent {
    fn choose(&mut self, pos: &Position) -> Option<Move> {
        self.buf.clear();
        pos.gen_moves(&mut self.buf);
        if self.buf.is_empty() {
            return None;
        }
        let me = pos.turn as usize;
        let mut best: Vec<Move> = Vec::new();
        let mut best_score = f64::MIN;
        for &m in &self.buf {
            let mut p = pos.clone();
            let score = match p.play(m) {
                Some(o) if o.winner as usize == me => f64::MAX,
                Some(_) => f64::MIN / 2.0,
                None => {
                    let mat = p.material();
                    let others = (0..3).filter(|&o| o != me && !p.elim[o]).map(|o| mat[o]).fold(0.0, f64::max);
                    // 相手の玉を取って脱落させた手は大きく評価
                    let elim_bonus = (0..3).filter(|&o| o != me && p.elim[o] && !pos.elim[o]).count() as f64 * 1e6;
                    mat[me] - others + elim_bonus
                }
            };
            if score > best_score {
                best_score = score;
                best.clear();
                best.push(m);
            } else if score == best_score {
                best.push(m);
            }
        }
        Some(best[self.rng.below(best.len())])
    }
    fn name(&self) -> String {
        "greedy".into()
    }
}

/// MCTS（評価器は差し替え可能。既定は駒価値の足場）
pub struct MctsAgent<E: Evaluator> {
    pub eval: E,
    pub visits: u32,
    pub cfg: SearchConfig,
    rng: Rng,
    /// 直近の探索の統計
    pub last_nodes: usize,
}

impl MctsAgent<MaterialEval> {
    pub fn material(visits: u32, seed: u64) -> Self {
        MctsAgent { eval: MaterialEval::default(), visits, cfg: SearchConfig::default(), rng: Rng::new(seed), last_nodes: 0 }
    }
}

impl<E: Evaluator> MctsAgent<E> {
    pub fn with_eval(eval: E, visits: u32, seed: u64) -> Self {
        MctsAgent { eval, visits, cfg: SearchConfig::default(), rng: Rng::new(seed), last_nodes: 0 }
    }
}

impl<E: Evaluator> Agent for MctsAgent<E> {
    fn choose(&mut self, pos: &Position) -> Option<Move> {
        let mut s = Search::new(pos.clone(), self.cfg.clone());
        s.run(&mut self.eval, self.visits, Some(&mut self.rng));
        self.last_nodes = s.node_count();
        let m = s.best_move();
        (m != PASS).then_some(m)
    }
    fn name(&self) -> String {
        format!("mcts{}", self.visits)
    }
}
