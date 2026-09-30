//! Pythonから使う自己対局ドライバ（docs/self_play.md, docs/system_design.md）。
//!
//! 数百局を同時に進め、ネットの評価が必要な葉をまとめて Python に渡す（`next_batch`）。
//! Python は PyTorch で推論して結果を返す（`submit`）。終局した対局から学習データを作る（`take_finished`）。
//!
//! 局面は 109 バイトの小さな形でやり取りする（入力チャンネルへの展開は Python 側）：
//!   盤 81（駒コード） + 持ち駒 21（持ち主×駒種7） + 脱落 3 + 手番 1 + 手数 2（u16 LE） + 取り駒ルール 1（0=all 1=next 2=vanish）
//! ルールもネットに渡し、1つのネットで3つのルールを学ぶ（KataGo がルールを入力に入れるのと同じ考え方）。
//! 方策の番号：`(移動元*2 + 成り)*81 + 移動先`（移動元 = 盤上0..80、打ちは 81+駒種）。全 14,256 通り。

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};
use shogi3_core::{mv_from, mv_promote, mv_to, CaptureRule, Move, Position, WinKind};
use shogi3_mcts::{Agent, EvalOut, Evaluator, GreedyAgent, Leaf, MaterialEval, MctsAgent, RandomAgent, Rng, Search, SearchConfig, PASS};

pub const STATE_BYTES: usize = 109;
pub const NUM_POLICY: usize = 88 * 2 * 81;

pub fn policy_index(m: Move) -> i32 {
    ((mv_from(m) * 2 + mv_promote(m) as usize) * 81 + mv_to(m)) as i32
}

fn encode_state(p: &Position, out: &mut Vec<u8>) {
    out.extend_from_slice(&p.board);
    for o in 0..3 {
        out.extend_from_slice(&p.hand[o][..7]);
    }
    for o in 0..3 {
        out.push(p.elim[o] as u8);
    }
    out.push(p.turn);
    out.extend_from_slice(&p.move_count.to_le_bytes());
    out.push(rule_id(p.rule));
}

fn rule_id(r: CaptureRule) -> u8 {
    match r {
        CaptureRule::All => 0,
        CaptureRule::Next => 1,
        CaptureRule::Vanish => 2,
    }
}

fn rule_from_id(i: u8) -> CaptureRule {
    match i {
        1 => CaptureRule::Next,
        2 => CaptureRule::Vanish,
        _ => CaptureRule::All,
    }
}

/// "all" / "next" / "vanish" / "mix"（3つを対局ごとに順に）
fn parse_rules(rule: &str) -> PyResult<Vec<CaptureRule>> {
    Ok(match rule {
        "all" => vec![CaptureRule::All],
        "next" => vec![CaptureRule::Next],
        "vanish" => vec![CaptureRule::Vanish],
        "mix" => vec![CaptureRule::All, CaptureRule::Next, CaptureRule::Vanish],
        _ => return Err(PyValueError::new_err("rule は all/next/vanish/mix")),
    })
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}
fn read_f32(b: &[u8], i: usize) -> f32 {
    f32::from_le_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]])
}

// ── 席ごとのプレイヤー ──

enum Seat {
    /// ネット（番号でモデルを区別。評価対局で新旧のネットを戦わせるため）
    Net(u8),
    /// ネット以外（足場のMCTS・駒得優先・ランダム）。Rust内で即座に指す
    Internal(Box<dyn Agent>),
}

fn make_seat(spec: &str, seed: u64) -> PyResult<Seat> {
    let parts: Vec<&str> = spec.split(':').collect();
    let num = |i: usize, d: u32| parts.get(i).and_then(|s| s.parse::<u32>().ok()).unwrap_or(d);
    Ok(match parts[0] {
        "net" => Seat::Net(num(1, 0) as u8),
        "scaffold" | "mcts" => Seat::Internal(Box::new(MctsAgent::material(num(1, 400), seed))),
        "greedy" => Seat::Internal(Box::new(GreedyAgent::new(seed))),
        "random" => Seat::Internal(Box::new(RandomAgent::new(seed))),
        _ => return Err(PyValueError::new_err(format!("未知の席の種類 {spec}"))),
    })
}

