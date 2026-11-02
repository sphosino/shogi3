"""二人将棋の「飛車先の歩」の局面を作る（2026-11-02）。

二人将棋配置（make_twoplayer_positions.py と同じ）から、攻める側が飛車先の歩を伸ばして角頭を狙う
  2六歩 → 2五歩 → 2四歩 →（同歩なら）同飛 → 2八飛 → 2四歩打（赤が攻めるときは 8筋 で同じ形）
を指し、受ける側はネットの方策から確率どおりに選んだ手を指す。攻める側も、ときどきネットの手を挟む。
2五歩・2四歩・同飛・2四歩打 の直後（受ける側の手番）のどれかで止めて保存する。
学習AIは飛車先の受け（3二金・2三歩打）を知らず、人に 2四歩打 から 2三歩成 で角頭を破られた。

作った局面を runs/<run>/start_positions/rookpawn-*.npy に置くと、train_loop.py の二人将棋の山の4つ目（--two-weights の4つ目）になる。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/make_rookpawn_positions.py --run pbig2 --gen 344 --n 4000 --out runs/pbig2/start_positions/rookpawn-2026-11-02.npy
  python/.venv/Scripts/python.exe python/scripts/make_rookpawn_positions.py --run pbig2 --gen 344 --n 1000 --stops 2四歩打 --seed 2 --out runs/pbig2/start_positions/rookpawn-2026-11-02-24fu.npy
"""
import argparse
import os
import sys
from collections import Counter

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import shogi3_rs  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.selfplay import evaluate_batch  # noqa: E402
from make_twoplayer_positions import initial  # noqa: E402

FU = 0
# 青が攻めるときの手順（盤の番号は 行*9+列。2筋 は列7）。(名前, 元, 先, 成り, 打つ駒)
STEPS = [("2六歩", 6 * 9 + 7, 5 * 9 + 7, 0, None), ("2五歩", 5 * 9 + 7, 4 * 9 + 7, 0, None), ("2四歩", 4 * 9 + 7, 3 * 9 + 7, 0, None),
         ("同飛", 7 * 9 + 7, 3 * 9 + 7, 0, None), ("2八飛", 3 * 9 + 7, 7 * 9 + 7, 0, None), ("2四歩打", None, 3 * 9 + 7, 0, FU)]
STOPS = ["2五歩", "2四歩", "同飛", "2四歩打"]   # ここで止める（受ける側の手番）


def flip(i):
    return 80 - i


def step_index(step, attacker):
    _, fr, to, pro, drop = step
    if attacker == 1:
        to = flip(to)
        fr = None if fr is None else flip(fr)
    return ((81 + drop if drop is not None else fr) * 2 + pro) * 81 + to


def legal_moves(st):
    s = shogi3_rs.Searcher(st, visits=1)
    leaf = s.next_leaf()
    if leaf is None:
        return []
    return [int(x) for x in np.frombuffer(leaf[1], dtype=np.int32) if x >= 0]


@torch.no_grad()
def sample(model, dev, st, legal, rng):
    x = torch.from_numpy(np.frombuffer(st, dtype=np.uint8).copy()).view(1, 109).to(dev)
    lg = torch.tensor(legal, dtype=torch.int64, device=dev).view(1, -1)
    p, _ = evaluate_batch(model, x, lg)
    p = p[0].cpu().numpy().astype(np.float64)
    return legal[int(rng.choice(len(legal), p=p / p.sum()))]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pbig2")
    ap.add_argument("--gen", type=int, required=True)
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--filler", type=float, default=0.3, help="攻める側の手番で、手順の手のかわりにネットの手を指す確率")
    ap.add_argument("--max-filler", type=int, default=3)
    ap.add_argument("--stops", nargs="+", default=STOPS, choices=STOPS, help="止めるところ（この中から均等に選ぶ）")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    model = M.load(os.path.join(root, "models", f"gen{a.gen:04d}.pt"), dev).eval()
    rng = np.random.default_rng(a.seed)
    out, stops, fail = [], Counter(), Counter()
    while len(out) < a.n:
        attacker, first = int(rng.integers(2)), int(rng.integers(2))
        target = a.stops[int(rng.integers(len(a.stops)))]
        st, k, fillers, ok = bytes(initial(first)), 0, 0, False
        for _ply in range(60):
            legal = legal_moves(st)
            if not legal:
                break
            if st[105] == attacker:
                name = STEPS[k][0]
                idx = step_index(STEPS[k], attacker)
                if name == "同飛" and st[STEPS[k][2] if attacker == 0 else flip(STEPS[k][2])] == 0:
                    break   # 2四 の歩を取られずに放っておかれた（同飛できない）
                if idx not in legal:
                    break
                if fillers < a.max_filler and name != "同飛" and rng.random() < a.filler:
                    # 挟む手で飛車を動かすと飛車先の意味がなくなるので、飛車の手は選ばない（同飛 のあとの飛車は手順どおりに動かす）
                    rook = [i for i in range(81) if st[i] == 1 + attacker * 16 + 6]
                    cand = [m for m in legal if (m // 81) // 2 not in rook]
                    if not cand:
                        break
                    mv = sample(model, dev, st, cand, rng)
                    fillers += 1
                else:
                    mv, k = idx, k + 1
            else:
                mv = sample(model, dev, st, legal, rng)
            s2, w = shogi3_rs.play_policy_index(st, mv)
            st = bytes(s2)
            if w is not None:
                break
            if st[105] != attacker and k > 0 and STEPS[k - 1][0] == target and mv == step_index(STEPS[k - 1], attacker):
                ok = True
                break
        if ok:
            out.append(np.frombuffer(st, dtype=np.uint8))
            stops[("青" if attacker == 0 else "赤") + "が攻め・" + target] += 1
        else:
            fail[target] += 1
    arr = np.stack(out)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    np.save(a.out, arr)
    mc = arr[:, 106].astype(int) + arr[:, 107].astype(int) * 256
    print(f"{len(arr)}局面 → {a.out}（手数 {mc.min()}〜{mc.max()}、平均 {mc.mean():.1f}、重複なし {len(np.unique(arr, axis=0))}）")
    print("止めたところ:", dict(sorted(stops.items())))
    print("途中で手順が続かなかった:", dict(fail))


if __name__ == "__main__":
    main()
