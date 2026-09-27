//! 局面・指し手生成・指す・終局判定。
//!
//! 挙動は JS の `game.js`（`applyMove` / `allMoves`）と `engine.js`（`eMake` / `eGenMoves`）に合わせてある。
//! 照合は `tests/js_fixtures.rs`（データは `node tools/gen-fixtures.js` で作る）。

use crate::tables::*;
use crate::{make_drop, make_move, mv_from, mv_promote, mv_to, piece_code, piece_kind, piece_owner, piece_promoted, piece_type, Move};

/// 手数の上限。手数（全員の合計）がこの値に達する手を指そうとした時点で終局する（実際に指されるのは MAX_MOVES-1 手）
pub const MAX_MOVES: u16 = 500;

/// 取った駒の行き先
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureRule {
    /// 常に持ち駒（取った人）
    All,
    /// お裾分け（取った人・取られた人以外の生存者。いなければ取った人）
    Next,
    /// 消滅あり（条件を満たすときだけ取った人、それ以外は消える）
    Vanish,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinKind {
    /// 最後の1人（玉取りで他が全員脱落）
    LastAlive,
    /// 入玉
    Entry,
    /// 500手制限（駒価値の合計で判定）
    MoveLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub winner: u8,
    pub kind: WinKind,
}

/// 指し手を適用した結果（ゲームとしての終局判定の前）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveEffect {
    Normal,
    /// 玉を取った（取られた人は脱落）
    KingCapture,
    /// 入玉が成立した
    EntryWin,
}

#[derive(Clone, Debug)]
pub struct Position {
    /// 駒コード（0 = 空）
    pub board: [u8; 81],
    /// 持ち駒の枚数 `hand[持ち主][駒種]`（玉の枠は常に0）
    pub hand: [[u8; 8]; 3],
    pub elim: [bool; 3],
    /// 玉のマス（脱落していれば -1）
    pub king: [i8; 3],
    /// 盤上＋持ち駒の枚数（玉を含む。消滅ありルールの判定用）
    pub count: [i16; 3],
    /// 手番
    pub turn: u8,
    /// これまでに `play` が呼ばれた回数（JS の moveCount）
    pub move_count: u16,
    pub rule: CaptureRule,
    /// 盤＋持ち駒のZobristハッシュ（手番・脱落は `key()` で混ぜる）
    hash: u64,
}

impl Position {
    /// 初期局面（game_spec.md の初期配置、持ち駒は各自 香1・桂1、手番 P0）
    pub fn initial(rule: CaptureRule) -> Position {
        let mut board = [0u8; 81];
        let mut put = |r: usize, c: usize, o: u8, pt: u8| board[r * 9 + c] = piece_code(o, false, pt);
        for (c, pt) in [GIN, KIN, OU, KIN, GIN].into_iter().enumerate() {
            put(8, c, 0, pt);
            put(0, c, 1, pt);
            put(2 + c, 8, 2, pt);
        }
        put(7, 0, 0, HI);
        put(7, 4, 0, KAKU);
        put(1, 0, 1, KAKU);
        put(1, 4, 1, HI);
        put(2, 7, 2, HI);
        put(6, 7, 2, KAKU);
        for i in 0..5 {
            put(6, i, 0, FU);
            put(2, i, 1, FU);
            put(2 + i, 6, 2, FU);
        }
        let mut hand = [[0u8; 8]; 3];
        for h in hand.iter_mut() {
            h[KY as usize] = 1;
            h[KE as usize] = 1;
        }
        Position::from_parts(board, hand, [false; 3], 0, 0, rule)
    }

    /// 盤・持ち駒などから局面を作る（玉の位置・枚数・ハッシュは計算し直す）
    pub fn from_parts(board: [u8; 81], hand: [[u8; 8]; 3], elim: [bool; 3], turn: u8, move_count: u16, rule: CaptureRule) -> Position {
        let mut p = Position { board, hand, elim, king: [-1; 3], count: [0; 3], turn, move_count, rule, hash: 0 };
        let t = tables();
        for sq in 0..81 {
            let c = p.board[sq];
            if c == 0 {
                continue;
            }
            let o = piece_owner(c);
            p.count[o as usize] += 1;
            if piece_type(c) == OU {
                p.king[o as usize] = sq as i8;
            }
            p.hash ^= t.z_board[z_board_index(sq, c)];
        }
        for o in 0..3 {
            for pt in 0..7 {
                let n = p.hand[o][pt];
                p.count[o] += n as i16;
                for k in 1..=n {
                    p.hash ^= z_hand_value(o as u8, pt as u8, k);
                }
            }
        }
        p
    }

