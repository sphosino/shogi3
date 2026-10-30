"""二人将棋の局面を作る（2026-10-31）。

盤面編集の「二人将棋配置」（ui.js の setTwoPlayerPreset）と同じ、青（下）と赤（上）が9筋に並んだふつうの将棋の初期配置で、
緑は最初から脱落。学習AIは三人で始める局面しか指したことがなく、二人将棋の序盤が弱かった（作者に185手で負けた）。

  - 初期配置そのまま（青が先手・赤が先手、半分ずつ）
  - そこからランダムに --rand-min〜--rand-max 手指した局面（序盤のいろいろな形）
取り駒ルールは「全部持ち駒」（ふつうの将棋と同じ）。

作った局面は runs/<run>/start_positions/ に置くと、train_loop.py の「特別な局面から」の山（--lead-share）の候補に足される。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/make_twoplayer_positions.py --n-init 3000 --n-rand 3000 --out runs/pbig2/start_positions/twoplayer-2026-10-31.npy
"""
import argparse
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402
from train_loop import run_driver  # noqa: E402

PIECES = ["FU", "KY", "KE", "GIN", "KIN", "KAKU", "HI", "OU"]
BACK = ["KY", "KE", "GIN", "KIN", "OU", "KIN", "GIN", "KE", "KY"]


def initial(turn):
    st = np.zeros(109, dtype=np.uint8)
    put = lambda r, c, p, o: st.__setitem__(r * 9 + c, 1 + o * 16 + PIECES.index(p))
    for c in range(9):
        put(8, c, BACK[c], 0); put(6, c, "FU", 0)
        put(0, c, BACK[c], 1); put(2, c, "FU", 1)
    put(7, 1, "KAKU", 0); put(7, 7, "HI", 0)   # 自分から見て角が左、飛車が右
    put(1, 1, "HI", 1); put(1, 7, "KAKU", 1)
    st[104] = 1   # 緑は脱落
    st[105] = turn
    return bytes(st)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--n-init", type=int, default=3000)
    p.add_argument("--n-rand", type=int, default=3000)
    p.add_argument("--rand-min", type=int, default=2)
    p.add_argument("--rand-max", type=int, default=10)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    starts = [initial(0), initial(1)]
    out = [np.frombuffer(starts[i % 2], dtype=np.uint8) for i in range(a.n_init)]
    rng, seed, rand = np.random.default_rng(a.seed), a.seed, []
    while len(rand) < a.n_rand:
        s0 = starts[seed % 2]   # どちらの初期配置から指したか分かるように、1回の Driver では1つだけ
        drv = shogi3_rs.Driver(parallel=256, total_games=256, seats=["random"] * 3, record=True, full_prob=1.0, visits_full=1,
                               dirichlet_total=0.0, temp_plies=0, seed=seed, rule="all", start_prob=1.0, start_states=[s0])
        seed += 1
        d = D.decode(run_driver(drv, {}, torch.device("cpu"), {}))
        off = d["g_moves_offsets"]
        for gi in range(len(d["g_plies"])):
            mv, k = d["g_moves"][off[gi]:off[gi + 1]], int(rng.integers(a.rand_min, a.rand_max + 1))
            st = s0
            if len(mv) < k:
                continue
            ok = True
            for m in mv[:k]:
                m = int(m)
                if m == 65535:
                    ok = False
                    break
                to, frm, pro = m & 127, (m >> 7) & 127, (m >> 14) & 1
                st, w = shogi3_rs.play_policy_index(st, (frm * 2 + pro) * 81 + to)
                st = bytes(st)
                if w is not None or sum(st[102:104]):
                    ok = False
                    break
            if ok:
                rand.append(np.frombuffer(st, dtype=np.uint8))
            if len(rand) >= a.n_rand:
                break
    arr = np.stack(out + rand)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    np.save(a.out, arr)
    mc = arr[:, 106].astype(int) + arr[:, 107].astype(int) * 256
    print(f"{len(arr)}局面 → {a.out}（初期配置 {a.n_init}、ランダムに{a.rand_min}〜{a.rand_max}手 {len(rand)}。手数 {mc.min()}〜{mc.max()}）")


if __name__ == "__main__":
    main()
