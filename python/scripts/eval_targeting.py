"""「いつも同じ人を狙ってくる」相手2人に、今のネットがどれだけ弱いかを測る。

狙う側（2体）は、測る側と同じネットだが、勝率予想を作り替えて「標的が負けるほど嬉しい」ようにする：
  標的以外の人 p の価値 = 自分が勝つ確率 + λ × (1 − 標的が勝つ確率)
狙う側の探索では、自分ももう1人も標的を倒したがっている、として読む（2人で示し合わせて狙う形）。
測る側は標的の席に固定して座る。λ=0（ふつうの自分の分身2体）と比べる。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/eval_targeting.py --run pmix --gen 141 --lambdas 0 0.5 1.0 --seats 0 1 --games 300
"""
import argparse
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.selfplay import run_driver  # noqa: E402

SEAT = ["青", "赤", "緑"]
RULES = ["全部持ち駒", "お裾分け", "消滅あり"]


class Targeter(torch.nn.Module):
    """同じネットで、標的が負けるほど価値が上がるように作り替えたプレイヤー"""

    def __init__(self, net, target: int, lam: float):
        super().__init__()
        self.net, self.target, self.lam = net, target, lam

    def forward(self, x, aux=False):
        return self.net(x, aux=aux)

    def value_transform(self, v, states):
        t = self.target
        out = v.clone()
        bonus = self.lam * (1.0 - v[:, t])
        for p in range(3):
            if p != t:
                out[:, p] = v[:, p] + bonus * (states[:, 102 + p] == 0)  # 脱落した人には足さない
        return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pmix")
    ap.add_argument("--gen", type=int, default=141)
    ap.add_argument("--lambdas", type=float, nargs="+", default=[0.0, 0.5, 1.0])
    ap.add_argument("--seats", type=int, nargs="+", default=[0, 1], help="測る側（標的）の席")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--visits", type=int, default=200)
    ap.add_argument("--rule", default="mix")
    ap.add_argument("--seed", type=int, default=31)
    a = ap.parse_args()
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    dev = torch.device("cuda")
    net = M.load(os.path.join(root, "models", f"gen{a.gen:04d}.pt"), dev).eval()
    print(f"{a.run} 世代{a.gen}。測る側を標的の席に固定し、残り2席は同じネットで「標的を狙う」度合い λ を変える（{a.games}局、{a.rule}）", flush=True)
    for seat in a.seats:
        for lam in a.lambdas:
            t0 = time.time()
            seats = ["net:1"] * 3
            seats[seat] = "net:0"
            models = {0: net, 1: Targeter(net, seat, lam).eval()}
            drv = shogi3_rs.Driver(parallel=a.games, total_games=a.games, seats=seats, rotate=False, record=True,
                                   full_prob=1.0, visits_full=a.visits, dirichlet_total=0.0, temp_plies=8, seed=a.seed, rule=a.rule)
            d = D.decode(run_driver(drv, models, dev))
            w = np.bincount(d["g_winner"], minlength=3) / len(d["g_winner"]) * 100
            # 標的が最下位（最初に脱落）になった割合：記録の最初の行の順位
            first = np.r_[0, np.nonzero(np.diff(d["game_id"]))[0] + 1]
            rank = d["rank"][first]
            last_place = (rank[:, seat] == 3).mean() * 100
            by_rule = {RULES[r]: round(float((d["g_winner"][d["g_rule"] == r] == seat).mean() * 100), 1)
                       for r in range(3) if (d["g_rule"] == r).any()}
            print(f"■ 標的={SEAT[seat]} λ={lam}: 標的（測る側）の勝率 {w[seat]:.1f}%  最下位 {last_place:.1f}%  "
                  f"勝率 青{w[0]:.1f} 赤{w[1]:.1f} 緑{w[2]:.1f}  平均{d['g_plies'].mean():.0f}手  ルール別 {by_rule}  {time.time()-t0:.0f}秒", flush=True)


if __name__ == "__main__":
    main()
