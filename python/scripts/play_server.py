"""学習したネットとブラウザで対局するためのローカルサーバー。

リポジトリ直下のファイル（shogi3.html など）をそのまま配信し、POST /api/move で AI の指し手を返す。
ブラウザの難易度で「学習AI」を選ぶと、CPU の手番でここに局面を送る。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/play_server.py --run pbig2 --gen 61
  python/.venv/Scripts/python.exe python/scripts/play_server.py --model shogi3-pbig2-gen61.pt   # リリースのファイル
  → http://localhost:8765/shogi3.html を開く
--gen を省くと最新の世代を使う。学習中でも動く（GPU を少し分け合う）。GPU がなければ --device cpu（遅い）。
"""
import argparse
import glob
import json
import os
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# 学習中は site-packages の shogi3_rs が使用中で上書きできないので、別に作ったものを優先して読む
sys.path.insert(0, os.path.join(ROOT, "engine-rs", "target", "play"))
sys.path.insert(0, os.path.join(ROOT, "python"))
import shogi3_rs  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.selfplay import evaluate_batch  # noqa: E402

PIECES = ["FU", "KY", "KE", "GIN", "KIN", "KAKU", "HI", "OU"]
PASS = 65535


def encode(req) -> bytes:
    """ブラウザの局面（board[r][c] = {p,o,pr} / hand[o] = [駒名] …）→ 109バイト（最後はルール）"""
    st = bytearray(109)
    for r in range(9):
        for c in range(9):
            cell = req["board"][r][c]
            if cell:
                st[r * 9 + c] = 1 + cell["o"] * 16 + (8 if cell["pr"] else 0) + PIECES.index(cell["p"])
    for o in range(3):
        for p in req["hand"][o]:
            st[81 + o * 7 + PIECES.index(p)] += 1
    for o in range(3):
        st[102 + o] = 1 if req["eliminated"][o] else 0
    st[105] = req["turn"]
    st[106:108] = int(req["moveCount"]).to_bytes(2, "little")
    st[108] = RULE_ID[rule_name(req.get("rule", "all"))]
    return bytes(st)


RULE_ID = {"all": 0, "next": 1, "vanish": 2}


def rule_name(v):
    """ブラウザの keepAllPieces（true / 'all' / 'next' / false）→ ルール名"""
    return {True: "all", "all": "all", "next": "next", False: "vanish", "vanish": "vanish"}.get(v, "all")


def decode_move(m: int, board):
    """to | from<<7 | 成り<<14 → ブラウザの手 {fr,fc,tr,tc,pro} / {drop,piece,tr,tc}"""
    to, frm, pro = m & 127, (m >> 7) & 127, bool(m >> 14 & 1)
    if frm >= 81:
        return {"drop": True, "piece": PIECES[frm - 81], "tr": to // 9, "tc": to % 9}
    return {"fr": frm // 9, "fc": frm % 9, "tr": to // 9, "tc": to % 9, "pro": pro}


class Engine:
    def __init__(self, path, device):
        self.device = device
        self.model = M.load(path, device).eval()
        self.lock = threading.Lock()

    def think(self, req):
        visits = max(1, min(int(req.get("visits", 800)), 20000))
        s = shogi3_rs.Searcher(encode(req), visits=visits)
        t = time.time()
        with self.lock:
            while True:
                leaf = s.next_leaf()
                if leaf is None:
                    break
                st_b, legal_b = leaf
                st = torch.from_numpy(np.frombuffer(st_b, dtype=np.uint8).copy()).view(1, 109).to(self.device)
                legal = torch.from_numpy(np.frombuffer(legal_b, dtype=np.int32).astype(np.int64)).view(1, -1).to(self.device)
                p, v = evaluate_batch(self.model, st, legal)
                s.submit(p[0].cpu().tolist(), v[0].cpu().tolist())
        best, counts, value = s.result()
        counts = sorted(counts, key=lambda x: -x[1])
        return {
            "move": None if best == PASS else decode_move(best, req["board"]),
            "value": [round(x, 3) for x in value],
            "top": [{"move": None if m == PASS else decode_move(m, req["board"]), "visits": n} for m, n in counts[:5]],
            "visits": visits,
            "sec": round(time.time() - t, 2),
        }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="pbig2")
    ap.add_argument("--gen", type=int, default=None, help="省略時は最新の世代")
    ap.add_argument("--model", default=None, help="モデルのファイルを直接指定（GitHub のリリースからダウンロードしたものなど）。--run/--gen より優先")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    a = ap.parse_args()
    if a.model:
        path = a.model
    else:
        models = sorted(glob.glob(os.path.join(ROOT, "runs", a.run, "models", "gen*.pt")))
        path = os.path.join(ROOT, "runs", a.run, "models", f"gen{a.gen:04d}.pt") if a.gen is not None else models[-1]
    m = re.search(r"gen(\d+)", os.path.basename(path))
    gen = int(m.group(1)) if m else None
    engine = Engine(path, torch.device(a.device))

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=ROOT, **kw)

        def log_message(self, fmt, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def do_GET(self):
            if self.path == "/api/info":
                return self.reply({"run": None if a.model else a.run, "gen": gen, "model": os.path.basename(path), "device": a.device})
            super().do_GET()

        def do_POST(self):
            if self.path != "/api/move":
                return self.send_error(404)
            try:
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                res = engine.think(req)
                print(f"手番{req['turn']} {req['moveCount']}手目: {res['sec']}秒 価値{res['value']} → {res['move']}", flush=True)
                self.reply(res)
            except Exception as e:  # noqa: BLE001
                print("エラー:", repr(e), flush=True)
                self.reply({"error": repr(e)}, 500)

        def reply(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    print(f"{os.path.basename(path)} を読み込みました。http://localhost:{a.port}/shogi3.html を開いてください", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
