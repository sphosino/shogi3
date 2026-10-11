"""相手2人が「同じモデル」か「違うモデル」かで、1体の勝率が変わるかを調べる。

測る側1体 vs 相手2体を3通り：A×2 / B×2 / A＋B。
A×2 と B×2 の勝率から A・B の強さ（測る側との比）を出し、「強さだけで決まるなら」A＋B のときの勝率を予測して、実際と比べる。
強さの比は、3人の勝ち確率がそれぞれの強さに比例するとみなす（Luce の選択モデル。docs/results.md の成長曲線と同じ）。
実際が予測より高ければ、「同じ考え方の2人のほうが手強い」。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/eval_mixed.py --me pbig2:181 --a pbig2:1 --b pmix:81 --games 300
"""
import argparse
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import model as M  # noqa: E402
from train_loop import evaluate  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def load(spec, device):
    run, g = spec.split(":")
    return M.load(os.path.join(ROOT, "runs", run, "models", f"gen{int(g):04d}.pt"), device).eval()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--me", required=True)
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--visits", type=int, default=200)
    ap.add_argument("--rule", default="mix")
    a = ap.parse_args()
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    models = {0: load(a.me, dev), 1: load(a.a, dev), 2: load(a.b, dev)}
    res = {}
    for name, seats in ((f"{a.a}×2", ["net:0", "net:1", "net:1"]), (f"{a.b}×2", ["net:0", "net:2", "net:2"])):
        r = evaluate(models, seats, a.games, a.visits, dev, 7, a.rule)
        res[name] = r
        print(f"{a.me} vs {name}: {r['wins']}/{r['games']} = {r['rate']}%", flush=True)
    # A＋B：相手2人の並び（どちらが先に指すか）で偏らないよう、半分ずつ入れ替える
    r1 = evaluate(models, ["net:0", "net:1", "net:2"], a.games // 2, a.visits, dev, 8, a.rule)
    r2 = evaluate(models, ["net:0", "net:2", "net:1"], a.games - a.games // 2, a.visits, dev, 9, a.rule)
    wins, n = r1["wins"] + r2["wins"], r1["games"] + r2["games"]
    p_mix = wins / n
    print(f"{a.me} vs {a.a}＋{a.b}: {wins}/{n} = {p_mix*100:.1f}%", flush=True)

    # Luce：p = s0 / (s0 + s1 + s2)。s0 = 1 として、同じモデル2体の結果から s を出す
    pa, pb = res[f"{a.a}×2"]["wins"] / res[f"{a.a}×2"]["games"], res[f"{a.b}×2"]["wins"] / res[f"{a.b}×2"]["games"]
    sa, sb = (1 - pa) / (2 * pa), (1 - pb) / (2 * pb)
    pred = 1 / (1 + sa + sb)
    se = np.sqrt(p_mix * (1 - p_mix) / n)
    print(f"強さ（{a.me}＝1）: {a.a} {sa:.3f}、{a.b} {sb:.3f}")
    print(f"{a.a}＋{a.b} の予測 {pred*100:.1f}% / 実際 {p_mix*100:.1f}%（差 {(p_mix-pred)*100:+.1f}、誤差の目安 ±{1.96*se*100:.1f}）")


if __name__ == "__main__":
    main()
