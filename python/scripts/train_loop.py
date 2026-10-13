"""自己対局 → 学習 → 評価 のループ（docs/training.md の同期版）。

使い方（リポジトリ直下）:
  python/.venv/Scripts/python.exe python/scripts/train_loop.py --run test1 --gens 6 --games-per-gen 500

runs/<run>/ に、学習データ（selfplay/）、モデル（models/）、評価結果（eval.jsonl）、ログ（log.txt）を置く。
途中で止めても、最後に保存した世代から再開する。
"""
import argparse
import glob
import json
import multiprocessing as mp
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import shogi3_rs  # noqa: E402
from shogi3ml import data as D  # noqa: E402
from shogi3ml import model as M  # noqa: E402
from shogi3ml.selfplay import run_driver  # noqa: E402
from shogi3ml.train import train_steps, value_check  # noqa: E402


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--run", required=True)
    p.add_argument("--gens", type=int, default=10, help="この実行で進める世代数")
    p.add_argument("--games-per-gen", type=int, default=500)
    p.add_argument("--parallel", type=int, default=512, help="同時に進める対局数（推論のバッチの大きさ）")
    p.add_argument("--visits-full", type=int, default=600)
    p.add_argument("--visits-fast", type=int, default=100)
    p.add_argument("--full-prob", type=float, default=0.25)
    p.add_argument("--scaffold-games", type=int, default=2000, help="最初の世代（足場の評価器）の対局数")
    p.add_argument("--scaffold-procs", type=int, default=16)
    p.add_argument("--train-ratio", type=float, default=1.0, help="1世代の学習サンプル数 ÷ 新しく増えた局面数")
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--lr", type=float, default=0.02)
    p.add_argument("--lr-warm", type=float, default=None, help="最初の --lr-warm-gens 世代だけ使う低い学習率（蒸留直後のネットを崩さないため）")
    p.add_argument("--lr-warm-gens", type=int, default=0, help="この実行で低い学習率を使う世代数（世代番号 ≤ 蒸留の世代 + この数）")
    p.add_argument("--window", type=int, default=250_000, help="学習に使う直近の局面数")
    p.add_argument("--blocks", type=int, default=6)
    p.add_argument("--ch", type=int, default=96)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--q-mix", type=float, default=0.5, help="価値のターゲットに混ぜるMCTS根の価値の割合")
    p.add_argument("--eval-every", type=int, default=2)
    p.add_argument("--eval-games", type=int, default=60)
    p.add_argument("--eval-visits", type=int, default=200)
    p.add_argument("--eval-vs", nargs="+", default=["scaffold", "prev"],
                   help="評価の相手: scaffold（足場のMCTS）/ prev（eval_every世代前）/ gen:N（固定の世代）/ ext:実行名:N（別の実行のモデル）")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--rule", default="all", choices=["all", "next", "vanish", "mix"], help="取り駒のルール（all=全部持ち駒 / next=お裾分け / vanish=消滅あり / mix=3つを均等に混ぜる）")
    p.add_argument("--past-prob", type=float, default=0.0, help="自己対局のうち過去の世代を混ぜる対局の割合（半分は 現世代2+過去1、半分は 現世代1+過去2）")
    p.add_argument("--mix-share", type=float, default=0.0, help="他のモデル入りの対局（過去の世代・弱いモデル）を別のバッファに分け、自己対局と学習でこの割合を使う")
    p.add_argument("--adj-share", type=float, default=0.0, help="調整局面の対局（途中で駒を渡して大差を作る）を別のバッファに分け、自己対局と学習でこの割合を使う")
    p.add_argument("--rand-share", type=float, default=0.0, help="ランダム局面から始める対局（最初の何手かを合法手からランダムに指す）を別のバッファに分け、自己対局と学習でこの割合を使う")
    p.add_argument("--rand-min", type=int, default=40, help="ランダム局面：最初にランダムに指す手数の最小")
    p.add_argument("--rand-max", type=int, default=100, help="ランダム局面：最初にランダムに指す手数の最大")
    p.add_argument("--rand-seed-games", type=int, default=0, help="ランダム局面の山が空なら、最初にこの局数をまとめて作る")
    p.add_argument("--lead-share", type=float, default=0.0, help="学習バッチのうち「大差局面から」の山の割合（自己対局で大差がついた実際の局面から指し直した対局）")
    p.add_argument("--lead-min", type=int, default=12, help="大差局面：3人とも生きていて、トップが2位より駒数（盤上の玉以外＋持ち駒）でこの枚数以上多い局面")
    p.add_argument("--lead-from", type=int, default=182, help="大差局面を集める自己対局のシャード：この世代から（それより前は記録の形が違う）")
    p.add_argument("--mix-past-weight", type=float, default=0.5, help="他のモデル入りの対局のうち、過去の世代の割合（残りは弱いモデル）")
    p.add_argument("--weak-models", nargs="*", default=[], help="自己対局に混ぜる弱いモデル（実行名:世代。例 pbig2:1 pmix:81）。1世代に1つを順番に使う")
    p.add_argument("--weak1-prob", type=float, default=0.0, help="自己対局のうち、弱いモデル1体（現世代2体）の対局の割合")
    p.add_argument("--weak2-prob", type=float, default=0.0, help="自己対局のうち、弱いモデル2体（現世代1体）の対局の割合")
    p.add_argument("--gift-prob", type=float, default=0.0, help="自己対局のうち、途中（20〜120手目）で1人に他の人の駒を5〜20枚渡して大差の局面を作る対局の割合")
    p.add_argument("--past-start", type=int, default=21, help="過去の世代の候補：この世代から")
    p.add_argument("--past-every", type=int, default=10, help="過去の世代の候補：この間隔ごと")
    p.add_argument("--past-max", type=int, default=6, help="過去の世代の候補の最大数（新しい方から）")
    p.add_argument("--past-per-gen", type=int, default=1, help="1世代で使う過去の世代の数（候補から順番に選ぶ）。モデルが増えると推論が分かれて遅くなる")
    p.add_argument("--init", default=None, help="最初のモデルを別の実行から持ってくる（例 p5c:25）。足場の対局の代わりにこのモデルで自己対局を始める")
    return p.parse_args()


