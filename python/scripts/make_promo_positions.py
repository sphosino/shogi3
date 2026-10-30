"""成り駒だらけの局面を作る（2026-10-30）。

自己対局では成り駒は多くても7枚で、5枚以上は0.11%しか出ない。人の対局で成り駒が増えたときに崩れないように、
実際の自己対局の局面（3人とも生きている、40〜150手目）を元に、盤上の成れる駒（歩・香・桂・銀・角・飛）を
まとめて成らせた局面を作る。持ち駒・手番・手数はそのまま。成った駒はどこにいても動けるので、局面としては成り立つ。

作った局面は runs/<run>/start_positions/ に置くと、train_loop.py の「特別な局面から」の山（--lead-share）の候補に足される
（add_start_positions.py で足す人の対局の局面と同じ扱い）。--out を別のフォルダにすれば、対応力テスト用の局面にもなる。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/make_promo_positions.py --run pbig2 --gens 251-266 --n 6000 --out runs/pbig2/start_positions/promo-2026-10-30.npy
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D  # noqa: E402

PROMOTABLE = (0, 1, 2, 3, 5, 6)   # 歩・香・桂・銀・角・飛（金・玉は成れない）


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gens", required=True, help="元にする自己対局の世代（例 251-266）")
    p.add_argument("--n", type=int, default=6000)
    p.add_argument("--min", type=int, default=5, help="成り駒をこの枚数以上にする")
    p.add_argument("--max", type=int, default=12, help="成り駒をこの枚数まで")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    lo, hi = map(int, a.gens.split("-"))
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    rng = np.random.default_rng(a.seed)
    pool = []
    for g in range(lo, hi + 1):
        st = D.load_shard(os.path.join(root, "selfplay", f"gen{g:04d}.npz"))["states"]
        mc = st[:, 106].astype(int) + st[:, 107].astype(int) * 256
        pool.append(st[(st[:, 102:105].sum(1) == 0) & (mc >= 40) & (mc <= 150)])
    pool = np.concatenate(pool)
    out, counts = [], []
    while len(out) < a.n:
        s = pool[rng.integers(len(pool))].copy()
        b = s[:81].astype(int)
        cand = [i for i in range(81) if b[i] > 0 and (b[i] - 1) % 16 < 8 and (b[i] - 1) % 8 in PROMOTABLE]
        have = int(((b > 0) & ((b - 1) % 16 >= 8)).sum())
        want = int(rng.integers(a.min, a.max + 1))
        k = want - have
        if k <= 0 or k > len(cand):
            continue
        for i in rng.choice(cand, size=k, replace=False):
            s[i] += 8
        out.append(s)
        counts.append(want)
    out = np.stack(out)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    np.save(a.out, out)
    c = np.array(counts)
    print(f"{len(out)}局面 → {a.out}（成り駒 平均{c.mean():.1f}枚、{c.min()}〜{c.max()}枚。元の局面 {len(pool)}）")


if __name__ == "__main__":
    main()
