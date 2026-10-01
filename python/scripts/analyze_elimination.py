"""最初の脱落（玉取り）の前後で何が起きているかを調べる。

脱落した人の駒は、動かず利きもないまま盤に残り、誰でも取れる（docs/game_spec.md）。
玉を取った人（脱落させた人）と、残りのもう1人を比べる：
- 勝率予想（MCTS 根の価値）が、玉取りの前後でどう変わるか
- 脱落した人の残りの駒を、どちらがどれだけ拾うか（「ちゃっかり」）
- 玉取りの直後に、互いの駒をどれだけ取り合うか

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/analyze_elimination.py --run pmix --gens 82-101
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D  # noqa: E402

RULES = ["全部持ち駒", "お裾分け", "消滅あり"]
PV = np.array([100, 300, 350, 400, 500, 800, 900, 0], dtype=np.float64)
PVP = np.array([400, 200, 150, 100, 0, 500, 450, 0], dtype=np.float64)


def piece_value(code: int) -> float:
    c = code - 1
    pt, pr = c % 8, (c % 16) // 8
    return PV[pt] + pr * PVP[pt]


def capture(b0: np.ndarray, b1: np.ndarray, mover: int):
    """1手の前後の盤から、取った駒（持ち主, 価値）を返す。取っていなければ None"""
    sq = np.nonzero((b0 > 0) & (b1 > 0) & (((b0.astype(np.int64) - 1) // 16) != mover) & (((b1.astype(np.int64) - 1) // 16) == mover))[0]
    if len(sq) == 0:
        return None
    code = int(b0[sq[0]])
    return (code - 1) // 16, piece_value(code)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pmix")
    ap.add_argument("--gens", default="82-101")
    ap.add_argument("--window", type=int, default=30, help="脱落のあと何手の間の駒の取り合いを数えるか")
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.gens.split("-"))
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run, "selfplay")
    ev = {r: [] for r in range(3)}
    for g in range(lo, hi + 1):
        d = D.load_shard(os.path.join(root, f"gen{g:04d}.npz"))
        st, gid, rv = d["states"], d["game_id"], d["root_value"]
        mixed = {int(x) for i, x in enumerate(d["g_id"]) if (d["g_seat_net"][i] != 0).any()}  # 過去の世代を混ぜた対局は除く
        win = dict(zip(d["g_id"].astype(int).tolist(), d["g_winner"].astype(int).tolist()))
        rule = dict(zip(d["g_id"].astype(int).tolist(), d["g_rule"].astype(int).tolist()))
        starts = np.r_[0, np.nonzero(np.diff(gid))[0] + 1]
        ends = np.r_[starts[1:], len(gid)]
        for s, e in zip(starts, ends):
            gi = int(gid[s])
            if gi in mixed:
                continue
            el = st[s:e, 102:105].astype(bool)
            j = next((k for k in range(1, e - s) if (el[k] & ~el[k - 1]).any()), None)
            if j is None or j < 4:
                continue
            out = int(np.argmax(el[j] & ~el[j - 1]))
            killer = int(st[s + j - 1, 105])
            if killer == out:
                continue
            other = 3 - out - killer
            # 勝率予想：玉取りの1巡前（取った人の前の手番）、玉取りの直前、直後、6手後
            def val(k, p):
                return float(rv[s + k, p]) if 0 <= k < e - s else np.nan
            vals = {name: (val(k, killer), val(k, other)) for name, k in (("1巡前", j - 4), ("直前", j - 1), ("直後", j), ("6手後", j + 6))}
            # 脱落のあとの取り合い
            loot = {killer: 0.0, other: 0.0}           # 脱落した人の残りの駒
            hit = {killer: 0.0, other: 0.0}            # 互いの駒（取った人 → もう1人、もう1人 → 取った人）
            first_loot = None
            for k in range(j, min(e - s - 1, j + a.window)):
                mover = int(st[s + k, 105])
                c = capture(st[s + k, :81], st[s + k + 1, :81], mover)
                if c is None:
                    continue
                owner, v = c
                if owner == out:
                    loot[mover] += v
                    if first_loot is None:
                        first_loot = mover
                else:
                    hit[mover] += v
            ev[rule[gi]].append(dict(killer_win=win[gi] == killer, vals=vals, loot_k=loot[killer], loot_o=loot[other],
                                     first_loot=None if first_loot is None else first_loot == killer,
                                     hit_k=hit[killer], hit_o=hit[other]))

    print(f"{a.run} 世代{lo}〜{hi} の自己対局（現世代どうし）。最初の脱落の前後。取った人＝玉を取って脱落させた人、もう1人＝残りの人")
    for r in range(3):
        E = ev[r]
        if not E:
            continue
        n = len(E)
        print(f"\n■ {RULES[r]}（{n}局）  最終的に勝ったのは 取った人 {np.mean([x['killer_win'] for x in E])*100:.1f}%")
        print("  勝率予想（MCTS根の価値）   取った人   もう1人")
        for name in ("1巡前", "直前", "直後", "6手後"):
            kv = np.nanmean([x["vals"][name][0] for x in E]) * 100
            ov = np.nanmean([x["vals"][name][1] for x in E]) * 100
            print(f"    {name:<6}               {kv:6.1f}%   {ov:6.1f}%")
        lk = np.array([x["loot_k"] for x in E])
        lo_ = np.array([x["loot_o"] for x in E])
        fl = [x["first_loot"] for x in E if x["first_loot"] is not None]
        print(f"  脱落した人の残りの駒を拾った量（{a.window}手以内、駒価値の平均）: 取った人 {lk.mean():.0f} / もう1人 {lo_.mean():.0f}"
              f"  最初に拾ったのが取った人 {np.mean(fl)*100:.1f}%（{len(fl)}局）")
        hk = np.array([x["hit_k"] for x in E])
        ho = np.array([x["hit_o"] for x in E])
        print(f"  互いの駒を取った量（{a.window}手以内）: 取った人→もう1人 {hk.mean():.0f} / もう1人→取った人 {ho.mean():.0f}")
        # 拾った量の差と勝敗
        diff = lo_ - lk
        for lab, m in (("もう1人の方が多く拾った", diff > 0), ("同じ", diff == 0), ("取った人の方が多く拾った", diff < 0)):
            if m.sum() >= 30:
                print(f"    {lab}（{m.sum()}局）→ 取った人の勝率 {np.mean([x['killer_win'] for x, mm in zip(E, m) if mm])*100:.1f}%")


if __name__ == "__main__":
    main()
