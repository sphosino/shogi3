"""損失と学習ステップ（docs/training.md）。"""
import numpy as np
import torch
import torch.nn.functional as F

from .features import alive_mask, planes

# 損失の重み（docs/training.md の初期値）
WEIGHTS = dict(policy=1.0, value=1.5, rank=0.3, next_elim=0.2, loss20=0.2, final_mat=0.1, remaining=0.1, st=0.5)


def _masked_value_logits(logits, alive):
    return logits.float().masked_fill(~alive, -1e4)


def losses(model, b: dict) -> dict:
    st = b["states"]
    with torch.autocast("cuda", dtype=torch.float16, enabled=st.is_cuda):
        out = model(planes(st), aux=True)
    alive = alive_mask(st)
    L = {}
    # 方策：全力探索の局面だけ
    logp = F.log_softmax(out["policy"].float(), dim=1)
    pl = -(b["policy"] * logp).sum(dim=1)
    w = b["policy_w"]
    L["policy"] = (pl * w).sum() / w.sum().clamp(min=1.0)
    # 価値（勝者）
    vlog = _masked_value_logits(out["value"], alive)
    L["value"] = F.cross_entropy(vlog, b["winner"])
    # 順位（1..3 → 0..2）
    L["rank"] = F.cross_entropy(out["rank"].float().reshape(-1, 3), (b["rank"] - 1).clamp(0, 2).reshape(-1))
    L["next_elim"] = F.cross_entropy(out["next_elim"].float(), b["next_elim"])
    L["loss20"] = F.huber_loss(out["loss20"].float(), b["loss20"] / 1000.0)
    L["final_mat"] = F.huber_loss(out["final_mat"].float(), b["final_mat"] / 10000.0)
    L["remaining"] = F.huber_loss(out["remaining"].float().squeeze(1), torch.log1p(b["remaining"]))
    # 短期の価値（MCTS根の価値をソフトラベルに）
    st_l = 0
    for k in ("st6", "st16"):
        lp = F.log_softmax(_masked_value_logits(out[k], alive), dim=1)
        st_l = st_l + (-(b[k] * lp).sum(dim=1)).mean()
    L["st"] = st_l / 2
    L["total"] = sum(WEIGHTS[k] * L[k] for k in WEIGHTS)
    # 監視用：価値の正解率
    with torch.no_grad():
        L["value_acc"] = (vlog.argmax(1) == b["winner"]).float().mean()
    return L


def train_steps(model, opt, scaler, window, steps: int, batch: int, device, rng: np.random.Generator, log=None):
    model.train()
    hist = []
    for s in range(steps):
        idx = rng.integers(0, window.n, size=batch)
        b = window.batch(idx, device)
        L = losses(model, b)
        opt.zero_grad(set_to_none=True)
        scaler.scale(L["total"]).backward()
        scaler.step(opt)
        scaler.update()
        hist.append({k: float(v.detach()) for k, v in L.items()})
        if log and (s + 1) % 100 == 0:
            m = {k: np.mean([h[k] for h in hist[-100:]]) for k in hist[-1]}
            log(f"  step {s+1}/{steps} " + " ".join(f"{k}={v:.3f}" for k, v in m.items()))
    model.eval()
    return {k: float(np.mean([h[k] for h in hist])) for k in hist[-1]} if hist else {}
