"""評価対局（eval_models.py --save-games）を、測る側の席ごとに分解する。

測る側（1体）が各席に座ったときに、
- ルールごとの勝率
- 負けたとき誰が勝ったか（測る側の次の手番の相手か、前の手番の相手か）
- 最初に脱落するのは誰か、測る側の玉を取ったのは誰か
- 終わり方（最後の1人・入玉・500手）と手数
を並べて、特定の相手・席でだけ起きていることを探す。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/analyze_eval.py runs/pmix/eval_games/gen61_vs_gen-41_mix_s6161.npz ...
"""
import os
import sys
from collections import Counter

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shogi3ml import data as D  # noqa: E402

SEAT = ["青", "赤", "緑"]
RULES = ["全部持ち駒", "お裾分け", "消滅あり"]
KIND = ["最後の1人", "入玉", "500手"]


def games(d):
    """対局ごとに (測る側の席, ルール, 勝者, 終わり方, 手数, 最初の脱落者, それを取った人, 測る側を取った人)"""
    st, gid = d["states"], d["game_id"]
    starts = np.r_[0, np.nonzero(np.diff(gid))[0] + 1]
    ends = np.r_[starts[1:], len(gid)]
    info = {}
    for a, b in zip(starts, ends):
        el = st[a:b, 102:105].astype(bool)
        events = []  # (脱落した人, 取った人)
        for j in range(1, b - a):
            new = el[j] & ~el[j - 1]
            for p in np.nonzero(new)[0]:
                events.append((int(p), int(st[a + j - 1, 105])))
        info[int(gid[a])] = events
    out = []
    for i, g in enumerate(d["g_id"]):
        cand = int(g % 3)
        ev = list(info.get(int(g), []))
        # 対局を終わらせた最後の玉取りは記録（指す前の局面）に残らないので補う：最後の1人で終わったなら、勝者が残りの人を取った
        w = int(d["g_winner"][i])
        if int(d["g_kind"][i]) == 0:
            out_already = {p for p, _ in ev}
            for p in range(3):
                if p != w and p not in out_already:
                    ev.append((p, w))
        first = ev[0] if ev else (None, None)
        cand_killer = next((k for p, k in ev if p == cand), None)
        out.append(dict(cand=cand, rule=int(d["g_rule"][i]), winner=int(d["g_winner"][i]), kind=int(d["g_kind"][i]),
                        plies=int(d["g_plies"][i]), first_out=first[0], first_by=first[1], cand_killer=cand_killer))
    return out


def rel(cand, p):
    """測る側から見た相手の位置：次＝測る側の直後に指す人、前＝直前に指す人"""
    if p is None:
        return "—"
    if p == cand:
        return "自分"
    return "次の相手" if p == (cand + 1) % 3 else "前の相手"


def report(path):
    d = D.load_shard(path)
    G = games(d)
    print(f"\n━━ {os.path.basename(path)}（{len(G)}局）━━")
    for s in range(3):
        g = [x for x in G if x["cand"] == s]
        n = len(g)
        win = sum(x["winner"] == s for x in g)
        print(f"■ 測る側が{SEAT[s]}（次の相手={SEAT[(s+1)%3]}、前の相手={SEAT[(s+2)%3]}）：{win}/{n} = {win/n*100:.1f}%  平均{np.mean([x['plies'] for x in g]):.0f}手")
        by_rule = []
        for r in range(3):
            gr = [x for x in g if x["rule"] == r]
            if gr:
                by_rule.append(f"{RULES[r]} {sum(x['winner'] == s for x in gr)}/{len(gr)}")
        print("  ルール別: " + "  ".join(by_rule))
        lose = [x for x in g if x["winner"] != s]
        c = Counter(rel(s, x["winner"]) for x in lose)
        print(f"  負けたときの勝者: " + "  ".join(f"{k} {v}" for k, v in c.most_common()))
        c = Counter(rel(s, x["first_out"]) for x in g)
        print(f"  最初に脱落: " + "  ".join(f"{k} {v}" for k, v in c.most_common()))
        c = Counter(rel(s, x["cand_killer"]) for x in g if x["cand_killer"] is not None)
        print(f"  測る側の玉を取った人: " + "  ".join(f"{k} {v}" for k, v in c.most_common()))
        c = Counter((KIND[x["kind"]], "測る側" if x["winner"] == s else rel(s, x["winner"])) for x in g)
        print(f"  終わり方と勝者: " + "  ".join(f"{k[0]}→{k[1]} {v}" for k, v in sorted(c.items())))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    for p in sys.argv[1:]:
        report(p)


if __name__ == "__main__":
    main()