RULE_NAMES = ["all", "next", "vanish"]


def scaffold_worker(args):
    games, seed, visits_full, visits_fast, full_prob, *rest = args
    rule = rest[0] if rest else "all"
    d = shogi3_rs.Driver(parallel=games, total_games=games, seats=["net:0"] * 3, scaffold=True, seed=seed,
                         visits_full=visits_full, visits_fast=visits_fast, full_prob=full_prob, rule=rule)
    assert d.next_batch() is None  # 足場モードでは推論を求めずに全局終わる
    return d.take_finished()


def past_summary(d: dict, ids=None) -> str:
    """過去の世代（や弱いモデル）を混ぜた対局での、現世代の勝率（1体のとき・2体のとき）。ids：集計する相手のネット番号（省略時は全部）"""
    sn = d["g_seat_net"].astype(np.int64)  # 対局×3席のネット番号（0=現世代）
    n0 = (sn == 0).sum(1)
    won = sn[np.arange(len(sn)), d["g_winner"].astype(np.int64)] == 0
    sel = np.ones(len(sn), dtype=bool) if ids is None else np.isin(sn, list(ids)).any(1)
    parts = []
    for k, name in ((2, "現世代2体"), (1, "現世代1体")):
        m = (n0 == k) & sel
        if m.any():
            parts.append(f"{name} {int(m.sum())}局 現世代の勝率 {won[m].mean()*100:.1f}%（互角なら{k/3*100:.0f}%）")
    return " / ".join(parts)


def lead_states(d: dict, th: int) -> np.ndarray:
    """3人とも生きていて、トップが2位より駒数で th 枚以上多い局面（109バイトの行）"""
    st = d["states"]
    board = st[:, :81].astype(np.int64)
    owner = np.where(board > 0, (board - 1) >> 4, -1)
    ptype = np.where(board > 0, (board - 1) & 7, -1)
    hand = st[:, 81:102].reshape(-1, 3, 7).sum(2).astype(np.int64)
    cnt = np.stack([((owner == o) & (ptype != 7)).sum(1) for o in range(3)], 1) + hand
    srt = np.sort(cnt, 1)
    keep = (st[:, 102:105] == 0).all(1) & (srt[:, 2] - srt[:, 1] >= th)
    return st[keep]


