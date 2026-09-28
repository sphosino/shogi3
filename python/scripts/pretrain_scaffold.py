"""足場の評価器（駒価値MCTS）の対局から、ネットを教師あり学習で底上げする（蒸留）。

自己対局の強化学習だけでは、数千局ではネットが足場のMCTSに追いつかなかったため（docs/training.md）、
足場で大量の対局を作ってネットに真似させてから、強化学習を始める。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/pretrain_scaffold.py --run p4 --games 30000 --epochs 2
大きいネットへの蒸留（別の実行の自己対局データを使う）:
  python/.venv/Scripts/python.exe python/scripts/pretrain_scaffold.py --run p5 --blocks 10 --ch 128 --from-run p4 --from-gens 41-51 --eval-vs ext:p4:51
出力: runs/<run>/selfplay/scaffold_XX.npz（足場の対局）、runs/<run>/models/gen0001.pt（学習済み）
続けて train_loop.py --run <run> で強化学習を再開できる。
"""
import argparse
import glob
import json
import math
import multiprocessing as mp
import os
import shutil
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.train import losses, value_check  # noqa: E402
from train_loop import evaluate, scaffold_worker, summarize_games  # noqa: E402


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--games", type=int, default=30000)
    p.add_argument("--procs", type=int, default=16)
    p.add_argument("--chunk", type=int, default=2000, help="1シャードあたりの対局数")
    p.add_argument("--visits-full", type=int, default=600)
    p.add_argument("--visits-fast", type=int, default=100)
    p.add_argument("--full-prob", type=float, default=0.25)
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--lr", type=float, default=0.02)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--q-mix", type=float, default=0.5)
    p.add_argument("--blocks", type=int, default=6)
    p.add_argument("--ch", type=int, default=96)
    p.add_argument("--val-frac", type=float, default=0.05)
    p.add_argument("--eval-games", type=int, default=60)
    p.add_argument("--eval-visits", type=int, default=200)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--from-run", default=None, help="足場の対局を作らず、この実行の自己対局データ（gen*.npz）から学ぶ")
    p.add_argument("--from-gens", default=None, help="--from-run で使う世代の範囲（例 41-51）")
    p.add_argument("--eval-vs", default=None, help="最後の評価の相手（例 ext:p4:51）。省略時は足場のMCTS")
    return p.parse_args()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = parse()
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    shard_dir = os.path.join(root, "selfplay")
    for sub in ("models", "selfplay"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    logf = open(os.path.join(root, "log.txt"), "a", encoding="utf-8")

    def log(msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    with open(os.path.join(root, "pretrain_config.json"), "w", encoding="utf-8") as f:
        json.dump(vars(a), f, ensure_ascii=False, indent=1)
    device = torch.device("cuda")

    # 1. 学習データ：別の実行の自己対局データを写す（大きいネットへの蒸留）か、足場の対局を作る
    if a.from_run:
        lo, hi = (int(x) for x in a.from_gens.split("-"))
        src = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.from_run, "selfplay")
        for g in range(lo, hi + 1):
            dst = os.path.join(shard_dir, f"gen{g:04d}.npz")
            if not os.path.exists(dst):
                shutil.copy2(os.path.join(src, f"gen{g:04d}.npz"), dst)  # 更新時刻も写す（学習ループが新しい順に使う）
        pattern = "gen*.npz"
        log(f"{a.from_run} の世代{lo}〜{hi}の自己対局データから学ぶ")
    else:
        pattern = "scaffold_*.npz"
    have = len(glob.glob(os.path.join(shard_dir, "scaffold_*.npz")))
    n_chunks = 0 if a.from_run else math.ceil(a.games / a.chunk)
    for c in range(have, n_chunks):
        t = time.time()
        games = min(a.chunk, a.games - c * a.chunk)
        per = [games // a.procs + (1 if i < games % a.procs else 0) for i in range(a.procs)]
        with mp.Pool(a.procs) as pool:
            parts = pool.map(scaffold_worker, [(n, a.seed * 100000 + c * 100 + i, a.visits_full, a.visits_fast, a.full_prob)
                                               for i, n in enumerate(per) if n > 0])
        decoded = []
        for j, x in enumerate(parts):
            dj = D.decode(x)
            # プロセスごとに対局IDが0から振られるので、プロセス番号でずらして一意にする（検証用の分割に使う）
            dj["game_id"] = dj["game_id"].astype(np.uint32) + np.uint32(j * 10000)
            decoded.append(dj)
        d = D.merge(decoded)
        D.save_shard(os.path.join(shard_dir, f"scaffold_{c:02d}.npz"), d)
        log(f"足場の対局 {c+1}/{n_chunks}: {time.time()-t:.0f}秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")

    # 2. 読み込み、対局単位で検証用を分ける
    files = sorted(glob.glob(os.path.join(shard_dir, pattern)))
    parts = []
    for i, f in enumerate(files):
        d = D.load_shard(f)
        d["game_id"] = (d["game_id"].astype(np.uint64) + np.uint64(i) * np.uint64(1_000_000)).astype(np.uint32)
        parts.append(d)
    win = D.Window.__new__(D.Window)
    win.d = D.merge(parts)
    win.n = len(win.d["winner"])
    win.files = len(files)
    rng = np.random.default_rng(a.seed)
    gids = np.unique(win.d["game_id"])
    val_g = set(rng.choice(gids, int(len(gids) * a.val_frac), replace=False).tolist())
    is_val = np.isin(win.d["game_id"], np.array(sorted(val_g), dtype=np.uint32))
    tr_idx, va_idx = np.nonzero(~is_val)[0], np.nonzero(is_val)[0]
    val = {k: v[va_idx] for k, v in win.d.items() if k in ("states", "winner")}
    log(f"学習データ {len(tr_idx)}局面 / 検証 {len(va_idx)}局面（{len(val_g)}局）")

    # 3. 学習
    model = M.Net(blocks=a.blocks, ch=a.ch).to(device)
    opt = torch.optim.SGD(model.parameters(), lr=a.lr, momentum=0.9, weight_decay=a.weight_decay, nesterov=True)
    scaler = torch.amp.GradScaler("cuda")
    total = int(len(tr_idx) * a.epochs / a.batch)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(s, total) / total)))
    check_every = max(1, total // (int(a.epochs * 2) or 1))
    hist = []
    t = time.time()
    model.train()
    for s in range(total):
        idx = tr_idx[rng.integers(0, len(tr_idx), size=a.batch)]
        L = losses(model, win.batch(idx, device), a.q_mix)
        opt.zero_grad(set_to_none=True)
        scaler.scale(L["total"]).backward()
        scaler.step(opt)
        scaler.update()
        sched.step()
        hist.append({k: float(v.detach()) for k, v in L.items()})
        if (s + 1) % check_every == 0 or s + 1 == total:
            m = {k: np.mean([h[k] for h in hist[-check_every:]]) for k in hist[-1]}
            vc = value_check(model, val, device)
            model.train()
            log(f"  {s+1}/{total}ステップ {time.time()-t:.0f}秒 学習: policy={m['policy']:.3f} value={m['value']:.3f} value_acc={m['value_acc']*100:.1f}% "
                f"| 検証: 価値損失 {vc['loss']:.3f} 正解率 {vc['acc']*100:.1f}%（60手未満 {vc['acc_early']*100:.1f}%）")
    model.eval()
    M.save(model, os.path.join(root, "models", "gen0000.pt"))
    M.save(model, os.path.join(root, "models", "gen0001.pt"), extra=dict(pretrain=True))

    # 4. 評価（足場のMCTS、または別の実行のモデル）
    if a.eval_vs and a.eval_vs.startswith("ext:"):
        _, run2, g2 = a.eval_vs.split(":")
        other = M.load(os.path.join(os.path.dirname(__file__), "..", "..", "runs", run2, "models", f"gen{int(g2):04d}.pt"), device).eval()
        r = evaluate({0: model, 1: other}, ["net:0", "net:1", "net:1"], a.eval_games, a.eval_visits, device, 3)
        name = a.eval_vs
    else:
        r = evaluate({0: model}, ["net:0", f"scaffold:{a.eval_visits}", f"scaffold:{a.eval_visits}"], a.eval_games, a.eval_visits, device, 3)
        name = f"scaffold:{a.eval_visits}"
    log(f"評価 net vs {name}×2: {r['wins']}/{r['games']} = {r['rate']}% (z={r['z']}) 平均{r['avg_plies']:.0f}手 {r['sec']}秒")
    r.update(gen=1, opponent=name)
    with open(os.path.join(root, "eval.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(r, ensure_ascii=False) + chr(10))


if __name__ == "__main__":
    main()
