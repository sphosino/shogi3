// ブラウザだけで動く学習AI（サーバーなし）。
// 探索とルールは WebAssembly（engine-rs/wasm）、ネットの推論は ONNX Runtime Web（WebGPU、使えなければ CPU）。
// 使い方：await LocalAI.init({ model: "web/models/xxx.onnx", wasm: "web/shogi3_wasm.wasm" });
//         const res = await LocalAI.think({ board, hand, eliminated, turn, moveCount, rule }); // res.move は game.js の手の形
(function (global) {
  "use strict";
  const PIECES = ["FU", "KY", "KE", "GIN", "KIN", "KAKU", "HI", "OU"];
  const RULE_ID = { all: 0, next: 1, vanish: 2 };
  const ruleName = (v) => (v === true || v === "all") ? "all" : v === "next" ? "next" : (v === false || v === "vanish") ? "vanish" : "all";

  const LocalAI = {
    ready: false,
    provider: null,   // "webgpu" か "wasm"
    visits: 800,
    batch: 16,
    temp: 0.5,        // 序盤のランダムさ（0で常に最多票の手）
    tempPlies: 15,

    async init(opt) {
      const o = Object.assign({ model: "web/models/pbig2-gen120.onnx", wasm: "web/shogi3_wasm.wasm" }, opt || {});
      const resp = await fetch(o.wasm);
      const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
      this.w = instance.exports;
      const ort = global.ort;
      ort.env.wasm.wasmPaths = o.ortWasmPaths || "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
      const providers = ("gpu" in navigator && !o.forceCpu) ? ["webgpu", "wasm"] : ["wasm"];
      let lastErr = null;
      for (const p of providers) {
        try {
          this.sess = await ort.InferenceSession.create(o.model, { executionProviders: [p] });
          this.provider = p;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!this.sess) throw lastErr || new Error("ネットを読み込めませんでした");
      this.model = o.model.split("/").pop().replace(/\.onnx$/, "");  // 例: pbig2-gen120
      if (this.provider === "wasm") { this.visits = o.cpuVisits || 200; this.batch = 4; }
      else { this.visits = o.visits || 800; this.batch = 16; }
      this.ready = true;
      return this.provider;
    },

    encode(req) {
      const st = new Uint8Array(109);
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        const x = req.board[r][c];
        if (x) st[r * 9 + c] = 1 + x.o * 16 + (x.pr ? 8 : 0) + PIECES.indexOf(x.p);
      }
      for (let o = 0; o < 3; o++) for (const p of req.hand[o]) st[81 + o * 7 + PIECES.indexOf(p)]++;
      for (let o = 0; o < 3; o++) st[102 + o] = req.eliminated[o] ? 1 : 0;
      st[105] = req.turn;
      st[106] = req.moveCount & 255; st[107] = (req.moveCount >> 8) & 255;
      st[108] = RULE_ID[ruleName(req.rule)];
      return st;
    },

    decodeMove(idx) {
      const to = idx % 81, rest = Math.floor(idx / 81), from = rest >> 1, pro = (rest & 1) === 1;
      if (from >= 81) return { drop: true, piece: PIECES[from - 81], tr: Math.floor(to / 9), tc: to % 9 };
      return { fr: Math.floor(from / 9), fc: from % 9, tr: Math.floor(to / 9), tc: to % 9, pro };
    },

    // req.timeMs があれば、その時間いっぱい探索する（なければ this.visits 回）
    async think(req) {
      const w = this.w, ort = global.ort, t0 = performance.now();
      const timed = req.timeMs > 0;
      const st = this.encode(req);
      const sp = w.alloc(109);
      new Uint8Array(w.memory.buffer, sp, 109).set(st);
      const ctx = w.search_new(sp, timed ? 100000 : this.visits, this.batch, 1.5);
      w.dealloc(sp, 109);
      let bufP = 0, bufV = 0, capP = 0, capV = 0;
      try {
        for (;;) {
          const k = w.search_next(ctx);
          if (k === 0) break;
          const L = w.search_legal_len(ctx);
          const states = new Uint8Array(w.memory.buffer, w.search_states_ptr(ctx), k * 109).slice();
          const legal = new Int32Array(w.memory.buffer, w.search_legal_ptr(ctx), k * L).slice();
          const out = await this.sess.run({ states: new ort.Tensor("uint8", states, [k, 109]) });
          const pol = out.policy.data, val = out.value.data, P = out.policy.dims[1];
          const priors = new Float32Array(k * L), values = new Float32Array(k * 3);
          for (let i = 0; i < k; i++) {
            let mx = -Infinity;
            for (let j = 0; j < L; j++) { const m = legal[i * L + j]; if (m >= 0) mx = Math.max(mx, pol[i * P + m]); }
            let sum = 0;
            for (let j = 0; j < L; j++) { const m = legal[i * L + j]; const e = m >= 0 ? Math.exp(pol[i * P + m] - mx) : 0; priors[i * L + j] = e; sum += e; }
            for (let j = 0; j < L; j++) priors[i * L + j] = sum > 0 ? priors[i * L + j] / sum : 0;
            let vm = -Infinity;
            for (let p = 0; p < 3; p++) if (!states[i * 109 + 102 + p]) vm = Math.max(vm, val[i * 3 + p]);
            let vs = 0;
            for (let p = 0; p < 3; p++) { const e = states[i * 109 + 102 + p] ? 0 : Math.exp(val[i * 3 + p] - vm); values[i * 3 + p] = e; vs += e; }
            for (let p = 0; p < 3; p++) values[i * 3 + p] /= vs;
          }
          // 書き込み用の領域（足りなければ取り直す。取り直すとメモリが増えて古い view は使えなくなるので、毎回 view を作る）
          if (priors.byteLength > capP) { if (capP) w.dealloc(bufP, capP); capP = priors.byteLength; bufP = w.alloc(capP); }
          if (values.byteLength > capV) { if (capV) w.dealloc(bufV, capV); capV = values.byteLength; bufV = w.alloc(capV); }
          new Float32Array(w.memory.buffer, bufP, priors.length).set(priors);
          new Float32Array(w.memory.buffer, bufV, values.length).set(values);
          w.search_submit(ctx, bufP, bufV);
          if (timed && performance.now() - t0 >= req.timeMs) break;
        }
        const n = w.search_result(ctx);
        const ch = new Int32Array(w.memory.buffer, w.search_children_ptr(ctx), n * 2).slice();
        const value = Array.from(new Float32Array(w.memory.buffer, w.search_value_ptr(ctx), 3));
        const kids = [];
        for (let i = 0; i < n; i++) kids.push({ idx: ch[i * 2], visits: ch[i * 2 + 1] });
        kids.sort((a, b) => b.visits - a.visits);
        let pick = kids[0];
        if (this.temp > 0 && req.moveCount < this.tempPlies && kids.length > 1 && pick.idx >= 0) {
          const ws = kids.map((x) => Math.pow(x.visits, 1 / this.temp));
          let r = Math.random() * ws.reduce((a, b) => a + b, 0);
          for (let i = 0; i < kids.length; i++) { r -= ws[i]; if (r <= 0) { pick = kids[i]; break; } }
        }
        return {
          move: pick.idx < 0 ? null : this.decodeMove(pick.idx),
          value: value.map((x) => Math.round(x * 1000) / 1000),
          top: kids.slice(0, 5).map((x) => ({ move: x.idx < 0 ? null : this.decodeMove(x.idx), visits: x.visits })),
          visits: kids.reduce((a, x) => a + x.visits, 0),
          sec: Math.round(performance.now() - t0) / 1000,
          provider: this.provider,
        };
      } finally {
        if (capP) w.dealloc(bufP, capP);
        if (capV) w.dealloc(bufV, capV);
        w.search_free(ctx);
      }
    },
  };
  global.LocalAI = LocalAI;
})(typeof window !== "undefined" ? window : globalThis);
