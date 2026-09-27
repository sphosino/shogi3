//! 駒の動き・駒価値・Zobristハッシュのテーブル。

use std::sync::OnceLock;

pub const FU: u8 = 0;
pub const KY: u8 = 1;
pub const KE: u8 = 2;
pub const GIN: u8 = 3;
pub const KIN: u8 = 4;
pub const KAKU: u8 = 5;
pub const HI: u8 = 6;
pub const OU: u8 = 7;

pub const PIECE_NAMES: [&str; 8] = ["FU", "KY", "KE", "GIN", "KIN", "KAKU", "HI", "OU"];
pub const CAN_PROMOTE: [bool; 8] = [true, true, true, true, false, true, true, false];

/// 駒価値（constants.js の PV）
pub const PIECE_VALUE: [i64; 8] = [100, 300, 350, 400, 500, 800, 900, 10_000_000];
/// 成りの追加価値（constants.js の PVP）
pub const PROMO_BONUS: [i64; 8] = [400, 200, 150, 100, 0, 500, 450, 0];
/// 500手制限の判定で持ち駒に掛ける倍率（constants.js の AI_HAND_BONUS_RATE）
pub const HAND_RATE: f64 = 1.3;

/// 走る方向（engine.js の E_DIRS と同じ順）
pub const DIRS: [(i8, i8); 8] = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)];

pub fn piece_from_name(name: &str) -> Option<u8> {
    PIECE_NAMES.iter().position(|&n| n == name).map(|i| i as u8)
}

/// P0の向きで定義した差分を持ち主ごとに回転する（JSの rotDir）
pub fn rot_dir(dr: i8, dc: i8, owner: u8) -> (i8, i8) {
    match owner {
        0 => (dr, dc),
        1 => (-dr, -dc),
        _ => (-dc, dr),
    }
}

pub struct Tables {
    /// `ray[dir*81 + sq]`: sq から dir 方向のマス列
    pub ray: Vec<Vec<u8>>,
    /// `step[kind*81 + sq]`: 1マス動き（桂を含む）の行き先
    pub step: Vec<Vec<u8>>,
    /// `slide[kind]`: 走る方向（DIRSの番号）
    pub slide: Vec<Vec<u8>>,
    /// `z_board[sq*48 + (駒種*2+成り)*3 + 持ち主]`
    pub z_board: Vec<u64>,
    /// `z_hand[(持ち主*8+駒種)*20 + 枚数]`（1..枚数 をすべてXOR）
    pub z_hand: Vec<u64>,
    /// 手番
    pub z_turn: [u64; 3],
    /// 脱落状態（ビットマスク 0..8）
    pub z_elim: [u64; 8],
}

pub fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(build)
}

fn build() -> Tables {
    let mut ray = vec![Vec::new(); 8 * 81];
    for (d, &(dr, dc)) in DIRS.iter().enumerate() {
        for sq in 0..81 {
            let (mut r, mut c) = ((sq / 9) as i8 + dr, (sq % 9) as i8 + dc);
            let mut v = Vec::new();
            while (0..9).contains(&r) && (0..9).contains(&c) {
                v.push((r * 9 + c) as u8);
                r += dr;
                c += dc;
            }
            ray[d * 81 + sq] = v;
        }
    }

    const GOLD: [(i8, i8); 6] = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, 0)];
    let dir_idx = |d: (i8, i8)| DIRS.iter().position(|&x| x == d).unwrap() as u8;
    let mut step = vec![Vec::new(); 48 * 81];
    let mut slide = vec![Vec::new(); 48];
    for o in 0..3u8 {
        for pr in 0..2u8 {
            for pt in 0..8u8 {
                let k = (o * 16 + pr * 8 + pt) as usize;
                let mut steps: Vec<(i8, i8)> = Vec::new();
                let mut slides: Vec<(i8, i8)> = Vec::new();
                if pr == 1 && pt <= GIN {
                    steps = GOLD.to_vec();
                } else {
                    match pt {
                        FU => steps = vec![(-1, 0)],
                        KY => slides = vec![rot_dir(-1, 0, o)],
                        KE => steps = vec![(-2, -1), (-2, 1)],
                        GIN => steps = vec![(-1, -1), (-1, 0), (-1, 1), (1, -1), (1, 1)],
                        KIN => steps = GOLD.to_vec(),
                        KAKU => {
                            slides = vec![(-1, -1), (-1, 1), (1, -1), (1, 1)];
                            if pr == 1 {
                                steps = vec![(1, 0), (-1, 0), (0, 1), (0, -1)];
                            }
                        }
                        HI => {
                            slides = vec![(1, 0), (-1, 0), (0, 1), (0, -1)];
                            if pr == 1 {
                                steps = vec![(-1, -1), (-1, 1), (1, -1), (1, 1)];
                            }
                        }
                        _ => {
                            for dr in -1..=1 {
                                for dc in -1..=1 {
                                    if dr != 0 || dc != 0 {
                                        steps.push((dr, dc));
                                    }
                                }
                            }
                        }
                    }
                }
                // 玉・飛・角の1マス動きは上下左右対称なので回転不要（JSと同じ扱い）
                let rsteps: Vec<(i8, i8)> = if pt == OU || pt == HI || pt == KAKU {
                    steps
                } else {
                    steps.iter().map(|&(dr, dc)| rot_dir(dr, dc, o)).collect()
                };
                slide[k] = slides.iter().map(|&d| dir_idx(d)).collect();
                for sq in 0..81 {
                    let (r, c) = ((sq / 9) as i8, (sq % 9) as i8);
                    step[k * 81 + sq] = rsteps
                        .iter()
                        .filter_map(|&(dr, dc)| {
                            let (nr, nc) = (r + dr, c + dc);
                            ((0..9).contains(&nr) && (0..9).contains(&nc)).then(|| (nr * 9 + nc) as u8)
                        })
                        .collect();
                }
            }
        }
    }

    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let z_board = (0..81 * 48).map(|_| rnd()).collect();
    let z_hand = (0..3 * 8 * 20).map(|_| rnd()).collect();
    let z_turn = [rnd(), rnd(), rnd()];
    let z_elim = [0, rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
    Tables { ray, step, slide, z_board, z_hand, z_turn, z_elim }
}

/// 敵陣（成れる範囲）
#[inline]
pub fn in_promo_zone(owner: u8, sq: usize) -> bool {
    match owner {
        0 => sq < 27,
        1 => sq >= 54,
        _ => sq % 9 <= 2,
    }
}

/// 行き所のない駒（必ず成る／そこには打てない）
#[inline]
pub fn must_promote(pt: u8, owner: u8, sq: usize) -> bool {
    match pt {
        FU | KY => match owner {
            0 => sq < 9,
            1 => sq >= 72,
            _ => sq % 9 == 0,
        },
        KE => match owner {
            0 => sq < 18,
            1 => sq >= 63,
            _ => sq % 9 <= 1,
        },
        _ => false,
    }
}

/// 入玉マス
#[inline]
pub fn is_entry_square(owner: u8, sq: usize) -> bool {
    match owner {
        0 => sq < 9,
        1 => sq >= 72,
        _ => sq % 9 == 0,
    }
}
