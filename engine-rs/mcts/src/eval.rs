//! 評価器：局面と合法手から、各手の事前確率と3人の勝率を返す。

use shogi3_core::{mv_promote, mv_to, piece_type, Move, Position, OU, PIECE_VALUE};

pub struct EvalOut {
    /// 合法手と同じ順の事前確率（合計1）
    pub priors: Vec<f32>,
    /// P0, P1, P2 それぞれの勝率（脱落者は0、合計1）
    pub value: [f32; 3],
}

pub trait Evaluator {
    fn evaluate(&mut self, pos: &Position, moves: &[Move]) -> EvalOut;
}

/// ネットができるまでの足場（docs/self_play.md）。最初の数世代の自己対局だけで使う。
/// - 事前確率：玉取りを大きく、駒取りは取る駒の価値に応じて、成りを少し高く（一様だと2手先の玉取りすら探索が届かないため）
/// - 価値：生存者の駒価値の softmax。ただし手番の人が誰かの玉を取れるなら、その玉取りを指した後で評価する
pub struct MaterialEval {
    /// softmax の温度（駒価値の差がこの値だと勝率比が e 倍）
    pub temperature: f32,
    /// false なら事前確率を一様にする（比較用）
    pub capture_priors: bool,
}

impl Default for MaterialEval {
    fn default() -> Self {
        MaterialEval { temperature: 600.0, capture_priors: true }
    }
}

impl MaterialEval {
    pub fn value(&self, pos: &Position, moves: &[Move]) -> [f32; 3] {
        // 手番の人が玉を取れるなら、手番の人にとって最も良い玉取りの後の局面で評価
        let me = pos.turn as usize;
        let mut best: Option<[f32; 3]> = None;
        for &m in moves {
            if mv_is_drop_or_pass(m) {
                continue;
            }
            let tc = pos.board[mv_to(m)];
            if tc == 0 || piece_type(tc) != OU {
                continue;
            }
            let mut p = pos.clone();
            let v = match p.play(m) {
                Some(o) => {
                    let mut v = [0f32; 3];
                    v[o.winner as usize] = 1.0;
                    v
                }
                None => material_value(&p, self.temperature),
            };
            if best.map_or(true, |b| v[me] > b[me]) {
                best = Some(v);
            }
        }
        best.unwrap_or_else(|| material_value(pos, self.temperature))
    }

    pub fn priors(&self, pos: &Position, moves: &[Move]) -> Vec<f32> {
        if !self.capture_priors {
            return vec![1.0 / moves.len().max(1) as f32; moves.len()];
        }
        let w: Vec<f32> = moves
            .iter()
            .map(|&m| {
                if mv_is_drop_or_pass(m) {
                    return 1.0;
                }
                let tc = pos.board[mv_to(m)];
                let mut w = 1.0;
                if tc != 0 {
                    w += if piece_type(tc) == OU { 50.0 } else { PIECE_VALUE[piece_type(tc) as usize] as f32 / 100.0 };
                }
                if mv_promote(m) {
                    w += 1.0;
                }
                w
            })
            .collect();
        let sum: f32 = w.iter().sum();
        w.into_iter().map(|x| x / sum).collect()
    }
}

impl Evaluator for MaterialEval {
    fn evaluate(&mut self, pos: &Position, moves: &[Move]) -> EvalOut {
        EvalOut { priors: self.priors(pos, moves), value: self.value(pos, moves) }
    }
}

fn mv_is_drop_or_pass(m: Move) -> bool {
    m == crate::search::PASS || shogi3_core::mv_is_drop(m)
}

/// 生存者の駒価値の softmax
pub fn material_value(pos: &Position, temperature: f32) -> [f32; 3] {
    let m = pos.material();
    let alive: Vec<usize> = (0..3).filter(|&o| !pos.elim[o]).collect();
    let mut v = [0f32; 3];
    if alive.is_empty() {
        return v;
    }
    let mx = alive.iter().map(|&o| m[o]).fold(f64::MIN, f64::max);
    let mut sum = 0f32;
    for &o in &alive {
        let e = (((m[o] - mx) as f32) / temperature).exp();
        v[o] = e;
        sum += e;
    }
    for x in v.iter_mut() {
        *x /= sum;
    }
    v
}