// ── 対局中の状態 ──

struct PlyRecord {
    state: Vec<u8>,
    /// 全力探索のときだけ（合法手の方策番号と訪問数）
    policy: Option<(Vec<i32>, Vec<u32>)>,
    root_value: [f32; 3],
    material: [f32; 3],
}

struct Pending {
    leaf: Leaf,
    moves: Vec<Move>,
    /// 根の最初の評価（ノイズを入れるため）
    is_root: bool,
}

struct Game {
    id: u64,
    pos: Position,
    seats: Vec<Seat>,
    search: Option<Search>,
    target: u32,
    full: bool,
    pending: Option<Pending>,
    records: Vec<PlyRecord>,
    /// 手数ごとの記録を残すか（自己対局のとき）
    record: bool,
    moves: Vec<u16>,
    /// 脱落の記録（記録の番号, 脱落した人）
    elim_events: Vec<(usize, u8)>,
    outcome: Option<(u8, WinKind)>,
    rng: Rng,
}

#[derive(Clone)]
struct Cfg {
    visits_full: u32,
    visits_fast: u32,
    full_prob: f64,
    temp_plies: u16,
    search: SearchConfig,
    /// ネットの代わりに足場の評価器を使う（最初の世代）
    scaffold: bool,
}

#[pyclass(unsendable)]
pub struct Driver {
    games: Vec<Game>,
    cfg: Cfg,
    seat_specs: Vec<String>,
    rotate: bool,
    /// 過去の世代を混ぜる対局（alt_prob の確率で、この中から1つを選び、席をランダムに回す）
    alt_seats: Vec<Vec<String>>,
    alt_prob: f64,
    record: bool,
    total_games: u64,
    started: u64,
    seed: u64,
    /// 対局ごとのルール（mix なら3つ。対局番号/3 で選ぶ：評価で席を回す 対局番号%3 と独立にするため）
    rules: Vec<CaptureRule>,
    finished: Vec<Game>,
    /// next_batch で渡した順（submit で使う）
    batch_order: Vec<usize>,
    scaffold_eval: MaterialEval,
    moves_buf: Vec<Move>,
}

impl Driver {
    fn new_game(&mut self) -> PyResult<Game> {
        let id = self.started;
        self.started += 1;
        let seed = self.seed.wrapping_mul(1_000_003).wrapping_add(id);
        let mut pick = Rng::new(seed ^ 0x5EED_A17);
        let (specs, rot) = if !self.alt_seats.is_empty() && pick.unit() < self.alt_prob {
            let k = ((pick.unit() * self.alt_seats.len() as f64) as usize).min(self.alt_seats.len() - 1);
            (&self.alt_seats[k], ((pick.unit() * 3.0) as usize).min(2))
        } else {
            (&self.seat_specs, if self.rotate { (id % 3) as usize } else { 0 })
        };
        let mut seats = Vec::with_capacity(3);
        for s in 0..3 {
            // 基本の並び [A,B,C] を対局ごとにずらす（評価：測る側の席を入れ替える／過去の世代を混ぜる対局：席をランダムに）
            let spec = &specs[(s + 3 - rot) % 3];
            seats.push(make_seat(spec, seed * 3 + s as u64)?);
        }
        Ok(Game {
            id,
            pos: Position::initial(self.rules[((id / 3) % self.rules.len() as u64) as usize]),
            seats,
            search: None,
            target: 0,
            full: false,
            pending: None,
            records: Vec::new(),
            record: self.record,
            moves: Vec::new(),
            elim_events: Vec::new(),
            outcome: None,
            rng: Rng::new(seed ^ 0xABCDEF),
        })
    }

