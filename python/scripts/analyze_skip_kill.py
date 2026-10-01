"""玉を取れるのに取らない（スルーする）局面を探す。3人とも生きている局面だけ。

全力探索の局面には合法手がすべて記録されているので、その中に相手の玉を取る手があるかを調べ、
実際に取ったか（次の局面でその人が脱落しているか）を見る。スルーした局面では、
取れた相手がどれだけ弱っていたか、その相手が結局誰に倒されたか、スルーした本人が勝ったかを数える。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/analyze_skip_kill.py --run pmix --gens 82-101
"""
import argparse
import os
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# 学習中は site-packages の shogi3_rs が使用中で上書きできないので、分析用に別に作ったものを優先して読む
sys.path.insert(0, os.path.join(ROOT, "engine-rs", "target", "analysis"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402
from analyze_games import material  # noqa: E402

RULES = ["全部持ち駒", "お裾分け", "消滅あり"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pmix")
    ap.add_argument("--gens", default="82-101")
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.gens.split("-"))
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run, "selfplay")
    rec = {r: [] for r in range(3)}
    for g in range(lo, hi + 1):
        d = D.load_shard(os.path.join(root, f"gen{g:04d}.npz"))
        st, gid, full = d["states"], d["game_id"], d["full"]
        offs, pidx, pvis = d["policy_offsets"], d["policy_index"], d["policy_visits"]
        gi_row = {int(x): i for i, x in enumerate(d["g_id"])}
        mixed = {int(x) for i, x in enumerate(d["g_id"]) if (d["g_seat_net"][i] != 0).any()}
        last = np.r_[gid[1:] != gid[:-1], True]  # その対局の最後の記録か
        mats = material(st)
        for k in np.nonzero(full == 1)[0]:
            gi = int(gid[k])
            if gi in mixed:
                continue
            s = st[k]
            el = s[102:105].astype(bool)
            if el.any():
                continue  # 3人とも生きている局面だけ
            mover = int(s[105])
            idx = pidx[offs[k]:offs[k + 1]].astype(np.int64)
            vis = pvis[offs[k]:offs[k + 1]].astype(np.float64)
            to, frm = idx % 81, idx // 162
            tgt = s[:81][to].astype(np.int64)
            is_kill = (frm < 81) & (tgt > 0) & (((tgt - 1) % 8) == 7) & (((tgt - 1) // 16) != mover)
            if not is_kill.any():
                continue
            victims = sorted({int((t - 1) // 16) for t in tgt[is_kill]})
            # 玉を取った後、自分の玉に残りの相手の利きがあるか（取ると自分が取られる）。玉取りの手のうち票が最多のもので見る
            kill_idx = int(idx[is_kill][np.argmax(vis[is_kill])])
            sb = s.tobytes()
            in_check = shogi3_rs.king_threats(sb)[mover]
            exposed = shogi3_rs.king_threats(shogi3_rs.apply_policy_index(sb, kill_idx))[mover]
            row = gi_row[gi]
            winner, kind = int(d["g_winner"][row]), int(d["g_kind"][row])
            if last[k]:
                took = kind == 0 and winner == mover  # 最後の記録で、玉取りで終わった
                after = None
            else:
                after = st[k + 1, 102:105].astype(bool)
                took = bool(after[victims].any())
            # 取れた相手（2人取れるときは弱い方）の駒の価値の割合
            v = min(victims, key=lambda p: mats[k, p])
            share = mats[k, v] / max(mats[k].sum(), 1)
            # スルーしたとき：その相手は結局誰に倒されたか
            killer_later = None
            if not took and not last[k]:
                j = k + 1
                while j < len(st) and int(gid[j]) == gi:
                    if st[j, 102 + v] and not st[j - 1, 102 + v]:
                        killer_later = int(st[j - 1, 105])
                        break
                    j += 1
            rec[int(d["g_rule"][row])].append(dict(
                took=took, share=share, vis_kill=vis[is_kill].sum() / max(vis.sum(), 1),
                win=winner == mover, killer_later=killer_later, mover=mover, two=len(victims) == 2,
                in_check=in_check, exposed=exposed))

    print(f"{a.run} 世代{lo}〜{hi} の自己対局（現世代どうし、全力探索の局面、3人とも生存）で、相手の玉を取れる局面")
    for r in range(3):
        R = rec[r]
        if not R:
            continue
        took = np.array([x["took"] for x in R])
        share = np.array([x["share"] for x in R])
        print(f"\n■ {RULES[r]}：玉を取れる局面 {len(R)}  取った {took.mean()*100:.1f}%  スルー {(~took).sum()}局面"
              f"（探索の票のうち玉取りの手に入れた割合 平均 {np.mean([x['vis_kill'] for x in R])*100:.0f}%）")
        for lab, m in (("相手が弱っている（駒の価値が3人の合計の20%未満）", share < 0.2),
                       ("ふつう（20〜33%）", (share >= 0.2) & (share < 0.333)),
                       ("相手が強い（33%以上）", share >= 0.333)):
            if m.sum():
                print(f"  {lab}: {m.sum()}局面  取った {took[m].mean()*100:.1f}%")
        ex = np.array([x["exposed"] for x in R])
        ic = np.array([x["in_check"] for x in R])
        print(f"  取ると自分の玉に利きが残る（取ったら次に取られうる）: {ex.sum()}局面 → 取った {took[ex].mean()*100:.1f}%")
        print(f"  取っても自分の玉は安全: {(~ex).sum()}局面 → 取った {took[~ex].mean()*100:.1f}%"
              f"（このうち自分が王手を受けている {(ic & ~ex).sum()}局面）")
        safe = ~ex
        for lab, m in (("安全で、相手が弱っている（20%未満）", safe & (share < 0.2)),
                       ("安全で、ふつう（20〜33%）", safe & (share >= 0.2) & (share < 0.333)),
                       ("安全で、相手が強い（33%以上）", safe & (share >= 0.333))):
            if m.sum():
                print(f"    {lab}: {m.sum()}局面  取った {took[m].mean()*100:.1f}%")
        sk = [x for x in R if not x["took"] and not x["exposed"]]
        print("  ↓ 以下は「取っても安全なのにスルーした」局面")
        if sk:
            kl = [x["killer_later"] for x in sk]
            me = sum(1 for x, k in zip(sk, kl) if k == x["mover"])
            oth = sum(1 for x, k in zip(sk, kl) if k is not None and k != x["mover"])
            none = sum(1 for k in kl if k is None)
            print(f"  スルーした局面のその後：その相手を後で自分が倒した {me}、もう1人が倒した {oth}、倒されなかった {none}")
            print(f"  最後に勝った割合：スルーした人 {np.mean([x['win'] for x in sk])*100:.1f}% / 取った人 {np.mean([x['win'] for x in R if x['took']])*100:.1f}%")
            print(f"  スルーした局面の探索の票：玉取りの手に平均 {np.mean([x['vis_kill'] for x in sk])*100:.0f}%")


if __name__ == "__main__":
    main()
