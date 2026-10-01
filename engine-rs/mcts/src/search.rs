//! 3人用 PUCT 探索。

use crate::eval::{EvalOut, Evaluator};
use crate::rng::Rng;
use shogi3_core::{Move, Position};

/// 指せる手がないときのパス
pub const PASS: Move = u16::MAX;
const NONE: u32 = u32::MAX;

#[derive(Clone, Debug)]
pub struct SearchConfig {
    pub c_puct: f32,
    /// 未訪問の子の Q = 親の Q − この値（First Play Urgency）
    pub fpu_reduction: f32,
    /// 根のディリクレノイズ（0 なら入れない）。α = dirichlet_total / 合法手数
    pub dirichlet_total: f32,
    pub dirichlet_weight: f32,
}

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig { c_puct: 1.5, fpu_reduction: 0.2, dirichlet_total: 0.0, dirichlet_weight: 0.25 }
    }
}

struct Edge {
    mv: Move,
    prior: f32,
    child: u32,
}

struct Node {
    pos: Position,
    edges_start: u32,
    edges_len: u32,
    expanded: bool,
    /// 終局ノードなら勝者の one-hot
    terminal: Option<[f32; 3]>,
    n: u32,
    w: [f32; 3],
}

/// 評価待ちの葉（またはすでに値が決まっている終局ノード）
pub struct Leaf {
    path: Vec<u32>,
    /// 終局ノードなら値が決まっている
    pub terminal: Option<[f32; 3]>,
}

impl Leaf {
    fn node(&self) -> u32 {
        *self.path.last().unwrap()
    }
}

pub struct Search {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    cfg: SearchConfig,
    moves_buf: Vec<Move>,
}

fn onehot(w: u8) -> [f32; 3] {
    let mut v = [0f32; 3];
    v[w as usize] = 1.0;
    v
}

impl Search {
    pub fn new(root: Position, cfg: SearchConfig) -> Search {
        Search {
            nodes: vec![Node { pos: root, edges_start: 0, edges_len: 0, expanded: false, terminal: None, n: 0, w: [0.0; 3] }],
            edges: Vec::new(),
            cfg,
            moves_buf: Vec::with_capacity(1024),
        }
    }

    pub fn root(&self) -> &Position {
        &self.nodes[0].pos
    }

    pub fn root_visits(&self) -> u32 {
        self.nodes[0].n
    }

    /// 根から PUCT で降りて、評価が必要な葉（または終局ノード）を返す
    pub fn select(&mut self) -> Leaf {
        let mut path = vec![0u32];
        let mut cur = 0u32;
        loop {
            let node = &self.nodes[cur as usize];
            if let Some(t) = node.terminal {
                return Leaf { path, terminal: Some(t) };
            }
            if !node.expanded {
                return Leaf { path, terminal: None };
            }
            let p = node.pos.turn as usize;
            let sqrt_n = (node.n.max(1) as f32).sqrt();
            let parent_q = if node.n > 0 { node.w[p] / node.n as f32 } else { 0.0 };
            let fpu = (parent_q - self.cfg.fpu_reduction).max(0.0);
            let (s, l) = (node.edges_start as usize, node.edges_len as usize);
            let mut best = s;
            let mut best_score = f32::MIN;
            for i in s..s + l {
                let e = &self.edges[i];
                let (q, cn) = if e.child == NONE {
                    (fpu, 0u32)
                } else {
                    let c = &self.nodes[e.child as usize];
                    if c.n == 0 {
                        (fpu, 0)
                    } else {
                        (c.w[p] / c.n as f32, c.n)
                    }
                };
                let score = q + self.cfg.c_puct * e.prior * sqrt_n / (1.0 + cn as f32);
                if score > best_score {
                    best_score = score;
                    best = i;
                }
            }
            if self.edges[best].child == NONE {
                // 子を作る
                let mut pos = self.nodes[cur as usize].pos.clone();
                let mv = self.edges[best].mv;
                let terminal = if mv == PASS {
                    pos.pass();
                    None
                } else {
                    pos.play(mv).map(|o| onehot(o.winner))
                };
                let id = self.nodes.len() as u32;
                self.nodes.push(Node { pos, edges_start: 0, edges_len: 0, expanded: false, terminal, n: 0, w: [0.0; 3] });
                self.edges[best].child = id;
                path.push(id);
                return Leaf { path, terminal };
            }
            cur = self.edges[best].child;
            path.push(cur);
        }
    }

    /// 葉の局面と合法手（評価器に渡す）。終局ノードでは呼ばない
    pub fn leaf_position(&self, leaf: &Leaf) -> &Position {
        &self.nodes[leaf.node() as usize].pos
    }

    /// 葉の合法手を作る（パスしかなければ [PASS]）
    pub fn leaf_moves(&mut self, leaf: &Leaf) -> Vec<Move> {
        self.moves_buf.clear();
        self.nodes[leaf.node() as usize].pos.gen_moves(&mut self.moves_buf);
        if self.moves_buf.is_empty() {
            self.moves_buf.push(PASS);
        }
        self.moves_buf.clone()
    }

