"""損失と学習ステップ（docs/training.md）。"""
import numpy as np
import torch
import torch.nn.functional as F

from .features import alive_mask, planes

# 損失の重み（docs/training.md の初期値）
WEIGHTS = dict(policy=1.0, value=1.5, rank=0.3, next_elim=0.2, loss20=0.2, final_mat=0.1, remaining=0.1, st=0.5)


def _masked_value_logits(logits, alive):
    return logits.float().masked_fill(~alive, -1e4)


def losses(model, b: dict, q_mix: float = 0.5) -> dict:
    """q_mix: 価値のターゲットに混ぜる MCTS 根の価値の割合（0 なら勝者のみ）。
    三人では序盤の勝敗の雑音が大きく、勝者だけだと対局ごとの暗記（過学習）が起きたため混ぜる。"""
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
    # 価値：勝者の one-hot と MCTS 根の価値を混ぜたソフトラベル
    vlog = _masked_value_logits(out["value"], alive)
    target = (1 - q_mix) * F.one_hot(b["winner"], 3).float() + q_mix * b["root_value"]
    L["value"] = -(target * F.log_softmax(vlog, dim=1)).sum(dim=1).mean()
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


def teacher_losses(model, teacher, b: dict, v_mix: float = 0.5) -> dict:
    """先生ネットの出力を教師にした蒸留（大きいネットへ移すとき）。
    実際の勝敗は使わないので、対局の結果を丸暗記する過学習が起きない。
    方策：全力探索の局面は訪問数、それ以外は先生の方策。価値：先生の価値と MCTS 根の価値を v_mix で混ぜる。"""
    st = b["states"]
    alive = alive_mask(st)
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16, enabled=st.is_cuda):
        t = teacher(planes(st), aux=True)
    with torch.autocast("cuda", dtype=torch.float16, enabled=st.is_cuda):
        out = model(planes(st), aux=True)
    soft = lambda x: F.softmax(x.float(), dim=-1)
    ce = lambda target, logits: -(target * F.log_softmax(logits.float(), dim=-1)).sum(dim=-1).mean()
    L = {}
    full = b["policy_w"][:, None]
    L["policy"] = ce(full * b["policy"] + (1 - full) * soft(t["policy"]), out["policy"])
    tv = soft(_masked_value_logits(t["value"], alive))
    vlog = _masked_value_logits(out["value"], alive)
    L["value"] = ce((1 - v_mix) * tv + v_mix * b["root_value"], vlog)
    L["rank"] = ce(soft(t["rank"]), out["rank"])
    L["next_elim"] = ce(soft(t["next_elim"]), out["next_elim"])
    for k in ("loss20", "final_mat", "remaining"):
        L[k] = F.huber_loss(out[k].float(), t[k].float())
    L["st"] = sum(ce(soft(_masked_value_logits(t[k], alive)), _masked_value_logits(out[k], alive)) for k in ("st6", "st16")) / 2
    L["total"] = sum(WEIGHTS[k] * L[k] for k in WEIGHTS)
    with torch.no_grad():
        L["value_acc"] = (vlog.argmax(1) == b["winner"]).float().mean()
        L["agree"] = (out["policy"].argmax(1) == t["policy"].argmax(1)).float().mean()  # 先生と最善手が一致する割合
    return L


def train_steps(model, opt, scaler, window, steps: int, batch: int, device, rng: np.random.Generator, log=None, q_mix: float = 0.5):
    model.train()
    hist = []
    for s in range(steps):
        idx = rng.integers(0, window.n, size=batch)
        b = window.batch(idx, device)
        L = losses(model, b, q_mix)
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


@torch.inference_mode()
def value_check(model, data: dict, device, n: int = 20000, seed: int = 0) -> dict:
    """学習に使っていないデータでの価値の損失（勝者に対する交差エントロピー）と正解率。過学習の監視用"""
    N = len(data["winner"])
    idx = np.random.default_rng(seed).choice(N, min(N, n), replace=False)
    st = torch.from_numpy(data["states"][idx]).to(device)
    w = torch.from_numpy(data["winner"][idx].astype(np.int64)).to(device)
    model.eval()
    with torch.autocast("cuda", dtype=torch.float16, enabled=st.is_cuda):
        out = model(planes(st), aux=False)
    v = _masked_value_logits(out["value"], alive_mask(st))
    ply = data["states"][idx, 106].astype(int) + data["states"][idx, 107].astype(int) * 256
    acc = (v.argmax(1) == w).float().cpu().numpy()
    early = ply < 60
    return dict(loss=float(F.cross_entropy(v, w)), acc=float(acc.mean()),
                acc_early=float(acc[early].mean()) if early.any() else float("nan"))