    /// 1局を、ネットの評価が必要になるか終局するまで進める。評価待ちなら true
    fn advance(g: &mut Game, cfg: &Cfg, scaffold: &mut MaterialEval, buf: &mut Vec<Move>) -> bool {
        loop {
            if g.outcome.is_some() {
                return false;
            }
            let turn = g.pos.turn as usize;
            if let Seat::Internal(agent) = &mut g.seats[turn] {
                let mv = agent.choose(&g.pos);
                Self::play(g, mv.unwrap_or(PASS));
                continue;
            }
            if g.search.is_none() {
                g.full = cfg.full_prob >= 1.0 || g.rng.unit() < cfg.full_prob;
                g.target = if g.full { cfg.visits_full } else { cfg.visits_fast };
                let mut sc = cfg.search.clone();
                if !g.full {
                    sc.dirichlet_total = 0.0;
                }
                g.search = Some(Search::new(g.pos.clone(), sc));
            }
            let s = g.search.as_mut().unwrap();
            if s.root_visits() >= g.target {
                Self::finish_move(g, cfg);
                continue;
            }
            let leaf = s.select();
            if leaf.terminal.is_some() {
                s.expand(leaf, &[], None);
                continue;
            }
            let is_root = s.root_visits() == 0;
            let moves = s.leaf_moves(&leaf);
            if cfg.scaffold {
                let ev = scaffold.evaluate(s.leaf_position(&leaf), &moves);
                s.expand(leaf, &moves, Some(ev));
                if is_root {
                    s.add_root_noise(&mut g.rng);
                }
                continue;
            }
            let _ = buf;
            g.pending = Some(Pending { leaf, moves, is_root });
            return true;
        }
    }

    /// 探索が終わった局面で手を決めて指す（自己対局なら記録を残す）
    fn finish_move(g: &mut Game, cfg: &Cfg) {
        let s = g.search.take().unwrap();
        let mv = if g.pos.move_count < cfg.temp_plies { s.sample_move(1.0, &mut g.rng) } else { s.best_move() };
        // 学習データは現世代（ネット0番）の手番だけ残す（過去の世代の手を方策の手本にしない）
        let mine = matches!(g.seats[g.pos.turn as usize], Seat::Net(0));
        if g.record && mv != PASS && mine {
            let mut state = Vec::with_capacity(STATE_BYTES);
            encode_state(&g.pos, &mut state);
            let policy = g.full.then(|| {
                let vc = s.root_visit_counts();
                (vc.iter().filter(|x| x.0 != PASS).map(|x| policy_index(x.0)).collect(), vc.iter().filter(|x| x.0 != PASS).map(|x| x.1).collect())
            });
            let m = g.pos.material();
            g.records.push(PlyRecord { state, policy, root_value: s.root_value(), material: [m[0] as f32, m[1] as f32, m[2] as f32] });
        }
        Self::play(g, mv);
    }

    fn play(g: &mut Game, mv: Move) {
        if mv == PASS {
            g.pos.pass();
            return;
        }
        let before = g.pos.elim;
        g.moves.push(mv);
        if let Some(o) = g.pos.play(mv) {
            g.outcome = Some((o.winner, o.kind));
        }
        for p in 0..3 {
            if g.pos.elim[p] && !before[p] {
                g.elim_events.push((g.records.len(), p as u8));
            }
        }
    }
}

/// 研究用の順位（docs/game_spec.md）：勝者1位、脱落者は後に脱落した人ほど上位、残りは駒価値順（入玉なら同順位）
fn ranks(g: &Game) -> [u8; 3] {
    let (winner, kind) = g.outcome.unwrap();
    let mut r = [0u8; 3];
    r[winner as usize] = 1;
    let mut next_rank = 2u8;
    let alive_losers: Vec<usize> = (0..3).filter(|&p| p != winner as usize && !g.pos.elim[p]).collect();
    if !alive_losers.is_empty() {
        if kind == WinKind::MoveLimit {
            let m = g.pos.material();
            let mut v = alive_losers.clone();
            v.sort_by(|&a, &b| m[b].partial_cmp(&m[a]).unwrap());
            for p in v {
                r[p] = next_rank;
                next_rank += 1;
            }
        } else {
            for &p in &alive_losers {
                r[p] = next_rank;
            }
            next_rank += alive_losers.len() as u8;
        }
    }
    for &(_, p) in g.elim_events.iter().rev() {
        if r[p as usize] == 0 {
            r[p as usize] = next_rank;
            next_rank += 1;
        }
    }
    r
}

