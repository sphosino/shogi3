"""成長曲線（docs/growth.svg）を描く。外部ライブラリは使わない。

各段階の強さは、直前の段階との直接対戦（1体 vs 同じ相手2体）の勝率 p から積み上げた推定値。
3人の勝ち確率がそれぞれの強さに比例するとみなすと（Luce の選択モデル）、強さの比は 2p/(1−p)。
その対数の400倍を差とする。互角（33.3%）で0、40%で約+50、50%で約+120。足場＝0。

新しい評価が出たら POINTS に足して、リポジトリ直下で実行する:
  python/.venv/Scripts/python.exe python/scripts/plot_growth.py
"""
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def gap(p):
    return 400 * math.log10(2 * p / (1 - p))


# (名前, 系列, 今の最強に至る系列の自己対局の千局数, [(基準, 勝率), ...], 測り方)
# 基準が複数あるときは、それぞれから出した値を平均する
POINTS = [
    ("足場", "base", 0, [], "基準"),
    ("p4 世代1", "p4", 30, [("足場", .75)], "足場の3万局から蒸留"),
    ("p4 世代11", "p4", 40, [("p4 世代1", .75)], ""),
    ("p4 世代21", "p4", 50, [("p4 世代1", .833)], ""),
    ("p4 世代31", "p4", 60, [("p4 世代11", .733)], ""),
    ("p4 世代51", "p4", 80, [("p4 世代31", .617)], ""),
    ("p5c 世代1", "p5c", 80, [("p4 世代51", .443)], "p4 世代51 の出力から蒸留"),
    ("p5c 世代11", "p5c", 90, [("p4 世代51", .503)], ""),
    ("p5c 世代25", "p5c", 104, [("p4 世代51", .50)], ""),
    ("pmix 世代21", "pmix", 125, [("p5c 世代25", .607)], "3ルール混合"),
    ("pmix 世代41", "pmix", 145, [("pmix 世代21", .48)], ""),
    ("pmix 世代61", "pmix", 165, [("pmix 世代41", .373)], ""),
    ("pmix 世代81", "pmix", 185, [("pmix 世代61", .42)], "過去の世代を混ぜる"),
    ("pmix 世代101", "pmix", 205, [("pmix 世代81", .43)], ""),
    ("pmix 世代121", "pmix", 225, [("pmix 世代101", .517)], "データ窓150万局面"),
    ("pmix 世代141", "pmix", 245, [("pmix 世代121", .377)], ""),
    ("pbig 世代1", "pbig2", 245, [("pmix 世代141", .403)], "12ブロックに蒸留"),
    ("pbig2 世代21", "pbig2", 266, [("pbig 世代1", .273)], ""),
    ("pbig2 世代41", "pbig2", 286, [("pbig 世代1", .37), ("pbig2 世代21", .42)], ""),
    ("pbig2 世代61", "pbig2", 306, [("pbig2 世代41", .457), ("pbig2 世代21", .493)], ""),
    ("pbig2 世代81", "pbig2", 326, [("pbig2 世代61", .37), ("pbig2 世代41", .377)], ""),
]
SERIES = [("p4", "p4（6ブロック×96ch）", "#2a78d6"), ("p5c", "p5c（10ブロック、全部持ち駒）", "#eb6834"),
          ("pmix", "pmix（10ブロック、3ルール混合）", "#1baf7a"), ("pbig2", "pbig / pbig2（12ブロック×160ch）", "#4a3aa7")]
EVENTS = [(105, "3ルール混合"), (166, "過去の世代を混ぜる"), (206, "データ窓150万"), (245, "12ブロックに蒸留")]


def ratings():
    r = {}
    for name, _, _, refs, _ in POINTS:
        r[name] = 0.0 if not refs else sum(r[b] + gap(p) for b, p in refs) / len(refs)
    return r


def svg(r):
    W, H, L, R, T, B = 900, 500, 58, 24, 56, 92
    xmax = max(p[2] for p in POINTS) * 1.05
    ymax = math.ceil(max(r.values()) / 400 + 0.5) * 400
    x = lambda v: L + v / xmax * (W - L - R)
    y = lambda v: T + (1 - v / ymax) * (H - T - B)
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="Hiragino Sans, Yu Gothic, Meiryo, sans-serif">',
         f'<rect width="{W}" height="{H}" fill="#fbfaf6"/>',
         f'<text x="{L}" y="24" font-size="16" font-weight="700" fill="#1d1c19">三人将棋AI 成長曲線（推定の強さ、足場＝0）</text>']
    for v in range(0, ymax + 1, 400):
        o.append(f'<line x1="{L}" x2="{W-R}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke="#dedbd0" stroke-dasharray="2 4"/>')
        o.append(f'<text x="{L-8}" y="{y(v)+4:.1f}" font-size="11" fill="#8a867b" text-anchor="end">{v}</text>')
    for v in range(0, int(xmax) + 1, 50):
        o.append(f'<text x="{x(v):.1f}" y="{H-B+18}" font-size="11" fill="#8a867b" text-anchor="middle">{v}</text>')
    o.append(f'<text x="{W-R}" y="{H-B+36}" font-size="11" fill="#8a867b" text-anchor="end">今の最強に至る系列の自己対局（千局）</text>')
    for i, (v, lab) in enumerate(EVENTS):
        o.append(f'<line x1="{x(v):.1f}" x2="{x(v):.1f}" y1="{T-8}" y2="{H-B}" stroke="#b48a2c" stroke-dasharray="3 3"/>')
        o.append(f'<text x="{x(v)+4:.1f}" y="{T-12-(i%2)*14}" font-size="11" fill="#55524a">{lab}</text>')
    pos = {p[0]: (p[2], r[p[0]]) for p in POINTS}
    prev = "足場"
    for sid, _, col in SERIES:
        pts = [p for p in POINTS if p[1] == sid]
        chain = [pos[prev]] + [pos[p[0]] for p in pts]
        o.append('<polyline fill="none" stroke="%s" stroke-width="2" stroke-linejoin="round" points="%s"/>'
                 % (col, " ".join(f"{x(a):.1f},{y(b):.1f}" for a, b in chain)))
        for p in pts:
            a, b = pos[p[0]]
            o.append(f'<circle cx="{x(a):.1f}" cy="{y(b):.1f}" r="4.5" fill="{col}" stroke="#fbfaf6" stroke-width="2"/>')
        last = pts[-1][0]
        a, b = pos[last]
        o.append(f'<text x="{x(a)-8:.1f}" y="{y(b)-12:.1f}" font-size="12" font-weight="700" fill="#1d1c19" text-anchor="end">{last} {b:.0f}</text>')
        prev = last
    o.append(f'<circle cx="{x(0):.1f}" cy="{y(0):.1f}" r="4.5" fill="#8a867b"/>')
    # 凡例
    for i, (sid, name, col) in enumerate(SERIES):  # 2列×2行
        lx, ly = L + (i % 2) * 380, H - 30 + (i // 2) * 18
        o.append(f'<rect x="{lx}" y="{ly-5}" width="16" height="3" rx="1.5" fill="{col}"/>')
        o.append(f'<text x="{lx+22}" y="{ly}" font-size="11" fill="#55524a">{name}</text>')
    o.append("</svg>")
    return "\n".join(o)


def main():
    r = ratings()
    path = os.path.join(ROOT, "docs", "growth.svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg(r))
    for name, *_ in POINTS:
        print(f"{name:12s} {r[name]:6.0f}")
    print("→", path)


if __name__ == "__main__":
    main()
