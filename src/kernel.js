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
        { id: 'A', name: '通路 A', cy: -0.58, cz: 0, hw: SCHEMA.slitHw.def, hh: 0.52, open: true,  tint: [0.70, 0.85, 1.00] },
        { id: 'B', name: '通路 B', cy:  0.58, cz: 0, hw: SCHEMA.slitHw.def, hh: 0.52, open: false, tint: [1.00, 0.86, 0.66] }
      ]
    };
  }

  function cloneScene(s) {
    return Object.assign({}, s, { slits: s.slits.map(x => Object.assign({}, x, { tint: x.tint.slice() })) });
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
      if (!s.open) continue;
      if (Math.abs(c.yc - s.cy) <= s.hw && Math.abs(c.zc - s.cz) <= s.hh) return s;
    }
    return null;
  }

  const ZERO_EVAL = { star: 0, rgb: [0, 0, 0], slitId: null, geom: 0 };

  // 路径贡献 f(theta)。直接光路 E->P：Le * G(E,P) * V_slit * We。
  function evalPath(scene, st) {
    if (!inStateBox(scene, st)) return ZERO_EVAL;
    let slit = null;
    if (!scene.uniform) {
      slit = hitSlit(scene, st);
      if (!slit) return ZERO_EVAL;
    }
    const dx = 2 * scene.D;
    const ry = st.py - st.ey;
    const rz = st.pz - st.ez;
    const r2 = dx * dx + ry * ry + rz * rz;
    const invR = 1 / Math.sqrt(r2);
    const cos = dx * invR;
    const G = cos * cos / r2;                 // 3D 面积测度几何项
    const scalar = scene.emitterPower * G;
    const tint = slit ? slit.tint : [1, 1, 1];
    const r = scalar * tint[0], g = scalar * tint[1], b = scalar * tint[2];
    return { star: lumRGB(r, g, b), rgb: [r, g, b], slitId: slit ? slit.id : 'U', geom: G };
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

      // 剧本开始：B 遮板关闭
      this.scene.slits[1].open = false;
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
      const open = this.scene.slits.filter(s => s.open);
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
        const key = f.slitId || (f.star > 0 ? 'U' : 'zero');
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
      out[k] = stg.bInfo.b > 0 ? o.b / stg.b : 0;
    }
    return out;
  }

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
      if (!s.open) {
        status = 'closed';
        reasons.push('遮板关闭，目标支持域中不存在该区域');
      } else if (expFrac > 0.02) {
        if (reach < reachMin && rate === 0 && n > minVisits) {
          status = 'unreachable';
          reasons.push('提议支持域探针命中率≈' + reach.toExponential(1) + '，链从未访问（' + visits + '）；局部有界扰动跨不过零密度间隔');
        } else if (visits < minVisits || (n > 2000 && rate < expFrac * 0.25)) {
          status = 'weak';
          reasons.push('访问率 ' + rate.toFixed(4) + ' 显著低于归一化预测 ' + expFrac.toFixed(4) + '，证据不足');
        } else {
          reasons.push('访问率 ' + rate.toFixed(3) + ' 与预测份额 ' + expFrac.toFixed(3) + ' 相容');
        }
      }
      regions.push({ id: s.id, name: s.name, open: s.open, expFrac, rate, visits, reach, status, reasons, roi: slitScreenROI(cmp.scene, s) });
    }

    // 像素级证据不足区域
    const evidence = buildEvidenceMap(exp, opts.countThreshold || 6);

    // 决策：是否存在“目标里开着、但提议够不到且无访问”的区域
    const unreachable = regions.filter(r => r.status === 'unreachable');
    const weak = regions.filter(r => r.status === 'weak');
    const targetDirty = exp.stage && exp.stage.sceneVersion !== cmp.scene.sceneVersion;

    let action = 'continue';
    let severity = 'ok';
    let title = '继续累计';
    const reasons = [];
    if (targetDirty) {
      action = 'stage-renorm';
      severity = 'warn';
      title = '目标已改变：分阶段重新归一';
      reasons.push('阶段建立于 sceneVersion=' + exp.stage.sceneVersion + '，当前=' + cmp.scene.sceneVersion);
    } else if (unreachable.length) {
      action = 'restart';
      severity = 'bad';
      title = '重启链 / 启用全局提议';
      reasons.push('存在提议支持域不可达的亮路: ' + unreachable.map(r => r.id).join(','));
    } else if (weak.length) {
      action = 'continue';
      severity = 'warn';
      title = '继续累计：部分区域证据不足';
      reasons.push('弱证据区域: ' + weak.map(r => r.id).join(','));
    } else {
      reasons.push('提议支持域覆盖全部开放通路，访问率与 b 预测相容');
    }

    return {
      which, action, severity, title, reasons, regions, probe, evidence,
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
      : exp.scene.slits.filter(s => s.open).map(slit => slitScreenROI(exp.scene, slit));
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
    const open = scene.slits.filter(s => s.open &&
      Math.abs(c.yc - s.cy) <= s.hw && Math.abs(c.zc - s.cz) <= s.hh);
    if (!open.length) return 0;
    const k = scene.slits.filter(s => s.open).length;
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
    const openSlits = scene.slits.filter(s => s.open);
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
      const openSlits = this.scene.slits.filter(s => s.open);
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

  return {
    D_X, FILM_W, FILM_H, LUM_W, lumRGB,
    RNG, SCHEMA,
    defaultScene, cloneScene, boxVolume, inStateBox, uniformState,
    crossing, hitSlit, evalPath,
    pixelOf, Film, imageEnergy, imageRegionEnergy, slitScreenROI,
    localPdf, proposalQ, propose, localMoveFromDraws,
    estimateB,
    Experiment, pairedSyncStep, Comparison,
    probeSupport, evaluateDiagnosis, buildEvidenceMap, expectedModeFractions,
    McImage, runReferenceSync, ReferenceRunner,
    sampleConditional, conditionalP, uniformMc, compareImages
  };
});
