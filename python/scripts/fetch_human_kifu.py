"""サーバー（api.mataasobo.com）にたまった、人が指した棋譜を取ってきて、学習の局面にする（2026-10-30）。

棋譜は mataasobo リポジトリの server/src/kifu.js がためている（ひとりで指す画面から送られたものと、みんなと指す部屋の対局）。
勝ち負けは使わない。人が最初に指したあとの局面を、3人とも生きている間だけ取り出す（棋譜は人が脱落したところで終わっている）。

  1. 新しく増えた棋譜を取ってきて runs/human_kifu/kifu.jsonl に足す（同じ id は新しいほうで上書き。続きは runs/human_kifu/cursor.txt から）
  2. 全部の棋譜を並べ直して、局面を runs/<run>/start_positions/human-server.npy に書く（train_loop.py の「大差局面から」の山の候補に足される）

取ってくるには KIFU_TOKEN（サーバーに wrangler secret put KIFU_TOKEN で設定したもの）を runs/kifu-token.txt に置いておく。

  python/.venv/Scripts/python.exe python/scripts/fetch_human_kifu.py --run pbig2
"""
import argparse
import json
import os
import sys
import urllib.request

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import shogi3_rs  # noqa: E402
from add_start_positions import RULES, policy_index  # noqa: E402
from export_games import initial_bytes  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = "https://api.mataasobo.com/kifu"


def fetch(token, after, api=API):
    items = []
    while True:
        req = urllib.request.Request(f"{api}?after={after}&limit=500", headers={"authorization": "Bearer " + token, "user-agent": "shogi3-fetch"})
        d = json.load(urllib.request.urlopen(req, timeout=60))
        items += d["items"]
        if len(d["items"]) < 500:
            return items, d["total"]
        after = d["items"][-1]["at"]


def positions(rec):
    """人が最初に指したあとの局面（3人とも生きている間）。並べ直せない手があれば、そこまで"""
    st = initial_bytes(RULES[rec["rule"]])
    humans, out, seen_human = set(rec["humans"]), [], False
    for m in rec["moves"]:
        if st[102:105] != bytes(3):
            break
        if m.get("resign"):
            break
        try:
            s2, w = shogi3_rs.play_policy_index(st, policy_index(m["mv"]))
        except Exception:
            break
        st = bytes(s2)
        seen_human = seen_human or m["o"] in humans
        if seen_human and st[102:105] == bytes(3) and w is None:
            out.append(st)
        if w is not None:
            break
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--api", default=API, help="試すとき：手元のサーバー（http://127.0.0.1:8787/kifu）")
    p.add_argument("--token-file", default=os.path.join(ROOT, "runs", "kifu-token.txt"))
    p.add_argument("--no-fetch", action="store_true", help="取ってこないで、手元の kifu.jsonl から局面だけ作り直す")
    a = p.parse_args()
    d = os.path.join(ROOT, "runs", "human_kifu")
    os.makedirs(d, exist_ok=True)
    path, cur = os.path.join(d, "kifu.jsonl"), os.path.join(d, "cursor.txt")
    recs = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            r = json.loads(line)
            recs[r["id"]] = r
    if not a.no_fetch:
        token = open(a.token_file, encoding="utf-8").read().strip()
        after = int(open(cur).read()) if os.path.exists(cur) else 0
        items, total = fetch(token, after, a.api)
        for r in items:
            recs[r["id"]] = r
        if items:
            open(cur, "w").write(str(items[-1]["at"]))
        with open(path, "w", encoding="utf-8") as f:
            for r in recs.values():
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"新しく {len(items)}局（サーバーに全部で {total}局、手元に {len(recs)}局）")
    rows, n_solo, n_room = [], 0, 0
    for r in recs.values():
        x = positions(r)
        rows += x
        n_solo += r["src"] == "solo"
        n_room += r["src"] == "room"
    arr = np.frombuffer(b"".join(rows), dtype=np.uint8).reshape(-1, 109) if rows else np.zeros((0, 109), dtype=np.uint8)
    out = os.path.join(ROOT, "runs", a.run, "start_positions", "human-server.npy")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.save(out, arr)
    print(f"ひとりで指した {n_solo}局・部屋 {n_room}局 → {len(arr)}局面 → {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()
