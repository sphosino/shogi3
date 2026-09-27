//! 三人将棋のルールエンジン。
//!
//! 仕様は `docs/game_spec.md`（現行JS実装を正とする）。盤面の表し方は `engine.js` と同じ整数表現：
//! - 駒コード: 0 = 空, 1 + 持ち主*16 + 成り*8 + 駒種（駒種: 歩香桂銀金角飛玉 = 0..7）
//! - 指し手  : to | from<<7 | 成り<<14（from >= 81 は打ち。駒種 = from - 81）
//! - マス    : sq = r*9 + c（r=行 0..8 上が0、c=列 0..8 左が0）

pub mod position;
pub mod tables;

pub use position::{CaptureRule, Outcome, Position, WinKind, MAX_MOVES};
pub use tables::*;

/// 指し手（`to | from<<7 | 成り<<14`）
pub type Move = u16;

pub const PROMOTE_BIT: Move = 1 << 14;

#[inline]
pub fn mv_to(m: Move) -> usize {
    (m & 127) as usize
}
#[inline]
pub fn mv_from(m: Move) -> usize {
    ((m >> 7) & 127) as usize
}
#[inline]
pub fn mv_is_drop(m: Move) -> bool {
    mv_from(m) >= 81
}
#[inline]
pub fn mv_promote(m: Move) -> bool {
    m & PROMOTE_BIT != 0
}
/// 打ち手の駒種
#[inline]
pub fn mv_drop_piece(m: Move) -> u8 {
    (mv_from(m) - 81) as u8
}
#[inline]
pub fn make_move(from: usize, to: usize, promote: bool) -> Move {
    (to as Move) | ((from as Move) << 7) | if promote { PROMOTE_BIT } else { 0 }
}
#[inline]
pub fn make_drop(piece: u8, to: usize) -> Move {
    (to as Move) | (((81 + piece as usize) as Move) << 7)
}

/// 駒コード → (持ち主, 成り, 駒種)
#[inline]
pub fn piece_owner(code: u8) -> u8 {
    (code - 1) >> 4
}
#[inline]
pub fn piece_promoted(code: u8) -> bool {
    (code - 1) & 8 != 0
}
#[inline]
pub fn piece_type(code: u8) -> u8 {
    (code - 1) & 7
}
/// 駒コード → 動きテーブルの番号（持ち主*16 + 成り*8 + 駒種）
#[inline]
pub fn piece_kind(code: u8) -> usize {
    (code - 1) as usize
}
#[inline]
pub fn piece_code(owner: u8, promoted: bool, pt: u8) -> u8 {
    1 + owner * 16 + if promoted { 8 } else { 0 } + pt
}
