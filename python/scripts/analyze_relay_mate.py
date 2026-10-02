"""「やけくそ王手 → もう1人が乗る → 仕留める」形の脱落を探す。

手番が A → B → C のとき：
  1. B が、自分の直前に指す A の玉に王手をかける（持ち駒を打って、など）
  2. A が応じる前に C の手番。C も A の玉に利きを足す（「乗る」）
  3. A は1手で両方を防げず、B が A の玉を取る
最初の脱落（3人とも生きている状態から）が、この形で起きたかを数える。B が王手をかけた時点の勝率予想（MCTS 根の価値）も見る。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/analyze_relay_mate.py --run pmix --gens 102-141
"""
import argparse
import os
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "engine-rs", "target", "analysis"))  # 学習中でも読める分析用の shogi3_rs
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402

RULES = ["全部持ち駒", "お裾分け", "消滅あり"]
SUJI = "９８７６５４３２１"
DAN = "一二三四五六七八九"
PNAME = ["歩", "香", "桂", "銀", "金", "角", "飛", "玉"]
SEAT = ["青", "赤", "緑"]


def without(state: bytes, owner: int) -> bytes:
    """owner の盤上の駒を取り除いた局面（残りの1人の利きだけを見るため）"""
    b = bytearray(state)
    for sq in range(81):
        c = b[sq]
        if c and (c - 1) // 16 == owner and (c - 1) % 8 != 7:
            b[sq] = 0
    return bytes(b)


def attacks_by(state: bytes, attacker: int, victim: int) -> bool:
    """attacker の駒だけで victim の玉に利いているか（3人目の駒を取り除いて調べる）"""
    third = 3 - attacker - victim
    return shogi3_rs.king_threats(without(state, third))[victim]


def is_drop(b0: np.ndarray, b1: np.ndarray, mover: int) -> bool:
    """盤上の駒が1つ増えただけ（どこからも動いていない）なら打つ手"""
    gone = np.nonzero((b0 > 0) & (b1 == 0))[0]
    return len(gone) == 0 and int(((b1 > 0) & (b0 == 0)).sum()) == 1


def fmt_move(m: int, board: np.ndarray) -> str:
    to, frm, pro = m & 127, (m >> 7) & 127, (m >> 14) & 1
    sq = f"{SUJI[to % 9]}{DAN[to // 9]}"
    if frm >= 81:
        return f"{sq}{PNAME[frm - 81]}打"
    c = int(board[frm])
    name = PNAME[(c - 1) % 8] if c else "?"
    return f"{sq}{name}{'成' if pro else ''}({SUJI[frm % 9]}{DAN[frm // 9]})"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pmix")
    ap.add_argument("--gens", default="102-141")
    ap.add_argument("--examples", type=int, default=3)
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.gens.split("-"))
    root = os.path.join(ROOT, "runs", a.run, "selfplay")
    stats = {r: dict(total=0, relay=0, relay_drop=0, desperate=0, kv=[], killer_win=0) for r in range(3)}
    examples = []
    for g in range(lo, hi + 1):
        d = D.load_shard(os.path.join(root, f"gen{g:04d}.npz"))
        st, gid, rv = d["states"], d["game_id"], d["root_value"]
        row = {int(x): i for i, x in enumerate(d["g_id"])}
        starts = np.r_[0, np.nonzero(np.diff(gid))[0] + 1]
        ends = np.r_[starts[1:], len(gid)]
        for s, e in zip(starts, ends):
            gi = int(gid[s])
            i = row[gi]
            if (d["g_seat_net"][i] != 0).any():
                continue  # 現世代どうしの対局だけ（全手が記録されている）
            el = st[s:e, 102:105].astype(bool)
            j = next((k for k in range(1, e - s) if (el[k] & ~el[k - 1]).any()), None)
            if j is None or j < 4:
                continue
            r = int(d["g_rule"][i])
            V = int(np.argmax(el[j] & ~el[j - 1]))
            K = int(st[s + j - 1, 105])
            stats[r]["total"] += 1
            # 手番が V → K → C で、K が j-4 で王手、C が j-3 で乗る、V が j-2 で逃げきれず、K が j-1 で取る
            if K == V or (V + 1) % 3 != K or int(st[s + j - 4, 105]) != K:
                continue
            C = 3 - V - K
            s4, s3, s2 = (st[s + j - k].tobytes() for k in (4, 3, 2))
            check_by_k = attacks_by(s3, K, V) and not attacks_by(s4, K, V)
            c_joins = attacks_by(s2, C, V) and not attacks_by(s3, C, V)
            if not (check_by_k and c_joins):
                continue
            stats[r]["relay"] += 1
            drop = is_drop(st[s + j - 4, :81], st[s + j - 3, :81], K)
            stats[r]["relay_drop"] += drop
            kv = float(rv[s + j - 4, K])
            stats[r]["kv"].append(kv)
            stats[r]["desperate"] += kv < 0.25
            stats[r]["killer_win"] += int(d["g_winner"][i]) == K
            if drop and kv < 0.25 and len(examples) < a.examples:
                mo = d["g_moves_offsets"]
                mv = d["g_moves"][mo[i]:mo[i + 1]]
                seq = []
                for k in range(j - 4, j):
                    seq.append(f"{SEAT[int(st[s + k, 105])]} {fmt_move(int(mv[k]), st[s + k, :81])}")
                examples.append(dict(gen=g, game=gi, rule=RULES[r], ply=j - 4, V=SEAT[V], K=SEAT[K], C=SEAT[C], kv=kv,
                                     seq=seq, winner=SEAT[int(d["g_winner"][i])]))

    print(f"{a.run} 世代{lo}〜{hi} の自己対局（現世代どうし）。最初の脱落のうち「王手 → もう1人が乗る → 取る」の形")
    for r in range(3):
        S = stats[r]
        if not S["total"]:
            continue
        kv = np.array(S["kv"])
        print(f"\n■ {RULES[r]}：最初の脱落 {S['total']}局  うちこの形 {S['relay']}（{S['relay']/S['total']*100:.1f}%）")
        if S["relay"]:
            print(f"  王手が持ち駒を打つ手 {S['relay_drop']}（{S['relay_drop']/S['relay']*100:.0f}%）")
            print(f"  王手をかけた人の、そのときの勝率予想：平均 {kv.mean()*100:.1f}%  25%未満（やけくそ） {S['desperate']}（{S['desperate']/S['relay']*100:.0f}%）")
            print(f"  王手をかけて玉を取った人が最後に勝った {S['killer_win']/S['relay']*100:.1f}%")
    for ex in examples:
        print(f"\n例：pmix 世代{ex['gen']} の自己対局 {ex['game']}（{ex['rule']}、{ex['ply']+1}手目から）。"
              f"{ex['K']}が{ex['V']}に王手（{ex['K']}の勝率予想 {ex['kv']*100:.0f}%）→ {ex['C']}が乗る → {ex['K']}が取る。最終的な勝者 {ex['winner']}")
        for line in ex["seq"]:
            print("   " + line)


if __name__ == "__main__":
    main()
