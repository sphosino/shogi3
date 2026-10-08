"""学習したネットを ONNX に書き出す（ブラウザの ONNX Runtime Web で動かすため）。

入力は局面そのもの（uint8 [N,109]、self_play.md の形）。入力チャンネルへの展開（features.planes）もグラフに含めるので、
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

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.features import STATE_BYTES, planes  # noqa: E402


class StateNet(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, states):
        out = self.net(planes(states), aux=False)
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
    wrapped = StateNet(net).eval()
    # 実際の局面で書き出し・照合する
    d = D.load_shard(os.path.join(ROOT, "runs", "pbig2", "selfplay", "gen0101.npz"))
    sample = torch.from_numpy(d["states"][:16].copy())
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
        x = d["states"][:b].copy()
        sess.run(None, {"states": x})
        t = time.time()
        for _ in range(20):
            sess.run(None, {"states": x})
        print(f"  CPU（onnxruntime）でバッチ{b}: {(time.time()-t)/20*1000:.1f}ms/回")
    assert STATE_BYTES == 109


if __name__ == "__main__":
    main()
