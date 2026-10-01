"""「玉を取っても安全なのにスルーした」局面を、長く読ませて確かめる。

自己対局（1手600回の探索）で、相手の玉を取れて、取っても自分の玉に利きが残らないのに取らなかった局面を集め、
同じネットで 600回 と 長い探索（既定3200回）をやり直して、
- 玉取りの手に入る票の割合、最善手が玉取りになるか
- 玉取りの手の後の勝率（手番の人から見た）と、それ以外で一番票の多い手の後の勝率
を比べる。長く読むと取るなら「探索が足りずに見落としていた」、長く読んでも取らないなら「取らないと判断している」。
比較のため、実際に取った局面も少し調べる。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/deep_check_skip.py --run pmix --gens 82-101 --model-gen 101
"""
import argparse
import os
import sys
import time

import numpy as np
import torch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "engine-rs", "target", "analysis"))  # 学習中でも読める分析用の shogi3_rs
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.selfplay import evaluate_batch  # noqa: E402

RULES = ["全部持ち駒", "お裾分け", "消滅あり"]


def collect(root, lo, hi):
    """(局面109バイト, 玉取りの方策番号の集合, 取ったか, ルール) のリスト。取っても安全な局面だけ"""
    out = []
    for g in range(lo, hi + 1):
        d = D.load_shard(os.path.join(root, f"gen{g:04d}.npz"))
        st, gid, full = d["states"], d["game_id"], d["full"]
        offs, pidx = d["policy_offsets"], d["policy_index"]
        gi_row = {int(x): i for i, x in enumerate(d["g_id"])}
        mixed = {int(x) for i, x in enumerate(d["g_id"]) if (d["g_seat_net"][i] != 0).any()}
        last = np.r_[gid[1:] != gid[:-1], True]
        for k in np.nonzero(full == 1)[0]:
            gi = int(gid[k])
            s = st[k]
            if gi in mixed or s[102:105].any() or last[k]:
                continue
            mover = int(s[105])
            idx = pidx[offs[k]:offs[k + 1]].astype(np.int64)
            to, frm = idx % 81, idx // 162
            tgt = s[:81][to].astype(np.int64)
            is_kill = (frm < 81) & (tgt > 0) & (((tgt - 1) % 8) == 7) & (((tgt - 1) // 16) != mover)
            if not is_kill.any():
                continue
            sb = s.tobytes()
            kills = [int(x) for x in idx[is_kill]]
            if any(shogi3_rs.king_threats(shogi3_rs.apply_policy_index(sb, x))[mover] for x in kills):
                continue  # 取ると自分の玉に利きが残る手がある局面は除く（単純にするため）
            victims = {int((t - 1) // 16) for t in tgt[is_kill]}
            took = bool(st[k + 1, 102:105].astype(bool)[sorted(victims)].any())
            out.append((sb, set(kills), took, int(d["g_rule"][gi_row[gi]])))
    return out


def search(model, sb, visits, device):
    s = shogi3_rs.Searcher(sb, visits=visits)
    while True:
        leaf = s.next_leaf()
        if leaf is None:
            break
        st_b, legal_b = leaf
        st = torch.from_numpy(np.frombuffer(st_b, dtype=np.uint8).copy()).view(1, -1).to(device)
        legal = torch.from_numpy(np.frombuffer(legal_b, dtype=np.int32).astype(np.int64)).view(1, -1).to(device)
        p, v = evaluate_batch(model, st, legal)
        s.submit(p[0].cpu().tolist(), v[0].cpu().tolist())
    return s.children()


def summarize(ch, kills, mover):
    """玉取りの手の票の割合、最善手が玉取りか、玉取りの後の勝率、それ以外で一番票の多い手の後の勝率"""
    tot = sum(n for _, n, _ in ch) or 1
    kshare = sum(n for m, n, _ in ch if m in kills) / tot
    best = max(ch, key=lambda x: x[1])
    kill_best = max((x for x in ch if x[0] in kills), key=lambda x: x[1])
    alt = max((x for x in ch if x[0] not in kills), key=lambda x: x[1], default=None)
    qk = kill_best[2][mover] if kill_best[2] is not None else np.nan
    qa = alt[2][mover] if alt is not None and alt[2] is not None else np.nan
    return kshare, best[0] in kills, qk, qa


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pmix")
    ap.add_argument("--gens", default="82-101")
    ap.add_argument("--model-gen", type=int, default=101)
    ap.add_argument("--per-rule", type=int, nargs=3, default=[100, 50, 50], help="ルールごとに調べるスルー局面の数")
    ap.add_argument("--control", type=int, default=20, help="ルールごとに調べる、実際に取った局面の数")
    ap.add_argument("--deep", type=int, default=3200)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.gens.split("-"))
    dev = torch.device("cuda")
    model = M.load(os.path.join(ROOT, "runs", a.run, "models", f"gen{a.model_gen:04d}.pt"), dev).eval()
    cases = collect(os.path.join(ROOT, "runs", a.run, "selfplay"), lo, hi)
    rng = np.random.default_rng(a.seed)
    print(f"{a.run} 世代{lo}〜{hi} の自己対局から、取っても安全な玉取りがある局面 {len(cases)}。ネットは世代{a.model_gen}、探索 600回 と {a.deep}回", flush=True)
    t0 = time.time()
    for r in range(3):
        for took, n in ((False, a.per_rule[r]), (True, a.control)):
            pool = [c for c in cases if c[3] == r and c[2] == took]
            if not pool or n == 0:
                continue
            pick = [pool[i] for i in rng.choice(len(pool), min(n, len(pool)), replace=False)]
            res = {600: [], a.deep: []}
            for sb, kills, _, _ in pick:
                mover = sb[105]
                for v in res:
                    res[v].append(summarize(search(model, sb, v, dev), kills, mover))
            label = "実際に取った局面（比較）" if took else "取っても安全なのにスルーした局面"
            print(f"\n■ {RULES[r]}：{label} {len(pick)}局面（{time.time()-t0:.0f}秒）", flush=True)
            for v, R in res.items():
                R = np.array(R, dtype=np.float64)
                print(f"  {v:>5}回: 玉取りの手の票 平均{R[:,0].mean()*100:5.1f}%  最善手が玉取り {R[:,1].mean()*100:5.1f}%  "
                      f"手番の人の勝率 玉取り後 {np.nanmean(R[:,2])*100:5.1f}% / ほかの最善の手の後 {np.nanmean(R[:,3])*100:5.1f}%", flush=True)


if __name__ == "__main__":
    main()
