//! ブラウザ版の探索（WebAssembly、wasm-bindgen なしの素の C ABI）。
//!
//! ブラウザ側（web/ai.js）の流れ：
//!   ctx = search_new(局面109バイト, 探索回数, まとめる数)
//!   loop { k = search_next(ctx); if k == 0 break;            // 評価待ちの葉を最大「まとめる数」個用意する
//!          局面 k×109バイト（search_states_ptr）と合法手 k×L（search_legal_ptr, L = search_legal_len）を読み、
//!          ONNX Runtime Web で推論して、事前確率 k×L と価値 k×3 を書き込んで search_submit(ctx, …) }
//!   n = search_result(ctx)  // 根の各手（方策番号, 訪問数）と根の価値
//!   search_free(ctx)
//! 葉をまとめるときは仮想訪問を使う（同じ道ばかり選ばないように）。局面と方策番号の形は engine-rs/py と同じ。

use shogi3_core::{mv_from, mv_promote, mv_to, CaptureRule, Move, Position};
use shogi3_mcts::{EvalOut, Leaf, Search, SearchConfig, PASS};

const STATE_BYTES: usize = 109;

fn policy_index(m: Move) -> i32 {
    ((mv_from(m) * 2 + mv_promote(m) as usize) * 81 + mv_to(m)) as i32
}

fn rule_id(r: CaptureRule) -> u8 {
    match r {
        CaptureRule::All => 0,
        CaptureRule::Next => 1,
        CaptureRule::Vanish => 2,
    }
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

fn decode_state(s: &[u8]) -> Position {
    let mut board = [0u8; 81];
    board.copy_from_slice(&s[..81]);
    let mut hand = [[0u8; 8]; 3];
    for o in 0..3 {
        hand[o][..7].copy_from_slice(&s[81 + o * 7..88 + o * 7]);
    }
    let elim = [s[102] != 0, s[103] != 0, s[104] != 0];
    let rule = match s[108] {
        1 => CaptureRule::Next,
        2 => CaptureRule::Vanish,
        _ => CaptureRule::All,
    };
    Position::from_parts(board, hand, elim, s[105], u16::from_le_bytes([s[106], s[107]]), rule)
}

pub struct Ctx {
    search: Search,
    pending: Vec<(Leaf, Vec<Move>)>,
    visits: u32,
    batch: usize,
    states: Vec<u8>,
    legal: Vec<i32>,
    l: usize,
    children: Vec<i32>,
    root_value: [f32; 3],
}

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// alloc で確保した領域を、同じ大きさで返すこと
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n));
}

/// # Safety
/// state は109バイト
#[no_mangle]
pub unsafe extern "C" fn search_new(state: *const u8, visits: u32, batch: u32, c_puct: f32) -> *mut Ctx {
    let s = std::slice::from_raw_parts(state, STATE_BYTES);
    let cfg = SearchConfig { c_puct, fpu_reduction: 0.2, dirichlet_total: 0.0, dirichlet_weight: 0.0 };
    Box::into_raw(Box::new(Ctx {
        search: Search::new(decode_state(s), cfg),
        pending: Vec::new(),
        visits,
        batch: batch.max(1) as usize,
        states: Vec::new(),
        legal: Vec::new(),
        l: 0,
        children: Vec::new(),
        root_value: [0.0; 3],
    }))
}

/// 評価待ちの葉を用意して、その数を返す（0 なら探索終了）
///
/// # Safety
/// ctx は search_new が返したもの
#[no_mangle]
pub unsafe extern "C" fn search_next(ctx: *mut Ctx) -> u32 {
    let c = &mut *ctx;
    c.pending.clear();
    let mut guard = 0;
    while c.pending.len() < c.batch && (c.search.root_visits() as usize + c.pending.len()) < c.visits as usize && guard < 4 * c.batch + 64 {
        guard += 1;
        let leaf = c.search.select();
        if leaf.terminal.is_some() {
            c.search.expand(leaf, &[], None);
            continue;
        }
        if c.pending.iter().any(|(p, _)| p.id() == leaf.id()) {
            break; // 同じ葉をもう一度選んだ：このまとまりはここまで
        }
        let moves = c.search.leaf_moves(&leaf);
        c.search.add_virtual(&leaf);
        c.pending.push((leaf, moves));
    }
    let k = c.pending.len();
    c.l = c.pending.iter().map(|(_, m)| m.len()).max().unwrap_or(0);
    c.states.clear();
    c.legal.clear();
    for (leaf, moves) in &c.pending {
        encode_state(c.search.leaf_position(leaf), &mut c.states);
        for i in 0..c.l {
            c.legal.push(match moves.get(i) {
                Some(&m) if m != PASS => policy_index(m),
                _ => -1,
            });
        }
    }
    k as u32
}

#[no_mangle]
pub unsafe extern "C" fn search_states_ptr(ctx: *mut Ctx) -> *const u8 {
    (*ctx).states.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn search_legal_ptr(ctx: *mut Ctx) -> *const i32 {
    (*ctx).legal.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn search_legal_len(ctx: *mut Ctx) -> u32 {
    (*ctx).l as u32
}

/// search_next の葉の評価を返す。priors: f32[k×L]、values: f32[k×3]
///
/// # Safety
/// 大きさは直前の search_next と合わせること
#[no_mangle]
pub unsafe extern "C" fn search_submit(ctx: *mut Ctx, priors: *const f32, values: *const f32) {
    let c = &mut *ctx;
    let l = c.l;
    let pending = std::mem::take(&mut c.pending);
    let pr = std::slice::from_raw_parts(priors, pending.len() * l);
    let va = std::slice::from_raw_parts(values, pending.len() * 3);
    for (bi, (leaf, moves)) in pending.into_iter().enumerate() {
        let n = moves.len();
        let ev = EvalOut { priors: pr[bi * l..bi * l + n].to_vec(), value: [va[bi * 3], va[bi * 3 + 1], va[bi * 3 + 2]] };
        c.search.expand_virtual(leaf, &moves, Some(ev));
    }
}

/// 根の各手を (方策番号 or -1, 訪問数) の組で用意して、その数を返す。根の価値も用意する
///
/// # Safety
/// ctx は search_new が返したもの
#[no_mangle]
pub unsafe extern "C" fn search_result(ctx: *mut Ctx) -> u32 {
    let c = &mut *ctx;
    c.children.clear();
    for (m, n) in c.search.root_visit_counts() {
        c.children.push(if m == PASS { -1 } else { policy_index(m) });
        c.children.push(n as i32);
    }
    c.root_value = c.search.root_value();
    (c.children.len() / 2) as u32
}

#[no_mangle]
pub unsafe extern "C" fn search_children_ptr(ctx: *mut Ctx) -> *const i32 {
    (*ctx).children.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn search_value_ptr(ctx: *mut Ctx) -> *const f32 {
    (*ctx).root_value.as_ptr()
}

/// # Safety
/// ctx は search_new が返したもの。以後使わないこと
#[no_mangle]
pub unsafe extern "C" fn search_free(ctx: *mut Ctx) {
    drop(Box::from_raw(ctx));
}