#[pymethods]
impl Driver {
    /// seats: 3つの席の種類（"net:0" / "net:1" / "scaffold:訪問数" / "greedy" / "random"）。rotate=True で対局ごとに席をずらす
    #[new]
    #[pyo3(signature = (parallel, total_games, seats, rotate=false, record=true, visits_full=600, visits_fast=100, full_prob=0.25,
                        temp_plies=30, c_puct=1.5, fpu_reduction=0.2, dirichlet_total=10.0, dirichlet_weight=0.25, scaffold=false, seed=1, rule="all",
                        alt_seats=Vec::new(), alt_prob=0.0))]
    #[allow(clippy::too_many_arguments)]
    fn py_new(
        parallel: usize,
        total_games: u64,
        seats: Vec<String>,
        rotate: bool,
        record: bool,
        visits_full: u32,
        visits_fast: u32,
        full_prob: f64,
        temp_plies: u16,
        c_puct: f32,
        fpu_reduction: f32,
        dirichlet_total: f32,
        dirichlet_weight: f32,
        scaffold: bool,
        seed: u64,
        rule: &str,
        alt_seats: Vec<Vec<String>>,
        alt_prob: f64,
    ) -> PyResult<Driver> {
        if seats.len() != 3 {
            return Err(PyValueError::new_err("seats は3つ"));
        }
        if alt_seats.iter().any(|a| a.len() != 3) {
            return Err(PyValueError::new_err("alt_seats の各要素は3つ"));
        }
        let rules = parse_rules(rule)?;
        let cfg = Cfg {
            visits_full,
            visits_fast,
            full_prob,
            temp_plies,
            search: SearchConfig { c_puct, fpu_reduction, dirichlet_total, dirichlet_weight },
            scaffold,
        };
        let mut d = Driver {
            games: Vec::new(),
            cfg,
            seat_specs: seats,
            rotate,
            alt_seats,
            alt_prob,
            record,
            total_games,
            started: 0,
            seed,
            rules,
            finished: Vec::new(),
            batch_order: Vec::new(),
            scaffold_eval: MaterialEval::default(),
            moves_buf: Vec::new(),
        };
        for _ in 0..parallel.min(total_games as usize) {
            let g = d.new_game()?;
            d.games.push(g);
        }
        Ok(d)
    }

    /// 評価待ちの局面をまとめて返す。全局終わっていれば None。
    /// 戻り値: (states: bytes[B*108], legal: bytes[i32 B*L], L, model: bytes[u8 B])  legal は -1 で埋める
    fn next_batch<'py>(&mut self, py: Python<'py>) -> PyResult<Option<(Bound<'py, PyBytes>, Bound<'py, PyBytes>, usize, Bound<'py, PyBytes>)>> {
        self.batch_order.clear();
        let mut i = 0;
        while i < self.games.len() {
            let has = self.games[i].pending.is_some()
                || Self::advance(&mut self.games[i], &self.cfg, &mut self.scaffold_eval, &mut self.moves_buf);
            if self.games[i].outcome.is_some() {
                let g = self.games.swap_remove(i);
                self.finished.push(g);
                if self.started < self.total_games {
                    let ng = self.new_game()?;
                    self.games.push(ng);
                }
                continue;
            }
            if has {
                self.batch_order.push(i);
            }
            i += 1;
        }
        if self.batch_order.is_empty() {
            return Ok(None);
        }
        let l = self.batch_order.iter().map(|&i| self.games[i].pending.as_ref().unwrap().moves.len()).max().unwrap();
        let mut states = Vec::with_capacity(self.batch_order.len() * STATE_BYTES);
        let mut legal: Vec<i32> = Vec::with_capacity(self.batch_order.len() * l);
        let mut model = Vec::with_capacity(self.batch_order.len());
        for &i in &self.batch_order {
            let g = &self.games[i];
            let p = g.pending.as_ref().unwrap();
            let pos = g.search.as_ref().unwrap().leaf_position(&p.leaf);
            encode_state(pos, &mut states);
            for k in 0..l {
                legal.push(match p.moves.get(k) {
                    Some(&m) if m != PASS => policy_index(m),
                    _ => -1,
                });
            }
            model.push(match &g.seats[g.pos.turn as usize] {
                Seat::Net(n) => *n,
                _ => 0,
            });
        }
        let legal_b: Vec<u8> = legal.iter().flat_map(|x| x.to_le_bytes()).collect();
        Ok(Some((PyBytes::new_bound(py, &states), PyBytes::new_bound(py, &legal_b), l, PyBytes::new_bound(py, &model))))
    }

    /// next_batch の順に評価を返す。priors: f32[B*L]（L は next_batch と同じ）、values: f32[B*3]
    fn submit(&mut self, priors: &[u8], values: &[u8], l: usize) -> PyResult<()> {
        let b = self.batch_order.len();
        if priors.len() != b * l * 4 || values.len() != b * 12 {
            return Err(PyValueError::new_err("submit の大きさが next_batch と合わない"));
        }
        for (bi, &gi) in self.batch_order.iter().enumerate() {
            let g = &mut self.games[gi];
            let p = g.pending.take().unwrap();
            let n = p.moves.len();
            let pr: Vec<f32> = (0..n).map(|k| read_f32(priors, bi * l + k)).collect();
            let value = [read_f32(values, bi * 3), read_f32(values, bi * 3 + 1), read_f32(values, bi * 3 + 2)];
            let s = g.search.as_mut().unwrap();
            s.expand(p.leaf, &p.moves, Some(EvalOut { priors: pr, value }));
            if p.is_root {
                s.add_root_noise(&mut g.rng);
            }
        }
        self.batch_order.clear();
        Ok(())
    }

    /// 全局終わったか
    fn done(&self) -> bool {
        self.games.is_empty()
    }

    fn finished_count(&self) -> usize {
        self.finished.len()
    }

    /// 終局した対局を取り出す。学習データ（1局面1行）と対局の要約を bytes の dict で返す
    fn take_finished<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let games = std::mem::take(&mut self.finished);
        let d = PyDict::new_bound(py);
        let mut states = Vec::new();
        let mut pol_off: Vec<i64> = vec![0];
        let (mut pol_idx, mut pol_cnt): (Vec<i32>, Vec<u32>) = (Vec::new(), Vec::new());
        let (mut full, mut winner, mut rank, mut next_elim) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut root_v, mut loss20, mut final_mat, mut st6, mut st16) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut remaining, mut game_id): (Vec<u16>, Vec<u32>) = (Vec::new(), Vec::new());
        // 対局の要約
        let (mut g_id, mut g_winner, mut g_kind, mut g_plies, mut g_seat_net) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut g_rule: Vec<u8> = Vec::new();
        let (mut g_moves_off, mut g_moves): (Vec<i64>, Vec<u16>) = (vec![0], Vec::new());
        for g in &games {
            let (w, kind) = g.outcome.unwrap();
            g_id.push(g.id as u32);
            g_winner.push(w);
            g_kind.push(match kind {
                WinKind::LastAlive => 0u8,
                WinKind::Entry => 1,
                WinKind::MoveLimit => 2,
            });
            g_plies.push(g.pos.move_count);
            g_rule.push(rule_id(g.pos.rule));
            for s in &g.seats {
                g_seat_net.push(match s {
                    Seat::Net(n) => *n as i8,
                    Seat::Internal(_) => -1,
                });
            }
            g_moves.extend_from_slice(&g.moves);
            g_moves_off.push(g_moves.len() as i64);

            let rk = ranks(g);
            let n = g.records.len();
            let fm = g.pos.material();
            let final_m = [fm[0] as f32, fm[1] as f32, fm[2] as f32];
            let mut onehot = [0f32; 3];
            onehot[w as usize] = 1.0;
            for (i, r) in g.records.iter().enumerate() {
                states.extend_from_slice(&r.state);
                match &r.policy {
                    Some((idx, cnt)) => {
                        pol_idx.extend_from_slice(idx);
                        pol_cnt.extend_from_slice(cnt);
                        full.push(1u8);
                    }
                    None => full.push(0u8),
                }
                pol_off.push(pol_idx.len() as i64);
                winner.push(w);
                rank.extend_from_slice(&rk);
                // この記録の後で最初に脱落する人（なければ3）
                next_elim.push(g.elim_events.iter().find(|&&(at, _)| at > i).map(|&(_, p)| p).unwrap_or(3));
                root_v.extend_from_slice(&r.root_value);
                let j = (i + 20).min(n);
                let later = if j < n { g.records[j].material } else { final_m };
                for k in 0..3 {
                    loss20.push((r.material[k] - later[k]).max(0.0));
                }
                final_mat.extend_from_slice(&final_m);
                st6.extend_from_slice(&if i + 6 < n { g.records[i + 6].root_value } else { onehot });
                st16.extend_from_slice(&if i + 16 < n { g.records[i + 16].root_value } else { onehot });
                remaining.push((n - i) as u16);
                game_id.push(g.id as u32);
            }
        }
        let u16b = |v: &[u16]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        let u32b = |v: &[u32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        let i32b = |v: &[i32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        let i64b = |v: &[i64]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        d.set_item("states", PyBytes::new_bound(py, &states))?;
        d.set_item("policy_offsets", PyBytes::new_bound(py, &i64b(&pol_off)))?;
        d.set_item("policy_index", PyBytes::new_bound(py, &i32b(&pol_idx)))?;
        d.set_item("policy_visits", PyBytes::new_bound(py, &u32b(&pol_cnt)))?;
        d.set_item("full", PyBytes::new_bound(py, &full))?;
        d.set_item("winner", PyBytes::new_bound(py, &winner))?;
        d.set_item("rank", PyBytes::new_bound(py, &rank))?;
        d.set_item("next_elim", PyBytes::new_bound(py, &next_elim))?;
        d.set_item("root_value", PyBytes::new_bound(py, &f32_bytes(&root_v)))?;
        d.set_item("loss20", PyBytes::new_bound(py, &f32_bytes(&loss20)))?;
        d.set_item("final_material", PyBytes::new_bound(py, &f32_bytes(&final_mat)))?;
        d.set_item("st6", PyBytes::new_bound(py, &f32_bytes(&st6)))?;
        d.set_item("st16", PyBytes::new_bound(py, &f32_bytes(&st16)))?;
        d.set_item("remaining", PyBytes::new_bound(py, &u16b(&remaining)))?;
        d.set_item("game_id", PyBytes::new_bound(py, &u32b(&game_id)))?;
        d.set_item("g_id", PyBytes::new_bound(py, &u32b(&g_id)))?;
        d.set_item("g_winner", PyBytes::new_bound(py, &g_winner))?;
        d.set_item("g_kind", PyBytes::new_bound(py, &g_kind))?;
        d.set_item("g_plies", PyBytes::new_bound(py, &u16b(&g_plies)))?;
        d.set_item("g_rule", PyBytes::new_bound(py, &g_rule))?;
        d.set_item("g_seat_net", PyBytes::new_bound(py, &g_seat_net.iter().map(|&x| x as u8).collect::<Vec<u8>>()))?;
        d.set_item("g_moves_offsets", PyBytes::new_bound(py, &i64b(&g_moves_off)))?;
        d.set_item("g_moves", PyBytes::new_bound(py, &u16b(&g_moves)))?;
        Ok(d)
    }
}

