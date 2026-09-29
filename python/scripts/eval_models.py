"""保存したモデルの評価対局（1席 vs 2席、席は毎局入れ替え）。docs/evaluation.md

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/eval_models.py --run p4 --gen 11 --vs scaffold:200 gen:1
相手: scaffold:訪問数 / greedy / random / gen:世代 / ext:実行名:世代（別の実行のモデル）
"""
import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from shogi3ml import model as M  # noqa: E402
from train_loop import evaluate  # noqa: E402


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gen", type=int, required=True)
    p.add_argument("--vs", nargs="+", required=True)
    p.add_argument("--games", type=int, default=60)
    p.add_argument("--visits", type=int, default=200)
    p.add_argument("--seed", type=int, default=101)
    a = p.parse_args()
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    dev = torch.device("cuda")
    load = lambda g: M.load(os.path.join(root, "models", f"gen{g:04d}.pt"), dev).eval()
    me = load(a.gen)
    for opp in a.vs:
        if opp.startswith("gen:"):
            r = evaluate({0: me, 1: load(int(opp[4:]))}, ["net:0", "net:1", "net:1"], a.games, a.visits, dev, a.seed)
        elif opp.startswith("ext:"):  # 別の実行のモデル（例 ext:p4:51）
            _, run2, g2 = opp.split(":")
            other = M.load(os.path.join(root, "..", run2, "models", f"gen{int(g2):04d}.pt"), dev).eval()
            r = evaluate({0: me, 1: other}, ["net:0", "net:1", "net:1"], a.games, a.visits, dev, a.seed)
        else:
            r = evaluate({0: me}, ["net:0", opp, opp], a.games, a.visits, dev, a.seed)
        r.update(gen=a.gen, opponent=opp)
        print(f"世代{a.gen} vs {opp}×2: {r['wins']}/{r['games']} = {r['rate']}% (z={r['z']}) 平均{r['avg_plies']:.0f}手 終局{r['end']} {r['sec']}秒", flush=True)
        with open(os.path.join(root, "eval_extra.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(r, ensure_ascii=False) + chr(10))


if __name__ == "__main__":
    main()
