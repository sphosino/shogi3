"""局面（109バイトの形）→ ネットの入力チャンネル。GPU上で作る。

局面の形（engine-rs/py の encode_state と同じ）：
  盤 81（駒コード 0=空, 1+持ち主*16+成り*8+駒種） / 持ち駒 21（持ち主×駒種7） / 脱落 3 / 手番 1 / 手数 2（u16 LE）
  / 取り駒ルール 1（0=全部持ち駒 1=お裾分け 2=消滅あり）。ルールを持たない古い108バイトのデータは「全部持ち駒」として扱う

入力チャンネル（docs/ai_architecture.md。絶対座標のまま、回転しない）：
  駒 48（持ち主3 × 成り2 × 駒種8。成った金・玉は常に0）
  持ち駒 21（枚数 ÷ その駒の総数）
  脱落 3 / 手番 3 / 手数 1（÷500） / ルール 3（1つのネットで3つのルールを学ぶ）
  合計 79（ルールを入れる前のモデルは76。読み込むときに足りない分を重み0で足す：model.load）
"""
import torch
import torch.nn.functional as F

STATE_BYTES = 109
NUM_POLICY = 88 * 2 * 81
IN_CHANNELS = 48 + 21 + 3 + 3 + 1 + 3

# 駒種ごとの総数（歩香桂銀金角飛）
_HAND_MAX = torch.tensor([15, 3, 3, 6, 6, 3, 3], dtype=torch.float32)


def planes(states: torch.Tensor) -> torch.Tensor:
    """states: uint8 [N,109]（または古い [N,108]）→ float [N,79,9,9]"""
    n = states.shape[0]
    dev = states.device
    board = states[:, :81].long()
    pb = F.one_hot(board, 49)[..., 1:].permute(0, 2, 1).reshape(n, 48, 9, 9).float()
    hands = states[:, 81:102].float().view(n, 3, 7) / _HAND_MAX.to(dev)
    elim = states[:, 102:105].float()
    turn = F.one_hot(states[:, 105].long(), 3).float()
    ply = (states[:, 106].float() + states[:, 107].float() * 256.0) / 500.0
    rule = states[:, 108].long() if states.shape[1] > 108 else torch.zeros(n, dtype=torch.long, device=dev)
    glob = torch.cat([hands.view(n, 21), elim, turn, ply.view(n, 1), F.one_hot(rule, 3).float()], dim=1)  # [N,31]
    return torch.cat([pb, glob.view(n, 31, 1, 1).expand(n, 31, 9, 9)], dim=1)


def alive_mask(states: torch.Tensor) -> torch.Tensor:
    """脱落していない人 → True [N,3]"""
    return states[:, 102:105] == 0
