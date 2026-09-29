"""自己対局 → 学習 → 評価 のループ（docs/training.md の同期版）。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/train_loop.py --run test1 --gens 6 --games-per-gen 500

runs/<run>/ に、学習データ（selfplay/）、モデル（models/）、評価結果（eval.jsonl）、ログ（log.txt）を置く。
途中で止めても、最後に保存した世代から再開する。
"""
import argparse
import glob
import json
import multiprocessing as mp
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
from shogi3ml.train import train_steps, value_check  # noqa: E402


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gens", type=int, default=10, help="この実行で進める世代数")
    p.add_argument("--games-per-gen", type=int, default=500)
    p.add_argument("--parallel", type=int, default=512, help="同時に進める対局数（推論のバッチの大きさ）")
    p.add_argument("--visits-full", type=int, default=600)
    p.add_argument("--visits-fast", type=int, default=100)
    p.add_argument("--full-prob", type=float, default=0.25)
    p.add_argument("--scaffold-games", type=int, default=2000, help="最初の世代（足場の評価器）の対局数")
    p.add_argument("--scaffold-procs", type=int, default=16)
    p.add_argument("--train-ratio", type=float, default=1.0, help="1世代の学習サンプル数 ÷ 新しく増えた局面数")
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--lr", type=float, default=0.02)
    p.add_argument("--lr-warm", type=float, default=None, help="最初の --lr-warm-gens 世代だけ使う低い学習率（蒸留直後のネットを崩さないため）")
    p.add_argument("--lr-warm-gens", type=int, default=0, help="この実行で低い学習率を使う世代数（世代番号 ≤ 蒸留の世代 + この数）")
    p.add_argument("--window", type=int, default=250_000, help="学習に使う直近の局面数")
    p.add_argument("--blocks", type=int, default=6)
    p.add_argument("--ch", type=int, default=96)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--q-mix", type=float, default=0.5, help="価値のターゲットに混ぜるMCTS根の価値の割合")
    p.add_argument("--eval-every", type=int, default=2)
    p.add_argument("--eval-games", type=int, default=60)
    p.add_argument("--eval-visits", type=int, default=200)
    p.add_argument("--eval-vs", nargs="+", default=["scaffold", "prev"],
                   help="評価の相手: scaffold（足場のMCTS）/ prev（eval_every世代前）/ gen:N（固定の世代）/ ext:実行名:N（別の実行のモデル）")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--rule", default="all", choices=["all", "next", "vanish", "mix"], help="取り駒のルール（all=全部持ち駒 / next=お裾分け / vanish=消滅あり / mix=3つを均等に混ぜる）")
    p.add_argument("--init", default=None, help="最初のモデルを別の実行から持ってくる（例 p5c:25）。足場の対局の代わりにこのモデルで自己対局を始める")
    return p.parse_args()


RULE_NAMES = ["all", "next", "vanish"]


def scaffold_worker(args):
    games, seed, visits_full, visits_fast, full_prob, *rest = args
    rule = rest[0] if rest else "all"
    d = shogi3_rs.Driver(parallel=games, total_games=games, seats=["net:0"] * 3, scaffold=True, seed=seed,
                         visits_full=visits_full, visits_fast=visits_fast, full_prob=full_prob, rule=rule)
    assert d.next_batch() is None  # 足場モードでは推論を求めずに全局終わる
    return d.take_finished()


def summarize_games(d: dict) -> dict:
    kinds = np.bincount(d["g_kind"], minlength=3)
    out = dict(games=int(len(d["g_winner"])), positions=int(len(d["winner"])), avg_plies=float(d["g_plies"].mean()),
               seat_wins=np.bincount(d["g_winner"], minlength=3).tolist(),
               end_last=int(kinds[0]), end_entry=int(kinds[1]), end_limit=int(kinds[2]),
               full_positions=int(d["full"].sum()))
    rules = d.get("g_rule")
    if rules is not None and len(np.unique(rules)) > 1:
        # ルールごと：[対局数, 平均手数, 最後の1人, 入玉, 500手]
        for r, name in enumerate(RULE_NAMES):
            m = rules == r
            if m.any():
                k = np.bincount(d["g_kind"][m], minlength=3)
                out[name] = [int(m.sum()), round(float(d["g_plies"][m].mean()), 1), int(k[0]), int(k[1]), int(k[2])]
    return out


