"""学習データのシャード（1回の自己対局の出力）の保存・読み込みと、バッチの作成。

シャードは npz。1局面1行（docs/self_play.md の学習データ）：
  states [N,109] u8（古いシャードは108。読み込み時にルール=全部持ち駒の列を足す） / policy_offsets [N+1] i64 / policy_index [M] i32 / policy_visits [M] u32 / full [N] u8
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
    "g_rule": (np.uint8, (-1,)),
    "g_seat_net": (np.int8, (-1, 3)),
    "g_moves_offsets": (np.int64, (-1,)),
    "g_moves": (np.uint16, (-1,)),
    "g_rand": (np.uint16, (-1,)),      # 最初にランダムに指した手数（ランダム局面から始めた対局。0 = ふつう）
}

_POS_KEYS = ["states", "full", "winner", "rank", "next_elim", "root_value", "loss20", "final_material", "st6", "st16", "remaining", "game_id"]
_GAME_KEYS = ["g_id", "g_winner", "g_kind", "g_plies", "g_rule", "g_seat_net", "g_rand"]


def subset_games(d: dict, keep: np.ndarray) -> dict:
    """対局（g_*）のうち keep が True のものと、その局面だけを取り出す（offsets も作り直す）"""
    out = {k: d[k][keep] for k in _GAME_KEYS}
    pos = np.nonzero(np.isin(d["game_id"], d["g_id"][keep]))[0]
    for k in _POS_KEYS:
        out[k] = d[k][pos]

    def take(offs, vals_keys, rows):
        a, b = offs[rows], offs[rows + 1]
        lens = b - a
        new_offs = np.concatenate([[0], np.cumsum(lens)]).astype(np.int64)
        idx = np.repeat(a - new_offs[:-1], lens) + np.arange(new_offs[-1]) if len(rows) else np.zeros(0, dtype=np.int64)
        return new_offs, {k: d[k][idx] for k in vals_keys}
    out["policy_offsets"], vals = take(d["policy_offsets"], ["policy_index", "policy_visits"], pos)
    out.update(vals)
    out["g_moves_offsets"], vals = take(d["g_moves_offsets"], ["g_moves"], np.nonzero(keep)[0])
    out.update(vals)
    return out


def decode(d: dict) -> dict:
    """Driver.take_finished() の bytes の dict → numpy の dict"""
    out = {k: np.frombuffer(v, dtype=_DTYPES[k][0]).reshape(_DTYPES[k][1]) for k, v in d.items()}
    if "g_rand" not in out:   # g_rand を出さない古い Driver
        out["g_rand"] = np.zeros(len(out["g_winner"]), dtype=np.uint16)
    return out


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
        d = {k: z[k] for k in z.files}
    # ルールを持たない古いデータ（108バイト・g_rule なし）は「全部持ち駒」
    if d["states"].shape[1] == STATE_BYTES - 1:
        d["states"] = np.concatenate([d["states"], np.zeros((len(d["states"]), 1), dtype=np.uint8)], axis=1)
    if "g_rule" not in d:
        d["g_rule"] = np.zeros(len(d["g_winner"]), dtype=np.uint8)
    if "g_rand" not in d:
        d["g_rand"] = np.zeros(len(d["g_winner"]), dtype=np.uint16)
    return d


class MultiWindow:
    """いくつかのリプレイバッファから、決めた比率で局面を集めて1つのバッチにする
    （自己対局のみ／他のモデル入り／調整局面 を分けて持ち、学習のたびに比率どおりに混ぜる）"""

    def __init__(self, parts):
        """parts: [(名前, Window, 比率)]。局面のないバッファは除き、残りの比率を足して1にする"""
        parts = [(name, w, r) for name, w, r in parts if w.n > 0 and r > 0]
        tot = sum(r for _, _, r in parts)
        self.parts = [(name, w, r / tot) for name, w, r in parts]
        self.n = sum(w.n for _, w, _ in self.parts)
        self.files = sum(w.files for _, w, _ in self.parts)

    def sample(self, rng: np.random.Generator, B: int, device) -> dict:
        counts = [int(round(B * r)) for _, _, r in self.parts]
        counts[0] += B - sum(counts)
        bs = [w.sample(rng, c, device) for (_, w, _), c in zip(self.parts, counts) if c > 0]
        return {k: torch.cat([b[k] for b in bs]) for k in bs[0]}

    def describe(self) -> str:
        return " ".join(f"{name}{w.n}局面({r*100:.0f}%)" for name, w, r in self.parts)


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

    def sample(self, rng: np.random.Generator, B: int, device) -> dict:
        return self.batch(rng.integers(0, self.n, size=B), device)

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
