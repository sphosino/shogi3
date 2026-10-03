"""蒸留直後のネットが強化学習で弱くなる原因を調べる（方策と価値のどちらが崩れたか）。

1. 同じ局面（どのネットも学習に使っていない自己対局）で、方策・価値の当たり方を比べる
   - 方策：全力探索の訪問分布との交差エントロピー、最善手の一致、方策のエントロピー（自信の強さ）
   - 価値：勝敗との交差エントロピー・正解率、予想の確信度
2. 方策と価値を入れ替えた「合成ネット」を対局させる
   - 世代A の方策 + 世代B の価値、を 世代A の2体と対戦させ、どちらの部品が勝率を落としているかを見る

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/analyze_rl_drop.py --a pbig:1 --b pbig2:20 --data pbig2:21 --games 150
"""
import argparse
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.features import alive_mask, planes  # noqa: E402
from train_loop import evaluate  # noqa: E402


def load(spec, dev):
    run, g = spec.split(":")
    return M.load(os.path.join(ROOT, "runs", run, "models", f"gen{int(g):04d}.pt"), dev).eval()


class Hybrid(torch.nn.Module):
    """方策は p_net、価値は v_net から取る"""

    def __init__(self, p_net, v_net):
        super().__init__()
        self.p_net, self.v_net = p_net, v_net

    def forward(self, x, aux=False):
        return {"policy": self.p_net(x, aux=False)["policy"], "value": self.v_net(x, aux=False)["value"]}


@torch.no_grad()
def metrics(net, d, idx, dev):
    pol_ce, pol_ent, top1, vce, vacc, vconf = [], [], [], [], [], []
    for k in range(0, len(idx), 1024):
        j = idx[k:k + 1024]
        st = torch.from_numpy(d["states"][j].copy()).to(dev)
        with torch.autocast("cuda", dtype=torch.float16):
            o = net(planes(st), aux=False)
        v = F.softmax(o["value"].float().masked_fill(~alive_mask(st), -1e4), 1)
        w = torch.from_numpy(d["winner"][j].astype(np.int64)).to(dev)
        vce.append(-torch.log(v.gather(1, w[:, None]).clamp(min=1e-6)).squeeze(1).cpu())
        vacc.append((v.argmax(1) == w).float().cpu())
        vconf.append(v.max(1).values.cpu())
        logits = o["policy"].float()
        offs = d["policy_offsets"]
        for r, jj in enumerate(j):
            a, b = offs[jj], offs[jj + 1]
            li = torch.from_numpy(d["policy_index"][a:b].astype(np.int64)).to(dev)
            vis = torch.from_numpy(d["policy_visits"][a:b].astype(np.float32)).to(dev)
            if vis.sum() <= 0:
                continue
            lp = F.log_softmax(logits[r, li], 0)
            t = vis / vis.sum()
            pol_ce.append(float(-(t * lp).sum()))
            pol_ent.append(float(-(lp.exp() * lp).sum()))
            top1.append(float(li[lp.argmax()] == li[t.argmax()]))
    c = lambda x: float(torch.cat(x).mean()) if isinstance(x[0], torch.Tensor) else float(np.mean(x))
    return dict(policy_ce=c(pol_ce), policy_entropy=c(pol_ent), top1=c(top1) * 100,
                value_ce=c(vce), value_acc=c(vacc) * 100, value_conf=c(vconf) * 100)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", default="pbig:1", help="基準（蒸留直後）")
    ap.add_argument("--b", default="pbig2:20", help="比べる（強化学習後）")
    ap.add_argument("--data", default="pbig2:21", help="調べる局面の自己対局（実行名:世代）。どちらも学習に使っていないもの")
    ap.add_argument("--positions", type=int, default=20000)
    ap.add_argument("--games", type=int, default=150)
    ap.add_argument("--visits", type=int, default=200)
    a = ap.parse_args()
    dev = torch.device("cuda")
    A, B = load(a.a, dev), load(a.b, dev)
    run, g = a.data.split(":")
    d = D.load_shard(os.path.join(ROOT, "runs", run, "selfplay", f"gen{int(g):04d}.npz"))
    rng = np.random.default_rng(0)
    full = np.nonzero(d["full"] == 1)[0]
    idx = np.sort(rng.choice(full, min(a.positions, len(full)), replace=False))
    print(f"■ 同じ局面での当たり方（{a.data} の自己対局から全力探索の局面 {len(idx)}）", flush=True)
    for name, net in ((a.a, A), (a.b, B)):
        m = metrics(net, d, idx, dev)
        print(f"  {name:<10} 方策: 交差エントロピー {m['policy_ce']:.3f}  最善手の一致 {m['top1']:.1f}%  エントロピー {m['policy_entropy']:.3f}"
              f" | 価値: 交差エントロピー {m['value_ce']:.3f}  正解率 {m['value_acc']:.1f}%  確信度 {m['value_conf']:.1f}%", flush=True)

    print(f"\n■ 合成ネット vs {a.a}×2（{a.games}局、3ルール混合。互角なら33.3%）", flush=True)
    for label, net in ((f"方策 {a.a} + 価値 {a.b}", Hybrid(A, B)), (f"方策 {a.b} + 価値 {a.a}", Hybrid(B, A)), (f"{a.b}（そのまま）", B)):
        t = time.time()
        r = evaluate({0: net, 1: A}, ["net:0", "net:1", "net:1"], a.games, a.visits, dev, 5, "mix")
        print(f"  {label:<32} {r['rate']}%（z={r['z']}） 席別 {r['by_seat']} ルール別 {r['by_rule']}  {time.time()-t:.0f}秒", flush=True)


if __name__ == "__main__":
    main()
