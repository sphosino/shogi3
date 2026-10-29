// 人が指した棋譜を送る（2026-10-30）。学習AIに「人ならではの局面」を見せるため。勝ち負けは使わない。review.js のあとに読みこむ
//   送るのは、ひとりで指す画面の対局のうち、ふつうの初期局面から人が指したものだけ（盤面編集・読みこんだ棋譜・自己対局は送らない）
//   人が脱落したところで打ち止め（そのあとの AI どうしの手は送らない）。10手未満は送らない
//   送るとき：人が脱落した・対局が終わった・新しい対局を始めた・ページを閉じた。同じ対局は同じ gid で送り、サーバーは手の多いほうを残す
//   送るもの：指し手・どの席が人だったか・ルール・AI の種類。名前などは送らない（プライバシーポリシーの「三人将棋の棋譜」）
//   みんなと指す部屋の対局は、サーバーが自分で保存するのでここでは送らない
(function () {
  // 手元で開いたときは送らない（試すときは ?kifuapi=http://127.0.0.1:8787/kifu のように送り先を付ける）
  const URL_ = location.hostname === 'mataasobo.com' ? 'https://api.mataasobo.com/kifu'
    : /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URLSearchParams(location.search).get('kifuapi') : null;
  if (!URL_) return;
  const MIN = 10;
  // ふつうの初期局面（game.js の init と同じ並び）
  const START = (() => {
    const b = Array.from({ length: 9 }, () => Array(9).fill(null)), put = (r, c, p, o) => { b[r][c] = { p, o, pr: false }; };
    [[8, 0, 'GIN'], [8, 1, 'KIN'], [8, 2, 'OU'], [8, 3, 'KIN'], [8, 4, 'GIN'], [7, 0, 'HI'], [7, 4, 'KAKU']].forEach(([r, c, p]) => put(r, c, p, 0));
    for (let c = 0; c <= 4; c++) put(6, c, 'FU', 0);
    [[0, 0, 'GIN'], [0, 1, 'KIN'], [0, 2, 'OU'], [0, 3, 'KIN'], [0, 4, 'GIN'], [1, 0, 'KAKU'], [1, 4, 'HI']].forEach(([r, c, p]) => put(r, c, p, 1));
    for (let c = 0; c <= 4; c++) put(2, c, 'FU', 1);
    [[2, 8, 'GIN'], [3, 8, 'KIN'], [4, 8, 'OU'], [5, 8, 'KIN'], [6, 8, 'GIN'], [2, 7, 'HI'], [6, 7, 'KAKU']].forEach(([r, c, p]) => put(r, c, p, 2));
    for (let r = 2; r <= 6; r++) put(r, 6, 'FU', 2);
    return JSON.stringify(b);
  })();
  const standard = (s) => s && (s.moveCount || 0) === 0 && s.turn === 0 && JSON.stringify(s.board) === START &&
    JSON.stringify(s.hand) === '[["KY","KE"],["KY","KE"],["KY","KE"]]' && !s.eliminated.some(Boolean);
  const ruleOf = (v) => (v === true || v === 'all' ? 'all' : v === 'next' ? 'next' : v === false || v === 'vanish' ? 'vanish' : 'all');
  const newGid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');

  const skip = new WeakSet();   // 読みこんだ棋譜（人が指したものとは限らない）
  if (typeof loadGameRecordText === 'function') {
    const orig = loadGameRecordText;
    window.loadGameRecordText = function () { const r = orig.apply(this, arguments); if (gameRecord) skip.add(gameRecord); return r; };
  }
  let cur = null;   // {rec, gid, humans:Set, cut, sent, ai}
  const payload = (c) => {
    const n = c.cut ?? c.rec.moves.length;
    if (skip.has(c.rec) || !c.humans.size || n < MIN || n <= c.sent || !standard(c.rec.start)) return null;
    return { n, body: JSON.stringify({ gid: c.gid, rule: ruleOf(c.rec.start.rule), humans: [...c.humans], ai: c.ai,
      moves: c.rec.moves.slice(0, n).map((m) => (m.resign ? { o: m.o, resign: true } : { o: m.o, mv: m.mv })) }) };
  };
  const send = (c, beacon) => {
    const p = c && payload(c); if (!p) return;
    c.sent = p.n;
    try {
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(URL_, new Blob([p.body], { type: 'text/plain' }));
      else fetch(URL_, { method: 'POST', body: p.body, headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(() => {});
    } catch (e) {}
  };
  setInterval(() => {
    if (typeof reviewMode !== 'undefined' && reviewMode) return;   // 検討中は棋譜が仮のものに入れかわることがある
    const rec = gameRecord;
    if (!cur || cur.rec !== rec) {   // 新しい対局：前の対局が送れていなければ送る
      if (cur) send(cur);
      cur = rec ? { rec, gid: newGid(), humans: new Set(), cut: null, sent: 0, ai: '' } : null;
    }
    if (!cur) return;
    if (!selfPlayMode && humanPlayer >= 0 && !(cur.cut !== null)) cur.humans.add(humanPlayer);
    cur.ai = aiKind === 'net' ? (window.LocalAI && LocalAI.model || 'net') + ':' + netTimeMs + 'ms' : 'cpu';
    if (selfPlayMode) skip.add(rec);
    if (humanEliminated && cur.cut === null) cur.cut = rec.moves.length;   // 人が脱落したところで打ち止め
    if (cur.cut !== null || gover) send(cur);
  }, 2000);
  addEventListener('pagehide', () => send(cur, true));
})();
