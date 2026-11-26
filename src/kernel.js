/*
 * ml-path-lab kernel
 * 狭窄光路通道的路径空间马尔可夫渲染原型（无 DOM 依赖，可在 Node 测试）。
 *
 * 路径参数化（初版唯一受支持族）：
 *   E(面光源点) -> P(屏幕/传感器点) 的直接光路，在 x=0 处做狭缝可见性测试。
 *   状态 theta = (ey, ez, py, pz)，关于乘积面积测度 dA_E dA_P。
 *   目标标量 fstar = luminance(f_RGB)，链的平稳密度 pi = fstar/b，b = ∫ fstar dμ。
 *   图像估计：Î = Σ_k w_time,k · (b_k / n_k) Σ_i (f_RGB/fstar) · pixel(P_i)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MLK = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const D_X = 1.6;                 // 光源平面 x=-D_X，遮板 x=0，屏幕 x=+D_X
  const FILM_W = 160;
  const FILM_H = 108;
  const LUM_W = [0.2126, 0.7152, 0.0722];

  function lumRGB(r, g, b) {
    return LUM_W[0] * r + LUM_W[1] * g + LUM_W[2] * b;
  }

  // ---------------- 确定性随机数 ----------------
  class RNG {
    constructor(seed) {
      this.seed = (seed >>> 0) || 1;
      this._a = this.seed;
    }
    next() {
      let a = this._a | 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      this._a = a;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(n) { return Math.floor(this.next() * n); }
  }

  // ---------------- 控件 schema（界面由内核驱动） ----------------
  const SCHEMA = {
    slitHw:   { label: '狭缝半宽', min: 0.012, max: 0.12, step: 0.001, def: 0.045, unit: '世界单位' },
    slitCy:   { label: '狭缝中心 y', min: -0.85, max: 0.85, step: 0.005, def: 0.58 },
    transmission: { label: '暗色帘透射率 T', min: 0.02, max: 0.6, step: 0.01, def: 0.12 },
    sigma:    { label: '细扰动半径 σ', min: 0.008, max: 0.2, step: 0.002, def: 0.05 },
    globalProb: { label: '全局跳转预算 g', min: 0, max: 1, step: 0.01, def: 0.3 },
    chains:   { label: '独立链数', min: 1, max: 12, step: 1, def: 2 },
    stepsPerFrame: { label: '每帧突变数', min: 100, max: 20000, step: 100, def: 6000 },
    openFraction: { label: 'B 路开口时刻（预算比例）', min: 0.1, max: 0.9, step: 0.05, def: 0.5 },
    totalSteps: { label: '剧本总突变预算', min: 20000, max: 1200000, step: 10000, def: 720000 },
    exposure: { label: '显示增益（仅显示变换）', min: 200, max: 60000, step: 100, def: 14000 }
  };

  function defaultScene() {
    return {
      D: D_X,
      eyHalf: 0.18,
      ezHalf: 0.55,
      syHalf: 1.4,
      szHalf: 0.95,
      emitterPower: 7.0,
      uniform: false,
      sceneVersion: 1,
      slits: [
        { id: 'A', name: '通路 A', cy: -0.58, cz: 0, hw: SCHEMA.slitHw.def, hh: 0.52, open: true,  blocker: 'open',   T: 0, tint: [0.70, 0.85, 1.00] },
        { id: 'B', name: '通路 B', cy:  0.58, cz: 0, hw: SCHEMA.slitHw.def, hh: 0.52, open: false, blocker: 'door', T: 0, tint: [1.00, 0.86, 0.66] }
      ]
    };
    return normalizeScene(scene);
  }

  function cloneScene(s) {
    const c = Object.assign({}, s, { slits: s.slits.map(x => Object.assign({}, x, { tint: x.tint.slice() })) });
    return normalizeScene(c);
  }

  function boxVolume(scene) {
    return (2 * scene.eyHalf) * (2 * scene.ezHalf) * (2 * scene.syHalf) * (2 * scene.szHalf);
  }

  function inStateBox(scene, st) {
    return Math.abs(st.ey) <= scene.eyHalf && Math.abs(st.ez) <= scene.ezHalf &&
           Math.abs(st.py) <= scene.syHalf && Math.abs(st.pz) <= scene.szHalf;
  }

  function uniformState(scene, rng, out) {
    const st = out || {};
    st.ey = rng.range(-scene.eyHalf, scene.eyHalf);
    st.ez = rng.range(-scene.ezHalf, scene.ezHalf);
    st.py = rng.range(-scene.syHalf, scene.syHalf);
    st.pz = rng.range(-scene.szHalf, scene.szHalf);
    return st;
  }

  // 狭缝平面 x=0 处的穿越点（E 与 P 的中点，因为光源/屏幕关于墙等距）
  function crossing(scene, st) {
    return { yc: (st.ey + st.py) * 0.5, zc: (st.ez + st.pz) * 0.5 };
  }

  function hitSlit(scene, st) {
    if (!inStateBox(scene, st)) return null;
    const c = crossing(scene, st);
    for (const s of scene.slits) {
      if (Math.abs(c.yc - s.cy) <= s.hw && Math.abs(c.zc - s.cz) <= s.hh) return s;
    }
    return null;
  }

  // 通路在几何上是否透光：开口、或挂暗色帘（T>0 的低能量通路）。
  // 不透光滑门（blocker='door'）使整族路径从目标支持域中消失。blocker 为权威字段。
  function slitTransmits(s) {
    if (s.blocker === 'curtain') return (s.T == null ? SCHEMA.transmission.def : s.T) > 0;
    if (s.blocker === 'door') return false;
    return true; // blocker === 'open'（含旧数据缺省值经 normalizeScene 校正后）
  }

  // 载入/构造场景时校正旧字段：保证 open 与 blocker 一致，避免只翻 open 的遗留调用产生矛盾。
  function normalizeScene(scene) {
    for (const s of scene.slits) {
      if (!s.blocker) s.blocker = s.open ? 'open' : 'door';
      if (s.blocker === 'open') s.open = true;
      if (s.blocker === 'door') { s.open = false; s.T = 0; }
      if (s.T == null) s.T = 0;
    }
    return scene;
  }

  const ZERO_EVAL = { star: 0, rgb: [0, 0, 0], slitId: null, geom: 0, blockedBy: null };

  // 路径贡献 f(theta)。直接光路 E->P：Le * G(E,P) * V_slit * We。
  // blocker 三态（同一窄窗几何，只换材质/遮挡）：
  //   open    -> 全透光；door -> 零贡献（路径族消失）；curtain -> 乘以透射率 T（低能量通路仍在）。
  function evalPath(scene, st) {
    if (!inStateBox(scene, st)) return ZERO_EVAL;
    let slit = null;
    if (!scene.uniform) {
      slit = hitSlit(scene, st);
      if (!slit) return ZERO_EVAL;
      if (!slitTransmits(slit)) {
        return { star: 0, rgb: [0, 0, 0], slitId: null, geom: 0, blockedBy: slit.id };
      }
    }
    const dx = 2 * scene.D;
    const ry = st.py - st.ey;
    const rz = st.pz - st.ez;
    const r2 = dx * dx + ry * ry + rz * rz;
    const invR = 1 / Math.sqrt(r2);
    const cos = dx * invR;
    const G = cos * cos / r2;                 // 3D 面积测度几何项
    const T = slit && slit.blocker === 'curtain' ? (slit.T == null ? SCHEMA.transmission.def : slit.T) : 1;
    const scalar = scene.emitterPower * G * T;
    const tint = slit ? slit.tint : [1, 1, 1];
    const r = scalar * tint[0], g = scalar * tint[1], b = scalar * tint[2];
    return { star: lumRGB(r, g, b), rgb: [r, g, b], slitId: slit ? slit.id : 'U', geom: G, blockedBy: null };
  }

  // ---------------- 像素映射 / 胶片 ----------------
  function pixelOf(scene, W, H, st) {
    let ix = Math.floor((st.py + scene.syHalf) / (2 * scene.syHalf) * W);
    let iy = Math.floor((st.pz + scene.szHalf) / (2 * scene.szHalf) * H);
    if (ix < 0) ix = 0; else if (ix >= W) ix = W - 1;
    if (iy < 0) iy = 0; else if (iy >= H) iy = H - 1;
    return { ix, iy };
  }

  class Film {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.rgb = new Float64Array(W * H * 3);
      this.counts = new Uint32Array(W * H);
    }
    deposit(ix, iy, wr, wg, wb) {
      const p = (iy * this.W + ix) * 3;
      this.rgb[p] += wr; this.rgb[p + 1] += wg; this.rgb[p + 2] += wb;
      this.counts[iy * this.W + ix]++;
    }
    energy() {
      let r = 0, g = 0, b = 0, lum = 0;
      const a = this.rgb;
      for (let i = 0; i < a.length; i += 3) {
        r += a[i]; g += a[i + 1]; b += a[i + 2];
        lum += LUM_W[0] * a[i] + LUM_W[1] * a[i + 1] + LUM_W[2] * a[i + 2];
      }
      return { r, g, b, lum };
    }
    regionEnergy(roi) {
      // roi: py 范围 [lo,hi]（z 全高），与像素列相交
      const x0 = Math.max(0, Math.floor((roi.lo + 1.4) / 2.8 * this.W)); // 用 scene 无关的归一化需外部传
      return null;
    }
  }

  // 依据给定物理范围计算区域能量（img 为已合成线性图，含 W/H）
  function imageEnergy(img) {
    let r = 0, g = 0, b = 0, lum = 0;
    const d = img.data;
    for (let i = 0; i < d.length; i += 3) {
      r += d[i]; g += d[i + 1]; b += d[i + 2];
      lum += LUM_W[0] * d[i] + LUM_W[1] * d[i + 1] + LUM_W[2] * d[i + 2];
    }
    return { r, g, b, lum };
  }

  function imageRegionEnergy(img, scene, lo, hi) {
    const x0 = Math.max(0, Math.floor((lo + scene.syHalf) / (2 * scene.syHalf) * img.W));
    const x1 = Math.min(img.W - 1, Math.ceil((hi + scene.syHalf) / (2 * scene.syHalf) * img.W));
    let lum = 0, r = 0, g = 0, b = 0, pixels = 0, samples = 0;
    for (let y = 0; y < img.H; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = (y * img.W + x) * 3;
        r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2];
        lum += LUM_W[0] * img.data[p] + LUM_W[1] * img.data[p + 1] + LUM_W[2] * img.data[p + 2];
        pixels++;
        if (img.counts) samples += img.counts[y * img.W + x];
      }
    }
    return { lum, r, g, b, pixels, samples, x0, x1 };
  }

  function slitScreenROI(scene, s) {
    // 给定 ey 范围，通路在屏幕 py 上的投影包络
    return {
      lo: Math.max(-scene.syHalf, 2 * s.cy - scene.eyHalf - 2 * s.hw),
      hi: Math.min( scene.syHalf, 2 * s.cy + scene.eyHalf + 2 * s.hw)
    };
  }

  // ---------------- 提议分布（密度显式、可追踪） ----------------
  const DIMS = 4;

  function localPdf(scene, x, y, cfg) {
    const sig = cfg.sigma;
    if (cfg.shape === 'gaussian') {
      let p = 1;
      const c = 1 / (sig * Math.sqrt(2 * Math.PI));
      for (const k of ['ey', 'ez', 'py', 'pz']) {
        const d = y[k] - x[k];
        p *= c * Math.exp(-(d * d) / (2 * sig * sig));
      }
      return p;
    }
    // 默认：有界均匀立方体，支撑域精确为 [x-sigma,x+sigma]^4
    for (const k of ['ey', 'ez', 'py', 'pz']) {
      if (Math.abs(y[k] - x[k]) > sig + 1e-15) return 0;
    }
    return Math.pow(2 * sig, -DIMS);
  }

  // q(x -> y) = g * p_ind(y) + (1-g) * T_local(y|x)，完整混合密度（不是被抽中的分量）
  function proposalQ(scene, x, y, cfg) {
    const g = cfg.globalProb;
    const qGlobal = inStateBox(scene, y) ? 1 / boxVolume(scene) : 0;
    const qLocal = localPdf(scene, x, y, cfg);
    return g * qGlobal + (1 - g) * qLocal;
  }

  function propose(scene, x, cfg, rng, out) {
    const y = out || {};
    let kind;
    if (rng.next() < cfg.globalProb) {
      kind = 'global';
      uniformState(scene, rng, y);
    } else {
      kind = 'local';
      if (cfg.shape === 'gaussian') {
        for (const k of ['ey', 'ez', 'py', 'pz']) {
          // Box-Muller
          const u1 = Math.max(1e-12, rng.next());
          const u2 = rng.next();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          y[k] = x[k] + cfg.sigma * z;
        }
      } else {
        for (const k of ['ey', 'ez', 'py', 'pz']) {
          y[k] = x[k] + cfg.sigma * (2 * rng.next() - 1);
        }
      }
    }
    return { y, kind };
  }

  // 用预先抽好的扰动向量构造局部提议（供双运行 CRN 同步）
  function localMoveFromDraws(x, sigma, draws) {
    return {
      ey: x.ey + sigma * (2 * draws[0] - 1),
      ez: x.ez + sigma * (2 * draws[1] - 1),
      py: x.py + sigma * (2 * draws[2] - 1),
      pz: x.pz + sigma * (2 * draws[3] - 1)
    };
  }

  // ---------------- 归一化常数 b 的独立 MC 估计（来源可追踪） ----------------
  function estimateB(scene, n, rng) {
    rng = rng || new RNG(0xBEEF);
    const V = boxVolume(scene);
    let sum = 0, sum2 = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    const bySlit = {};
    for (const s of scene.slits) bySlit[s.id] = { sum: 0, sum2: 0, n: 0, b: 0 };
    if (scene.uniform) bySlit.U = { sum: 0, sum2: 0, n: 0, b: 0 };
    const st = {};
    for (let i = 0; i < n; i++) {
      uniformState(scene, rng, st);
      const f = evalPath(scene, st);
      sum += f.star;
      sum2 += f.star * f.star;
      sumR += f.rgb[0]; sumG += f.rgb[1]; sumB += f.rgb[2];
      const key = f.slitId || 'zero';
      if (bySlit[key]) { bySlit[key].sum += f.star; bySlit[key].sum2 += f.star * f.star; bySlit[key].n++; }
    }
    const mean = sum / n;
    const varMean = Math.max(0, sum2 / n - mean * mean) / n;
    const info = {
      b: V * mean,
      se: V * Math.sqrt(varMean),
      n,
      volume: V,
      proposal: 'p_ind = 1/V 的全状态盒均匀独立采样',
      densityFormula: 'p(theta)=1/V, V=(2eyH)(2ezH)(2pyH)(2pzH)=' + V.toFixed(5),
      rgb: [V * sumR / n, V * sumG / n, V * sumB / n],
      bBySlit: {},
      sceneVersion: scene.sceneVersion,
      uniform: !!scene.uniform
    };
    for (const k of Object.keys(bySlit)) {
      const o = bySlit[k];
      info.bBySlit[k] = { b: V * o.sum / n, hits: o.n, hitFraction: o.n / n };
    }
    return info;
  }

  // ---------------- 实验 / 链 ----------------
  let EXP_SEQ = 1;

  class Experiment {
    constructor(opts) {
      opts = opts || {};
      this.id = EXP_SEQ++;
      this.name = opts.name || ('运行 ' + this.id);
      this.scene = opts.scene || defaultScene();
      this.W = opts.W || FILM_W;
      this.H = opts.H || FILM_H;
      this.rng = opts.rng || new RNG(opts.seed || (1000 + this.id * 77));
      this.cfg = {
        globalProb: opts.globalProb != null ? opts.globalProb : SCHEMA.globalProb.def,
        sigma: opts.sigma != null ? opts.sigma : SCHEMA.sigma.def,
        shape: opts.shape || 'cube'
      };
      this.numChains = opts.chains || SCHEMA.chains.def;
      this.chains = [];
      this.stages = [];
      this.stage = null;
      this.cursor = 0;
      this.totalSteps = 0;
      this.stats = this._freshStats();
      this.trace = [];
      this.maxTrace = 160;
      this.recentModes = [];
      this.recentMax = 1200;
      this.events = [];
      this.coverage = new Uint32Array(this.W * this.H);
      this.evidence = null;
    }

    _freshStats() {
      return {
        proposed: 0, accepted: 0, rejected: 0,
        global: { proposed: 0, accepted: 0 },
        local: { proposed: 0, accepted: 0 }
      };
    }

    logEvent(kind, msg, data) {
      const e = { t: this.totalSteps, kind, msg, data: data || null, time: Date.now() };
      this.events.push(e);
      if (this.events.length > 200) this.events.shift();
      return e;
    }

    resetChains(positive = true) {
      this.chains = [];
      for (let c = 0; c < this.numChains; c++) {
        let st = uniformState(this.scene, this.rng);
        let f = evalPath(this.scene, st);
        if (positive) {
          for (let tries = 0; tries < 500 && f.star === 0; tries++) {
            uniformState(this.scene, this.rng, st);
            f = evalPath(this.scene, st);
          }
        }
        this.chains.push({ state: st, f, initTries: 0 });
      }
    }

    // 独立初始化全部链（大步探索的兜底），返回每条链落到的模式
    independentReinitialize() {
      const modes = [];
      for (const ch of this.chains) {
        let st = uniformState(this.scene, this.rng);
        let f = evalPath(this.scene, st);
        let tries = 1;
        for (; tries < 2000 && f.star === 0; tries++) {
          uniformState(this.scene, this.rng, st);
          f = evalPath(this.scene, st);
        }
        ch.state = st; ch.f = f; ch.initTries = tries;
        modes.push(f.slitId);
      }
      this.logEvent('restart', '独立初始化 ' + this.chains.length + ' 条链，模式: ' + modes.map(m => m || 'zero').join(','));
      return modes;
    }

    reset(opts) {
      opts = opts || {};
      this.numChains = opts.chains || this.numChains;
      if (opts.globalProb != null) this.cfg.globalProb = opts.globalProb;
      if (opts.sigma != null) this.cfg.sigma = opts.sigma;
      this.stats = this._freshStats();
      this.trace = [];
      this.recentModes = [];
      this.totalSteps = 0;
      this.coverage = new Uint32Array(this.W * this.H);
      this.stages = [];
      const bInfo = opts.bInfo || estimateB(this.scene, opts.bSamples || 200000, this.rng);
      this.resetChains(true);
      this.beginStage({ label: opts.label || '阶段 1', bInfo, timeWeight: 1 });
      return bInfo;
    }

    beginStage(opts) {
      const stage = {
        index: this.stages.length,
        label: opts.label || ('阶段 ' + (this.stages.length + 1)),
        bInfo: opts.bInfo,
        b: opts.bInfo.b,
        timeWeight: opts.timeWeight != null ? opts.timeWeight : 1,
        film: new Film(this.W, this.H),
        n: 0,
        createdAtStep: this.totalSteps,
        sceneVersion: this.scene.sceneVersion,
        modeCounts: {},
        modeLumRaw: {},
        kindStats: { global: { proposed: 0, accepted: 0 }, local: { proposed: 0, accepted: 0 } }
      };
      this.stages.push(stage);
      this.stage = stage;
      this.logEvent('stage', stage.label + ' 开始，b=' + stage.b.toExponential(4) +
        '（' + (opts.bInfo.proposal || '外部给定') + '），时间权重=' + stage.timeWeight);
      return stage;
    }

    // 记录一个状态到当前阶段胶片（拒绝状态也会再次沉积）
    _recordState(chain) {
      const f = chain.f;
      const stage = this.stage;
      if (f.star <= 0) return;
      const wr = stage.b * f.rgb[0] / f.star;
      const wg = stage.b * f.rgb[1] / f.star;
      const wb = stage.b * f.rgb[2] / f.star;
      const px = pixelOf(this.scene, this.W, this.H, chain.state);
      stage.film.deposit(px.ix, px.iy, wr, wg, wb);
      this.coverage[px.iy * this.W + px.ix]++;
      stage.n++;
      const mode = f.slitId || 'U';
      stage.modeCounts[mode] = (stage.modeCounts[mode] || 0) + 1;
      // lum(rgb/star)=1，故每状态的模式亮度原始累计恰为 b
      stage.modeLumRaw[mode] = (stage.modeLumRaw[mode] || 0) + stage.b;
      this.recentModes.push(mode);
      if (this.recentModes.length > this.recentMax) this.recentModes.shift();
    }

    step() {
      if (!this.stage) throw new Error('Experiment.step() before reset()/beginStage()');
      const ci = this.cursor % this.chains.length;
      this.cursor++;
      const chain = this.chains[ci];
      const x = chain.state;
      if (!chain.f) chain.f = evalPath(this.scene, x);
      const fx = chain.f;
      const { y, kind } = propose(this.scene, x, this.cfg, this.rng);
      const fy = evalPath(this.scene, y);
      const qf = proposalQ(this.scene, x, y, this.cfg);
      const qr = proposalQ(this.scene, y, x, this.cfg);
      let alpha;
      if (fx.star === 0 && fy.star === 0) alpha = 0;
      else if (fx.star === 0) alpha = 1;
      else if (fy.star === 0) alpha = 0;
      else alpha = Math.min(1, fy.star * qr / (fx.star * qf));
      if (!isFinite(alpha)) alpha = 0;
      const u = this.rng.next();
      const accepted = u < alpha;

      this.totalSteps++;
      this.stats.proposed++;
      this.stats[kind].proposed++;
      this.stage.kindStats[kind].proposed++;
      if (accepted) {
        this.stats.accepted++;
        this.stats[kind].accepted++;
        this.stage.kindStats[kind].accepted++;
        chain.state = y;
        chain.f = fy;
      } else {
        this.stats.rejected++;
      }
      this._recordState(chain);

      const tr = {
        t: this.totalSteps, chain: ci, kind, accepted, u, alpha,
        fxStar: fx.star, fyStar: fy.star,
        fxMode: fx.slitId, fyMode: fy.slitId,
        qf, qr, g: this.cfg.globalProb, sigma: this.cfg.sigma,
        x: { ey: x.ey, ez: x.ez, py: x.py, pz: x.pz },
        y: { ey: y.ey, ez: y.ez, py: y.py, pz: y.pz }
      };
      this.trace.push(tr);
      if (this.trace.length > this.maxTrace) this.trace.shift();
      return tr;
    }

    run(n) {
      for (let i = 0; i < n; i++) this.step();
      return this;
    }

    acceptanceRate(kind) {
      if (kind) {
        const k = this.stats[kind];
        return k.proposed ? k.accepted / k.proposed : null;
      }
      return this.stats.proposed ? this.stats.accepted / this.stats.proposed : null;
    }

    modeRates(stageIndex) {
      const stage = stageIndex == null ? this.stage : this.stages[stageIndex];
      if (!stage || !stage.n) return {};
      const out = {};
      for (const k of Object.keys(stage.modeCounts)) out[k] = stage.modeCounts[k] / stage.n;
      return out;
    }

    // 合成线性图像：sum_k timeWeight_k * film_k / n_k
    compose(opts) {
      opts = opts || {};
      const onlyStage = opts.stageIndex != null ? [this.stages[opts.stageIndex]] : this.stages;
      const data = new Float64Array(this.W * this.H * 3);
      const counts = opts.counts ? new Uint32Array(this.W * this.H) : null;
      for (const stg of onlyStage) {
        if (!stg || !stg.n) continue;
        const w = (opts.stageIndex != null ? 1 : stg.timeWeight) / stg.n;
        const a = stg.film.rgb;
        for (let i = 0; i < data.length; i++) data[i] += w * a[i];
        if (counts) {
          for (let i = 0; i < counts.length; i++) counts[i] += stg.film.counts[i];
        }
      }
      return { W: this.W, H: this.H, data, counts };
    }

    // 账目核对：胶片亮度累计 / n 必须等于 b（拒绝状态也沉积）
    audit() {
      const out = [];
      for (const stg of this.stages) {
        const e = stg.film.energy();
        out.push({
          stage: stg.label, n: stg.n, b: stg.b,
          rawLumPerSample: stg.n ? e.lum / stg.n : 0,
          relErr: stg.n ? (e.lum / stg.n - stg.b) / stg.b : 0,
          deposits: stg.n,
          acceptedPlusRejected: this.stats.proposed // 全局统计仅参考
        });
      }
      return out;
    }
  }

  // ---------------- 双运行对照（CRN 同步前半段） ----------------
  // 用同一组均匀随机数，对 A/B 施加完全相同的局部立方体突变与接受判定。
  function pairedSyncStep(A, B, rng) {
    const nCh = Math.min(A.chains.length, B.chains.length);
    for (let ci = 0; ci < nCh; ci++) {
      const chA = A.chains[ci], chB = B.chains[ci];
      const draws = [rng.next(), rng.next(), rng.next(), rng.next()];
      const u = rng.next();
      const sigma = A.cfg.sigma;
      const xSnap = { ey: chA.state.ey, ez: chA.state.ez, py: chA.state.py, pz: chA.state.pz };
      const y = localMoveFromDraws(chA.state, sigma, draws);
      const cfgLocal = { globalProb: 0, sigma, shape: 'cube' };
      const qf = proposalQ(A.scene, chA.state, y, cfgLocal);
      const qr = proposalQ(A.scene, y, chA.state, cfgLocal);
      const fy = evalPath(A.scene, y);
      const fx = chA.f;
      let alpha = fx.star === 0 ? (fy.star > 0 ? 1 : 0)
        : fy.star === 0 ? 0 : Math.min(1, fy.star * qr / (fx.star * qf));
      const accepted = u < alpha;

      for (const [E, ch] of [[A, chA], [B, chB]]) {
        E.totalSteps++;
        E.stats.proposed++; E.stats.local.proposed++;
        E.stage.kindStats.local.proposed++;
        if (accepted) {
          E.stats.accepted++; E.stats.local.accepted++;
          E.stage.kindStats.local.accepted++;
          // 两个实验各自持有 state 对象，写入相同坐标
          ch.state.ey = y.ey; ch.state.ez = y.ez; ch.state.py = y.py; ch.state.pz = y.pz;
          ch.f = fy;
        } else {
          E.stats.rejected++;
        }
        E._recordState(ch);
      }
      // 以 A 的名义留一条轨迹
      A.trace.push({
        t: A.totalSteps, chain: ci, kind: 'local-crn', accepted, u, alpha,
        fxStar: fx.star, fyStar: fy.star, fxMode: fx.slitId, fyMode: fy.slitId,
        qf, qr, g: 0, sigma, crn: true,
        x: xSnap, y
      });
      if (A.trace.length > A.maxTrace) A.trace.shift();
    }
    A.cursor = (A.cursor + 1) % A.chains.length;
    B.cursor = A.cursor;
  }

  class Comparison {
    constructor(opts) {
      opts = opts || {};
      this.W = opts.W || FILM_W;
      this.H = opts.H || FILM_H;
      this.scene = opts.scene || defaultScene();
      this.rngB = new RNG(424242);
      this.A = new Experiment({ scene: this.scene, W: this.W, H: this.H, seed: 10101, name: 'A · 全支持全局提议 + 细扰动', globalProb: SCHEMA.globalProb.def });
      this.B = new Experiment({ scene: this.scene, W: this.W, H: this.H, seed: 20202, name: 'B · 仅细扰动（无全局支持域）', globalProb: 0 });
      this.sharedRng = new RNG(777001);
      this.phase = 'idle';
      this.donePre = 0; this.donePost = 0;
      this.preTarget = 0; this.postTarget = 0;
      this.openFraction = SCHEMA.openFraction.def;
      this.totalSteps = SCHEMA.totalSteps.def;
      this.bSamples = 250000;
      this.events = [];
    }

    emit(kind, msg, data) {
      const e = { time: Date.now(), kind, msg, data: data || null };
      this.events.push(e);
      if (this.events.length > 300) this.events.shift();
      return e;
    }

    reset(opts) {
      opts = opts || {};
      this.totalSteps = opts.totalSteps || this.totalSteps;
      this.openFraction = opts.openFraction != null ? opts.openFraction : this.openFraction;
      this.bSamples = opts.bSamples || this.bSamples;
      const chains = opts.chains || SCHEMA.chains.def;
      const sigma = opts.sigma != null ? opts.sigma : SCHEMA.sigma.def;
      const g = opts.globalProb != null ? opts.globalProb : SCHEMA.globalProb.def;

      // 剧本开始：B 遮板关闭（不透光滑门，路径族消失）
      this.scene.slits[1].open = false;
      if (this.scene.slits[1].blocker === 'curtain') this.scene.slits[1].blocker = 'door';
      this.scene.slits[1].T = 0;
      this.scene.sceneVersion++;
      this.phase = 'pre';
      this.donePre = 0; this.donePost = 0;
      this.preTarget = Math.floor(this.totalSteps * this.openFraction);
      this.postTarget = this.totalSteps - this.preTarget;

      const bInfo = estimateB(this.scene, this.bSamples, new RNG(1234));
      this.A.numChains = chains; this.B.numChains = chains;
      this.A.cfg.sigma = sigma; this.B.cfg.sigma = sigma;
      this.A.cfg.globalProb = g; this.B.cfg.globalProb = 0;
      this.A.stats = this.A._freshStats(); this.B.stats = this.B._freshStats();
      this.A.trace = []; this.B.trace = [];
      this.A.recentModes = []; this.B.recentModes = [];
      this.A.totalSteps = 0; this.B.totalSteps = 0;
      this.A.coverage = new Uint32Array(this.W * this.H);
      this.B.coverage = new Uint32Array(this.W * this.H);
      this.A.stages = []; this.B.stages = [];

      // 相同的独立初始状态（CRN 前提）
      this.A.resetChains(true);
      this.B.chains = this.A.chains.map(ch => ({
        state: { ey: ch.state.ey, ez: ch.state.ez, py: ch.state.py, pz: ch.state.pz },
        f: ch.f, initTries: ch.initTries
      }));

      const w1 = this.openFraction, w2 = 1 - this.openFraction;
      this.A.beginStage({ label: '阶段1 · B未开（CRN同步）', bInfo, timeWeight: w1 });
      this.B.beginStage({ label: '阶段1 · B未开（CRN同步）', bInfo, timeWeight: w1 });
      this._w2 = w2;
      this.emit('reset', '剧本重置：B 遮板关闭，b1=' + bInfo.b.toExponential(4) +
        '（' + bInfo.n + ' 独立样本），前 ' + this.preTarget + ' 突变 CRN 同步');
      return bInfo;
    }

    openSecondPath() {
      if (this.phase !== 'pre') return null;
      this.scene.slits[1].open = true;
      this.scene.slits[1].blocker = 'open';
      this.scene.slits[1].T = 0;
      this.scene.sceneVersion++;
      const b2Info = estimateB(this.scene, this.bSamples, new RNG(5678));
      for (const E of [this.A, this.B]) {
        E.beginStage({ label: '阶段2 · B已开', bInfo: b2Info, timeWeight: this._w2 });
      }
      this.phase = 'post';
      this.emit('open', '第二条亮路 B 已在积累中途打开；重新估计 b2=' +
        b2Info.b.toExponential(4) + '，b_B/b=' +
        (b2Info.bBySlit.B ? (b2Info.bBySlit.B.b / b2Info.b).toFixed(3) : '?'));
      return b2Info;
    }

    // 推进 n 个“配对单位”：pre 阶段一次 pairedSyncStep 推进所有链；
    // post 阶段 A/B 各 step 一次（保持 n 计数可比）。
    stepUnits(n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        if (this.phase === 'pre') {
          if (this.donePre >= this.preTarget) { this.openSecondPath(); continue; }
          pairedSyncStep(this.A, this.B, this.sharedRng);
          this.donePre++;
          if (this.donePre >= this.preTarget) this.openSecondPath();
        } else if (this.phase === 'post') {
          if (this.donePost >= this.postTarget) { this.phase = 'done'; break; }
          this.A.step();
          this.B.step();
          this.donePost++;
        } else break;
      }
      return out;
    }

    // 每帧推进入口：剧本预算内走带开口编排的 stepUnits；预算完成后允许在当前阶段继续自由累计。
    tick(n) {
      if (this.phase === 'done') {
        this.A.run(n);
        this.B.run(n);
      } else {
        this.stepUnits(n);
      }
    }

    progress() {
      return {
        phase: this.phase,
        pre: this.donePre, preTarget: this.preTarget,
        post: this.donePost, postTarget: this.postTarget,
        frac: this.phase === 'pre' ? this.donePre / Math.max(1, this.preTarget)
          : this.phase === 'post' ? this.openFraction + (1 - this.openFraction) * this.donePost / Math.max(1, this.postTarget)
          : 1
      };
    }

    // 诊断器动作：继续累计
    continueAccumulation(n) {
      this.emit('policy', '诊断决策：继续累计（同一 b/阶段）' + (n ? '，追加 ' + n + ' 突变' : ''));
      if (n) this.stepUnits(n);
    }

    // 诊断器动作：分阶段重新归一（目标已变、提议支持域可覆盖）
    renormalizeStaged() {
      const bInfo = estimateB(this.scene, this.bSamples, this.rngB);
      const w = this._w2 != null ? this._w2 : 1;
      for (const E of [this.A, this.B]) {
        E.beginStage({ label: '手动分阶段归一 @' + E.totalSteps, bInfo, timeWeight: w });
      }
      this.emit('policy', '诊断决策：分阶段重新归一，新 b=' + bInfo.b.toExponential(4) +
        '；旧阶段胶片保留并按时间权重合成');
      return bInfo;
    }

    // 诊断器动作：补播新链。沿用已有链（状态/轨迹不动），仅为缺失的透光模式追加条件种子链，
    // 然后在新 b 下开一个阶段；若所有透光模式都已被覆盖则返回 null，不制造无意义阶段。
    supplementChains(which, opts) {
      opts = opts || {};
      const targets = which === 'A' ? [this.A] : which === 'B' ? [this.B] : [this.A, this.B];
      const added = [];
      const bInfo = estimateB(this.scene, this.bSamples, this.rngB);
      for (const E of targets) {
        const present = new Set(E.chains.map(c => c.f && c.f.slitId));
        const missing = this.scene.slits.filter(s => slitTransmits(s) && !present.has(s.id));
        if (!missing.length) {
          this.emit('policy', '补播判定：' + E.name[0] + ' 已覆盖全部透光通路，沿用已有链，不补播');
          continue;
        }
        for (const s of missing) {
          let seeded = false;
          for (let tries = 0; tries < 2000; tries++) {
            const smp = sampleConditional(this.scene, s, this.rngB);
            const f = evalPath(this.scene, smp.st);
            if (f.star > 0) {
              E.chains.push({ state: smp.st, f, initTries: tries + 1, supplemented: true });
              E.numChains = E.chains.length;
              seeded = true;
              added.push(E.name[0] + ':' + s.id);
              E.logEvent('reseed', '补播新链：条件种子到透光通路 ' + s.id + '（尝试 ' + (tries + 1) + ' 次）');
              break;
            }
          }
          if (!seeded) this.emit('fail', '补播失败：透光通路 ' + s.id + ' 条件采样 2000 次未得正贡献');
        }
        E.beginStage({ label: '补播新链阶段 @' + E.totalSteps, bInfo, timeWeight: this._w2 || 1 });
      }
      if (added.length) {
        this.emit('policy', '诊断决策：补播新链（已有链沿用，仅追加缺失模式链）→ ' + added.join(', '));
      }
      return added.length ? { added, bInfo } : null;
    }

    // 材质编排：同一窄窗几何在 不透光滑门 / 暗色帘 之间切换（只改材质，几何不动）。
    // door：整族路径 f*≡0；curtain：保留 T>0 的低能量通路。
    setBlocker(slitId, blocker, T) {
      const s = this.scene.slits.find(x => x.id === slitId);
      if (!s) throw new Error('未知通路 ' + slitId);
      if (blocker !== 'open' && blocker !== 'door' && blocker !== 'curtain') {
        throw new Error('blocker 必须是 open | door | curtain');
      }
      s.blocker = blocker;
      if (blocker === 'curtain') {
        s.T = T == null ? SCHEMA.transmission.def : T;
        s.open = false; // open 标志仅服务旧剧本；透光性改由 slitTransmits 判定
      } else if (blocker === 'door') {
        s.T = 0;
        s.open = false;
      } else {
        s.open = true;
      }
      this.scene.sceneVersion++;
      for (const E of [this.A, this.B]) for (const ch of E.chains) ch.f = evalPath(this.scene, ch.state);
      this.emit('geom', '通路 ' + slitId + ' 材质切换为 ' + blocker +
        (blocker === 'curtain' ? '（T=' + s.T + '，低能量通路保留）' : blocker === 'door' ? '（路径族消失）' : '（全透光）'));
      return s;
    }

    // 诊断器动作：重启链（支持域够不到新区域时的唯一无偏有限样本补救之一）
    restartChains(which, opts) {
      opts = opts || {};
      const targets = which === 'A' ? [this.A] : which === 'B' ? [this.B] : [this.A, this.B];
      const bInfo = estimateB(this.scene, this.bSamples, this.rngB);
      for (const E of targets) {
        if (opts.enableGlobal && E === this.B) E.cfg.globalProb = SCHEMA.globalProb.def;
        E.independentReinitialize();
        if (opts.ensureModes !== false) this._seedMissingModes(E);
        E.beginStage({ label: '重启后阶段 @' + E.totalSteps, bInfo, timeWeight: this._w2 || 1 });
      }
      this.emit('policy', '诊断决策：重启链（独立全 support 初始化' +
        (opts.ensureModes !== false ? '，并为每个开放通路补种子链' : '') + '）' +
        (opts.enableGlobal ? '，并为 B 启用全局提议预算' : '') + '，对象=' + targets.map(t => t.name[0]).join(''));
    }

    // 模式覆盖初始化：若独立随机种子漏掉某条开放通路，用该通路条件样本补一条链。
    _seedMissingModes(E) {
      const present = new Set(E.chains.map(c => c.f && c.f.slitId));
      const open = this.scene.slits.filter(s => slitTransmits(s));
      let k = 0;
      for (const s of open) {
        if (present.has(s.id)) continue;
        const ci = k % E.chains.length;
        for (let tries = 0; tries < 2000; tries++) {
          const smp = sampleConditional(this.scene, s, this.rngB);
          const f = evalPath(this.scene, smp.st);
          if (f.star > 0) {
            E.chains[ci].state = smp.st;
            E.chains[ci].f = f;
            present.add(s.id);
            E.logEvent('init', '模式覆盖初始化：链' + ci + ' 直接种子到 ' + s.id);
            break;
          }
        }
        k++;
      }
    }
  }

  // ---------------- 提议支持域探针 + 诊断器 ----------------
  // 从链当前状态按真实 q 抽探针，估计提议落到各通路的经验概率。
  // 落到不透光滑门后的几何狭缝也会被单独标记（door:<id>），与“根本没命中任何狭缝”的 zero 区分。
  function probeSupport(exp, nProbe, rng) {
    rng = rng || new RNG(9090);
    nProbe = nProbe || 800;
    const reach = {};
    let total = 0;
    const probePoints = [];
    const perChain = exp.chains.map(() => ({ n: 0, reach: {} }));
    for (let ci = 0; ci < exp.chains.length; ci++) {
      const x = exp.chains[ci].state;
      for (let i = 0; i < nProbe; i++) {
        const { y } = propose(exp.scene, x, exp.cfg, rng);
        const f = evalPath(exp.scene, y);
        let key;
        if (f.slitId) key = f.slitId;
        else if (f.blockedBy) key = 'door:' + f.blockedBy;
        else key = f.star > 0 ? 'U' : 'zero';
        reach[key] = (reach[key] || 0) + 1;
        perChain[ci].reach[key] = (perChain[ci].reach[key] || 0) + 1;
        perChain[ci].n++;
        total++;
        if (probePoints.length < 240 && i % 4 === 0) {
          probePoints.push({ ey: y.ey, py: y.py, mode: key, chain: ci });
        }
      }
    }
    for (const k of Object.keys(reach)) reach[k] /= total;
    return { reach, total, probePoints, perChain };
  }

  // 通道在状态空间中的解析体积占比（p_ind 下命中概率），来自 bInfo 的 hitFraction
  function expectedModeFractions(exp, stageIndex) {
    const stg = stageIndex != null ? exp.stages[stageIndex] : exp.stage;
    if (!stg) return {};
    const out = {};
    for (const k of Object.keys(stg.bInfo.bBySlit || {})) {
      const o = stg.bInfo.bBySlit[k];
      out[k] = stg.b > 0 ? o.b / stg.b : 0;
    }
    return out;
  }

  // 三态诊断：对每条透光通路在
  //   continue（沿用已有链继续累计）/ reseed（补播新链覆盖缺模式）/ unreachable（目标里根本不存在该族路径）
  // 之间取舍。不透光滑门通路的正确判决就是 unreachable——它不是采样失败，而是路径族已消失。
  function evaluateDiagnosis(cmp, which, opts) {
    opts = opts || {};
    const exp = which === 'B' ? cmp.B : cmp.A;
    const rng = opts.rng || new RNG((which === 'B' ? 31337 : 1337) + Math.floor(exp.totalSteps / 1));
    const probe = probeSupport(exp, opts.probes || 600, rng);
    const expected = expectedModeFractions(exp);
    const rates = exp.modeRates();
    const n = exp.stage ? exp.stage.n : 0;
    const minVisits = opts.minVisits || 200;
    const reachMin = opts.reachMin || 0.002;

    const regions = [];
    for (const s of cmp.scene.slits) {
      const expFrac = expected[s.id] != null ? expected[s.id] : 0;
      const visits = exp.stage && exp.stage.modeCounts[s.id] || 0;
      const rate = rates[s.id] || 0;
      const reach = probe.reach[s.id] || 0;
      let status = 'ok';
      const reasons = [];
      if (!slitTransmits(s)) {
        // 滑门关闭：目标支持域中该族路径严格不存在；门后探针命中只证明几何狭缝在，不代表可采样
        status = 'closed';
        const doorReach = probe.reach['door:' + s.id] || 0;
        reasons.push(s.blocker === 'door'
          ? '不透光滑门：该族路径已从目标中消失（f*≡0），判决不可达；门后几何探针命中=' + doorReach.toExponential(1)
          : '遮板关闭，目标支持域中不存在该区域');
      } else if (expFrac > 0.02) {
        if (reach < reachMin && rate === 0 && n > minVisits) {
          status = 'unreachable';
          reasons.push('提议支持域探针命中率≈' + reach.toExponential(1) + '，链从未访问（' + visits + '）；局部有界扰动跨不过零密度间隔');
        } else if (visits < minVisits || (n > 2000 && rate < expFrac * 0.25)) {
          status = 'weak';
          reasons.push('访问率 ' + rate.toFixed(4) + ' 显著低于归一化预测 ' + expFrac.toFixed(4) + '，证据不足，需要补播新链');
        } else {
          reasons.push('访问率 ' + rate.toFixed(3) + ' 与预测份额 ' + expFrac.toFixed(3) + ' 相容，沿用已有链继续累计');
        }
      } else if (s.blocker === 'curtain') {
        reasons.push('暗色帘透射 T=' + s.T + '：低能量通路仍计入目标，bBySlit 份额=' + expFrac.toExponential(1));
      }
      regions.push({
        id: s.id, name: s.name, open: slitTransmits(s), blocker: s.blocker, T: s.T || 0,
        expFrac, rate, visits, reach, status, reasons, roi: slitScreenROI(cmp.scene, s)
      });
    }

    // 像素级证据不足区域
    const evidence = buildEvidenceMap(exp, opts.countThreshold || 6);

    // 目标里真实存在（透光）但采样够不到/证据不足的区域，才构成采样器动作；
    // 滑门造成的 unreachable 属于正确物理状态，不触发重启。
    const physicalUnreachable = regions.filter(r => r.status === 'unreachable' && r.open);
    const doorUnreachable = regions.filter(r => r.status === 'unreachable' && !r.open);
    const weak = regions.filter(r => r.status === 'weak');
    const targetDirty = exp.stage && exp.stage.sceneVersion !== cmp.scene.sceneVersion;

    let action = 'continue';
    let policy3 = 'continue';
    let severity = 'ok';
    let title = '沿用已有链继续累计';
    const reasons = [];
    if (physicalUnreachable.length) {
      // 透光但现有链支持域够不到：必须补播新链（或重启）
      action = 'restart';
      policy3 = 'reseed';
      severity = 'bad';
      title = '补播新链 / 启用全局提议（现有链支持域不可达）';
      reasons.push('存在提议支持域不可达的透光通路: ' + physicalUnreachable.map(r => r.id).join(','));
    } else if (weak.length) {
      // 目标可达但证据不足：可沿用链继续累计，也可补播加速覆盖
      action = 'continue';
      policy3 = 'reseed';
      severity = 'warn';
      title = '建议补播新链：部分透光区域证据不足（也可沿用链继续累计）';
      reasons.push('弱证据区域: ' + weak.map(r => r.id).join(',') + '（也可继续累计等待混合）');
    } else {
      reasons.push('提议支持域覆盖全部透光通路，访问率与 b 预测相容，沿用已有链');
    }
    if (targetDirty) {
      // 目标已变：旧阶段权重失效，需先分阶段重新归一；
      // 三态建议只由覆盖状态决定，目标脏本身不构成补链理由。
      action = 'stage-renorm';
      severity = severity === 'ok' ? 'warn' : severity;
      title = '目标已改变：分阶段重新归一' + (policy3 === 'reseed' ? '（并按需补播新链）' : '（沿用已有链）');
      reasons.unshift('阶段建立于 sceneVersion=' + exp.stage.sceneVersion + '，当前=' + cmp.scene.sceneVersion);
    }
    if (doorUnreachable.length) {
      reasons.push('滑门通路 ' + doorUnreachable.map(r => r.id).join(',') + ' 判决不可达：f*≡0，不补链、不计能量（与暗色帘的低能量通路对照）');
    }

    return {
      which, action, policy3, severity, title, reasons, regions, probe, evidence,
      acceptance: exp.acceptanceRate(),
      acceptanceGlobal: exp.acceptanceRate('global'),
      acceptanceLocal: exp.acceptanceRate('local'),
      globalProb: exp.cfg.globalProb,
      n, targetDirty
    };
  }

  // 证据图：当前阶段每个像素的沉积数是否达到阈值（仅标记 ROI 内）
  function buildEvidenceMap(exp, threshold) {
    const W = exp.W, H = exp.H;
    const counts = exp.stage ? exp.stage.film.counts : exp.coverage;
    const status = new Uint8Array(W * H); // 0 无目标/不计, 1 证据不足, 2 充分
    // 用 bInfo 无法给像素级期望，改用“是否落在任一开放 ROI”作为应照亮区域
    const rois = exp.scene.uniform ? [{ lo: -exp.scene.syHalf, hi: exp.scene.syHalf }]
      : exp.scene.slits.filter(slit => slitTransmits(slit)).map(slit => slitScreenROI(exp.scene, slit));
    for (let x = 0; x < W; x++) {
      const py = -exp.scene.syHalf + (x + 0.5) / W * 2 * exp.scene.syHalf;
      let inRoi = false;
      for (const r of rois) if (py >= r.lo && py <= r.hi) { inRoi = true; break; }
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (!inRoi) { status[i] = 0; continue; }
        status[i] = counts[i] >= threshold ? 2 : 1;
      }
    }
    let weakPixels = 0, supportPixels = 0;
    for (let i = 0; i < status.length; i++) {
      if (status[i] === 1) weakPixels++;
      if (status[i]) supportPixels++;
    }
    return { status, weakPixels, supportPixels, threshold };
  }

  // ---------------- 普通 MC 参照 / 长曝光（含狭缝条件重要性采样） ----------------
  class McImage {
    constructor(W, H) {
      this.W = W; this.H = H;
      this.sum = new Float64Array(W * H * 3); // Σ f/p
      this.hits = new Uint32Array(W * H);
      this.n = 0;
    }
    addSample(st, f, p) {
      if (p <= 0) return;
      const inv = 1 / p;
      if (f.star > 0) {
        const px = pixelOfGlobal(this.W, this.H, st);
        if (px) {
          const idx = (px.iy * this.W + px.ix) * 3;
          this.sum[idx] += f.rgb[0] * inv;
          this.sum[idx + 1] += f.rgb[1] * inv;
          this.sum[idx + 2] += f.rgb[2] * inv;
          this.hits[px.iy * this.W + px.ix]++;
        }
      }
      this.n++;
    }
    composed() {
      const data = new Float64Array(this.W * this.H * 3);
      const counts = new Uint32Array(this.W * this.H);
      if (this.n > 0) {
        const invN = 1 / this.n;
        for (let i = 0; i < data.length; i++) data[i] = this.sum[i] * invN;
        for (let i = 0; i < counts.length; i++) counts[i] = this.hits[i];
      }
      return { W: this.W, H: this.H, data, counts };
    }
  }

  // McImage 需要不依赖 scene 实例的映射；这里用固定 FILM 物理框（与默认 scene 一致）
  function pixelOfGlobal(W, H, st) {
    const syH = 1.4, szH = 0.95;
    let ix = Math.floor((st.py + syH) / (2 * syH) * W);
    let iy = Math.floor((st.pz + szH) / (2 * szH) * H);
    if (ix < 0 || ix >= W || iy < 0 || iy >= H) return null;
    return { ix, iy };
  }

  // 狭缝条件提议：ey,ez 均匀；yc,zc 在孔内均匀；py=2yc-ey, pz=2zc-ez。
  // 密度 p_theta = 1/(16 * Ley * Lez * hw * hh)（单缝，未按屏幕截断）。
  function sampleConditional(scene, slit, rng) {
    const ey = rng.range(-scene.eyHalf, scene.eyHalf);
    const ez = rng.range(-scene.ezHalf, scene.ezHalf);
    const yc = rng.range(slit.cy - slit.hw, slit.cy + slit.hw);
    const zc = rng.range(slit.cz - slit.hh, slit.cz + slit.hh);
    const py = 2 * yc - ey;
    const pz = 2 * zc - ez;
    const Ley = 2 * scene.eyHalf, Lez = 2 * scene.ezHalf;
    const pSingle = 1 / (16 * Ley * Lez * slit.hw * slit.hh);
    return { st: { ey, ez, py, pz }, pSingle };
  }

  function conditionalP(scene, st) {
    const c = crossing(scene, st);
    const open = scene.slits.filter(s => slitTransmits(s) &&
      Math.abs(c.yc - s.cy) <= s.hw && Math.abs(c.zc - s.cz) <= s.hh);
    if (!open.length) return 0;
    const k = scene.slits.filter(s => slitTransmits(s)).length;
    let p = 0;
    for (const s of open) {
      const Ley = 2 * scene.eyHalf, Lez = 2 * scene.ezHalf;
      p += (1 / k) / (16 * Ley * Lez * s.hw * s.hh);
    }
    return p;
  }

  function runReferenceSync(scene, n, opts) {
    opts = opts || {};
    const W = opts.W || FILM_W, H = opts.H || FILM_H;
    const rng = opts.rng || new RNG(opts.seed || 555);
    const mode = opts.mode || 'conditional'; // conditional | uniform
    const img = new McImage(W, H);
    const openSlits = scene.slits.filter(s => slitTransmits(s));
    const st = {};
    for (let i = 0; i < n; i++) {
      let p, sample;
      if (mode === 'uniform' || scene.uniform || openSlits.length === 0) {
        uniformState(scene, rng, st);
        p = 1 / boxVolume(scene);
      } else {
        const s = openSlits[rng.int(openSlits.length)];
        sample = sampleConditional(scene, s, rng);
        Object.assign(st, sample.st);
        p = conditionalP(scene, st);
      }
      const f = evalPath(scene, st);
      img.addSample(st, f, p);
    }
    return img;
  }

  // 分块异步参照运行器（界面进度）
  class ReferenceRunner {
    constructor(scene, opts) {
      this.scene = scene;
      this.opts = opts || {};
      this.W = this.opts.W || FILM_W;
      this.H = this.opts.H || FILM_H;
      this.img = new McImage(this.W, this.H);
      this.rng = new RNG(this.opts.seed || 555);
      this.done = 0;
      this.target = 0;
      this.running = false;
    }
    start(n) { this.target = n; this.done = 0; this.running = true; return this; }
    chunk(chunkN) {
      const mode = this.opts.mode || 'conditional';
      const openSlits = this.scene.slits.filter(s => slitTransmits(s));
      const st = {};
      const end = Math.min(this.target, this.done + chunkN);
      for (; this.done < end; this.done++) {
        let p;
        if (mode === 'uniform' || this.scene.uniform || openSlits.length === 0) {
          uniformState(this.scene, this.rng, st);
          p = 1 / boxVolume(this.scene);
        } else {
          const s = openSlits[this.rng.int(openSlits.length)];
          const smp = sampleConditional(this.scene, s, this.rng);
          Object.assign(st, smp.st);
          p = conditionalP(this.scene, st);
        }
        const f = evalPath(this.scene, st);
        this.img.addSample(st, f, p);
      }
      if (this.done >= this.target) this.running = false;
      return { done: this.done, target: this.target, progress: this.done / this.target };
    }
    async run(n, chunkN, onProgress) {
      this.start(n);
      chunkN = chunkN || 200000;
      while (this.running) {
        const pr = this.chunk(chunkN);
        if (onProgress) onProgress(pr);
        await new Promise(r => setTimeout(r, 0));
      }
      return this.img;
    }
  }

  // ---------------- 图像指标 / 对照 ----------------
  function compareImages(mlt, ref, scene) {
    // 仅在参照亮度高于阈值的像素上评估噪声结构
    const n = mlt.W * mlt.H;
    let se = 0, refEnergy = 0, mltEnergy = 0, maskN = 0;
    let seAll = 0;
    const diff = new Float64Array(n);
    const lumM = new Float64Array(n), lumR = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 3;
      const lm = lumRGB(mlt.data[p], mlt.data[p + 1], mlt.data[p + 2]);
      const lr = lumRGB(ref.data[p], ref.data[p + 1], ref.data[p + 2]);
      lumM[i] = lm; lumR[i] = lr;
      diff[i] = lm - lr;
      seAll += diff[i] * diff[i];
      refEnergy += lr; mltEnergy += lm;
      if (lr > 1e-6) { se += (lm - lr) * (lm - lr) / (lr * lr + 1e-4); maskN++; }
    }
    return {
      totalRelErr: refEnergy > 0 ? (mltEnergy - refEnergy) / refEnergy : null,
      rmse: Math.sqrt(seAll / n),
      relRmsMasked: maskN ? Math.sqrt(se / maskN) : null,
      maskN,
      mltEnergy, refEnergy,
      diff, lumM, lumR
    };
  }

  // 等预算均匀 MC（返回 McImage），便捷封装
  function uniformMc(scene, n, seed) {
    return runReferenceSync(scene, n, { mode: 'uniform', seed: seed || 8080 });
  }

  // ---------------- 微缩双缝场景：能量占比已知的可复现实验 ----------------
  // 两条几何完全相同的窄缝（同 hw/hh、对称 cy），份额差异只来自 tint/透射率；
  // 因此解析能量份额 = 该缝的 lum(tint)*T 占比，可在未采样前写入素材包。
  function miniScene(opts) {
    opts = opts || {};
    const sc = defaultScene();
    sc.sceneVersion = 1;
    sc.name = opts.name || 'mini-two-slit';
    const hw = opts.hw != null ? opts.hw : 0.022; // 比默认更窄的孔
    const cy = opts.cy != null ? opts.cy : 0.58;
    const hh = 0.52;
    const TA = opts.TA != null ? opts.TA : 1;
    const TB = opts.TB != null ? opts.TB : 1;
    const tintA = opts.tintA || [0.70, 0.85, 1.00];
    const tintB = opts.tintB || [1.00, 0.86, 0.66];
    sc.slits = [
      { id: 'A', name: '微缩通路 A', cy: -cy, cz: 0, hw, hh, open: true, blocker: 'open', tint: tintA.slice(), T: TA },
      { id: 'B', name: '微缩通路 B', cy:  cy, cz: 0, hw, hh, open: true, blocker: 'open', tint: tintB.slice(), T: TB }
    ];
    sc.knownFractions = analyticFractions(sc);
    return sc;
  }

  function slitWeight(s) {
    const T = s.blocker === 'curtain' ? (s.T == null ? SCHEMA.transmission.def : s.T)
      : slitTransmits(s) ? 1 : 0;
    return T * lumRGB(s.tint[0], s.tint[1], s.tint[2]);
  }

  // 几何相同的缝之间，解析亮度份额正比于 lum(tint)*T。
  function analyticFractions(scene) {
    const w = {};
    let sum = 0;
    for (const s of scene.slits) { w[s.id] = slitWeight(s); sum += w[s.id]; }
    const out = {};
    for (const k of Object.keys(w)) out[k] = sum > 0 ? w[k] / sum : 0;
    return out;
  }

  // ---------------- 像素级参考积分：分路光斑来源核验 ----------------
  // 对每条透光缝独立封住其余路径后跑条件参考，统计其屏幕 ROI 内的亮度能量；
  // 返回每路 ROI 能量、全图能量以及 ROI 占比，用于核验导出像素确实来自该路。
  function referencePathAttribution(scene, n, opts) {
    opts = opts || {};
    const rng0 = opts.seed || 7001;
    const perPath = {};
    const transmitting = scene.slits.filter(s => slitTransmits(s));
    let sumROI = 0;
    for (let k = 0; k < transmitting.length; k++) {
      const target = transmitting[k];
      const sc = cloneScene(scene);
      for (const s of sc.slits) {
        const isTarget = s.id === target.id;
        s.open = isTarget;
        s.blocker = isTarget ? target.blocker : 'door';
        if (!isTarget) s.T = 0;
      }
      const img = runReferenceSync(sc, n, { mode: 'conditional', seed: rng0 + k * 97, W: opts.W, H: opts.H }).composed();
      const roi = slitScreenROI(scene, target);
      const region = imageRegionEnergy(img, scene, roi.lo, roi.hi);
      const full = imageEnergy(img);
      perPath[target.id] = {
        roi: { lo: roi.lo, hi: roi.hi, x0: region.x0, x1: region.x1 },
        roiLum: region.lum, fullLum: full.lum,
        roiShareOfImage: full.lum > 0 ? region.lum / full.lum : 0,
        samples: img.counts ? region.samples : 0,
        pixelsLit: region.pixels
      };
      sumROI += region.lum;
    }
    // 双开参考：ROI 内能量应可由分路结果相加恢复
    const bothImg = runReferenceSync(scene, n, { mode: 'conditional', seed: rng0 + 9991, W: opts.W, H: opts.H }).composed();
    const both = {};
    for (const s of transmitting) {
      const roi = slitScreenROI(scene, s);
      both[s.id] = imageRegionEnergy(bothImg, scene, roi.lo, roi.hi).lum;
    }
    const check = {};
    for (const s of transmitting) {
      check[s.id] = both[s.id] > 0 ? perPath[s.id].roiLum / both[s.id] : null;
    }
    return { perPath, bothROILum: both, additivityRatio: check, n, analytic: analyticFractions(scene) };
  }

  // ---------------- 有限预算 · 多种子覆盖研究 ----------------
  // 固定连续种子序列（不挑幸运种子），在同一预算下重复独立 MLT 运行，
  // 报告模式覆盖率、份额误差与像素覆盖，暴露有限预算的模式未覆盖问题。
  function budgetStudy(scene, opts) {
    opts = opts || {};
    const seeds = opts.seeds || [11, 22, 33, 44, 55, 66, 77, 88];
    const budget = opts.budget || 40000;
    const g = opts.globalProb != null ? opts.globalProb : 0;
    const bInfo = opts.bInfo || estimateB(scene, opts.bSamples || 200000, new RNG(909));
    const truth = analyticFractions(scene);
    const rows = [];
    for (const seed of seeds) {
      const exp = new Experiment({
        scene, seed, globalProb: g, sigma: opts.sigma != null ? opts.sigma : SCHEMA.sigma.def,
        chains: opts.chains || 1, W: opts.W || FILM_W, H: opts.H || FILM_H
      });
      exp.reset({ bInfo });
      exp.run(budget);
      const rates = exp.modeRates();
      let lit = 0;
      for (let i = 0; i < exp.coverage.length; i++) if (exp.coverage[i] > 0) lit++;
      const covered = {};
      const fracErr = {};
      for (const s of scene.slits) {
        covered[s.id] = (exp.stage.modeCounts[s.id] || 0) > 0;
        fracErr[s.id] = covered[s.id] ? Math.abs((rates[s.id] || 0) - (truth[s.id] || 0)) : null;
      }
      rows.push({
        seed, budget, globalProb: g, acceptance: exp.acceptanceRate(),
        rates, covered, fracErr,
        pixelsCovered: lit,
        pixelCoverFraction: lit / (exp.W * exp.H)
      });
    }
    const summary = {};
    for (const s of scene.slits) {
      const miss = rows.filter(r => !r.covered[s.id]).length;
      const errs = rows.filter(r => r.fracErr[s.id] != null).map(r => r.fracErr[s.id]);
      summary[s.id] = {
        timesCovered: rows.length - miss,
        runs: rows.length,
        missRate: miss / rows.length,
        truthFraction: truth[s.id] || 0,
        medianFracErr: errs.length ? errs.slice().sort((a, b) => a - b)[Math.floor(errs.length / 2)] : null
      };
    }
    return { seeds, budget, globalProb: g, rows, summary, truth, b: bInfo.b, note: '连续固定种子，未做任何幸运种子筛选' };
  }

  // ---------------- 光路压力素材包：构建 / 校验 / 载入 ----------------
  // 素材包是自描述 JSON：场景来源与参数、解析份额、独立 MC 的 b 与分路统计、
  // 分路像素光斑归属，以及内容指纹。重建脚本与界面都通过 verifyStressPack 核验，禁止伪报。
  function fnv1aHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function canonicalScene(scene) {
    return JSON.stringify({
      D: scene.D, eyHalf: scene.eyHalf, ezHalf: scene.ezHalf,
      syHalf: scene.syHalf, szHalf: scene.szHalf, emitterPower: scene.emitterPower,
      uniform: !!scene.uniform,
      slits: scene.slits.map(s => ({
        id: s.id, cy: s.cy, cz: s.cz || 0, hw: s.hw, hh: s.hh,
        open: !!s.open, blocker: s.blocker || 'open', T: s.T || 0, tint: s.tint.slice()
      }))
    });
  }

  function buildStressPack(scene, opts) {
    opts = opts || {};
    const bSamples = opts.bSamples || 600000;
    const refN = opts.refN || 600000;
    const seedBase = opts.seedBase || 20250;
    const bInfo = estimateB(scene, bSamples, new RNG(seedBase));
    const attribution = referencePathAttribution(scene, refN, { seed: seedBase + 300, W: opts.W, H: opts.H });
    const pack = {
      format: 'ml-path-lab/stress-pack',
      formatVersion: 1,
      kind: opts.kind || 'two-slit-mini',
      name: opts.name || scene.name || 'stress-pack',
      createdAt: new Date().toISOString(),
      source: {
        description: opts.sourceDescription || 'src/kernel.js miniScene/defaultScene 生成，参数见 scene 段',
        kernel: 'src/kernel.js',
        generator: 'MLK.buildStressPack',
        sceneFingerprint: fnv1aHash(canonicalScene(scene))
      },
      params: { bSamples, refN, seedBase, film: { W: opts.W || FILM_W, H: opts.H || FILM_H } },
      scene: JSON.parse(canonicalScene(scene)),
      analyticFractions: analyticFractions(scene),
      normalization: {
        b: bInfo.b, se: bInfo.se, n: bInfo.n, volume: bInfo.volume,
        proposal: bInfo.proposal, densityFormula: bInfo.densityFormula,
        bBySlit: bInfo.bBySlit
      },
      attribution
    };
    pack.fingerprint = packFingerprint(pack);
    return pack;
  }

  // 指纹只覆盖物理/统计内容，不含指纹自身与时间戳，保证重建可复算。
  function packFingerprint(pack) {
    const body = JSON.stringify({
      fp: pack.source.sceneFingerprint,
      params: pack.params,
      scene: pack.scene,
      analytic: pack.analyticFractions,
      b: pack.normalization.b,
      attribution: pack.attribution
    });
    return fnv1aHash(body);
  }

  // 严格载入：结构、指纹、场景一致性全部检查；任何不符都抛错，由界面 toast 提示。
  function loadStressPack(json) {
    const pack = typeof json === 'string' ? JSON.parse(json) : json;
    const errs = [];
    if (!pack || pack.format !== 'ml-path-lab/stress-pack') errs.push('format 不是 ml-path-lab/stress-pack');
    if (!pack.scene || !Array.isArray(pack.scene.slits) || !pack.scene.slits.length) errs.push('scene.slits 缺失');
    if (!pack.normalization || !(pack.normalization.b > 0)) errs.push('normalization.b 非正');
    if (!pack.attribution || !pack.attribution.perPath) errs.push('attribution.perPath 缺失');
    if (errs.length) throw new Error('素材包结构无效: ' + errs.join('; '));
    if (pack.fingerprint !== packFingerprint(pack)) {
      throw new Error('素材包指纹不一致：内容被篡改或来自不兼容版本');
    }
    const rebuilt = fnv1aHash(canonicalScene(pack.scene));
    if (rebuilt !== pack.source.sceneFingerprint) {
      throw new Error('场景指纹不一致：scene 段已被修改（重算=' + rebuilt + ' 存档=' + pack.source.sceneFingerprint + '）');
    }
    // 内容指纹覆盖 source.sceneFingerprint，几何篡改必然同时改变两者的一致性，无法靠重算指纹绕过
    return pack;
  }

  // 独立重建核验：用当前采样器重新估计 b、重跑分路参考，与包内约定值比较。
  // tolerance 为相对容差；任一项越界即返回 ok:false 并列出原因，绝不静默通过。
  function verifyStressPack(pack, opts) {
    opts = opts || {};
    let loaded;
    try { loaded = loadStressPack(pack); } catch (e) { return { ok: false, checks: [], failure: e.message }; }
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
    add('结构与指纹', true, 'fingerprint=' + loaded.fingerprint);

    const bInfo = estimateB(loaded.scene, opts.bSamples || loaded.params.bSamples,
      new RNG((opts.seedBase || loaded.params.seedBase) + 777));
    const bRel = Math.abs(bInfo.b - loaded.normalization.b) / loaded.normalization.b;
    add('重建 b 与约定 b 相对误差', bRel <= (opts.bTol || 0.06),
      'rebuild=' + bInfo.b.toExponential(5) + ' packed=' + loaded.normalization.b.toExponential(5) + ' rel=' + bRel.toFixed(4));

    const attr = referencePathAttribution(loaded.scene, opts.refN || loaded.params.refN,
      { seed: (opts.seedBase || loaded.params.seedBase) + 4242, W: loaded.params.film.W, H: loaded.params.film.H });
    let attrOk = true;
    const attrDetail = [];
    for (const id of Object.keys(loaded.attribution.perPath)) {
      const packedV = loaded.attribution.perPath[id].roiLum;
      const rebuiltV = attr.perPath[id].roiLum;
      const rel = packedV > 0 ? Math.abs(rebuiltV - packedV) / packedV : 1;
      if (rel > (opts.attrTol || 0.08)) { attrOk = false; }
      attrDetail.push(id + ':' + rel.toFixed(4));
    }
    add('分路 ROI 光斑重建', attrOk, attrDetail.join(' '));

    // 可加性：封住单路的 ROI 能量之和应恢复双开参考 ROI（包内自证 + 重建复算）
    let addOk = true; const addDetail = [];
    for (const id of Object.keys(attr.additivityRatio)) {
      const r = attr.additivityRatio[id];
      if (r == null || Math.abs(r - 1) > (opts.addTol || 0.08)) addOk = false;
      addDetail.push(id + '=' + (r == null ? 'null' : r.toFixed(3)));
    }
    add('分路能量可加性（单封 vs 双开）', addOk, addDetail.join(' '));

    // 解析份额与 bBySlit 经验份额一致
    let fracOk = true; const fracDetail = [];
    for (const id of Object.keys(loaded.analyticFractions)) {
      const empirical = loaded.normalization.bBySlit[id]
        ? loaded.normalization.bBySlit[id].b / loaded.normalization.b : 0;
      const rel = Math.abs(empirical - loaded.analyticFractions[id]);
      if (rel > (opts.fracTol || 0.03)) fracOk = false;
      fracDetail.push(id + ': analytic=' + loaded.analyticFractions[id].toFixed(3) + ' mc=' + empirical.toFixed(3));
    }
    add('解析能量占比 vs 独立 MC 份额', fracOk, fracDetail.join(' '));

    // 不透光缝不得出现在 bBySlit 正贡献里
    let doorOk = true; const doorDetail = [];
    for (const s of loaded.scene.slits) {
      if (!slitTransmits(s)) {
        const v = loaded.normalization.bBySlit[s.id];
        if (v && v.b > 0) { doorOk = false; doorDetail.push(s.id + ' 应为零却 b=' + v.b); }
      }
    }
    add('滑门通路零能量', doorOk, doorDetail.join(' ') || '所有非透光缝 b=0');

    const ok = checks.every(c => c.pass);
    return { ok, checks, rebuilt: { b: bInfo.b, attribution: attr } };
  }

  return {
    D_X, FILM_W, FILM_H, LUM_W, lumRGB,
    RNG, SCHEMA,
    defaultScene, cloneScene, boxVolume, inStateBox, uniformState,
    crossing, hitSlit, evalPath, slitTransmits, slitWeight, normalizeScene,
    pixelOf, Film, imageEnergy, imageRegionEnergy, slitScreenROI,
    localPdf, proposalQ, propose, localMoveFromDraws,
    estimateB,
    Experiment, pairedSyncStep, Comparison,
    probeSupport, evaluateDiagnosis, buildEvidenceMap, expectedModeFractions,
    McImage, runReferenceSync, ReferenceRunner,
    sampleConditional, conditionalP, uniformMc, compareImages,
    miniScene, analyticFractions, referencePathAttribution, budgetStudy,
    buildStressPack, loadStressPack, verifyStressPack, packFingerprint,
    fnv1aHash, canonicalScene
  };
});