def evaluate(models: dict, seats, games, visits, device, seed, rule="all"):
    """seats[0] が測る側（席は対局ごとに回す）。測る側の勝率を返す"""
    drv = shogi3_rs.Driver(parallel=games, total_games=games, seats=seats, rotate=True, record=False,
                           full_prob=1.0, visits_full=visits, dirichlet_total=0.0, temp_plies=8, seed=seed, rule=rule)
    stats = {}
    d = D.decode(run_driver(drv, models, device, stats))
    rot = d["g_id"] % 3  # 測る側の席 = 対局番号 % 3
    wins = int((d["g_winner"] == rot).sum())
    n = len(rot)
    p = wins / n
    z = (p - 1 / 3) / np.sqrt((1 / 3) * (2 / 3) / n)
    kinds = np.bincount(d["g_kind"], minlength=3)
    out = dict(seats=seats, games=n, wins=wins, rate=round(p * 100, 1), z=round(float(z), 2),
               avg_plies=float(d["g_plies"].mean()), end=kinds.tolist(), sec=round(stats.get("seconds", 0), 1))
    if rule == "mix":  # ルールごとの勝率
        out["by_rule"] = {name: round(float((d["g_winner"][d["g_rule"] == r] == rot[d["g_rule"] == r]).mean() * 100), 1)
                          for r, name in enumerate(RULE_NAMES) if (d["g_rule"] == r).any()}
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = parse()
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    for sub in ("models", "selfplay"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    logf = open(os.path.join(root, "log.txt"), "a", encoding="utf-8")

    def log(msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    with open(os.path.join(root, "config.json"), "w", encoding="utf-8") as f:
        json.dump(vars(a), f, ensure_ascii=False, indent=1)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    rng = np.random.default_rng(a.seed)
    shard_dir = os.path.join(root, "selfplay")
    model_path = lambda g: os.path.join(root, "models", f"gen{g:04d}.pt")

    # 別のルール・実行で学習したモデルから始める：それを世代1として保存し、その自己対局を最初のデータにする
    if a.init and not glob.glob(os.path.join(shard_dir, "*.npz")):
        run2, g2 = a.init.split(":")
        init_model = M.load(os.path.join(root, "..", run2, "models", f"gen{int(g2):04d}.pt"), device).eval()
        M.save(init_model, model_path(1), extra=dict(init=a.init))
        log(f"世代1: {run2} 世代{g2} のモデルから開始（ルール {a.rule}）。最初の自己対局 {a.games_per_gen} 局")
        t = time.time()
        drv = shogi3_rs.Driver(parallel=a.parallel, total_games=a.games_per_gen, seats=["net:0"] * 3,
                               visits_full=a.visits_full, visits_fast=a.visits_fast, full_prob=a.full_prob,
                               seed=a.seed * 100000 + 1, rule=a.rule)
        stats = {}
        d = D.decode(run_driver(drv, {0: init_model}, device, stats))
        D.save_shard(os.path.join(shard_dir, "gen0001.npz"), d)
        log(f"  自己対局 {time.time()-t:.0f}秒 推論 {stats['evals_per_sec']:.0f}局面/秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")

    # 世代0のデータ：足場の評価器（CPUのみ、複数プロセス）
    if not glob.glob(os.path.join(shard_dir, "*.npz")):
        log(f"世代0: 足場の評価器で {a.scaffold_games} 局（{a.scaffold_procs} プロセス）")
        t = time.time()
        per = [a.scaffold_games // a.scaffold_procs + (1 if i < a.scaffold_games % a.scaffold_procs else 0) for i in range(a.scaffold_procs)]
        with mp.Pool(a.scaffold_procs) as pool:
            parts = pool.map(scaffold_worker, [(n, a.seed * 1000 + i, a.visits_full, a.visits_fast, a.full_prob, a.rule) for i, n in enumerate(per) if n > 0])
        d = D.merge([D.decode(x) for x in parts])
        D.save_shard(os.path.join(shard_dir, "gen0000.npz"), d)
        log(f"  完了 {time.time()-t:.0f}秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")

    # モデル：最後に保存した世代から再開
    saved = sorted(glob.glob(os.path.join(root, "models", "gen*.pt")))
    if saved:
        gen = int(os.path.basename(saved[-1])[3:7])
        model = M.load(saved[-1], device)
        log(f"世代{gen} のモデルから再開")
    else:
        gen = 0
        model = M.Net(blocks=a.blocks, ch=a.ch).to(device)
        M.save(model, model_path(0))
    model.eval()
    opt = torch.optim.SGD(model.parameters(), lr=a.lr, momentum=0.9, weight_decay=a.weight_decay, nesterov=True)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    for _ in range(a.gens):
        # 学習率：蒸留直後の数世代は低く（--lr-warm）
        warm = a.lr_warm is not None and gen < a.lr_warm_gens + 1
        for g_ in opt.param_groups:
            g_["lr"] = a.lr_warm if warm else a.lr
        # 学習：ステップ数は、直近のシャード（新しく増えた局面）の数 × train_ratio ÷ バッチ
        t = time.time()
        win = D.Window(shard_dir, a.window)
        newest = max(glob.glob(os.path.join(shard_dir, "*.npz")), key=os.path.getmtime)
        new_pos = len(D.load_shard(newest)["winner"])
        steps = max(1, int(np.ceil(new_pos * a.train_ratio / a.batch)))
        L = train_steps(model, opt, scaler, win, steps, a.batch, device, rng, q_mix=a.q_mix)
        gen += 1
        M.save(model, model_path(gen), extra=dict(train=L))
        log(f"世代{gen}: 学習 {steps}ステップ lr={opt.param_groups[0]['lr']}（新規 {new_pos}局面、窓 {win.n}局面/{win.files}シャード）{time.time()-t:.0f}秒 "
            + " ".join(f"{k}={v:.3f}" for k, v in L.items()))

        # 自己対局
        t = time.time()
        drv = shogi3_rs.Driver(parallel=a.parallel, total_games=a.games_per_gen, seats=["net:0"] * 3,
                               visits_full=a.visits_full, visits_fast=a.visits_fast, full_prob=a.full_prob,
                               seed=a.seed * 100000 + gen, rule=a.rule)
        stats = {}
        d = D.decode(run_driver(drv, {0: model}, device, stats))
        D.save_shard(os.path.join(shard_dir, f"gen{gen:04d}.npz"), d)
        log(f"  自己対局 {time.time()-t:.0f}秒 推論 {stats['evals_per_sec']:.0f}局面/秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")
        # 過学習の監視：まだ学習に使っていない、今の自己対局のデータで価値を測る
        vc = value_check(model, d, device)
        log(f"  価値（未学習データ）: 損失 {vc['loss']:.3f} 正解率 {vc['acc']*100:.1f}%（60手未満 {vc['acc_early']*100:.1f}%）")
        with open(os.path.join(root, "value_check.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(dict(gen=gen, train=L, heldout=vc), ensure_ascii=False) + chr(10))

        # 評価（相手は --eval-vs。固定の相手にすると世代ごとの推移が比べやすい）
        if gen % a.eval_every == 0:
            for opp in a.eval_vs:
                if opp == "scaffold":
                    r = evaluate({0: model}, ["net:0", f"scaffold:{a.eval_visits}", f"scaffold:{a.eval_visits}"],
                                 a.eval_games, a.eval_visits, device, 7 + gen, a.rule)
                    name = f"scaffold:{a.eval_visits}"
                elif opp.startswith("ext:"):  # 別の実行のモデル（例 ext:p4:51）
                    _, run2, g2 = opp.split(":")
                    other = M.load(os.path.join(root, "..", run2, "models", f"gen{int(g2):04d}.pt"), device).eval()
                    r = evaluate({0: model, 1: other}, ["net:0", "net:1", "net:1"], a.eval_games, a.eval_visits, device, 11 + gen, a.rule)
                    name = f"{run2}:gen{int(g2)}"
                else:
                    og = max(0, gen - a.eval_every) if opp == "prev" else int(opp.split(":")[1])
                    other = M.load(model_path(og), device).eval()
                    r = evaluate({0: model, 1: other}, ["net:0", "net:1", "net:1"], a.eval_games, a.eval_visits, device, 11 + gen, a.rule)
                    name = f"gen{og}"
                r.update(gen=gen, opponent=name)
                log(f"  評価 世代{gen} vs {name}×2: {r['wins']}/{r['games']} = {r['rate']}% (z={r['z']}) 平均{r['avg_plies']:.0f}手 {r['sec']}秒"
                    + (f" ルール別 {r['by_rule']}" if "by_rule" in r else ""))
                with open(os.path.join(root, "eval.jsonl"), "a", encoding="utf-8") as f:
                    f.write(json.dumps(r, ensure_ascii=False) + chr(10))
    log("終了")


if __name__ == "__main__":
    main()
