//! 評価対局：測る側1席 vs 比較相手2席（席は毎局入れ替え）。docs/evaluation.md
//! 実行: cargo run --release --example arena -- --cand mcts:200 --base random --games 90 --threads 16
//! エージェント: random / greedy / mcts:訪問数[:駒価値softmaxの温度] / mctsu:訪問数（事前確率を一様にした足場）

use shogi3_core::{CaptureRule, Position, WinKind};
use shogi3_mcts::{Agent, GreedyAgent, MaterialEval, MctsAgent, RandomAgent};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

fn make_agent(spec: &str, seed: u64) -> Box<dyn Agent> {
    let parts: Vec<&str> = spec.split(':').collect();
    match parts[0] {
        "random" => Box::new(RandomAgent::new(seed)),
        "greedy" => Box::new(GreedyAgent::new(seed)),
        "mcts" => {
            let visits = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(200);
            let mut a = MctsAgent::material(visits, seed);
            if let Some(t) = parts.get(2).and_then(|s| s.parse().ok()) {
                a.eval = MaterialEval { temperature: t, ..Default::default() };
            }
            Box::new(a)
        }
        "mctsu" => {
            let visits = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(200);
            let mut a = MctsAgent::material(visits, seed);
            a.eval.capture_priors = false;
            Box::new(a)
        }
        _ => panic!("未知のエージェント {spec}"),
    }
}

struct GameResult {
    cand_seat: u8,
    winner: u8,
    kind: WinKind,
    plies: u16,
}

fn play_game(cand: &str, base: &str, cand_seat: u8, seed: u64) -> GameResult {
    let mut agents: Vec<Box<dyn Agent>> = (0..3u8)
        .map(|s| make_agent(if s == cand_seat { cand } else { base }, seed * 3 + s as u64))
        .collect();
    let mut pos = Position::initial(CaptureRule::All);
    loop {
        match agents[pos.turn as usize].choose(&pos) {
            None => pos.pass(),
            Some(m) => {
                if let Some(o) = pos.play(m) {
                    return GameResult { cand_seat, winner: o.winner, kind: o.kind, plies: pos.move_count };
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |k: &str, d: &str| -> String {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned()).unwrap_or_else(|| d.to_string())
    };
    let cand = get("--cand", "mcts:200");
    let base = get("--base", "random");
    let games: usize = get("--games", "90").parse().unwrap();
    let threads: usize = get("--threads", "16").parse().unwrap();

    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    let t0 = Instant::now();
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= games {
                    break;
                }
                let r = play_game(&cand, &base, (i % 3) as u8, 1000 + i as u64);
                results.lock().unwrap().push(r);
            });
        }
    });
    let sec = t0.elapsed().as_secs_f64();
    let rs = results.into_inner().unwrap();
    let n = rs.len() as f64;
    let wins = rs.iter().filter(|r| r.winner == r.cand_seat).count();
    let mut seat_wins = [0usize; 3];
    let mut kinds = [0usize; 3];
    for r in &rs {
        seat_wins[r.winner as usize] += 1;
        kinds[match r.kind {
            WinKind::LastAlive => 0,
            WinKind::Entry => 1,
            WinKind::MoveLimit => 2,
        }] += 1;
    }
    let p = wins as f64 / n;
    let z = (p - 1.0 / 3.0) / ((1.0 / 3.0) * (2.0 / 3.0) / n).sqrt();
    let avg_plies = rs.iter().map(|r| r.plies as f64).sum::<f64>() / n;
    println!(
        "{cand} 1席 vs {base} 2席: {wins}/{} 勝 = {:.1}% (z={z:.2}) | 席別勝ち {:?} | 終局 最後の1人{} 入玉{} 500手{} | 平均{avg_plies:.0}手 | {sec:.1}秒 (1局 {:.2}秒×{threads}並列)",
        rs.len(),
        p * 100.0,
        seat_wins,
        kinds[0],
        kinds[1],
        kinds[2],
        sec * threads as f64 / n
    );
}
