//! JS実装との照合テスト。
//! データは `node tools/gen-fixtures.js`（リポジトリ直下で実行）で tests/fixtures/ に作る。
//! JS の対局を1手ずつ再生し、毎手の合法手・指した後の局面・終局結果が一致するかを確かめる。

use serde::Deserialize;
use shogi3_core::{piece_code, piece_from_name, CaptureRule, Move, Position, WinKind};
use std::path::PathBuf;

#[derive(Deserialize)]
struct Cell {
    p: String,
    o: u8,
    pr: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    board: Vec<Vec<Option<Cell>>>,
    hand: Vec<Vec<String>>,
    eliminated: Vec<bool>,
    turn: u8,
    move_count: u16,
}

#[derive(Deserialize)]
struct Ply {
    n: usize,
    legal: u32,
    #[serde(rename = "move")]
    mv: i64,
    after: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Game {
    start: Start,
    plies: Vec<Ply>,
    winner: i64,
    win_type: String,
    move_count: u16,
}

#[derive(Deserialize)]
struct Fixture {
    games: Vec<Game>,
}

fn fnv_moves(codes: &[Move]) -> u32 {
    let mut h = shogi3_core::position::FNV_START;
    for &c in codes {
        h = shogi3_core::position::fnv_byte(h, (c & 255) as u8);
        h = shogi3_core::position::fnv_byte(h, (c >> 8) as u8);
    }
    h
}

fn load_position(s: &Start, rule: CaptureRule) -> Position {
    let mut board = [0u8; 81];
    for r in 0..9 {
        for c in 0..9 {
            if let Some(cell) = &s.board[r][c] {
                board[r * 9 + c] = piece_code(cell.o, cell.pr, piece_from_name(&cell.p).unwrap());
            }
        }
    }
    let mut hand = [[0u8; 8]; 3];
    for o in 0..3 {
        for p in &s.hand[o] {
            hand[o][piece_from_name(p).unwrap() as usize] += 1;
        }
    }
    let elim = [s.eliminated[0], s.eliminated[1], s.eliminated[2]];
    Position::from_parts(board, hand, elim, s.turn, s.move_count, rule)
}

fn check_rule(file: &str, rule: CaptureRule) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{} がない。リポジトリ直下で `node tools/gen-fixtures.js` を実行して作る", path.display()));
    let fx: Fixture = serde_json::from_str(&text).unwrap();
    let mut plies_checked = 0usize;
    let mut moves = Vec::new();
    for (gi, g) in fx.games.iter().enumerate() {
        let mut pos = load_position(&g.start, rule);
        let mut outcome = None;
        for (pi, ply) in g.plies.iter().enumerate() {
            assert!(outcome.is_none(), "game {gi}: 終局後に手が続いている (ply {pi})");
            moves.clear();
            pos.gen_moves(&mut moves);
            moves.sort_unstable();
            assert_eq!(moves.len(), ply.n, "game {gi} ply {pi}: 合法手の数が違う");
            assert_eq!(fnv_moves(&moves), ply.legal, "game {gi} ply {pi}: 合法手の集合が違う");
            if ply.mv < 0 {
                pos.pass();
                continue;
            }
            let m = ply.mv as Move;
            assert!(moves.binary_search(&m).is_ok(), "game {gi} ply {pi}: JSの指し手 {m} がRustの合法手にない");
            outcome = pos.play(m);
            assert_eq!(pos.digest(), ply.after, "game {gi} ply {pi}: 指した後の局面が違う (move {m})");
            plies_checked += 1;
        }
        let out = outcome.unwrap_or_else(|| panic!("game {gi}: Rust側で終局していない"));
        let kind = match g.win_type.as_str() {
            "normal" => WinKind::LastAlive,
            "trywin" => WinKind::Entry,
            "limit" => WinKind::MoveLimit,
            other => panic!("未知の終局 {other}"),
        };
        assert_eq!(out.kind, kind, "game {gi}: 終局の種類が違う");
        assert_eq!(out.winner as i64, g.winner, "game {gi}: 勝者が違う");
        assert_eq!(pos.move_count, g.move_count, "game {gi}: 手数が違う");
    }
    eprintln!("{file}: {}局 {plies_checked}手 一致", fx.games.len());
}

#[test]
fn matches_js_capture_all() {
    check_rule("games_all.json", CaptureRule::All);
}

#[test]
fn matches_js_capture_next() {
    check_rule("games_next.json", CaptureRule::Next);
}

#[test]
fn matches_js_capture_vanish() {
    check_rule("games_vanish.json", CaptureRule::Vanish);
}

#[test]
fn initial_position_matches_js() {
    // JS の init() 直後の局面ダイジェストと合法手数
    let pos = Position::initial(CaptureRule::All);
    let text = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/games_all.json")).unwrap();
    let fx: Fixture = serde_json::from_str(&text).unwrap();
    // 偶数番の対局は初期局面から始まっている
    let js = load_position(&fx.games[0].start, CaptureRule::All);
    assert_eq!(pos.digest(), js.digest());
    assert_eq!(pos.key(), js.key());
}
