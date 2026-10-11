"""自己対局・評価対局の棋譜を、ブラウザで見られる形（「📋 棋譜をコピー」と同じ JSON）に書き出す。
web/games/ に1局1ファイルで置き、一覧（web/games/index.json）に足す。web/games.html から開ける。

使い方（リポジトリ直下）:
  # トレーニング棋譜（自己対局）。1シャードから何局か選ぶ
  python/.venv/Scripts/python.exe python/scripts/export_games.py --shard runs/pbig2/selfplay/gen0182.npz --kind train --me "pbig2 世代182" --per 6
  # レーティング棋譜（評価対局。eval_models.py --save-games で保存したもの。net:0 が測る側）
  python/.venv/Scripts/python.exe python/scripts/export_games.py --shard runs/pbig2/eval_games/xxx.npz --kind rating --me "pbig2 世代197" --opp "pbig2 世代181" --per 20

注意：途中で駒を渡した（--gift-prob）対局は、最初の局面から並べ直せないので書き出さない（pbig2 の世代142〜181 の selfplay は使わない）。
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FU, KY, KE, GIN, KIN, KAKU, HI, OU = range(8)
P = ["FU", "KY", "KE", "GIN", "KIN", "KAKU", "HI", "OU"]
RULE_JS = {0: "all", 1: "next", 2: False}
RULE_NAME = {0: "全部持ち駒", 1: "お裾分け", 2: "消滅あり"}
END_NAME = {0: "玉を取る", 1: "入玉", 2: "500手"}


def initial_bytes(rule):
    st = bytearray(109)

    def put(r, c, o, pt):
        st[r * 9 + c] = 1 + o * 16 + pt
    for c, pt in enumerate([GIN, KIN, OU, KIN, GIN]):
        put(8, c, 0, pt); put(0, c, 1, pt); put(2 + c, 8, 2, pt)
    for r, c, o, pt in [(7, 0, 0, HI), (7, 4, 0, KAKU), (1, 0, 1, KAKU), (1, 4, 1, HI), (2, 7, 2, HI), (6, 7, 2, KAKU)]:
        put(r, c, o, pt)
    for i in range(5):
        put(6, i, 0, FU); put(2, i, 1, FU); put(2 + i, 6, 2, FU)
    for o in range(3):
        st[81 + o * 7 + KY] = 1; st[81 + o * 7 + KE] = 1
    st[108] = rule
    return bytes(st)


def to_js(st, rule):
    board = [[None] * 9 for _ in range(9)]
    for s in range(81):
        c = st[s]
        if c:
            board[s // 9][s % 9] = {"p": P[(c - 1) & 7], "o": (c - 1) >> 4, "pr": bool((c - 1) & 8)}
    hand = [[P[t] for t in range(7) for _ in range(st[81 + o * 7 + t])] for o in range(3)]
    return {"board": board, "hand": hand, "eliminated": [False] * 3, "turn": 0, "moveCount": 0, "rule": RULE_JS[rule]}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", required=True)
    ap.add_argument("--kind", choices=["train", "rating"], required=True)
    ap.add_argument("--me", required=True, help="net:0 の名前（トレーニング棋譜ならその世代）")
    ap.add_argument("--opp", default="過去の世代", help="net:1 以上の名前")
    ap.add_argument("--per", type=int, default=6, help="書き出す局数（ルールごとになるべく同じ数）")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "games"))
    a = ap.parse_args()

    d = D.load_shard(a.shard)
    mv = d["g_moves"].astype(np.int64); off = d["g_moves_offsets"].astype(np.int64)
    recs = {}
    for j, g in enumerate(d["game_id"]):
        recs.setdefault(int(g), []).append(j)
    rv = d["root_value"]
    rng = np.random.default_rng(a.seed)
    n = len(off) - 1
    # ルールごとに順番に選ぶ
    by_rule = {r: [i for i in rng.permutation(n) if int(d["g_rule"][i]) == r] for r in range(3)}
    picked = []
    while len(picked) < a.per and any(by_rule.values()):
        for r in range(3):
            if by_rule[r] and len(picked) < a.per:
                picked.append(by_rule[r].pop())

    sub = "train" if a.kind == "train" else "rating"
    os.makedirs(os.path.join(a.out, sub), exist_ok=True)
    idx_path = os.path.join(a.out, "index.json")
    index = json.load(open(idx_path, encoding="utf-8")) if os.path.exists(idx_path) else []
    base = os.path.splitext(os.path.basename(a.shard))[0]
    run = os.path.basename(os.path.dirname(os.path.dirname(os.path.abspath(a.shard))))   # runs/<実行>/selfplay/xxx.npz
    tag = f"{run}-{base}"
    for gi in picked:
        rule = int(d["g_rule"][gi])
        moves = mv[off[gi]:off[gi + 1]]
        seat_net = [int(x) for x in d["g_seat_net"][gi]]
        players = [a.me if s == 0 else a.opp for s in seat_net]
        rj = recs.get(int(d["g_id"][gi]), [])
        st = initial_bytes(rule)
        out_moves, ri, ok = [], 0, True
        for x in moves:
            if x == 65535:          # パス（動ける駒がない）。ブラウザの形には無いので、手番だけ進む
                st2, w = shogi3_rs.play_policy_index(st, -1); st = bytes(st2)
                continue
            to, frm, pro = int(x & 127), int((x >> 7) & 127), int((x >> 14) & 1)
            m = ({"drop": True, "piece": P[frm - 81], "tr": to // 9, "tc": to % 9} if frm >= 81
                 else {"fr": frm // 9, "fc": frm % 9, "tr": to // 9, "tc": to % 9, "pro": bool(pro)})
            e = {"o": int(st[105]), "mv": m}
            if seat_net[st[105]] == 0 and ri < len(rj):   # 記録（勝率予想）は net:0 の手番だけ
                e["v"] = [round(float(v), 3) for v in rv[rj[ri]]]
                ri += 1
            out_moves.append(e)
            st2, w = shogi3_rs.play_policy_index(st, (frm * 2 + pro) * 81 + to); st = bytes(st2)
            if w is not None:
                break
        if any(int(x) == 65535 for x in moves):
            ok = False                # パスのある対局はブラウザで手番がずれるので書き出さない
        if not ok:
            continue
        gid = f"{tag}-g{int(d['g_id'][gi]):04d}"
        fname = f"{sub}/{gid}.json"
        winner = int(d["g_winner"][gi]); kind_end = int(d["g_kind"][gi])
        title = (f"{a.me} の自己対局" if a.kind == "train" else f"{a.me} vs {a.opp}")
        rec = {"version": 1, "kind": a.kind, "title": title, "players": players, "human": None,
               "source": os.path.relpath(a.shard, ROOT).replace("\\", "/"), "start": to_js(initial_bytes(rule), rule), "moves": out_moves}
        json.dump(rec, open(os.path.join(a.out, fname), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        entry = {"id": gid, "file": fname, "kind": a.kind, "title": title, "players": players, "rule": RULE_NAME[rule],
                 "winner": winner, "plies": len(out_moves), "end": END_NAME.get(kind_end, "?")}
        index = [x for x in index if x["id"] != gid] + [entry]
        print(f"{fname}  {RULE_NAME[rule]}  {len(out_moves)}手  勝者 {'青赤緑'[winner]}（{players[winner]}）  {END_NAME.get(kind_end, '?')}")
    json.dump(index, open(idx_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"一覧 {idx_path}：{len(index)}局")


if __name__ == "__main__":
    main()
