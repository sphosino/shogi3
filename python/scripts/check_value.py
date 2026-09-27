"""価値ヘッドの過学習チェック：学習に使ったデータと、使っていないデータ（新しいシャード）での損失・正解率を比べる
使い方: python check_value.py <run> <モデル世代> <シャード世代...>"""
import os, sys
import numpy as np, torch, torch.nn.functional as F
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D, model as M
from shogi3ml.features import planes, alive_mask
sys.stdout.reconfigure(encoding="utf-8")
run, g = sys.argv[1], int(sys.argv[2])
root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", run)
dev = torch.device("cuda")
net = M.load(os.path.join(root, "models", f"gen{g:04d}.pt"), dev).eval()
for sg in map(int, sys.argv[3:]):
    d = D.load_shard(os.path.join(root, "selfplay", f"gen{sg:04d}.npz"))
    n = len(d["winner"]); idx = np.random.default_rng(0).choice(n, min(n, 20000), replace=False)
    st = torch.from_numpy(d["states"][idx]).to(dev); w = torch.from_numpy(d["winner"][idx].astype(np.int64)).to(dev)
    with torch.inference_mode():
        out = net(planes(st), aux=False)
    v = out["value"].float().masked_fill(~alive_mask(st), -1e4)
    ply = (d["states"][idx, 106].astype(int) + d["states"][idx, 107].astype(int) * 256)
    acc = (v.argmax(1) == w).float().cpu().numpy()
    print(f"モデル世代{g} × シャード世代{sg}{'（学習済み）' if sg < g else '（未学習）'}: 価値損失 {F.cross_entropy(v, w).item():.3f} 正解率 {acc.mean()*100:.1f}%"
          f"  | 手数<60 {acc[ply<60].mean()*100:.1f}% 60-150 {acc[(ply>=60)&(ply<150)].mean()*100:.1f}% 150+ {acc[ply>=150].mean()*100:.1f}%")