    /// 置換表・推論キャッシュ用のキー（盤・持ち駒・手番・脱落）
    pub fn key(&self) -> u64 {
        let t = tables();
        let em = self.elim_mask();
        self.hash ^ t.z_turn[self.turn as usize] ^ t.z_elim[em]
    }

    pub fn elim_mask(&self) -> usize {
        (self.elim[0] as usize) | ((self.elim[1] as usize) << 1) | ((self.elim[2] as usize) << 2)
    }

    pub fn alive_count(&self) -> usize {
        self.elim.iter().filter(|&&e| !e).count()
    }

    /// o の次に指す生存者（いなければ None）
    pub fn next_alive(&self, o: u8) -> Option<u8> {
        let mut n = (o + 1) % 3;
        for _ in 0..3 {
            if !self.elim[n as usize] {
                return Some(n);
            }
            n = (n + 1) % 3;
        }
        None
    }

    // ── 指し手生成 ──

    /// 手番の人の合法手（擬似合法手。自殺手を含む）を `out` に追加する
    pub fn gen_moves(&self, out: &mut Vec<Move>) {
        self.gen_moves_for(self.turn, out);
    }

    /// 持ち主 o の合法手を `out` に追加する
    pub fn gen_moves_for(&self, o: u8, out: &mut Vec<Move>) {
        if self.elim[o as usize] {
            return;
        }
        let t = tables();
        for sq in 0..81 {
            let c = self.board[sq];
            if c == 0 || piece_owner(c) != o {
                continue;
            }
            let k = piece_kind(c);
            let pt = piece_type(c);
            let can_pro = !piece_promoted(c) && CAN_PROMOTE[pt as usize];
            let from_zone = can_pro && in_promo_zone(o, sq);
            for &to in &t.step[k * 81 + sq] {
                let tc = self.board[to as usize];
                if tc != 0 && piece_owner(tc) == o {
                    continue;
                }
                push_move(out, sq, to as usize, o, pt, can_pro, from_zone);
            }
            for &d in &t.slide[k] {
                for &to in &t.ray[d as usize * 81 + sq] {
                    let tc = self.board[to as usize];
                    if tc != 0 {
                        if piece_owner(tc) != o {
                            push_move(out, sq, to as usize, o, pt, can_pro, from_zone);
                        }
                        break;
                    }
                    push_move(out, sq, to as usize, o, pt, can_pro, from_zone);
                }
            }
        }
        // 持ち駒を打つ
        let h = &self.hand[o as usize];
        if h[..7].iter().all(|&n| n == 0) {
            return;
        }
        // 二歩：P0/P1は筋（列）、P2は段（行）
        let mut fu_lines = 0u16;
        if h[FU as usize] > 0 {
            let fu = piece_code(o, false, FU);
            for sq in 0..81 {
                if self.board[sq] == fu {
                    fu_lines |= 1 << line_of(o, sq);
                }
            }
        }
        for pt in 0..7u8 {
            if h[pt as usize] == 0 {
                continue;
            }
            for sq in 0..81 {
                if self.board[sq] != 0 {
                    continue;
                }
                if pt <= KE && must_promote(pt, o, sq) {
                    continue;
                }
                if pt == FU && fu_lines & (1 << line_of(o, sq)) != 0 {
                    continue;
                }
                out.push(make_drop(pt, sq));
            }
        }
    }

    // ── 利き ──

