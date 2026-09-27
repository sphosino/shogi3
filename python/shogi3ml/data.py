"""学習データのシャード（1回の自己対局の出力）の保存・読み込みと、バッチの作成。

シャードは npz。1局面1行（docs/self_play.md の学習データ）：
  states [N,108] u8 / policy_offsets [N+1] i64 / policy_index [M] i32 / policy_visits [M] u32 / full [N] u8
  winner [N] u8 / rank [N,3] u8 / next_elim [N] u8 / root_value [N,3] / loss20 [N,3] / final_material [N,3]
  st6 [N,3] / st16 [N,3] / remaining [N] u16 / game_id [N] u32
対局の要約（g_*）も同じファイルに入れる（分析用）。
"""
import glob
import os

import numpy as np
import torch

from .features import NUM_POLICY, STATE_BYTES

_DTYPES = {
    "states": (np.uint8, (-1, STATE_BYTES)),
    "policy_offsets": (np.int64, (-1,)),
    "policy_index": (np.int32, (-1,)),
    "policy_visits": (np.uint32, (-1,)),
    "full": (np.uint8, (-1,)),
    "winner": (np.uint8, (-1,)),
    "rank": (np.uint8, (-1, 3)),
    "next_elim": (np.uint8, (-1,)),
    "root_value": (np.float32, (-1, 3)),
    "loss20": (np.float32, (-1, 3)),
    "final_material": (np.float32, (-1, 3)),
    "st6": (np.float32, (-1, 3)),
    "st16": (np.float32, (-1, 3)),
    "remaining": (np.uint16, (-1,)),
    "game_id": (np.uint32, (-1,)),
    "g_id": (np.uint32, (-1,)),
    "g_winner": (np.uint8, (-1,)),
    "g_kind": (np.uint8, (-1,)),
    "g_plies": (np.uint16, (-1,)),
    "g_seat_net": (np.int8, (-1, 3)),
    "g_moves_offsets": (np.int64, (-1,)),
    "g_moves": (np.uint16, (-1,)),
}


def decode(d: dict) -> dict:
    """Driver.take_finished() の bytes の dict → numpy の dict"""
    return {k: np.frombuffer(v, dtype=_DTYPES[k][0]).reshape(_DTYPES[k][1]) for k, v in d.items()}


def merge(parts: list[dict]) -> dict:
    """複数の decode 結果をつなぐ（offsets はずらす）"""
    out = {}
    for k in _DTYPES:
        arrs = [p[k] for p in parts]
        if k in ("policy_offsets", "g_moves_offsets"):
            base = 0
            fixed = [np.zeros(1, dtype=np.int64)]
            for a in arrs:
                fixed.append(a[1:] + base)
                base += a[-1]
            out[k] = np.concatenate(fixed)
        else:
            out[k] = np.concatenate(arrs)
    return out


def save_shard(path: str, data: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    np.savez_compressed(path, **data)


def load_shard(path: str) -> dict:
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


class Window:
    """直近のシャードから学習用の局面を集めたもの（リプレイバッファ）"""

    def __init__(self, shard_dir: str, max_positions: int):
        files = sorted(glob.glob(os.path.join(shard_dir, "*.npz")), key=os.path.getmtime)  # 作られた順
        parts, total = [], 0
        for f in reversed(files):
            d = load_shard(f)
            parts.append(d)
            total += len(d["winner"])
            if total >= max_positions:
                break
        parts.reverse()
        self.d = merge(parts) if parts else None
        self.n = 0 if self.d is None else len(self.d["winner"])
        self.files = len(parts)

    def batch(self, idx: np.ndarray, device) -> dict:
        d = self.d
        B = len(idx)
        st = torch.from_numpy(d["states"][idx]).to(device)
        full = d["full"][idx].astype(np.float32)
        # 方策ターゲット（全力探索の局面だけ）：訪問数を正規化して密な形に
        pol = np.zeros((B, NUM_POLICY), dtype=np.float32)
        offs = d["policy_offsets"]
        for i, j in enumerate(idx):
            if full[i]:
                a, b = offs[j], offs[j + 1]
                v = d["policy_visits"][a:b].astype(np.float32)
                s = v.sum()
                if s > 0:
                    pol[i, d["policy_index"][a:b]] = v / s
                else:
                    full[i] = 0
        t = lambda k, dt=torch.float32: torch.from_numpy(np.ascontiguousarray(d[k][idx])).to(device=device, dtype=dt)
        return {
            "states": st,
            "policy": torch.from_numpy(pol).to(device),
            "policy_w": torch.from_numpy(full).to(device),
            "winner": t("winner", torch.long),
            "root_value": t("root_value"),
            "rank": t("rank", torch.long),
            "next_elim": t("next_elim", torch.long),
            "loss20": t("loss20"),
            "final_mat": t("final_material"),
            "remaining": t("remaining"),
            "st6": t("st6"),
            "st16": t("st16"),
        }