// ── 1局面の探索（人との対局用。ネットの評価は Python が1つずつ返す）──

#[pyclass(unsendable)]
pub struct Searcher {
    search: Search,
    pending: Option<(Leaf, Vec<Move>)>,
    visits: u32,
}

#[pymethods]
impl Searcher {
    /// state: 109バイトの局面（encode_state と同じ形。最後の1バイトがルール）
    #[new]
    #[pyo3(signature = (state, visits=800, c_puct=1.5, fpu_reduction=0.2))]
    fn py_new(state: &[u8], visits: u32, c_puct: f32, fpu_reduction: f32) -> PyResult<Searcher> {
        if state.len() != STATE_BYTES {
            return Err(PyValueError::new_err("state は109バイト"));
        }
        let rule = rule_from_id(state[108]);
        let mut board = [0u8; 81];
        board.copy_from_slice(&state[..81]);
        let mut hand = [[0u8; 8]; 3];
        for o in 0..3 {
            hand[o][..7].copy_from_slice(&state[81 + o * 7..88 + o * 7]);
        }
        let elim = [state[102] != 0, state[103] != 0, state[104] != 0];
        let pos = Position::from_parts(board, hand, elim, state[105], u16::from_le_bytes([state[106], state[107]]), rule);
        let cfg = SearchConfig { c_puct, fpu_reduction, dirichlet_total: 0.0, dirichlet_weight: 0.0 };
        Ok(Searcher { search: Search::new(pos, cfg), pending: None, visits })
    }

