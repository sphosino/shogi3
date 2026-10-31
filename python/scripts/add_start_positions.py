"""人の対局の棋譜（ブラウザの「📋 棋譜をコピー」の JSON）から、自己対局を始める局面を取り出して保存する。

保存した局面は、train_loop.py の「特別な局面から」の山（--lead-share）の候補に足される（runs/<run>/start_positions/*.npy）。
取り出すのは、3人とも生きていて、トップが2位より駒数で --lead-min 枚以上多くなった最初の局面から、誰かが脱落する直前までの局面。
二人将棋の棋譜（最初から1人脱落している）は、大差の条件なしで、初手から決着の直前までの全部の局面（2026-10-31）。

  python/.venv/Scripts/python.exe python/scripts/add_start_positions.py --run pbig2 --name human-2026-10-13 棋譜.json
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import shogi3_rs  # noqa: E402
from export_games import P, initial_bytes  # noqa: E402
from train_loop import lead_states  # noqa: E402

RULES = {"all": 0, "next": 1, "vanish": 2}


def policy_index(m):
    if m.get("drop"):
        return ((81 + P.index(m["piece"])) * 2) * 81 + m["tr"] * 9 + m["tc"]
    return ((m["fr"] * 9 + m["fc"]) * 2 + int(bool(m.get("pro")))) * 81 + m["tr"] * 9 + m["tc"]


def start_bytes(start):
    """棋譜の最初の盤面（持ち駒なしの初期局面）を109バイトにする"""
    st = bytearray(109)
    for r, row in enumerate(start["board"]):
        for c, x in enumerate(row):
            if x:
                st[r * 9 + c] = 1 + x["o"] * 16 + P.index(x["p"])
    st[102:105] = bytes(int(e) for e in start["eliminated"])
    st[105] = start["turn"]
    st[108] = RULES[start.get("rule", "all")]
    return bytes(st)


def positions(rec, lead_min):
    """棋譜を並べ直して、大差がついてから脱落の直前までの局面（109バイトの行）を返す。二人将棋は決着の直前までの全部"""
    two = any(rec["start"]["eliminated"])
    st = start_bytes(rec["start"]) if two else initial_bytes(RULES[rec["start"].get("rule", "all")])
    out = []
    for m in rec["moves"]:
        if st[102:105] != bytes(3) and not two:
            break
        out.append(st)
        s2, w = shogi3_rs.play_policy_index(st, policy_index(m["mv"]))
        st = bytes(s2)
        if w is not None:
            break
    arr = np.frombuffer(b"".join(out), dtype=np.uint8).reshape(-1, 109)
    if two:
        return arr
    is_lead = np.array([len(lead_states({"states": r[None]}, lead_min)) > 0 for r in arr], dtype=bool)
    if not is_lead.any():
        return arr[:0]
    return arr[int(np.argmax(is_lead)):]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--name", required=True, help="保存するファイルの名前（runs/<run>/start_positions/<name>.npy）")
    p.add_argument("--lead-min", type=int, default=12)
    p.add_argument("files", nargs="+")
    a = p.parse_args()
    parts = []
    for f in a.files:
        rec = json.load(open(f, encoding="utf-8"))
        if rec["start"].get("moveCount", 0) != 0:
            print(f"{f}: 初期局面から始まっていない棋譜は使えません")
            continue
        x = positions(rec, a.lead_min)
        print(f"{f}: {len(rec['moves'])}手のうち {len(x)}局面")
        parts.append(x)
    arr = np.concatenate(parts) if parts else np.zeros((0, 109), dtype=np.uint8)
    out = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run, "start_positions", a.name + ".npy")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.save(out, arr)
    print(f"→ {os.path.normpath(out)}（{len(arr)}局面）")


if __name__ == "__main__":
    main()