    /// 葉に評価を反映して展開し、値を根まで足し込む。終局ノードなら eval は None でよい
    pub fn expand(&mut self, leaf: Leaf, moves: &[Move], eval: Option<EvalOut>) {
        let value = match leaf.terminal {
            Some(t) => t,
            None => {
                let ev = eval.expect("終局でない葉には評価が必要");
                let id = leaf.node() as usize;
                let start = self.edges.len() as u32;
                for (i, &mv) in moves.iter().enumerate() {
                    let prior = if moves.len() == 1 { 1.0 } else { ev.priors.get(i).copied().unwrap_or(0.0) };
                    self.edges.push(Edge { mv, prior, child: NONE });
                }
                let node = &mut self.nodes[id];
                node.edges_start = start;
                node.edges_len = moves.len() as u32;
                node.expanded = true;
                ev.value
            }
        };
        for &id in &leaf.path {
            let n = &mut self.nodes[id as usize];
            n.n += 1;
            for k in 0..3 {
                n.w[k] += value[k];
            }
        }
    }

    /// 評価器を直接呼んで visits 回まで探索する（推論をまとめない単純版）
    pub fn run<E: Evaluator>(&mut self, eval: &mut E, visits: u32, rng: Option<&mut Rng>) {
        if !self.nodes[0].expanded {
            let leaf = self.select();
            if leaf.terminal.is_some() {
                self.expand(leaf, &[], None);
                return;
            }
            let moves = self.leaf_moves(&leaf);
            let ev = eval.evaluate(self.leaf_position(&leaf), &moves);
            self.expand(leaf, &moves, Some(ev));
            if let Some(r) = rng {
                self.add_root_noise(r);
            }
        }
        while self.nodes[0].n < visits {
            let leaf = self.select();
            if leaf.terminal.is_some() {
                self.expand(leaf, &[], None);
                continue;
            }
            let moves = self.leaf_moves(&leaf);
            let ev = eval.evaluate(self.leaf_position(&leaf), &moves);
            self.expand(leaf, &moves, Some(ev));
        }
    }

    /// 根の事前確率にディリクレノイズを混ぜる
    pub fn add_root_noise(&mut self, rng: &mut Rng) {
        if self.cfg.dirichlet_total <= 0.0 || !self.nodes[0].expanded {
            return;
        }
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        if l <= 1 {
            return;
        }
        let alpha = (self.cfg.dirichlet_total / l as f32) as f64;
        let g: Vec<f64> = (0..l).map(|_| rng.gamma(alpha)).collect();
        let sum: f64 = g.iter().sum::<f64>().max(1e-12);
        let w = self.cfg.dirichlet_weight;
        for (i, gi) in g.iter().enumerate() {
            let e = &mut self.edges[s + i];
            e.prior = (1.0 - w) * e.prior + w * (*gi / sum) as f32;
        }
    }

    /// 根の各手の訪問数
    pub fn root_visit_counts(&self) -> Vec<(Move, u32)> {
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        (s..s + l)
            .map(|i| {
                let e = &self.edges[i];
                (e.mv, if e.child == NONE { 0 } else { self.nodes[e.child as usize].n })
            })
            .collect()
    }

    /// 根の各手の訪問数と、その手の後の価値（3つ組の平均。未訪問なら None）
    pub fn root_children(&self) -> Vec<(Move, u32, Option<[f32; 3]>)> {
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        (s..s + l)
            .map(|i| {
                let e = &self.edges[i];
                if e.child == NONE {
                    return (e.mv, 0, None);
                }
                let c = &self.nodes[e.child as usize];
                let d = c.n.max(1) as f32;
                (e.mv, c.n, Some([c.w[0] / d, c.w[1] / d, c.w[2] / d]))
            })
            .collect()
    }

    /// 根の価値（3つ組の平均）
    pub fn root_value(&self) -> [f32; 3] {
        let n = &self.nodes[0];
        let d = n.n.max(1) as f32;
        [n.w[0] / d, n.w[1] / d, n.w[2] / d]
    }

    /// 最多訪問の手（同数なら事前確率が大きい方）
    pub fn best_move(&self) -> Move {
        let (s, l) = (self.nodes[0].edges_start as usize, self.nodes[0].edges_len as usize);
        let mut best = s;
        let mut key = (0u32, f32::MIN);
        for i in s..s + l {
            let e = &self.edges[i];
            let n = if e.child == NONE { 0 } else { self.nodes[e.child as usize].n };
            if n > key.0 || (n == key.0 && e.prior > key.1) {
                key = (n, e.prior);
                best = i;
            }
        }
        self.edges[best].mv
    }

    /// 訪問数^(1/温度) に比例して選ぶ（自己対局の序盤用）
    pub fn sample_move(&self, temperature: f32, rng: &mut Rng) -> Move {
        let counts = self.root_visit_counts();
        let weights: Vec<f64> = counts.iter().map(|&(_, n)| (n as f64).powf(1.0 / temperature as f64)).collect();
        let sum: f64 = weights.iter().sum();
        if sum <= 0.0 {
            return self.best_move();
        }
        let mut x = rng.unit() * sum;
        for (i, w) in weights.iter().enumerate() {
            x -= w;
            if x <= 0.0 {
                return counts[i].0;
            }
        }
        counts.last().unwrap().0
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}