def summarize_games(d: dict) -> dict:
    kinds = np.bincount(d["g_kind"], minlength=3)
    out = dict(games=int(len(d["g_winner"])), positions=int(len(d["winner"])), avg_plies=float(d["g_plies"].mean()),
               seat_wins=np.bincount(d["g_winner"], minlength=3).tolist(),
               end_last=int(kinds[0]), end_entry=int(kinds[1]), end_limit=int(kinds[2]),
               full_positions=int(d["full"].sum()))
    rules = d.get("g_rule")
    if rules is not None and len(np.unique(rules)) > 1:
        # ルールごと：[対局数, 平均手数, 最後の1人, 入玉, 500手]
        for r, name in enumerate(RULE_NAMES):
            m = rules == r
            if m.any():
                k = np.bincount(d["g_kind"][m], minlength=3)
                out[name] = [int(m.sum()), round(float(d["g_plies"][m].mean()), 1), int(k[0]), int(k[1]), int(k[2])]
    return out


def evaluate(models: dict, seats, games, visits, device, seed, rule="all", save=None):
    """seats[0] が測る側（席は対局ごとに回す）。測る側の勝率を返す。save を指定すると対局データ（局面つき）を保存する"""
    drv = shogi3_rs.Driver(parallel=games, total_games=games, seats=seats, rotate=True, record=save is not None,
                           full_prob=1.0, visits_full=visits, dirichlet_total=0.0, temp_plies=8, seed=seed, rule=rule)
    stats = {}
    d = D.decode(run_driver(drv, models, device, stats))
    if save is not None:
        D.save_shard(save, d)
    rot = d["g_id"] % 3  # 測る側の席 = 対局番号 % 3
    wins = int((d["g_winner"] == rot).sum())
    n = len(rot)
    p = wins / n
    z = (p - 1 / 3) / np.sqrt((1 / 3) * (2 / 3) / n)
    kinds = np.bincount(d["g_kind"], minlength=3)
    out = dict(seats=seats, games=n, wins=wins, rate=round(p * 100, 1), z=round(float(z), 2),
               avg_plies=float(d["g_plies"].mean()), end=kinds.tolist(), sec=round(stats.get("seconds", 0), 1))
    # 測る側がその席に座ったときの勝率（青=P0, 赤=P1, 緑=P2）
    out["by_seat"] = [round(float((d["g_winner"][rot == s] == s).mean() * 100), 1) for s in range(3)]
    if rule == "mix":  # ルールごとの勝率
        out["by_rule"] = {name: round(float((d["g_winner"][d["g_rule"] == r] == rot[d["g_rule"] == r]).mean() * 100), 1)
                          for r, name in enumerate(RULE_NAMES) if (d["g_rule"] == r).any()}
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = parse()
    root = os.path.join(os.path.dirname(__file__), "..", "..", "runs", a.run)
    for sub in ("models", "selfplay", "selfplay_mix", "selfplay_adj", "selfplay_rand", "selfplay_lead"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    logf = open(os.path.join(root, "log.txt"), "a", encoding="utf-8")

    def log(msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    with open(os.path.join(root, "config.json"), "w", encoding="utf-8") as f:
        json.dump(vars(a), f, ensure_ascii=False, indent=1)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    rng = np.random.default_rng(a.seed)
    shard_dir = os.path.join(root, "selfplay")
    mix_dir = os.path.join(root, "selfplay_mix")   # 他のモデル入りの対局（--mix-share）
    adj_dir = os.path.join(root, "selfplay_adj")   # 調整局面の対局（--adj-share）
    rand_dir = os.path.join(root, "selfplay_rand")  # ランダム局面から始めた対局（--rand-share）
    lead_dir = os.path.join(root, "selfplay_lead")  # 大差局面から指し直した対局（--lead-share）
    model_path = lambda g: os.path.join(root, "models", f"gen{g:04d}.pt")

    # 別のルール・実行で学習したモデルから始める：それを世代1として保存し、その自己対局を最初のデータにする
    if a.init and not glob.glob(os.path.join(shard_dir, "*.npz")):
        run2, g2 = a.init.split(":")
        init_model = M.load(os.path.join(root, "..", run2, "models", f"gen{int(g2):04d}.pt"), device).eval()
        M.save(init_model, model_path(1), extra=dict(init=a.init))
        log(f"世代1: {run2} 世代{g2} のモデルから開始（ルール {a.rule}）。最初の自己対局 {a.games_per_gen} 局")
        t = time.time()
        drv = shogi3_rs.Driver(parallel=a.parallel, total_games=a.games_per_gen, seats=["net:0"] * 3,
                               visits_full=a.visits_full, visits_fast=a.visits_fast, full_prob=a.full_prob,
                               seed=a.seed * 100000 + 1, rule=a.rule)
        stats = {}
        d = D.decode(run_driver(drv, {0: init_model}, device, stats))
        D.save_shard(os.path.join(shard_dir, "gen0001.npz"), d)
        log(f"  自己対局 {time.time()-t:.0f}秒 推論 {stats['evals_per_sec']:.0f}局面/秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")

    # 世代0のデータ：足場の評価器（CPUのみ、複数プロセス）
    if not glob.glob(os.path.join(shard_dir, "*.npz")):
        log(f"世代0: 足場の評価器で {a.scaffold_games} 局（{a.scaffold_procs} プロセス）")
        t = time.time()
        per = [a.scaffold_games // a.scaffold_procs + (1 if i < a.scaffold_games % a.scaffold_procs else 0) for i in range(a.scaffold_procs)]
        with mp.Pool(a.scaffold_procs) as pool:
            parts = pool.map(scaffold_worker, [(n, a.seed * 1000 + i, a.visits_full, a.visits_fast, a.full_prob, a.rule) for i, n in enumerate(per) if n > 0])
        d = D.merge([D.decode(x) for x in parts])
        D.save_shard(os.path.join(shard_dir, "gen0000.npz"), d)
        log(f"  完了 {time.time()-t:.0f}秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")

    # モデル：最後に保存した世代から再開
    saved = sorted(glob.glob(os.path.join(root, "models", "gen*.pt")))
    if saved:
        gen = int(os.path.basename(saved[-1])[3:7])
        model = M.load(saved[-1], device)
        log(f"世代{gen} のモデルから再開")
    else:
        gen = 0
        model = M.Net(blocks=a.blocks, ch=a.ch).to(device)
        M.save(model, model_path(0))
    model.eval()
    opt = torch.optim.SGD(model.parameters(), lr=a.lr, momentum=0.9, weight_decay=a.weight_decay, nesterov=True)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    past_cache = {}
    # ランダム局面の山が空なら、最初にまとめて作る（少ない局面を何度も学習しないように）
    if a.rand_seed_games > 0 and not glob.glob(os.path.join(rand_dir, "*.npz")):
        t = time.time()
        drv = shogi3_rs.Driver(parallel=a.parallel, total_games=a.rand_seed_games, seats=["net:0"] * 3,
                               visits_full=a.visits_full, visits_fast=a.visits_fast, full_prob=a.full_prob,
                               seed=a.seed * 100000 + gen + 90000, rule=a.rule, rand_prob=1.0, rand_min=a.rand_min, rand_max=a.rand_max)
        stats = {}
        dr = D.decode(run_driver(drv, {0: model}, device, stats))
        D.save_shard(os.path.join(rand_dir, f"gen{gen:04d}.npz"), dr)
        log(f"ランダム局面から {a.rand_seed_games}局をまとめて作成 {time.time()-t:.0f}秒（最初のランダムな手 平均{dr['g_rand'].mean():.0f}手）"
            f" 局面 {len(dr['winner'])} {json.dumps(summarize_games(dr), ensure_ascii=False)}")
    # 大差局面の候補：これまでの「自己対局のみ」のシャードから集める（駒はいじらない、実際の局面）。新しい世代の分は毎世代足す
    starts = np.zeros((0, 109), dtype=np.uint8)
    if a.lead_share > 0:
        files = [f for f in glob.glob(os.path.join(shard_dir, "gen*.npz")) if int(os.path.basename(f)[3:7]) >= a.lead_from]
        if files:
            starts = np.concatenate([lead_states(D.load_shard(f), a.lead_min) for f in files])
        log(f"大差局面（{a.lead_min}枚以上リード）の候補 {len(starts)}局面（世代{a.lead_from}以降の自己対局 {len(files)}シャードから）")
        # 人の対局から取り出した局面（add_start_positions.py）も足す
        extra = sorted(glob.glob(os.path.join(root, "start_positions", "*.npy")))
        if extra:
            ex = np.concatenate([np.load(f) for f in extra])
            starts = np.concatenate([starts, ex])
            log(f"  人の対局から {len(ex)}局面（{len(extra)}ファイル）→ {len(starts)}局面")
    for _ in range(a.gens):
        # 学習率：蒸留直後の数世代は低く（--lr-warm）
        warm = a.lr_warm is not None and gen < a.lr_warm_gens + 1
        for g_ in opt.param_groups:
            g_["lr"] = a.lr_warm if warm else a.lr
        # 学習：ステップ数は、直近のシャード（新しく増えた局面）の数 × train_ratio ÷ バッチ
        # --mix-share / --adj-share を使うときは、自己対局のみ／他のモデル入り／調整局面 の3つのバッファから決めた比率で混ぜる
        t = time.time()
        pools = a.mix_share > 0 or a.adj_share > 0 or a.rand_share > 0 or a.lead_share > 0
        pure_r = 1 - a.mix_share - a.adj_share - a.rand_share - a.lead_share
        if pools:
            win = D.MultiWindow([("自己対局のみ", D.Window(shard_dir, a.window), pure_r),
                                 ("他のモデル入り", D.Window(mix_dir, int(a.window * a.mix_share / pure_r)), a.mix_share),
                                 ("調整局面", D.Window(adj_dir, int(a.window * a.adj_share / pure_r)), a.adj_share),
                                 ("ランダム局面から", D.Window(rand_dir, int(a.window * a.rand_share / pure_r)), a.rand_share),
                                 ("大差局面から", D.Window(lead_dir, int(a.window * a.lead_share / pure_r)), a.lead_share)])
        else:
            win = D.Window(shard_dir, a.window)
        newest = max(glob.glob(os.path.join(shard_dir, "*.npz")), key=os.path.getmtime)
        new_pos = int(len(D.load_shard(newest)["winner"]) / (pure_r if pools else 1))
        steps = max(1, int(np.ceil(new_pos * a.train_ratio / a.batch)))
        L = train_steps(model, opt, scaler, win, steps, a.batch, device, rng, q_mix=a.q_mix)
        gen += 1
        M.save(model, model_path(gen), extra=dict(train=L))
        wdesc = win.describe() if pools else f"{win.n}局面/{win.files}シャード"
        log(f"世代{gen}: 学習 {steps}ステップ lr={opt.param_groups[0]['lr']}（新規 {new_pos}局面、窓 {wdesc}）{time.time()-t:.0f}秒 "
            + " ".join(f"{k}={v:.3f}" for k, v in L.items()))

        # 自己対局。学習データは現世代の手番だけ
        t = time.time()
        models, pool, weak = {0: model}, [], None
        if a.past_prob > 0 or (pools and a.mix_share > 0):   # 過去の世代
            cands = [g for g in range(a.past_start, gen, a.past_every) if os.path.exists(model_path(g))][-a.past_max:]
            pool = [cands[(gen * a.past_per_gen + j) % len(cands)] for j in range(min(a.past_per_gen, len(cands)))] if cands else []
            for i, g in enumerate(pool):
                if g not in past_cache:
                    past_cache[g] = M.load(model_path(g), device).eval()
                models[i + 1] = past_cache[g]
        past_ids = [i for i in models if i > 0]
        if a.weak_models and (a.weak1_prob > 0 or a.weak2_prob > 0 or (pools and a.mix_share > 0)):   # 弱いモデル（別の実行）
            weak = a.weak_models[gen % len(a.weak_models)]
            if weak not in past_cache:
                run2, g2 = weak.split(":")
                past_cache[weak] = M.load(os.path.join(root, "..", run2, "models", f"gen{int(g2):04d}.pt"), device).eval()
            wi = len(models)
            models[wi] = past_cache[weak]

        def mixed_seats(w_past, w_weak1, w_weak2):
            """混ぜる対局の席の並び。Driver は alt_seats から等しい確率で選ぶので、割合に比例した数だけ並べる（0.5%単位）"""
            weighted = []
            for i in past_ids:
                w = w_past / 2 / len(past_ids)
                weighted += [(["net:0", "net:0", f"net:{i}"], w), (["net:0", f"net:{i}", f"net:{i}"], w)]
            if weak:
                weighted += [(["net:0", "net:0", f"net:{wi}"], w_weak1), (["net:0", f"net:{wi}", f"net:{wi}"], w_weak2)]
            return [s for s, w in weighted for _ in range(int(round(w / 0.005)))], sum(w for _, w in weighted)

        def play(n, alt, alt_prob, gift, seed):
            drv = shogi3_rs.Driver(parallel=a.parallel, total_games=n, seats=["net:0"] * 3,
                                   visits_full=a.visits_full, visits_fast=a.visits_fast, full_prob=a.full_prob,
                                   seed=seed, rule=a.rule, alt_seats=alt, alt_prob=alt_prob if alt else 0.0, gift_prob=gift)
            st = {}
            return D.decode(run_driver(drv, models, device, st)), st

        if not pools:
            alt, alt_prob = mixed_seats(a.past_prob, a.weak1_prob, a.weak2_prob)
            d, stats = play(a.games_per_gen, alt, alt_prob, a.gift_prob, a.seed * 100000 + gen)
            if past_ids:
                log(f"  過去の世代 {pool} を混ぜた対局: {past_summary(d, past_ids)}")
            if weak:
                log(f"  弱いモデル {weak} を混ぜた対局: {past_summary(d, [wi])}")
            D.save_shard(os.path.join(shard_dir, f"gen{gen:04d}.npz"), d)
            log(f"  自己対局 {time.time()-t:.0f}秒 推論 {stats['evals_per_sec']:.0f}局面/秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")
        elif a.adj_share == 0:
            # 自己対局のみ／他のモデル入り／ランダム局面から を、1つの Driver で同時に指して（GPU にまとめて計算させる）、終わってから山に分ける
            w_past = a.mix_past_weight if (past_ids and weak) else (1.0 if past_ids else 0.0)
            w_weak = 1.0 - w_past
            alt, _ = mixed_seats(w_past, w_weak / 2, w_weak / 2) if a.mix_share > 0 else ([], 0.0)
            drv = shogi3_rs.Driver(parallel=a.parallel, total_games=a.games_per_gen, seats=["net:0"] * 3,
                                   visits_full=a.visits_full, visits_fast=a.visits_fast, full_prob=a.full_prob,
                                   seed=a.seed * 100000 + gen, rule=a.rule, alt_seats=alt, alt_prob=a.mix_share if alt else 0.0,
                                   rand_prob=a.rand_share, rand_min=a.rand_min, rand_max=a.rand_max,
                                   start_prob=a.lead_share if len(starts) else 0.0, start_states=[bytes(s) for s in starts])
            stats = {}
            dall = D.decode(run_driver(drv, models, device, stats))
            is_mix = (dall["g_seat_net"] != 0).any(1)
            is_rand = dall["g_rand"] > 0
            is_lead = dall["g_start"] > 0
            pure = ~is_mix & ~is_rand & ~is_lead
            d = D.subset_games(dall, pure)
            D.save_shard(os.path.join(shard_dir, f"gen{gen:04d}.npz"), d)
            log(f"  自己対局 {a.games_per_gen}局 {time.time()-t:.0f}秒 推論 {stats['evals_per_sec']:.0f}局面/秒 / 自己対局のみ {int(pure.sum())}局 {json.dumps(summarize_games(d), ensure_ascii=False)}")
            if is_lead.any():
                dl = D.subset_games(dall, is_lead)
                D.save_shard(os.path.join(lead_dir, f"gen{gen:04d}.npz"), dl)
                log(f"  大差局面から {int(is_lead.sum())}局（始めた手数 平均{dl['g_start'].mean():.0f}手目） 局面 {len(dl['winner'])} {json.dumps(summarize_games(dl), ensure_ascii=False)}")
            if a.lead_share > 0:
                new = lead_states(d, a.lead_min)
                starts = np.concatenate([starts, new])
                log(f"  大差局面の候補 +{len(new)}局面 → {len(starts)}局面")
            if is_mix.any():
                dm = D.subset_games(dall, is_mix)
                D.save_shard(os.path.join(mix_dir, f"gen{gen:04d}.npz"), dm)
                log(f"  他のモデル入り {int(is_mix.sum())}局 局面 {len(dm['winner'])}"
                    + (f" / 過去の世代 {pool}: {past_summary(dm, past_ids)}" if past_ids else "")
                    + (f" / 弱いモデル {weak}: {past_summary(dm, [wi])}" if weak else ""))
            if is_rand.any():
                dr = D.subset_games(dall, is_rand)
                D.save_shard(os.path.join(rand_dir, f"gen{gen:04d}.npz"), dr)
                log(f"  ランダム局面から {int(is_rand.sum())}局（最初のランダムな手 平均{dr['g_rand'].mean():.0f}手） 局面 {len(dr['winner'])} {json.dumps(summarize_games(dr), ensure_ascii=False)}")
        else:
            G = a.games_per_gen
            n_mix, n_adj = int(round(G * a.mix_share)), int(round(G * a.adj_share))
            # 自己対局のみ（現世代3人、局面はいじらない）
            d, stats = play(G - n_mix - n_adj, [], 0.0, 0.0, a.seed * 100000 + gen)
            D.save_shard(os.path.join(shard_dir, f"gen{gen:04d}.npz"), d)
            log(f"  自己対局のみ {G - n_mix - n_adj}局 {time.time()-t:.0f}秒 推論 {stats['evals_per_sec']:.0f}局面/秒 {json.dumps(summarize_games(d), ensure_ascii=False)}")
            if n_mix:   # 他のモデル入り（過去の世代と弱いモデルを半々。どちらも 現世代2＋1 と 現世代1＋2 を半々。局面はいじらない）
                t = time.time()
                w_past = a.mix_past_weight if (past_ids and weak) else (1.0 if past_ids else 0.0)
                w_weak = 1.0 - w_past
                alt, _ = mixed_seats(w_past, w_weak / 2, w_weak / 2)
                dm, sm = play(n_mix, alt, 1.0, 0.0, a.seed * 100000 + gen + 50000)
                D.save_shard(os.path.join(mix_dir, f"gen{gen:04d}.npz"), dm)
                log(f"  他のモデル入り {n_mix}局 {time.time()-t:.0f}秒 局面 {len(dm['winner'])}"
                    + (f" / 過去の世代 {pool}: {past_summary(dm, past_ids)}" if past_ids else "")
                    + (f" / 弱いモデル {weak}: {past_summary(dm, [wi])}" if weak else ""))
            if n_adj:   # 調整局面（途中で1人に駒を渡して大差の局面を作る。現世代3人）
                t = time.time()
                da, sa = play(n_adj, [], 0.0, 1.0, a.seed * 100000 + gen + 70000)
                D.save_shard(os.path.join(adj_dir, f"gen{gen:04d}.npz"), da)
                log(f"  調整局面 {n_adj}局 {time.time()-t:.0f}秒 局面 {len(da['winner'])} {json.dumps(summarize_games(da), ensure_ascii=False)}")
        # 過学習の監視：まだ学習に使っていない、今の自己対局のデータで価値を測る
        vc = value_check(model, d, device)
        log(f"  価値（未学習データ）: 損失 {vc['loss']:.3f} 正解率 {vc['acc']*100:.1f}%（60手未満 {vc['acc_early']*100:.1f}%）")
        with open(os.path.join(root, "value_check.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(dict(gen=gen, train=L, heldout=vc), ensure_ascii=False) + chr(10))

        # 評価（相手は --eval-vs。固定の相手にすると世代ごとの推移が比べやすい）
        if gen % a.eval_every == 0:
            for opp in a.eval_vs:
                if opp == "scaffold":
                    r = evaluate({0: model}, ["net:0", f"scaffold:{a.eval_visits}", f"scaffold:{a.eval_visits}"],
                                 a.eval_games, a.eval_visits, device, 7 + gen, a.rule)
                    name = f"scaffold:{a.eval_visits}"
                elif opp.startswith("ext:"):  # 別の実行のモデル（例 ext:p4:51）
                    _, run2, g2 = opp.split(":")
                    other = M.load(os.path.join(root, "..", run2, "models", f"gen{int(g2):04d}.pt"), device).eval()
                    r = evaluate({0: model, 1: other}, ["net:0", "net:1", "net:1"], a.eval_games, a.eval_visits, device, 11 + gen, a.rule)
                    name = f"{run2}:gen{int(g2)}"
                else:
                    og = max(0, gen - a.eval_every) if opp == "prev" else int(opp.split(":")[1])
                    other = M.load(model_path(og), device).eval()
                    r = evaluate({0: model, 1: other}, ["net:0", "net:1", "net:1"], a.eval_games, a.eval_visits, device, 11 + gen, a.rule)
                    name = f"gen{og}"
                r.update(gen=gen, opponent=name)
                log(f"  評価 世代{gen} vs {name}×2: {r['wins']}/{r['games']} = {r['rate']}% (z={r['z']}) 平均{r['avg_plies']:.0f}手 {r['sec']}秒"
                    + f" 席別(青赤緑) {r['by_seat']}" + (f" ルール別 {r['by_rule']}" if "by_rule" in r else ""))
                with open(os.path.join(root, "eval.jsonl"), "a", encoding="utf-8") as f:
                    f.write(json.dumps(r, ensure_ascii=False) + chr(10))
    log("終了")


if __name__ == "__main__":
    main()