    /// 評価が必要な葉を返す（state 108バイト, 合法手の方策番号 i32 bytes）。探索が終わっていれば None
    fn next_leaf<'py>(&mut self, py: Python<'py>) -> Option<(Bound<'py, PyBytes>, Bound<'py, PyBytes>)> {
        loop {
            if self.search.root_visits() >= self.visits {
                return None;
            }
            let leaf = self.search.select();
            if leaf.terminal.is_some() {
                self.search.expand(leaf, &[], None);
                continue;
            }
            let moves = self.search.leaf_moves(&leaf);
            let mut st = Vec::with_capacity(STATE_BYTES);
            encode_state(self.search.leaf_position(&leaf), &mut st);
            let legal: Vec<u8> = moves.iter().flat_map(|&m| (if m == PASS { -1 } else { policy_index(m) }).to_le_bytes()).collect();
            self.pending = Some((leaf, moves));
            return Some((PyBytes::new_bound(py, &st), PyBytes::new_bound(py, &legal)));
        }
    }

    /// next_leaf の葉の評価を返す。priors: f32[合法手数]、value: [3]
    fn submit(&mut self, priors: Vec<f32>, value: [f32; 3]) -> PyResult<()> {
        let (leaf, moves) = self.pending.take().ok_or_else(|| PyValueError::new_err("評価待ちの葉がない"))?;
        self.search.expand(leaf, &moves, Some(EvalOut { priors, value }));
        Ok(())
    }

    /// 結果: (最善手, [(手, 訪問数)], 根の価値)。手は to | from<<7 | 成り<<14（パスは 65535）
    fn result(&self) -> (u16, Vec<(u16, u32)>, [f32; 3]) {
        (self.search.best_move(), self.search.root_visit_counts(), self.search.root_value())
    }
}

/// 定数（Python側と揃える）
#[pyfunction]
fn constants(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("STATE_BYTES", STATE_BYTES)?;
    d.set_item("NUM_POLICY", NUM_POLICY)?;
    Ok(d)
}

#[pymodule]
fn shogi3_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Driver>()?;
    m.add_class::<Searcher>()?;
    m.add_function(wrap_pyfunction!(constants, m)?)?;
    Ok(())
}
