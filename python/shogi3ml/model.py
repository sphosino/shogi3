"""ネット本体（docs/ai_architecture.md）。

残差ネット＋グローバルプーリングのブロック（KataGo 式）。出力：
  policy       : [N, 14256] 手番の人の方策のロジット（(移動元*2+成り)*81+移動先）
  value        : [N, 3]     勝者（P0/P1/P2）のロジット
  補助         : rank [N,3,3] / next_elim [N,4] / loss20 [N,3] / final_mat [N,3] / remaining [N,1] / st6 [N,3] / st16 [N,3]
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

from .features import IN_CHANNELS, NUM_POLICY


def gpool(x):
    """盤全体の平均と最大 [N,C,9,9] → [N,2C]（ONNX に書き出すときは export_onnx.py が差し替える）"""
    return torch.cat([x.mean(dim=(2, 3)), x.amax(dim=(2, 3))], dim=1)


class ResBlock(nn.Module):
    def __init__(self, ch: int):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class GlobalPoolBlock(nn.Module):
    """KataGo のグローバルプーリング：一部のチャンネルの平均・最大から、残りのチャンネルへのバイアスを作る"""

    def __init__(self, ch: int, gp_ch: int = 32):
        super().__init__()
        self.gp_ch = gp_ch
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch - gp_ch)
        self.bg = nn.BatchNorm2d(gp_ch)
        self.fc = nn.Linear(gp_ch * 2, ch - gp_ch)
        self.c2 = nn.Conv2d(ch - gp_ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = self.c1(x)
        reg, g = y[:, : -self.gp_ch], y[:, -self.gp_ch :]
        g = F.relu(self.bg(g))
        pooled = gpool(g)
        reg = F.relu(self.b1(reg) + self.fc(pooled)[:, :, None, None])
        y = self.b2(self.c2(reg))
        return F.relu(x + y)


class Net(nn.Module):
    def __init__(self, blocks: int = 6, ch: int = 96, gp_blocks=None):
        super().__init__()
        if gp_blocks is None:
            # グローバルプーリングのブロックは全体の1/3と2/3の位置（6ブロックなら2と4）
            gp_blocks = (blocks // 3, 2 * blocks // 3)
        self.config = dict(blocks=blocks, ch=ch, gp_blocks=tuple(gp_blocks))
        self.stem = nn.Sequential(nn.Conv2d(IN_CHANNELS, ch, 3, padding=1, bias=False), nn.BatchNorm2d(ch), nn.ReLU())
        self.trunk = nn.ModuleList([GlobalPoolBlock(ch) if i in gp_blocks else ResBlock(ch) for i in range(blocks)])
        # 方策：176チャンネル × 81マス = 14256
        self.p1 = nn.Sequential(nn.Conv2d(ch, 48, 1, bias=False), nn.BatchNorm2d(48), nn.ReLU())
        self.p2 = nn.Conv2d(48, 176, 1)
        # 価値・補助
        self.v1 = nn.Sequential(nn.Conv2d(ch, 32, 1, bias=False), nn.BatchNorm2d(32), nn.ReLU())
        self.vfc = nn.Sequential(nn.Linear(64, 256), nn.ReLU())
        self.value = nn.Linear(256, 3)
        self.rank = nn.Linear(256, 9)
        self.next_elim = nn.Linear(256, 4)
        self.loss20 = nn.Linear(256, 3)
        self.final_mat = nn.Linear(256, 3)
        self.remaining = nn.Linear(256, 1)
        self.st6 = nn.Linear(256, 3)
        self.st16 = nn.Linear(256, 3)

    def trunk_forward(self, x):
        x = self.stem(x)
        for b in self.trunk:
            x = b(x)
        return x

    def forward(self, x, aux: bool = True):
        h = self.trunk_forward(x)
        policy = self.p2(self.p1(h)).flatten(1)
        v = self.v1(h)
        v = self.vfc(gpool(v))
        out = {"policy": policy, "value": self.value(v)}
        if aux:
            out.update(
                rank=self.rank(v).view(-1, 3, 3),
                next_elim=self.next_elim(v),
                loss20=self.loss20(v),
                final_mat=self.final_mat(v),
                remaining=self.remaining(v),
                st6=self.st6(v),
                st16=self.st16(v),
            )
        return out


def save(model: Net, path, extra=None):
    torch.save({"config": model.config, "state": model.state_dict(), "extra": extra or {}}, path)


def load(path, device="cpu") -> Net:
    ck = torch.load(path, map_location=device, weights_only=False)
    m = Net(**ck["config"])
    st = ck["state"]
    # 入力チャンネルが少ない古いモデル（ルールの入力がない76チャンネル）：足りない分の重みを0で足す。出力は元と同じになる
    w = st["stem.0.weight"]
    if w.shape[1] < IN_CHANNELS:
        st["stem.0.weight"] = torch.cat([w, w.new_zeros(w.shape[0], IN_CHANNELS - w.shape[1], *w.shape[2:])], dim=1)
    m.load_state_dict(st)
    return m.to(device)