    /// sq に、持ち主 o 以外の生存者の駒が利いているか（入玉判定用）
    pub fn attacked_by_enemy(&self, sq: usize, o: u8) -> bool {
        let t = tables();
        for s in 0..81 {
            let c = self.board[s];
            if c == 0 {
                continue;
            }
            let e = piece_owner(c);
            if e == o || self.elim[e as usize] {
                continue;
            }
            let k = piece_kind(c);
            if t.step[k * 81 + s].iter().any(|&x| x as usize == sq) {
                return true;
            }
            for &d in &t.slide[k] {
                for &x in &t.ray[d as usize * 81 + s] {
                    if x as usize == sq {
                        return true;
                    }
                    if self.board[x as usize] != 0 {
                        break;
                    }
                }
            }
        }
        false
    }

    // ── 指す ──

    /// 手番の人が m を指した盤面の変化だけを行う（手番・手数・終局判定は変えない）。engine.js の eMake と同じ
    pub fn apply_move(&mut self, m: Move) -> MoveEffect {
        let o = self.turn;
        let to = mv_to(m);
        let from = mv_from(m);
        if from >= 81 {
            let pt = (from - 81) as u8;
            let n = self.hand[o as usize][pt as usize];
            self.hash ^= z_hand_value(o, pt, n);
            self.hand[o as usize][pt as usize] = n - 1;
            let code = piece_code(o, false, pt);
            self.board[to] = code;
            self.hash ^= tables().z_board[z_board_index(to, code)];
            return MoveEffect::Normal;
        }
        let t = tables();
        let mc = self.board[from];
        let cap = self.board[to];
        self.hash ^= t.z_board[z_board_index(from, mc)];
        let mut effect = MoveEffect::Normal;
        if cap != 0 {
            self.hash ^= t.z_board[z_board_index(to, cap)];
            let victim = piece_owner(cap);
            let cpt = piece_type(cap);
            if cpt == OU {
                self.elim[victim as usize] = true;
                self.king[victim as usize] = -1;
                self.count[victim as usize] -= 1;
                effect = MoveEffect::KingCapture;
            } else {
                let recip = self.capture_recipient(o, victim, cap);
                self.count[victim as usize] -= 1;
                if let Some(rc) = recip {
                    let n = self.hand[rc as usize][cpt as usize] + 1;
                    self.hand[rc as usize][cpt as usize] = n;
                    self.hash ^= z_hand_value(rc, cpt, n);
                    self.count[rc as usize] += 1;
                }
            }
        }
        let nc = if mv_promote(m) { mc + 8 } else { mc };
        self.board[to] = nc;
        self.board[from] = 0;
        self.hash ^= t.z_board[z_board_index(to, nc)];
        if piece_type(mc) == OU {
            self.king[o as usize] = to as i8;
            if effect == MoveEffect::Normal && is_entry_square(o, to) && !self.attacked_by_enemy(to, o) {
                effect = MoveEffect::EntryWin;
            }
        }
        effect
    }

    /// 取った駒を受け取る人（None = 消える）
    fn capture_recipient(&self, o: u8, victim: u8, cap: u8) -> Option<u8> {
        match self.rule {
            CaptureRule::All => Some(o),
            CaptureRule::Next => (0..3u8).find(|&p| !self.elim[p as usize] && p != o && p != victim).or(Some(o)),
            CaptureRule::Vanish => {
                let mut add = self.elim.iter().any(|&e| e) || piece_promoted(cap);
                if !add {
                    let ks = self.king[victim as usize];
                    if ks >= 0 {
                        let (kr, kc) = (ks / 9, ks % 9);
                        let beyond = match victim {
                            0 => kr <= 4,
                            1 => kr >= 4,
                            _ => kc <= 4,
                        };
                        if beyond || self.count[victim as usize] - self.count[o as usize] >= 3 {
                            add = true;
                        }
                    }
                }
                add.then_some(o)
            }
        }
    }

