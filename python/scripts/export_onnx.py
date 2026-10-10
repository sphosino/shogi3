"""学習したネットを ONNX に書き出す（ブラウザの ONNX Runtime Web で動かすため）。

入力は局面そのもの（109バイトを float32 にした [N,109]、self_play.md の形）。入力チャンネルへの展開（features.planes）もグラフに含めるので、
ブラウザ側は 109 バイトを渡すだけでよい。出力は policy [N,14256] と value [N,3] のロジット（補助ヘッドは含めない）。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/export_onnx.py --run pbig2 --gen 101 --out web/models/pbig2-gen101.onnx
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
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.features import STATE_BYTES, planes  # noqa: E402


_HAND_MAX21 = torch.tensor([15, 3, 3, 6, 6, 3, 3] * 3, dtype=torch.float32)


def planes_onnx(states):
    """features.planes と同じ結果を、比較・掛け算・連結だけで作る（OneHot / Expand を使わない。WebGPU でも素直に動く演算にしておく）"""
    s = states.float()
    board = s[:, :81].unsqueeze(1)                                            # [N,1,81]
    codes = torch.arange(1, 49, dtype=torch.float32).view(1, 48, 1)
    pb = (board == codes).float().reshape(-1, 48, 9, 9)                       # 駒 48
    hands = s[:, 81:102] / _HAND_MAX21                                        # 持ち駒 21
    elim = s[:, 102:105]                                                      # 脱落 3
    three = torch.arange(3, dtype=torch.float32).view(1, 3)
    turn = (s[:, 105:106] == three).float()                                   # 手番 3
    ply = (s[:, 106:107] + s[:, 107:108] * 256.0) / 500.0                     # 手数 1
    rule = (s[:, 108:109] == three).float()                                   # ルール 3
    glob = torch.cat([hands, elim, turn, ply, rule], dim=1)                   # [N,31]
    return torch.cat([pb, glob.unsqueeze(2).unsqueeze(3) * torch.ones(1, 1, 9, 9)], dim=1)


def gpool_onnx(x):
    """model.gpool と同じ値を、GlobalAveragePool / GlobalMaxPool で作る（WebGPU でも素直に動く演算にしておく）"""
    return torch.cat([F.adaptive_avg_pool2d(x, 1).flatten(1), F.adaptive_max_pool2d(x, 1).flatten(1)], dim=1)


class StateNet(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, states):
        out = self.net(planes_onnx(states), aux=False)
        return out["policy"], out["value"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run")
    ap.add_argument("--gen", type=int)
    ap.add_argument("--model", default=None, help="モデルのファイルを直接指定（--run/--gen の代わり）")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    path = a.model or os.path.join(ROOT, "runs", a.run, "models", f"gen{a.gen:04d}.pt")
    net = M.load(path, "cpu").eval()
    M.gpool = gpool_onnx  # 書き出し用の演算に差し替え（値は同じ）
    wrapped = StateNet(net).eval()
    # 実際の局面で書き出し・照合する
    d = D.load_shard(os.path.join(ROOT, "runs", "pbig2", "selfplay", "gen0101.npz"))
    # 入力は float32。ONNX Runtime Web 1.20.1 で uint8 入力にしていたとき、WebGPU で2局面以上まとめて推論すると2つ目以降が壊れた。
    # 1.30.0 ＋ float32 入力で直ったことを確かめた（どちらが効いたかは切り分けていない）
    sample = torch.from_numpy(d["states"][:16].astype(np.float32))
    many =torch.from_numpy(d["states"][::50].copy())
    assert torch.equal(planes_onnx(many), planes(many)), "planes_onnx が features.planes と一致しない"
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    torch.onnx.export(wrapped, (sample,), a.out, input_names=["states"], output_names=["policy", "value"],
                      dynamic_axes={"states": {0: "batch"}, "policy": {0: "batch"}, "value": {0: "batch"}},
                      opset_version=17, dynamo=False)
    import onnxruntime as ort
    sess = ort.InferenceSession(a.out, providers=["CPUExecutionProvider"])
    with torch.no_grad():
        tp, tv = wrapped(sample)
    op, ov = sess.run(None, {"states": sample.numpy()})
    print(f"{a.out}: {os.path.getsize(a.out)/1e6:.1f}MB  PyTorch との差 policy {np.abs(op - tp.numpy()).max():.2e} value {np.abs(ov - tv.numpy()).max():.2e}")
    for b in (1, 16):
        x = d["states"][:b].astype(np.float32)
        sess.run(None, {"states": x})
        t = time.time()
        for _ in range(20):
            sess.run(None, {"states": x})
        print(f"  CPU（onnxruntime）でバッチ{b}: {(time.time()-t)/20*1000:.1f}ms/回")
    assert STATE_BYTES == 109


if __name__ == "__main__":
    main()
