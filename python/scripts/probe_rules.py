"""ルールを入力にしたネットが、ルールの違いをどう吸収しているかを調べる。

同じ局面を、ルールの入力だけ変えてネットに入れ、出力の違いを見る。
- 価値：実際に指されたルールを入れたときと、別のルールを入れたときで、勝敗の当たり方がどう変わるか
- 方策：駒を取る手・玉を動かす手・持ち駒を打つ手に、どれだけ確率を置くか
- 補助：今後20手の駒の損失・残り手数の予測
- 初期局面：ルールごとの席の勝率予想

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/probe_rules.py --run pmix --gen 21 --data-gens 20 21
"""
import argparse
import os
import sys

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.features import alive_mask, planes  # noqa: E402

RULES = ["全部持ち駒", "お裾分け", "消滅あり"]
SEAT = ["青", "赤", "緑"]


@torch.no_grad()
def run_net(model, states: np.ndarray, rule: int, device, bs=2048):
    """局面のルールの入力を rule に差し替えて評価。価値の確率・方策のロジット・補助を返す"""
    vals, pols, l20, rem = [], [], [], []
    for k in range(0, len(states), bs):
        st = torch.from_numpy(states[k:k + bs].copy()).to(device)
        st[:, 108] = rule
        with torch.autocast("cuda", dtype=torch.float16):
            o = model(planes(st), aux=True)
        v = o["value"].float().masked_fill(~alive_mask(st), -1e4)
        vals.append(F.softmax(v, dim=1).cpu())
        pols.append(o["policy"].float().cpu())
        l20.append(o["loss20"].float().cpu() * 1000)
        rem.append(torch.expm1(o["remaining"].float().squeeze(1)).cpu())
    return torch.cat(vals).numpy(), torch.cat(pols), torch.cat(l20).numpy(), torch.cat(rem).numpy()


def move_kinds(state: np.ndarray, idx: np.ndarray):
    """方策の番号 → (駒を取る手, 玉の手, 打つ手) のフラグ"""
    to = idx % 81
    frm = idx // 162
    board = state[:81]
    turn = state[105]
    drop = frm >= 81
    tgt = board[to].astype(np.int64)
    capture = (~drop) & (tgt > 0) & (((tgt - 1) // 16) != turn)
    src = board[np.minimum(frm, 80)].astype(np.int64)
    king = (~drop) & (src > 0) & (((src - 1) % 8) == 7)
    return capture, king, drop


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pmix")
    ap.add_argument("--gen", type=int, default=21)
    ap.add_argument("--data-gens", type=int, nargs="+", default=[20, 21], help="調べる局面を取る自己対局の世代")
    ap.add_argument("--per-rule", type=int, default=20000, help="ルールごとに使う局面数")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    dev = torch.device("cuda")
    model = M.load(os.path.join(root, "models", f"gen{a.gen:04d}.pt"), dev).eval()
    d = D.merge([D.load_shard(os.path.join(root, "selfplay", f"gen{g:04d}.npz")) for g in a.data_gens])
    rng = np.random.default_rng(a.seed)
    true_rule = d["states"][:, 108]
    print(f"{a.run} 世代{a.gen} のネットで、自己対局（世代{a.data_gens}）の局面を調べる\n")

    # ── 1. 価値：実際のルール × 入れたルール ──
    print("■ 価値の当たり方（勝者を当てた割合 / 交差エントロピー）。行＝実際に指されたルール、列＝ネットに入れたルール")
    print("  " + " " * 10 + "".join(f"{RULES[r]:>16}" for r in range(3)))
    sel = {}
    for tr in range(3):
        ids = np.nonzero(true_rule == tr)[0]
        ids = rng.choice(ids, min(a.per_rule, len(ids)), replace=False)
        sel[tr] = ids
        cells = []
        for ir in range(3):
            v, _, _, _ = run_net(model, d["states"][ids], ir, dev)
            w = d["winner"][ids]
            acc = (v.argmax(1) == w).mean() * 100
            ce = -np.log(np.clip(v[np.arange(len(w)), w], 1e-6, 1)).mean()
            cells.append(f"{acc:6.1f}% / {ce:.3f}")
        print(f"  {RULES[tr]:<10}" + "".join(f"{c:>16}" for c in cells))

    # ── 2. 方策・補助：同じ局面にルールだけ変えて入れる ──
    print("\n■ 同じ局面でルールの入力だけ変えたとき（全力探索の局面。合法手の中での確率）")
    print("  入れたルール   取る手の確率  玉の手の確率  打つ手の確率  20手の駒損失予測(3人合計)  残り手数予測  最善手が全部持ち駒と同じ")
    full_ids = np.concatenate([sel[tr][d["full"][sel[tr]] == 1] for tr in range(3)])
    full_ids = full_ids[: 30000]
    st = d["states"][full_ids]
    offs = d["policy_offsets"]
    legal = [d["policy_index"][offs[j]:offs[j + 1]].astype(np.int64) for j in full_ids]
    kinds = [move_kinds(st[i], legal[i]) for i in range(len(full_ids))]
    best = {}
    for ir in range(3):
        _, pol, l20, rem = run_net(model, st, ir, dev)
        cap = kin = drp = 0.0
        bm = []
        for i in range(len(full_ids)):
            p = F.softmax(pol[i, legal[i]], dim=0).numpy()
            c, k, dr = kinds[i]
            cap += p[c].sum()
            kin += p[k].sum()
            drp += p[dr].sum()
            bm.append(legal[i][p.argmax()])
        n = len(full_ids)
        best[ir] = np.array(bm)
        same = (best[ir] == best[0]).mean() * 100
        print(f"  {RULES[ir]:<10}   {cap/n*100:10.1f}%  {kin/n*100:11.1f}%  {drp/n*100:11.1f}%  {l20.sum(1).mean():22.0f}  {rem.mean():12.1f}  {same:22.1f}%")

    # ── 3. 初期局面：ルールごとの席の勝率予想 ──
    first = np.nonzero(d["states"][:, 106].astype(np.int64) + d["states"][:, 107].astype(np.int64) * 256 == 0)[0][:1]
    if len(first):
        print("\n■ 初期局面の勝率予想（ルールごと）")
        for ir in range(3):
            v, _, _, rem = run_net(model, d["states"][first], ir, dev)
            print(f"  {RULES[ir]:<10} " + "  ".join(f"{SEAT[s]} {v[0, s]*100:.1f}%" for s in range(3)) + f"  残り手数予測 {rem[0]:.0f}")


if __name__ == "__main__":
    main()
