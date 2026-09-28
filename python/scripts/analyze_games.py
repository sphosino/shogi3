"""自己対局データから三人将棋の傾向を調べる（docs/research_plan.md の研究テーマ）。

- 席ごとの勝率（世代の区切りごと）と、勝ち方の内訳
- 最初に脱落する席・脱落させた席、その後どちらが勝つか
- 途中の駒得（自分 − 相手2人の平均）と勝率の関係

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/analyze_games.py --run p4 --groups 2-11 12-21 22-31 32-41 42-51
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D  # noqa: E402

SEAT = ["青(P0)", "赤(P1)", "緑(P2)"]
PV = np.array([100, 300, 350, 400, 500, 800, 900, 0], dtype=np.float64)  # 玉は数えない
PVP = np.array([400, 200, 150, 100, 0, 500, 450, 0], dtype=np.float64)
HAND_RATE = 1.3


def material(states: np.ndarray) -> np.ndarray:
    """[N,108] → 持ち主ごとの駒価値 [N,3]（500手制限の判定と同じ数え方）"""
    b = states[:, :81].astype(np.int64)
    occ = b > 0
    c = np.where(occ, b - 1, 0)
    owner, pr, pt = c // 16, (c % 16) // 8, c % 8
    val = np.where(occ, PV[pt] + pr * PVP[pt], 0.0)
    m = np.zeros((len(states), 3))
    for o in range(3):
        m[:, o] = (val * (owner == o)).sum(1)
    hands = states[:, 81:102].astype(np.float64).reshape(-1, 3, 7)
    m += (hands * PV[:7]).sum(2) * HAND_RATE
    return m


def ci(k, n):
    """二項分布の95%区間の半幅（%）"""
    if n == 0:
        return 0.0
    p = k / n
    return 196 * np.sqrt(p * (1 - p) / n)


def load_group(run, lo, hi):
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", run, "selfplay")
    parts = []
    for g in range(lo, hi + 1):
        f = os.path.join(root, f"gen{g:04d}.npz")
        if os.path.exists(f):
            d = D.load_shard(f)
            d["game_id"] = d["game_id"].astype(np.int64) + g * 1_000_000
            d["g_id"] = d["g_id"].astype(np.int64) + g * 1_000_000
            parts.append(d)
    return parts


def analyze(parts, label):
    gw = np.concatenate([d["g_winner"] for d in parts])
    gk = np.concatenate([d["g_kind"] for d in parts])
    gp = np.concatenate([d["g_plies"] for d in parts]).astype(np.int64)
    n = len(gw)
    print(f"\n━━ {label}（{n}局、平均{gp.mean():.0f}手）━━")

    print("■ 席ごとの勝率（互角なら33.3%）と勝ち方")
    for s in range(3):
        k = int((gw == s).sum())
        last = int(((gw == s) & (gk == 0)).sum())
        entry = int(((gw == s) & (gk == 1)).sum())
        print(f"  {SEAT[s]}: {k/n*100:5.1f}% ±{ci(k, n):.1f}  （最後の1人 {last}、入玉 {entry}）")

    # 脱落の流れ：記録（1手1行）の脱落フラグが最初に立ったところ
    first_out, eliminator, winner_after, plies_first = [], [], [], []
    mat_rows = {30: [], 60: []}
    for d in parts:
        st, gid, win = d["states"], d["game_id"], d["winner"]
        starts = np.r_[0, np.nonzero(np.diff(gid))[0] + 1]
        ends = np.r_[starts[1:], len(gid)]
        for a, b in zip(starts, ends):
            el = st[a:b, 102:105].astype(bool)
            anyel = el.any(1)
            w = int(win[a])
            if anyel.any():
                j = int(np.argmax(anyel))
                if j > 0:
                    out = int(np.argmax(el[j] & ~el[j - 1]))
                    first_out.append(out)
                    eliminator.append(int(st[j - 1, 105]))
                    winner_after.append(w)
                    plies_first.append(j)
            # 途中の駒得と勝敗（3人とも生きている局面だけ）
            for ply in mat_rows:
                if b - a > ply and not el[ply].any():
                    mat_rows[ply].append((st[a + ply], w))

    fo, ek, wa = np.array(first_out), np.array(eliminator), np.array(winner_after)
    m = len(fo)
    if m:
        print(f"■ 最初の脱落（{m}局、平均{np.mean(plies_first):.0f}手目）")
        for s in range(3):
            print(f"  {SEAT[s]}: 脱落 {np.mean(fo == s)*100:5.1f}%  脱落させた {np.mean(ek == s)*100:5.1f}%")
        other = 3 - fo - ek  # 脱落にかかわらなかった残りの1人
        valid = ek != fo
        k_el = int((wa[valid] == ek[valid]).sum())
        k_ot = int((wa[valid] == other[valid]).sum())
        mv = int(valid.sum())
        print(f"  その後の勝者: 脱落させた人 {k_el/mv*100:.1f}% ±{ci(k_el, mv):.1f} / 残りの人 {k_ot/mv*100:.1f}% ±{ci(k_ot, mv):.1f}")
        # 脱落させた人が、脱落した人の次の手番かどうか（手番は P0→P1→P2）
        nxt = (fo + 1) % 3 == ek
        for flag, name in ((True, "脱落した人の次の手番"), (False, "脱落した人の前の手番")):
            sel = valid & (nxt == flag)
            if sel.sum():
                kk = int((wa[sel] == ek[sel]).sum())
                print(f"    脱落させたのが{name}（{sel.sum()}局）→ その人が勝つ {kk/sel.sum()*100:.1f}%")

    print("■ 駒得（自分 − 相手2人の平均）と勝率（3人とも残っている局面）")
    bins = [-np.inf, -1500, -500, -150, 150, 500, 1500, np.inf]
    names = ["≤-1500", "-1500〜-500", "-500〜-150", "±150", "150〜500", "500〜1500", "≥1500"]
    for ply, rows in mat_rows.items():
        if not rows:
            continue
        S = np.stack([r[0] for r in rows])
        W = np.array([r[1] for r in rows])
        M_ = material(S)
        adv = M_ - (M_.sum(1, keepdims=True) - M_) / 2  # [N,3]
        won = W[:, None] == np.arange(3)[None, :]
        a, w = adv.ravel(), won.ravel()
        idx = np.digitize(a, bins) - 1
        cells = []
        for i, nm in enumerate(names):
            sel = idx == i
            if sel.sum() >= 30:
                cells.append(f"{nm}: {w[sel].mean()*100:.0f}%({sel.sum()})")
        # 駒得が一番多い人の勝率
        lead = adv.argmax(1)
        lw = np.mean(lead == W) * 100
        print(f"  {ply}手目（{len(rows)}局面）駒得1位の勝率 {lw:.1f}%")
        print("    " + "  ".join(cells))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="p4")
    ap.add_argument("--groups", nargs="+", default=["2-11", "12-21", "22-31", "32-41", "42-51"])
    a = ap.parse_args()
    for g in a.groups:
        lo, hi = (int(x) for x in g.split("-"))
        parts = load_group(a.run, lo, hi)
        if parts:
            analyze(parts, f"{a.run} 世代{lo}〜{hi}")


if __name__ == "__main__":
    main()
