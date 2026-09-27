"""自己対局の速度計測：同時対局数ごとに、推論のまとめ数・1秒あたりの評価数・CPU(MCTS)/GPU(推論)の時間配分を測る。
使い方: python/.venv/Scripts/python.exe python/scripts/bench_selfplay.py [同時対局数...]"""
import os, sys, time
import numpy as np, torch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs
from shogi3ml import model as M
from shogi3ml.features import STATE_BYTES
from shogi3ml.selfplay import evaluate_batch

dev = torch.device("cuda")
net = M.Net().to(dev).eval()
for par in [int(x) for x in sys.argv[1:]] or [128, 512, 1024]:
    drv = shogi3_rs.Driver(parallel=par, total_games=par, seats=["net:0"] * 3, visits_full=600, visits_fast=100, full_prob=0.25)
    t_rust = t_gpu = 0.0; evals = 0; t0 = time.time(); nb = 0
    while time.time() - t0 < 15:
        a = time.time(); b = drv.next_batch(); t_rust += time.time() - a
        if b is None: break
        st_b, lg_b, L, _ = b
        a = time.time()
        st = torch.from_numpy(np.frombuffer(st_b, np.uint8).reshape(-1, STATE_BYTES).copy()).to(dev)
        lg = torch.from_numpy(np.frombuffer(lg_b, np.int32).reshape(-1, L).astype(np.int64)).to(dev)
        p, v = evaluate_batch(net, st, lg)
        pb, vb = p.cpu().numpy().tobytes(), v.cpu().numpy().tobytes()
        t_gpu += time.time() - a
        a = time.time(); drv.submit(pb, vb, L); t_rust += time.time() - a
        evals += st.shape[0]; nb += 1
    dt = time.time() - t0
    print(f"同時{par}局: {evals/dt:.0f}評価/秒  平均まとめ数{evals/max(nb,1):.0f}  Rust(MCTS) {t_rust/dt*100:.0f}%  推論 {t_gpu/dt*100:.0f}%", flush=True)
