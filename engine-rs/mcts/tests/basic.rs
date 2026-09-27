//! MCTS の基本動作：玉を取れるなら取る／自分の玉が次の人に取られるなら逃げる

use shogi3_core::{mv_from, mv_to, piece_code, CaptureRule, Position, HI, KIN, OU};
use shogi3_mcts::{Agent, MctsAgent};

fn pos_with(pieces: &[(usize, usize, u8, u8)], turn: u8) -> Position {
    let mut board = [0u8; 81];
    for &(r, c, o, pt) in pieces {
        board[r * 9 + c] = piece_code(o, false, pt);
    }
    Position::from_parts(board, [[0; 8]; 3], [false; 3], turn, 0, CaptureRule::All)
}

#[test]
fn captures_king_when_possible() {
    // P0の飛(4,4)から、同じ列の(0,4)にP1の玉、同じ行の(4,8)にP2の玉。どちらも取れる。P0の手番
    let pos = pos_with(
        &[(8, 0, 0, OU), (4, 4, 0, HI), (0, 4, 1, OU), (1, 0, 1, KIN), (4, 8, 2, OU), (3, 8, 2, KIN)],
        0,
    );
    for visits in [50, 400] {
        let mut a = MctsAgent::material(visits, 1);
        let m = a.choose(&pos).unwrap();
        assert_eq!(mv_from(m), 4 * 9 + 4, "visits={visits}: 飛で取らなかった");
        assert!(mv_to(m) == 4 || mv_to(m) == 4 * 9 + 8, "visits={visits}: 玉を取らなかった（{}へ）", mv_to(m));
    }
}

#[test]
fn escapes_when_king_attacked_by_next_player() {
    // P0の玉(8,4)に、次に指すP1の飛(0,4)が同じ列から利いている。P0の手番
    let pos = pos_with(
        &[(8, 4, 0, OU), (8, 0, 0, KIN), (0, 4, 1, HI), (0, 0, 1, OU), (4, 8, 2, OU), (3, 8, 2, KIN)],
        0,
    );
    let mut a = MctsAgent::material(400, 1);
    let m = a.choose(&pos).unwrap();
    let mut p = pos.clone();
    assert!(p.play(m).is_none());
    // 指した後、P1（次の手番）が玉を取れないこと
    let mut moves = Vec::new();
    p.gen_moves(&mut moves);
    let king = p.king[0] as usize;
    assert!(moves.iter().all(|&x| mv_to(x) != king), "玉が取られる手を指した: {m}");
}
