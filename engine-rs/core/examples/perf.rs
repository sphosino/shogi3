//! 速度計測：ランダムに終局まで指す（合法手生成＋指す）。
//! 実行: cargo run --release --example perf -- [局数]

use shogi3_core::{CaptureRule, Position};
use std::time::Instant;

fn main() {
    let games: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(2000);
    let mut seed: u64 = 12345;
    let mut rnd = move |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as usize
    };
    let mut moves = Vec::with_capacity(1024);
    let (mut plies, mut gen_moves_total) = (0usize, 0usize);
    let t = Instant::now();
    for _ in 0..games {
        let mut pos = Position::initial(CaptureRule::All);
        loop {
            moves.clear();
            pos.gen_moves(&mut moves);
            gen_moves_total += moves.len();
            if moves.is_empty() {
                pos.pass();
                continue;
            }
            let m = moves[rnd(moves.len())];
            plies += 1;
            if pos.play(m).is_some() {
                break;
            }
        }
    }
    let sec = t.elapsed().as_secs_f64();
    println!(
        "{games}局 {plies}手 {sec:.2}秒 → {:.0} 手/秒（1手あたり合法手 平均{:.0}）, 1局 {:.2}ms",
        plies as f64 / sec,
        gen_moves_total as f64 / plies as f64,
        sec * 1000.0 / games as f64
    );
}