    /// ゲームとして1手指す（JS の applyMove ＋ 手番送り）。終局したら結果を返す。
    /// - 手数が MAX_MOVES に達したら、その手は指さずに500手制限で終局（手番も変えない）
    /// - 玉取りで生存者が1人になったら、指した人の勝ち
    /// - 入玉が成立したら、指した人の勝ち
    /// - 続行なら手番を次の生存者へ送る
    pub fn play(&mut self, m: Move) -> Option<Outcome> {
        self.move_count += 1;
        if self.move_count >= MAX_MOVES {
            return Some(Outcome { winner: self.limit_winner(), kind: WinKind::MoveLimit });
        }
        let mover = self.turn;
        match self.apply_move(m) {
            MoveEffect::KingCapture if self.alive_count() <= 1 => {
                return Some(Outcome { winner: mover, kind: WinKind::LastAlive });
            }
            MoveEffect::EntryWin => return Some(Outcome { winner: mover, kind: WinKind::Entry }),
            _ => {}
        }
        if let Some(n) = self.next_alive(mover) {
            self.turn = n;
        }
        None
    }

    /// 指せる手がないときの手番送り（手数は増えない）
    pub fn pass(&mut self) {
        if let Some(n) = self.next_alive(self.turn) {
            self.turn = n;
        }
    }

    // ── 駒価値（500手制限の判定）──

    /// 持ち主ごとの駒価値の合計：盤上の玉以外の駒（駒価値＋成りの追加価値）＋持ち駒（駒価値×1.3）
    pub fn material(&self) -> [f64; 3] {
        let mut s = [0f64; 3];
        for &c in self.board.iter() {
            if c == 0 || piece_type(c) == OU {
                continue;
            }
            let pt = piece_type(c) as usize;
            let v = PIECE_VALUE[pt] + if piece_promoted(c) { PROMO_BONUS[pt] } else { 0 };
            s[piece_owner(c) as usize] += v as f64;
        }
        for o in 0..3 {
            for pt in 0..7 {
                s[o] += PIECE_VALUE[pt] as f64 * HAND_RATE * self.hand[o][pt] as f64;
            }
        }
        s
    }

    /// 500手制限の勝者：生存者のうち駒価値が最大の人（同点なら番号の小さい人）
    pub fn limit_winner(&self) -> u8 {
        let s = self.material();
        let mut best: Option<u8> = None;
        for o in 0..3u8 {
            if self.elim[o as usize] {
                continue;
            }
            best = match best {
                Some(b) if s[b as usize] >= s[o as usize] => Some(b),
                _ => Some(o),
            };
        }
        best.unwrap_or(0)
    }

    /// 照合用ダイジェスト（FNV-1a 32bit：盤81＋持ち駒3×7＋脱落3＋手番）。tools/gen-fixtures.js と同じ計算
    pub fn digest(&self) -> u32 {
        let mut h = FNV_START;
        for &c in self.board.iter() {
            h = fnv_byte(h, c);
        }
        for o in 0..3 {
            for pt in 0..7 {
                h = fnv_byte(h, self.hand[o][pt]);
            }
        }
        for o in 0..3 {
            h = fnv_byte(h, self.elim[o] as u8);
        }
        fnv_byte(h, self.turn)
    }
}

pub const FNV_START: u32 = 0x811c_9dc5;
#[inline]
pub fn fnv_byte(h: u32, b: u8) -> u32 {
    (h ^ b as u32).wrapping_mul(16_777_619)
}

#[inline]
fn line_of(o: u8, sq: usize) -> usize {
    if o == 2 {
        sq / 9
    } else {
        sq % 9
    }
}

#[inline]
fn push_move(out: &mut Vec<Move>, from: usize, to: usize, o: u8, pt: u8, can_pro: bool, from_zone: bool) {
    if can_pro && (from_zone || in_promo_zone(o, to)) {
        if !must_promote(pt, o, to) {
            out.push(make_move(from, to, false));
        }
        out.push(make_move(from, to, true));
    } else {
        out.push(make_move(from, to, false));
    }
}

#[inline]
fn z_board_index(sq: usize, code: u8) -> usize {
    sq * 48 + (piece_type(code) as usize * 2 + piece_promoted(code) as usize) * 3 + piece_owner(code) as usize
}

#[inline]
fn z_hand_value(o: u8, pt: u8, count: u8) -> u64 {
    if count == 0 || count >= 20 {
        return 0;
    }
    tables().z_hand[(o as usize * 8 + pt as usize) * 20 + count as usize]
}
