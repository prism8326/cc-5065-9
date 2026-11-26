/* 界面控制器：所有数字/动作都来自 src/kernel.js（MLK）。 */
(function () {
  'use strict';
  const K = window.MLK;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const MODE_COLORS = { A: '#7fb4ff', B: '#ffd9a8', U: '#57e389', zero: '#e01b24' };

  const app = {
    cmp: null,
    running: true,
    slow: false,
    lastSlow: 0,
    lastDom: 0,
    lastDiag: 0,
    diagnosis: { A: null, B: null },
    ui: { run: 'A', stage: 'last', view: 'color', diagRun: 'A', evidence: false, policy: 'manual' },
    gain: K.SCHEMA.exposure.def,
    refs: { both: null, blockA: null, blockB: null, umc: null, sig: '', stale: true, busy: false },
    geometryDirty: false,
    autoRestarted: {},
    drag: null,
    lastMainImg: null,
    bench: null,
    lastFailTime: 0,
    toastTimer: null
  };
  window.__APP__ = app;

  // ---------------- 小工具 ----------------
  function fmt(x, d) {
    if (x == null || !isFinite(x)) return '—';
    if (Math.abs(x) >= 10000 || (Math.abs(x) < 1e-3 && x !== 0)) return x.toExponential(2);
    return x.toFixed(d == null ? 3 : d);
  }
  function pct(x, d) { return x == null || !isFinite(x) ? '—' : (100 * x).toFixed(d == null ? 1 : d) + '%'; }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  // ---------------- 控件由 SCHEMA 驱动 ----------------
  const sliderBindings = [
    ['slitHw', 'slitHw', v => +v],
    ['globalProb', 'globalProb', v => +v],
    ['sigma', 'sigma', v => +v],
    ['chains', 'chains', v => Math.round(+v)],
    ['stepsPerFrame', 'stepsPerFrame', v => Math.round(+v)],
    ['openFraction', 'openFraction', v => +v],
    ['exposure', 'exposure', v => +v]
  ];
  function initSliders() {
    for (const [id, key] of sliderBindings) {
      const input = $(id);
      const s = K.SCHEMA[key];
      input.min = s.min; input.max = s.max; input.step = s.step;
      input.value = key === 'exposure' ? K.SCHEMA.exposure.def : s.def;
    }
    $('slitCyA').min = K.SCHEMA.slitCy.min; $('slitCyA').max = K.SCHEMA.slitCy.max; $('slitCyA').step = K.SCHEMA.slitCy.step;
    $('slitCyB').min = K.SCHEMA.slitCy.min; $('slitCyB').max = K.SCHEMA.slitCy.max; $('slitCyB').step = K.SCHEMA.slitCy.step;
    const dflt = K.defaultScene();
    $('slitCyA').value = dflt.slits[0].cy;
    $('slitCyB').value = dflt.slits[1].cy;
    $('exposure').min = K.SCHEMA.exposure.min; $('exposure').max = K.SCHEMA.exposure.max; $('exposure').step = K.SCHEMA.exposure.step;
    $('exposure').value = app.gain;
  }
  function syncControlLabels() {
    const sc = app.cmp.scene;
    $('slitCyA').value = sc.slits[0].cy;
    $('slitCyB').value = sc.slits[1].cy;
    $('slitHw').value = sc.slits[0].hw;
    $('slitCyAVal').textContent = sc.slits[0].cy.toFixed(3);
    $('slitCyBVal').textContent = sc.slits[1].cy.toFixed(3);
    $('slitHwVal').textContent = sc.slits[0].hw.toFixed(3);
    $('globalProbVal').textContent = (+$('globalProb').value).toFixed(2);
    $('sigmaVal').textContent = (+$('sigma').value).toFixed(3);
    $('chainsVal').textContent = $('chains').value;
    $('stepsPerFrameVal').textContent = (+$('stepsPerFrame').value).toLocaleString();
    $('openFractionVal').textContent = (+$('openFraction').value).toFixed(2);
    $('exposureVal').textContent = '×' + Math.round(app.gain).toLocaleString();
    $('cmpG').textContent = (+$('globalProb').value).toFixed(2);
  }

  function readScriptOptions() {
    return {
      totalSteps: K.SCHEMA.totalSteps.def,
      openFraction: +$('openFraction').value,
      chains: Math.round(+$('chains').value),
      sigma: +$('sigma').value,
      globalProb: +$('globalProb').value
    };
  }

  function applyControlsToScene() {
    const sc = app.cmp.scene;
    sc.slits[0].cy = clamp(+$('slitCyA').value, K.SCHEMA.slitCy.min, K.SCHEMA.slitCy.max);
    sc.slits[1].cy = clamp(+$('slitCyB').value, K.SCHEMA.slitCy.min, K.SCHEMA.slitCy.max);
    const hw = +$('slitHw').value;
    sc.slits[0].hw = hw; sc.slits[1].hw = hw;
    sc.uniform = $('chkUniform').checked;
    sc.slits[0].open = $('chkA').checked;
    sc.slits[1].open = $('chkB').checked;
    for (const E of [app.cmp.A, app.cmp.B]) E.cfg.shape = $('selShape').value;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ---------------- 重置 / 剧本 ----------------
  function doReset() {
    try {
      if (!app.cmp) app.cmp = new K.Comparison({});
      applyControlsToScene();
      // 剧本默认 B 关闭；若用户手动勾选了 B，则尊重但不构成“中途打开”剧本
      const script = readScriptOptions();
      const bInfo = app.cmp.reset(script);
      if (!$('chkB').checked) { /* 标准剧本 */ }
      app.geometryDirty = false;
      app.autoRestarted = {};
      app.running = true;
      $('btnPlay').textContent = '‖ 暂停';
      $('chkA').checked = app.cmp.scene.slits[0].open;
      $('chkB').checked = app.cmp.scene.slits[1].open;
      app.refs.stale = true;
      syncControlLabels();
      renderAll();
      app.cmp.emit('ui', '界面启动剧本：b1=' + bInfo.b.toExponential(3) + '；点击“生成分遮板长曝光核对”或等待自动核对。');
      scheduleRefs(true);
    } catch (err) {
      console.error(err);
      if (app.cmp) app.cmp.emit('fail', '重置失败: ' + err.message);
    }
  }

  // 目标（场景）变化后的内核反馈闸门：手动策略下暂停推进，等待诊断动作
  function markTargetChanged(msg) {
    const sc = app.cmp.scene;
    sc.sceneVersion++;
    for (const E of [app.cmp.A, app.cmp.B]) {
      for (const ch of E.chains) ch.f = K.evalPath(sc, ch.state);
    }
    app.refs.stale = true;
    app.geometryDirty = true;
    app.cmp.emit('geom', msg || '场景目标已改变，旧 b/阶段不再严格对应');
    const policy = app.ui.policy;
    if (policy === 'auto-stage') {
      app.cmp.renormalizeStaged();
      app.geometryDirty = false;
      maybeAutoRestart();
    }
    scheduleRefs(false);
  }

  function maybeAutoRestart() {
    if (app.ui.policy !== 'auto-restart') return;
    for (const which of ['A', 'B']) {
      const d = app.diagnosis[which];
      const key = app.cmp.scene.sceneVersion + ':' + which;
      if (d && d.action === 'restart' && d.n > 6000 && !app.autoRestarted[key]) {
        app.autoRestarted[key] = true;
        app.cmp.restartChains(which, { enableGlobal: which === 'B' });
        app.geometryDirty = false;
      }
    }
  }

  // ---------------- 图像绘制 ----------------
  const offCache = {};
  function falseColor(t) {
    const stops = [
      [0.00, [6, 8, 20]], [0.22, [40, 32, 96]], [0.45, [150, 44, 140]],
      [0.68, [228, 84, 52]], [0.88, [250, 196, 70]], [1.00, [255, 252, 220]]
    ];
    t = clamp(t, 0, 1);
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
      if (t <= t1) {
        const u = (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
      }
    }
    return [255, 255, 255];
  }

  function paintFilm(canvas, img, opts) {
    opts = opts || {};
    const ctx2 = canvas.getContext('2d');
    if (!img) {
      ctx2.fillStyle = '#05070b'; ctx2.fillRect(0, 0, canvas.width, canvas.height);
      ctx2.fillStyle = '#5b6780'; ctx2.font = '16px sans-serif'; ctx2.textAlign = 'center';
      ctx2.fillText('等待估计器数据…', canvas.width / 2, canvas.height / 2);
      return;
    }
    let off = offCache[canvas.id];
    if (!off) { off = document.createElement('canvas'); off.width = img.W; off.height = img.H; offCache[canvas.id] = off; }
    const octx = off.getContext('2d');
    const id = octx.createImageData(img.W, img.H);
    const gain = opts.gain || app.gain;
    for (let p = 0, i = 0; p < img.data.length; p += 3, i += 4) {
      const r = img.data[p], g = img.data[p + 1], b = img.data[p + 2];
      let rr, gg, bb;
      if (opts.view === 'false') {
        const lum = K.lumRGB(r, g, b);
        const t = 1 - Math.exp(-lum * gain * 1.15);
        const c = falseColor(t);
        rr = c[0]; gg = c[1]; bb = c[2];
      } else {
        // 与所有图像共享同一显示增益；Reinhard + sRGB gamma，仅显示用途
        const tr = r * gain / (1 + r * gain);
        const tg = g * gain / (1 + g * gain);
        const tb = b * gain / (1 + b * gain);
        rr = 255 * Math.pow(tr, 1 / 2.2);
        gg = 255 * Math.pow(tg, 1 / 2.2);
        bb = 255 * Math.pow(tb, 1 / 2.2);
      }
      id.data[i] = rr; id.data[i + 1] = gg; id.data[i + 2] = bb; id.data[i + 3] = 255;
    }
    octx.putImageData(id, 0, 0);
    ctx2.imageSmoothingEnabled = false;
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    ctx2.drawImage(off, 0, 0, canvas.width, canvas.height);

    if (opts.evidence && opts.evidence.status) {
      const sx = canvas.width / img.W, sy = canvas.height / img.H;
      ctx2.save();
      for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) {
        if (opts.evidence.status[y * img.W + x] === 1) {
          ctx2.fillStyle = 'rgba(255,60,60,.30)';
          ctx2.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
        }
      }
      ctx2.restore();
    }
  }

  // 有符号残差图：仅作显示定标（按参照亮区平均亮度），不动任何估计器数值
  function paintDiff(canvas, img, cmpRes) {
    const ctx2 = canvas.getContext('2d');
    if (!cmpRes) {
      ctx2.fillStyle = '#05070b'; ctx2.fillRect(0, 0, canvas.width, canvas.height);
      ctx2.fillStyle = '#5b6780'; ctx2.font = '15px sans-serif'; ctx2.textAlign = 'center';
      ctx2.fillText('运行对照自测后生成残差图', canvas.width / 2, canvas.height / 2);
      return;
    }
    const W = img.W, H = img.H, n = W * H;
    let maskSum = 0, maskN = 0;
    for (let i = 0; i < n; i++) if (cmpRes.lumR[i] > 1e-6) { maskSum += cmpRes.lumR[i]; maskN++; }
    const meanRef = maskN ? maskSum / maskN : 1;
    const scale = 1 / (2.5 * meanRef);
    let off = offCache[canvas.id];
    if (!off) { off = document.createElement('canvas'); off.width = W; off.height = H; offCache[canvas.id] = off; }
    const octx = off.getContext('2d');
    const id = octx.createImageData(W, H);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let t = cmpRes.diff[i] * scale;
      t = t < -1 ? -1 : t > 1 ? 1 : t;
      const a = Math.pow(Math.abs(t), 0.75);
      // 零残差近黑；正=红（高估），负=蓝（低估）
      id.data[j] = t >= 0 ? 11 + (224 - 11) * a : 11 + (90 - 11) * a;
      id.data[j + 1] = t >= 0 ? 15 + (60 - 15) * a : 15 + (169 - 15) * a;
      id.data[j + 2] = t >= 0 ? 24 + (70 - 24) * a : 24 + (255 - 24) * a;
      id.data[j + 3] = 255;
    }
    octx.putImageData(id, 0, 0);
    ctx2.imageSmoothingEnabled = false;
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    ctx2.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  // 'last' 始终跟踪该运行的当前/最新阶段；写死的数字阶段在目标运行缺该阶段时回落到最新
  function stageIndexFor(E) {
    if (app.ui.stage === 'compose') return null;
    if (app.ui.stage === 'last') return E.stages.length - 1;
    const idx = +app.ui.stage;
    return E.stages[idx] ? idx : E.stages.length - 1;
  }
  function stageDisplayName(E) {
    if (app.ui.stage === 'compose') return '全程合成';
    const i = stageIndexFor(E);
    return E.stages[i] ? E.stages[i].label : '—';
  }

  function currentMainImage() {
    const E = app.cmp[app.ui.run];
    if (app.ui.stage === 'compose') return E.compose({ counts: true });
    return E.compose({ stageIndex: stageIndexFor(E), counts: true });
  }

  function stageOrCompose(E) {
    if (app.ui.stage === 'compose') return E.compose();
    return E.compose({ stageIndex: stageIndexFor(E) });
  }

  // 阶段可能因诊断动作（重新归一/重启）新增，阶段条按内核 stages 动态生成
  function renderStageSeg(force) {
    const seg = $('stageSeg');
    if (!seg || !app.cmp) return;
    const E = app.cmp[app.ui.run];
    const sel = stageIndexFor(E);
    const sig = app.ui.run + '|' + E.stages.length + '|' + app.ui.stage + '|' + sel;
    if (!force && seg.dataset.sig === sig) return;
    seg.dataset.sig = sig;
    const btn = (val, text, active, title) =>
      `<button data-stage="${val}" class="${active ? 'active' : ''}"${title ? ` title="${title}"` : ''}>${text}</button>`;
    let html = btn('compose', '全程合成', app.ui.stage === 'compose');
    E.stages.forEach((s, i) => {
      const text = i === 0 ? '阶段1' : i === 1 ? '阶段2（双开）' : '阶段' + (i + 1) + '（诊断后）';
      html += btn(String(i), text, app.ui.stage !== 'compose' && i === sel, s.label + ' · b=' + s.b.toExponential(3));
    });
    seg.innerHTML = html;
  }

  function focusRunLatestStage(which) {
    app.ui.run = which;
    app.ui.stage = 'last';
    $$('#runSeg button').forEach(x => x.classList.toggle('active', x.dataset.run === which));
    renderStageSeg(true);
  }

  // ---------------- 场景俯视图 ----------------
  const sceneView = { W: 760, H: 470, xmin: -2.05, xmax: 2.05, ymin: -1.62, ymax: 1.62 };
  function sceneMap() {
    const M = { l: 52, r: 40, t: 30, b: 40 };
    const pw = sceneView.W - M.l - M.r, ph = sceneView.H - M.t - M.b;
    const sc = Math.min(pw / (sceneView.xmax - sceneView.xmin), ph / (sceneView.ymax - sceneView.ymin));
    const X = (x) => M.l + (x - sceneView.xmin) / (sceneView.xmax - sceneView.xmin) * pw;
    const Y = (y) => M.t + (sceneView.ymax - y) / (sceneView.ymax - sceneView.ymin) * ph;
    return { M, sc, X, Y };
  }
  function pointerWorld(canvas, ev) {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * sceneView.W;
    const py = (ev.clientY - rect.top) / rect.height * sceneView.H;
    const { X, Y } = sceneMap();
    // 反解
    const wx = sceneView.xmin + (px - 52) / (sceneView.W - 92) * (sceneView.xmax - sceneView.xmin);
    const wy = sceneView.ymax - (py - 30) / (sceneView.H - 70) * (sceneView.ymax - sceneView.ymin);
    return { wx, wy, px, py, X, Y };
  }

  function drawScene() {
    const canvas = $('sceneCanvas');
    const ctx = canvas.getContext('2d');
    const sc = app.cmp.scene;
    const { X, Y } = sceneMap();
    ctx.clearRect(0, 0, sceneView.W, sceneView.H);
    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, sceneView.H);
    bg.addColorStop(0, '#0a101c'); bg.addColorStop(1, '#070a11');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, sceneView.W, sceneView.H);

    // 网格
    ctx.strokeStyle = 'rgba(120,150,200,.08)'; ctx.lineWidth = 1;
    ctx.fillStyle = '#5b6780'; ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
    for (let gy = -1.5; gy <= 1.5; gy += 0.5) {
      ctx.beginPath(); ctx.moveTo(X(-2), Y(gy)); ctx.lineTo(X(2), Y(gy)); ctx.stroke();
      ctx.fillText(gy.toFixed(1), 26, Y(gy) + 4);
    }

    // 屏幕 ROI 带
    for (const s of sc.slits) {
      const roi = K.slitScreenROI(sc, s);
      ctx.fillStyle = s.id === 'A' ? 'rgba(127,180,255,.13)' : 'rgba(255,217,168,.13)';
      ctx.fillRect(X(sc.D) - 4, Y(roi.hi), 26, Y(roi.lo) - Y(roi.hi));
      ctx.strokeStyle = s.id === 'A' ? 'rgba(127,180,255,.5)' : 'rgba(255,217,168,.5)';
      ctx.strokeRect(X(sc.D) - 4, Y(roi.hi), 26, Y(roi.lo) - Y(roi.hi));
    }

    // 屏幕
    ctx.strokeStyle = '#8fa3c4'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(X(sc.D), Y(-sc.syHalf)); ctx.lineTo(X(sc.D), Y(sc.syHalf)); ctx.stroke();
    ctx.fillStyle = '#8fa3c4'; ctx.fillText('屏幕 / 传感器', X(sc.D), Y(sc.syHalf) + 22);

    // 光源
    const eg = ctx.createRadialGradient(X(-sc.D), Y(0), 2, X(-sc.D), Y(0), 46);
    eg.addColorStop(0, 'rgba(255,244,214,.9)'); eg.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(X(-sc.D), Y(0), 46, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ffe9c4'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(X(-sc.D), Y(-sc.eyHalf)); ctx.lineTo(X(-sc.D), Y(sc.eyHalf)); ctx.stroke();
    ctx.fillStyle = '#cbb58d'; ctx.fillText('面光源 E', X(-sc.D), Y(sc.eyHalf) + 22);

    // 墙与狭缝
    const wallX = X(0);
    if (sc.uniform) {
      ctx.strokeStyle = 'rgba(120,135,165,.35)'; ctx.lineWidth = 7; ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.moveTo(wallX, Y(-1.5)); ctx.lineTo(wallX, Y(1.5)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#7d8aa3'; ctx.fillText('均匀照明：无遮挡墙', wallX, Y(-1.45) - 8);
    } else {
      ctx.strokeStyle = '#55637c'; ctx.lineWidth = 9;
      const intervals = sc.slits.map(s => [s.cy - s.hw, s.cy + s.hw]).sort((a, b) => a[0] - b[0]);
      let cursor = -1.55;
      for (const [lo, hi] of intervals) {
        ctx.beginPath(); ctx.moveTo(wallX, Y(cursor)); ctx.lineTo(wallX, Y(lo)); ctx.stroke();
        cursor = hi;
      }
      ctx.beginPath(); ctx.moveTo(wallX, Y(cursor)); ctx.lineTo(wallX, Y(1.55)); ctx.stroke();
      // 孔与遮板
      for (const s of sc.slits) {
        const y0 = Y(s.cy + s.hw), y1 = Y(s.cy - s.hw);
        if (s.open) {
          ctx.fillStyle = s.id === 'A' ? 'rgba(127,180,255,.85)' : 'rgba(255,217,168,.85)';
          ctx.fillRect(wallX - 5, y0, 10, Math.max(2, y1 - y0));
        } else {
          ctx.fillStyle = '#a34747';
          ctx.fillRect(wallX - 6, y0 - 1, 12, Math.max(4, y1 - y0 + 2));
          ctx.strokeStyle = 'rgba(255,120,120,.7)'; ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let yy = y0 - 4; yy < y1 + 6; yy += 7) { ctx.moveTo(wallX - 6, yy); ctx.lineTo(wallX + 6, yy + 5); }
          ctx.stroke();
        }
      }
    }

    // 光路
    const E = app.cmp[app.ui.run];
    const drawPath = (st, color, alpha, width, dash) => {
      ctx.save();
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(X(-sc.D), Y(st.ey));
      ctx.lineTo(X(sc.D), Y(st.py));
      ctx.stroke();
      ctx.restore();
    };
    // 近期接受路径
    const recent = E.trace.slice(-70);
    for (const tr of recent) {
      if (!tr.accepted) continue;
      const col = MODE_COLORS[tr.fyMode] || '#9fb4d8';
      drawPath(tr.y, col, 0.07, 1);
    }
    // 最新一次提议（慢速观察）
    const last = E.trace[E.trace.length - 1];
    if (last && app.slow) {
      drawPath(last.x, '#ffffff', 0.35, 1.4, [5, 4]);
      drawPath(last.y, last.accepted ? '#57e389' : '#ff5b5b', 0.95, 2.2, last.accepted ? [] : [7, 5]);
    }
    // 当前链
    E.chains.forEach((ch, i) => {
      const f = K.evalPath(sc, ch.state);
      const col = MODE_COLORS[f.slitId] || '#dfe9ff';
      drawPath(ch.state, col, 0.95, 1.8);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(X(sc.D), Y(ch.state.py), 3.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(X(-sc.D), Y(ch.state.ey), 3.2, 0, 7); ctx.fill();
    });

    // 可拖手柄
    for (const s of sc.slits) {
      const hy = Y(s.cy);
      ctx.beginPath(); ctx.arc(wallX, hy, 10, 0, 7);
      ctx.fillStyle = 'rgba(255,180,84,.18)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = app.drag && app.drag.id === s.id ? '#fff' : '#ffb454';
      ctx.beginPath();
      ctx.moveTo(wallX, hy - 6); ctx.lineTo(wallX + 6, hy); ctx.lineTo(wallX, hy + 6); ctx.lineTo(wallX - 6, hy);
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = '#ffb454'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(s.id + (s.open ? '' : '(关)'), wallX + 12, hy + 4);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7d8aa3'; ctx.fillText('x = 0 遮板', wallX, sceneView.H - 14);
  }

  function setupSceneDrag() {
    const canvas = $('sceneCanvas');
    canvas.addEventListener('pointerdown', (ev) => {
      const { py } = pointerWorld(canvas, ev);
      const { Y } = sceneMap();
      for (const s of app.cmp.scene.slits) {
        if (Math.abs(py - Y(s.cy)) < 16) {
          app.drag = { id: s.id, pointer: ev.pointerId };
          canvas.setPointerCapture(ev.pointerId);
          break;
        }
      }
    });
    canvas.addEventListener('pointermove', (ev) => {
      const w = pointerWorld(canvas, ev);
      if (!app.drag) {
        const { py } = w; const { Y } = sceneMap();
        let hit = false;
        for (const s of app.cmp.scene.slits) if (Math.abs(py - Y(s.cy)) < 16) hit = true;
        canvas.style.cursor = hit ? 'grab' : 'crosshair';
        return;
      }
      canvas.style.cursor = 'grabbing';
      const s = app.cmp.scene.slits.find(x => x.id === app.drag.id);
      s.cy = clamp(w.wy, K.SCHEMA.slitCy.min, K.SCHEMA.slitCy.max);
      syncControlLabels();
    });
    const end = () => {
      if (app.drag) { app.drag = null; markTargetChanged('拖动狭缝结束：几何目标已改变，诊断器需要决定重新归一或重启'); }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // ---------------- 支持域投影 ----------------
  function drawSupport() {
    const canvas = $('supportCanvas');
    if (!canvas) return;
    const d = app.diagnosis[app.ui.diagRun];
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const sc = app.cmp.scene;
    const xMin = -sc.eyHalf * 1.25, xMax = sc.eyHalf * 1.25;
    const yMin = -sc.syHalf * 1.05, yMax = sc.syHalf * 1.05;
    const X = x => 46 + (x - xMin) / (xMax - xMin) * (W - 66);
    const Y = y => 20 + (yMax - y) / (yMax - yMin) * (H - 44);
    ctx.fillStyle = '#0a0e15'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(120,150,200,.12)';
    ctx.strokeRect(46, 20, W - 66, H - 64);
    ctx.fillStyle = '#7d8aa3'; ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
    ctx.fillText('ey（光源 y，横向放大）', W / 2 + 10, H - 8);
    ctx.save(); ctx.translate(14, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('py（屏幕 y）', 0, 0); ctx.restore();

    // 通道平行四边形
    for (const s of sc.slits) {
      const col = s.id === 'A' ? [127, 180, 255] : [255, 217, 168];
      ctx.beginPath();
      const pts = [
        [-sc.eyHalf, 2 * s.cy - (-sc.eyHalf) - 2 * s.hw],
        [-sc.eyHalf, 2 * s.cy - (-sc.eyHalf) + 2 * s.hw],
        [ sc.eyHalf, 2 * s.cy - ( sc.eyHalf) + 2 * s.hw],
        [ sc.eyHalf, 2 * s.cy - ( sc.eyHalf) - 2 * s.hw]
      ];
      ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (let i = 1; i < 4; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
      ctx.closePath();
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${s.open ? .30 : .07})`;
      ctx.fill();
      ctx.setLineDash(s.open ? [] : [5, 4]);
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},.8)`; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; ctx.textAlign = 'left';
      ctx.fillText(s.id + (s.open ? '' : ' 关闭'), X(sc.eyHalf) + 6, Y(2 * s.cy) + 4);
    }

    const E = app.cmp[app.ui.diagRun];
    // 全局盒边界提示
    ctx.fillStyle = '#5b6780'; ctx.textAlign = 'right';
    ctx.fillText(E.cfg.globalProb > 0 ? `全局提议: 全盒 p=1/${K.boxVolume(sc).toFixed(2)}, g=${E.cfg.globalProb.toFixed(2)}`
      : '全局提议: 关闭 g=0', W - 12, 16);

    // 局部支撑矩形（ey/py 投影）
    for (const ch of E.chains) {
      if (E.cfg.globalProb < 1) {
        const sig = E.cfg.sigma;
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
        ctx.strokeRect(X(ch.state.ey - sig), Y(ch.state.py + sig),
          X(ch.state.ey + sig) - X(ch.state.ey - sig),
          Y(ch.state.py - sig) - Y(ch.state.py + sig));
      }
    }
    // 探针点
    if (d) {
      for (const p of d.probe.probePoints) {
        ctx.fillStyle = p.mode === 'zero' ? 'rgba(224,27,36,.55)' : (MODE_COLORS[p.mode] || '#57e389');
        ctx.fillRect(X(p.ey) - 1, Y(p.py) - 1, 2.4, 2.4);
      }
    }
    // 当前链
    for (const ch of E.chains) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(X(ch.state.ey), Y(ch.state.py), 4.5, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0b0f16'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  // ---------------- 模式时间轨迹 ----------------
  function drawTimeline() {
    const canvas = $('timelineCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0a0e15'; ctx.fillRect(0, 0, W, H);
    const strips = [['A', app.cmp.A, 8, H / 2 - 6], ['B', app.cmp.B, H / 2 + 4, H / 2 - 12]];
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    for (const [name, E, y0, h] of strips) {
      ctx.fillStyle = '#8b97ab'; ctx.fillText(name, 6, y0 + h / 2 + 4);
      const modes = E.recentModes;
      const max = E.recentMax;
      for (let i = 0; i < modes.length; i++) {
        const x = 26 + (i / max) * (W - 34);
        ctx.fillStyle = MODE_COLORS[modes[i]] || '#888';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, y0, Math.max(1, (W - 34) / max + 0.4), h);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#2a3344'; ctx.strokeRect(26, y0, W - 34, h);
    }
  }

  // ---------------- DOM 渲染 ----------------
  function renderFilms() {
    const img = currentMainImage();
    app.lastMainImg = img;
    const d = app.diagnosis[app.ui.run];
    paintFilm($('filmMain'), img, {
      view: app.ui.view, evidence: app.ui.evidence && d ? d.evidence : null
    });
    paintFilm($('filmA'), stageOrCompose(app.cmp.A), { view: app.ui.view });
    paintFilm($('filmB'), stageOrCompose(app.cmp.B), { view: app.ui.view });
  }

  function renderStats() {
    const cmp = app.cmp;
    // 剧本半程自动开 B 后，把场景状态回写到遮板控件（程序化赋值不触发 change）
    if (document.activeElement !== $('chkA')) $('chkA').checked = !!cmp.scene.slits[0].open;
    if (document.activeElement !== $('chkB')) $('chkB').checked = !!cmp.scene.slits[1].open;
    renderKernelToast();
    renderStageSeg();
    const pr = cmp.progress();
    const phaseText = { idle: '未开始', pre: '阶段1 · B 未开（CRN 同步）', post: '阶段2 · B 已开', done: '预算完成' }[pr.phase];
    const badge = $('phaseBadge');
    badge.textContent = phaseText + (pr.phase === 'pre' || pr.phase === 'post'
      ? '  ' + Math.round(100 * (pr.phase === 'pre' ? pr.pre / Math.max(1, pr.preTarget) : pr.post / Math.max(1, pr.postTarget))) + '%'
      : '');
    badge.className = 'badge ' + pr.phase;

    // 主图统计
    const E = cmp[app.ui.run];
    const img = app.lastMainImg;
    const viewSi = stageIndexFor(E);
    const viewStage = app.ui.stage === 'compose' ? null : E.stages[viewSi];
    if (img) {
      const e = K.imageEnergy(img);
      const rates = E.modeRates(app.ui.stage === 'compose' ? undefined : viewSi);
      $('filmStats').innerHTML =
        `<span>视图 <b>${app.ui.run} · ${stageDisplayName(E)}</b></span>` +
        `<span>全图亮度能量 ΣI <b>${fmt(e.lum, 4)}</b></span>` +
        `<span>像素均值 <b>${(e.lum / (img.W * img.H)).toExponential(3)}</b></span>` +
        `<span>本阶段记录状态 n <b>${viewStage ? viewStage.n : E.totalSteps}</b></span>` +
        `<span>接受率 <b>${pct(E.acceptanceRate(), 1)}</b></span>` +
        `<span>模式 <b>A ${pct(rates.A, 1)} / B ${pct(rates.B, 1)}</b></span>`;
    }

    // 对照小卡
    $('statsA').innerHTML = miniStats(cmp.A);
    $('statsB').innerHTML = miniStats(cmp.B);

    // CRN 均值行
    const f0A = cmp.A.stages[0], f0B = cmp.B.stages[0];
    if (f0A && f0B && f0A.n) {
      // 估计器真实像素均值：(film/n) 后再按像素数平均
      const mA = f0A.film.energy().lum / f0A.n / (cmp.W * cmp.H);
      const mB = f0B.film.energy().lum / f0B.n / (cmp.W * cmp.H);
      const rel = mA !== 0 ? Math.abs(mA - mB) / mA : 0;
      const line = $('preMeanLine');
      line.className = 'premean equal';
      line.innerHTML = `开口前阶段1 像素均值：A=${mA.toExponential(6)}  B=${mB.toExponential(6)}  ` +
        `相对差=<b>${rel.toExponential(2)}</b>（Float64 胶片${rel === 0 ? '逐元素相同' : '误差'}）；` +
        `开口后 A 有 g=${(+ $('globalProb').value).toFixed(2)} 全盒全局提议，B 的 g=0 且有界支撑域够不到 B 通道。`;
    }

    // 右栏状态
    $('statusPanel').innerHTML =
      kv('剧本进度', `${pr.donePre || pr.pre}/${pr.preTarget} 前 · ${pr.post}/${pr.postTarget} 后`) +
      kv('运行状态', app.running ? (app.slow ? '慢速观察中' : '连续采样中') : '已暂停') +
      kv('A 总接受率', pct(cmp.A.acceptanceRate(), 2)) +
      kv('A 全局/局部', `${pct(cmp.A.acceptanceRate('global'), 1)} / ${pct(cmp.A.acceptanceRate('local'), 1)}`) +
      kv('B 总接受率', pct(cmp.B.acceptanceRate(), 2)) +
      kv('B 全局/局部', `${pct(cmp.B.acceptanceRate('global'), 1)} / ${pct(cmp.B.acceptanceRate('local'), 1)}`) +
      kv('几何/目标', app.geometryDirty ? '<span class="bad">已改变待诊断决策</span>' : '<span class="good">阶段匹配</span>');

    // 模式面板
    $('modePanel').innerHTML = modeBars(cmp.A, 'A 运行') + modeBars(cmp.B, 'B 运行');

    // b 面板：A/B 共享阶段合并显示；诊断动作导致分叉后分别追踪各自的 b 来源
    const bCard = (tag, s, i) =>
      `<div class="audit-card"><div class="k"><b style="color:${tag === 'B' ? '#ff9d9d' : tag === 'A' ? '#7fb4ff' : '#9fe8c0'}">${tag}</b> · ${s.label}</div>` +
      `<div class="v">b${i + 1}=${s.b.toExponential(4)}</div>` +
      `<div class="k">SE=${s.bInfo.se ? s.bInfo.se.toExponential(2) : '外部'} · N=${s.bInfo.n ? s.bInfo.n.toLocaleString() : '—'}</div>` +
      `<div class="k">${s.bInfo.densityFormula || s.bInfo.proposal || ''}</div>` +
      `<div class="k">sceneVersion=${s.sceneVersion} · 时间权重=${s.timeWeight}</div></div>`;
    const bCards = [];
    for (let i = 0; i < Math.max(cmp.A.stages.length, cmp.B.stages.length); i++) {
      const sa = cmp.A.stages[i], sb = cmp.B.stages[i];
      if (sa && sb && sa.b === sb.b && sa.sceneVersion === sb.sceneVersion) bCards.push(bCard('A+B', sa, i));
      else { if (sa) bCards.push(bCard('A', sa, i)); if (sb) bCards.push(bCard('B', sb, i)); }
    }
    $('bPanel').innerHTML = bCards.join('');

    // 账目
    const audA = cmp.A.audit(), audB = cmp.B.audit();
    $('auditPanel').innerHTML =
      audA.map(a => auditRow('A·' + a.stage, a)).join('') +
      audB.map(a => auditRow('B·' + a.stage, a)).join('') +
      `<div class="hint">恒等式：胶片亮度累计 / n = b（相对误差应 ≈1e-15）；proposed = accepted + rejected，每次突变无论接受与否都记录一个状态。</div>`;

    renderInspector();
    renderTrace();
    renderLog();
    renderFractionTable();
    renderCoverage();
  }

  function kv(k, v) { return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`; }
  function miniStats(E) {
    const r = E.modeRates();
    return `<span>acc=${pct(E.acceptanceRate(), 1)} (G ${pct(E.acceptanceRate('global'), 0)} / L ${pct(E.acceptanceRate('local'), 0)})</span>` +
      `<span>A访问=${pct(r.A, 1)} · B访问=${pct(r.B, 1)} · n=${E.stage ? E.stage.n : 0}</span>`;
  }
  function modeBars(E, title) {
    const r = E.modeRates();
    const mk = (id, col) => {
      const v = r[id] || 0;
      return `<div class="bar-row"><div class="bar-head"><span style="color:${col}">${id} 模式</span><span>${pct(v, 2)}</span></div>` +
        `<div class="bar"><i style="width:${(v * 100).toFixed(2)}%;background:${col}"></i></div></div>`;
    };
    return `<div class="mode-panel"><div class="bar-head"><b>${title}</b></div>${mk('A', MODE_COLORS.A)}${mk('B', MODE_COLORS.B)}${E.scene.uniform ? mk('U', MODE_COLORS.U) : ''}</div>`;
  }
  function auditRow(label, a) {
    if (!a.n) {
      return `<div class="audit-card warn"><div class="k">${label}</div><div class="v">等待采样…</div></div>`;
    }
    const good = Math.abs(a.relErr) < 1e-8;
    return `<div class="audit-card ${good ? 'ok' : 'bad'}"><div class="k">${label} · n=${a.n.toLocaleString()}</div>` +
      `<div class="v">δ=${a.relErr.toExponential(2)}</div>` +
      `<div class="k">rawLum/n=${a.rawLumPerSample.toExponential(5)} vs b=${a.b.toExponential(5)}</div></div>`;
  }

  function renderInspector() {
    const E = app.cmp[app.ui.run];
    const tr = E.trace[E.trace.length - 1];
    if (!tr) { $('inspectorDetail').textContent = '尚无突变'; return; }
    const st = E.stage;
    const piX = st ? tr.fxStar / st.b : NaN;
    const qG = 1 / K.boxVolume(E.scene);
    $('inspectorDetail').textContent =
      `最近突变 #${tr.t} 链${tr.chain} 类型=${tr.kind} ${tr.crn ? '(CRN同步)' : ''}\n` +
      `x = (ey ${tr.x.ey.toFixed(4)}, ez ${tr.x.ez.toFixed(4)}, py ${tr.x.py.toFixed(4)}, pz ${tr.x.pz.toFixed(4)}) 模式=${tr.fxMode}\n` +
      `y = (ey ${tr.y.ey.toFixed(4)}, ez ${tr.y.ez.toFixed(4)}, py ${tr.y.py.toFixed(4)}, pz ${tr.y.pz.toFixed(4)}) 模式=${tr.fyMode}\n` +
      `fstar(x)=${tr.fxStar.toExponential(4)}  π(x)=fstar/b=${piX.toExponential(4)}\n` +
      `fstar(y)=${tr.fyStar.toExponential(4)}\n` +
      `q(x→y)=${tr.qf.toExponential(4)}   q(y→x)=${tr.qr.toExponential(4)}   (p_ind=1/V=${qG.toFixed(3)}, g=${tr.g}, σ=${tr.sigma})\n` +
      `α=min(1, f*y·qr/(f*x·qf))=${tr.alpha.toFixed(4)}   均匀随机数 u=${tr.u.toFixed(4)}  →  ${tr.accepted ? '接受' : '拒绝（原状态再次沉积）'}`;
  }

  function renderTrace() {
    const E = app.cmp[app.ui.run];
    const rows = E.trace.slice(-16).reverse();
    $('traceTable').querySelector('tbody').innerHTML = rows.map(tr =>
      `<tr><td>${tr.t}</td><td>${tr.chain}</td><td>${tr.kind}</td>` +
      `<td class="${tr.accepted ? 'trace-accept' : 'trace-reject'}">${tr.accepted ? '接受' : '拒绝'}</td>` +
      `<td style="color:${MODE_COLORS[tr.accepted ? tr.fyMode : tr.fxMode] || '#aaa'}">${tr.accepted ? (tr.fyMode || '0') : (tr.fxMode || '0')}</td>` +
      `<td>${tr.fxStar.toExponential(2)}</td><td>${tr.fyStar.toExponential(2)}</td>` +
      `<td>${tr.qf.toExponential(2)}</td><td>${tr.qr.toExponential(2)}</td>` +
      `<td>${tr.alpha.toFixed(3)}</td><td>${tr.u.toFixed(3)}</td></tr>`).join('');
  }

  function renderLog() {
    const evs = app.cmp.events.slice(-30).reverse();
    $('kernelLog').innerHTML = evs.map(e =>
      `<div class="ev-${e.kind}">[${e.kind}] ${e.msg}</div>`).join('');
  }

  // 失败必须反馈回马尔可夫光路内核：内核 emit('fail') 后这里弹出可见提示
  function renderKernelToast() {
    const toast = $('kernelToast');
    if (!toast) return;
    let latest = null;
    for (const e of app.cmp.events) if (e.kind === 'fail') latest = e;
    if (latest && latest.time !== app.lastFailTime) {
      app.lastFailTime = latest.time;
      toast.textContent = '内核反馈失败：' + latest.msg;
      toast.classList.add('show');
      clearTimeout(app.toastTimer);
      app.toastTimer = setTimeout(() => toast.classList.remove('show'), 4600);
    }
  }

  function renderCoverage() {
    if (!$('coverageStats')) return;
    const mk = (which) => {
      const E = app.cmp[which];
      let lit = 0;
      const cov = E.coverage;
      for (let i = 0; i < cov.length; i++) if (cov[i] > 0) lit++;
      const d = app.diagnosis[which];
      return `<div class="audit-card"><div class="k">${which} 链覆盖像素</div><div class="v">${lit}/${E.W * E.H} (${pct(lit / (E.W * E.H), 1)})</div>` +
        (d ? `<div class="k">ROI 内证据不足像素 ${d.evidence.weakPixels}/${d.evidence.supportPixels}</div>` : '') + `</div>`;
    };
    $('coverageStats').innerHTML = mk('A') + mk('B');
  }

  // ---------------- 诊断面板 ----------------
  function refreshDiagnosis() {
    const now = performance.now();
    if (now - app.lastDiag < 350) return;
    app.lastDiag = now;
    try {
      app.diagnosis.A = K.evaluateDiagnosis(app.cmp, 'A', { probes: 500 });
      app.diagnosis.B = K.evaluateDiagnosis(app.cmp, 'B', { probes: 500 });
    } catch (e) { console.warn('diag failed', e); }
    renderDiagPanel();
    maybeAutoRestart();
  }

  function renderDiagPanel() {
    const d = app.diagnosis[app.ui.diagRun];
    if (!d) return;
    $('diagCard').className = d.severity;
    $('diagCard').innerHTML =
      `<div class="dtitle">${d.title}</div>` +
      `<div>建议动作：<b>${{ continue: '继续累计', 'stage-renorm': '分阶段重新归一', restart: '重启链' }[d.action]}</b>` +
      ` · 接受率 ${pct(d.acceptance, 1)}（全局 ${pct(d.acceptanceGlobal, 1)} / 局部 ${pct(d.acceptanceLocal, 1)}） · n=${d.n}</div>` +
      `<ul>${d.reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
    $('regionTable').querySelector('tbody').innerHTML = d.regions.map(r => {
      const statusText = { ok: '证据相容', weak: '证据不足', unreachable: '不可达', closed: '遮板关闭' }[r.status];
      const cls = r.status === 'unreachable' ? 'bad' : r.status === 'weak' ? 'warn' : r.status === 'ok' ? 'good' : '';
      return `<tr><td style="color:${MODE_COLORS[r.id]}">${r.name}</td>` +
        `<td class="${cls}">${statusText}</td>` +
        `<td>${pct(r.expFrac, 2)}</td><td>${pct(r.rate, 2)}</td>` +
        `<td class="${r.reach < 0.002 && r.open ? 'bad' : ''}">${(r.reach * 100).toFixed(2)}%</td>` +
        `<td>${r.visits.toLocaleString()}</td></tr>`;
    }).join('');
  }

  // ---------------- 参照 / 亮度占比 ----------------
  function geometrySig() {
    const s = app.cmp.scene;
    return JSON.stringify({ u: s.uniform, slits: s.slits.map(x => [x.cy, x.hw, x.hh]) });
  }

  async function generateRefs(auto) {
    if (app.refs.busy) return;
    app.refs.busy = true;
    const btn = $('btnGenRefs');
    btn.disabled = true;
    try {
      const N_COND = 1_400_000, N_UMC = 900_000;
      const base = K.cloneScene(app.cmp.scene);
      base.uniform = false;
      const mkScene = (aOpen, bOpen) => {
        const s = K.cloneScene(base);
        s.slits[0].open = aOpen; s.slits[1].open = bOpen;
        s.sceneVersion++;
        return s;
      };
      const jobs = [
        ['both', mkScene(true, true), 'conditional', N_COND, 'refBoth'],
        ['blockB', mkScene(true, false), 'conditional', N_COND, 'refBlockB'],
        ['blockA', mkScene(false, true), 'conditional', N_COND, 'refBlockA'],
        ['umc', mkScene(true, true), 'uniform', N_UMC, 'refUmC']
      ];
      for (let ji = 0; ji < jobs.length; ji++) {
        const [key, scene, mode, n, canvasId] = jobs[ji];
        $('refProgress').textContent = `生成 ${key} …`;
        const runner = new K.ReferenceRunner(scene, { mode, seed: 20240 + ji });
        await runner.run(n, 250000, (p) => {
          $('refProgress').textContent = `生成 ${key} … ${pct(p.progress, 0)}`;
          paintFilm($(canvasId), runner.img.composed(), { view: app.ui.view });
        });
        app.refs[key] = runner.img.composed();
        paintFilm($(canvasId), app.refs[key], { view: app.ui.view });
      }
      app.refs.sig = geometrySig();
      app.refs.stale = false;
      $('refSignature').textContent = '参照几何签名 ' + app.refs.sig.slice(0, 80) + ' … 样本: 每条遮挡路 140 万条件样本 + 90 万均匀 MC';
      renderFractionTable();
    } catch (e) {
      console.error(e);
      app.cmp.emit('fail', '参照生成失败: ' + e.message);
    } finally {
      app.refs.busy = false;
      btn.disabled = false;
      $('refProgress').textContent = '完成';
      setTimeout(() => { if ($('refProgress').textContent === '完成') $('refProgress').textContent = ''; }, 2500);
    }
  }
  let refTimer = null;
  function scheduleRefs(auto) {
    clearTimeout(refTimer);
    refTimer = setTimeout(() => { if (!app.refs.busy) generateRefs(true); }, auto ? 600 : 1200);
  }

  function renderRefCanvases() {
    if (app.refs.both) paintFilm($('refBoth'), app.refs.both, { view: app.ui.view });
    if (app.refs.blockB) paintFilm($('refBlockB'), app.refs.blockB, { view: app.ui.view });
    if (app.refs.blockA) paintFilm($('refBlockA'), app.refs.blockA, { view: app.ui.view });
    if (app.refs.umc) paintFilm($('refUmC'), app.refs.umc, { view: app.ui.view });
    if (app.bench) {
      paintFilm($('uniMlt'), app.bench.mlt, { view: app.ui.view });
      paintFilm($('uniMc'), app.bench.mc, { view: app.ui.view });
      paintFilm($('uniRef'), app.bench.ref, { view: app.ui.view });
      paintDiff($('uniDiffMlt'), app.bench.mlt, app.bench.mM);
      paintDiff($('uniDiffMc'), app.bench.mc, app.bench.mC);
    } else {
      paintDiff($('uniDiffMlt'), { W: K.FILM_W, H: K.FILM_H }, null);
      paintDiff($('uniDiffMc'), { W: K.FILM_W, H: K.FILM_H }, null);
    }
  }

  function renderFractionTable() {
    const tb = $('fractionTable').querySelector('tbody');
    if (!tb) return;
    const rAonly = app.refs.blockB ? K.imageEnergy(app.refs.blockB).lum : null; // 遮 B -> 仅 A
    const rBonly = app.refs.blockA ? K.imageEnergy(app.refs.blockA).lum : null; // 遮 A -> 仅 B
    const rBoth = app.refs.both ? K.imageEnergy(app.refs.both).lum : null;
    const sum = (rAonly != null && rBonly != null) ? rAonly + rBonly : null;
    const fA = sum ? rAonly / sum : null, fB = sum ? rBonly / sum : null;
    const st2 = app.cmp.A.stages[1] || app.cmp.A.stage;
    const bInfo = st2 ? st2.bInfo : null;
    const bf = (id) => bInfo && bInfo.bBySlit[id] && bInfo.b > 0 ? bInfo.bBySlit[id].b / st2.b : null;
    const ratesA = app.cmp.A.modeRates(st2 ? st2.index : undefined);
    const ratesB = app.cmp.B.modeRates(st2 ? st2.index : undefined);
    const rows = [
      { id: 'A', e: rAonly, f: fA, bf: bf('A'), ra: ratesA.A, rb: ratesB.A },
      { id: 'B', e: rBonly, f: fB, bf: bf('B'), ra: ratesA.B, rb: ratesB.B }
    ];
    tb.innerHTML = rows.map(r => {
      const closeA = r.f != null && r.ra != null ? Math.abs(r.ra - r.f) < 0.05 : null;
      const closeB = r.f != null && r.rb != null ? Math.abs(r.rb - r.f) < 0.05 : null;
      return `<tr><td style="color:${MODE_COLORS[r.id]}">通路 ${r.id}</td>` +
        `<td>${r.id === 'A' ? '遮住 B 的长曝光' : '遮住 A 的长曝光'}</td>` +
        `<td>${r.e != null ? fmt(r.e, 5) : '待生成'}</td>` +
        `<td>${r.f != null ? pct(r.f, 2) : '—'}</td>` +
        `<td>${r.bf != null ? pct(r.bf, 2) : '—'}</td>` +
        `<td class="${closeA == null ? '' : closeA ? 'good' : 'bad'}">${pct(r.ra, 2)}</td>` +
        `<td class="${closeB == null ? '' : closeB ? 'good' : 'bad'}">${pct(r.rb, 2)}</td>` +
        `<td>${st2 && r.ra != null ? fmt(st2.b * r.ra, 4) : '—'}</td>` +
        `<td>${st2 && r.rb != null ? fmt(st2.b * r.rb, 4) : '—'}</td></tr>`;
    }).join('');

    // 能量核对卡
    const audit = [];
    if (rBoth != null && sum != null) {
      const addErr = rBoth / sum - 1;
      audit.push(card('遮挡能量可加性 E双开/(EA+EB)-1', (addErr * 100).toFixed(2) + '%', Math.abs(addErr) < 0.03 ? 'ok' : 'warn'));
    }
    if (st2) {
      const aImg = app.cmp.A.compose({ stageIndex: st2.index });
      const bImg = app.cmp.B.compose({ stageIndex: st2.index });
      const eA = K.imageEnergy(aImg).lum, eB = K.imageEnergy(bImg).lum;
      audit.push(card('b2（阶段2归一化）', st2.b.toExponential(4), ''));
      audit.push(card('A 全图能量 vs b2 恒等式', (eA / st2.b - 1).toExponential(1), Math.abs(eA / st2.b - 1) < 1e-8 ? 'ok' : 'bad'));
      audit.push(card('B 全图能量 vs b2 恒等式', (eB / st2.b - 1).toExponential(1), Math.abs(eB / st2.b - 1) < 1e-8 ? 'ok' : 'bad'));
      if (rBoth != null) {
        audit.push(card('A 对长曝光全图能量偏差', pct(eA / rBoth - 1, 2), Math.abs(eA / rBoth - 1) < 0.05 ? 'ok' : 'warn'));
        audit.push(card('B 对长曝光全图能量偏差', pct(eB / rBoth - 1, 2), Math.abs(eB / rBoth - 1) < 0.05 ? 'ok' : 'warn'));
      }
    }
    $('energyAudit').innerHTML = audit.join('') +
      `<div class="audit-card warn"><div class="k">关键对照</div><div class="v" style="font-size:12.5px">B 链全图能量同样等于 b2，但 B 通路访问率=0 → 整幅均值看不出错误，必须看分通路占比。</div></div>`;
  }
  function card(k, v, cls) {
    return `<div class="audit-card ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  }

  // ---------------- 均匀照明 benchmark ----------------
  function runUniformBench() {
    const btn = $('btnUniformBench');
    btn.disabled = true; btn.textContent = '运行中…';
    setTimeout(() => {
      try {
        const scene = K.defaultScene();
        scene.uniform = true; scene.sceneVersion = 999;
        const bInfo = K.estimateB(scene, 250000, new K.RNG(31));
        const exp = new K.Experiment({ scene, seed: 32, globalProb: 0.35, chains: 2 });
        exp.reset({ bInfo });
        exp.run(180000);
        const N = 180000;
        const mc = K.uniformMc(scene, N, 33).composed();
        const ref = K.runReferenceSync(scene, 900000, { mode: 'uniform', seed: 34 }).composed();
        const mlt = exp.compose({ counts: true });
        app.bench = { mlt, mc, ref };
        const mM = K.compareImages(mlt, ref, scene);
        const mC = K.compareImages(mc, ref, scene);
        app.bench.mM = mM; app.bench.mC = mC;
        const lit = (img) => { let n = 0; for (let i = 0; i < img.counts.length; i++) if (img.counts[i] > 0) n++; return n / img.W / img.H; };
        $('uniMetrics').innerHTML =
          card('MLT 总能量偏差', pct(mM.totalRelErr, 2), Math.abs(mM.totalRelErr) < 0.04 ? 'ok' : 'bad') +
          card('普通MC 总能量偏差', pct(mC.totalRelErr, 2), Math.abs(mC.totalRelErr) < 0.04 ? 'ok' : 'bad') +
          card('MLT 掩膜相对RMSE', fmt(mM.relRmsMasked, 3), '') +
          card('普通MC 掩膜相对RMSE', fmt(mC.relRmsMasked, 3), '') +
          card('MLT 像素覆盖率', pct(lit(mlt), 1), '') +
          card('普通MC 像素覆盖率', pct(lit(mc), 1), '');
        renderRefCanvases();
      } catch (e) {
        console.error(e);
      } finally {
        btn.disabled = false; btn.textContent = '运行均匀照明对照自测';
      }
    }, 40);
  }

  // ---------------- 主循环 ----------------
  function frame(ts) {
    if (app.cmp) {
      if (app.running && !app.geometryDirty) {
        if (app.slow) {
          if (ts - app.lastSlow > 170) { app.cmp.tick(1); app.lastSlow = ts; }
        } else {
          app.cmp.tick(+$('stepsPerFrame').value);
        }
      }
      drawScene();
      drawSupport();
      drawTimeline();
      if (!app.lastPaint || ts - app.lastPaint > 90) {
        app.lastPaint = ts;
        renderFilms();
      }
      refreshDiagnosis();
      if (ts - app.lastDom > 250) {
        app.lastDom = ts;
        syncControlLabels();
        renderStats();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------- 事件绑定 ----------------
  function bindEvents() {
    $('btnReset').addEventListener('click', doReset);
    $('btnPlay').addEventListener('click', () => {
      app.running = !app.running;
      $('btnPlay').textContent = app.running ? '‖ 暂停' : '▶ 继续';
    });
    $('btnStep').addEventListener('click', () => {
      if (app.geometryDirty) { app.cmp.emit('fail', '目标已改变：不能在旧阶段上单步，请先执行诊断动作（重新归一/重启）'); renderLog(); return; }
      app.running = false; $('btnPlay').textContent = '▶ 继续';
      app.cmp.tick(1);
    });
    $('chkSlow').addEventListener('change', e => { app.slow = e.target.checked; });

    for (const id of ['globalProb', 'sigma', 'chains', 'stepsPerFrame', 'openFraction', 'exposure', 'slitCyA', 'slitCyB', 'slitHw']) {
      $(id).addEventListener('input', () => {
        // 先把 DOM 值录入内核场景，再 syncControlLabels——后者会用场景值回写狭缝滑杆，顺序反了会把拖动值弹回
        if (id === 'exposure') app.gain = +$('exposure').value;
        if (id === 'globalProb') app.cmp.A.cfg.globalProb = +$('globalProb').value;
        if (id === 'sigma') { app.cmp.A.cfg.sigma = +$('sigma').value; app.cmp.B.cfg.sigma = +$('sigma').value; }
        if (id === 'chains') { /* 链数在重置时生效，避免运行中拆账 */ }
        if (id === 'slitCyA' || id === 'slitCyB') {
          const idx = id === 'slitCyA' ? 0 : 1;
          app.cmp.scene.slits[idx].cy = +$(id).value;
        }
        if (id === 'slitHw') {
          const hw = +$('slitHw').value;
          app.cmp.scene.slits[0].hw = hw; app.cmp.scene.slits[1].hw = hw;
        }
        syncControlLabels();
      });
      if (id === 'slitCyA' || id === 'slitCyB' || id === 'slitHw') {
        $(id).addEventListener('change', () => markTargetChanged('滑杆提交狭缝几何变更，需要诊断器重新归一/重启'));
      }
    }

    $('selShape').addEventListener('change', e => {
      app.cmp.A.cfg.shape = e.target.value; app.cmp.B.cfg.shape = e.target.value;
      app.cmp.emit('ui', '扰动核切换为 ' + e.target.value + '；q 密度与支撑域诊断随之更新');
    });

    $('chkA').addEventListener('change', e => {
      app.cmp.scene.slits[0].open = e.target.checked;
      markTargetChanged(e.target.checked ? '遮板 A 打开' : '遮板 A 关闭（遮挡长曝光对应配置）');
    });
    $('chkB').addEventListener('change', e => {
      if (e.target.checked && app.cmp.phase === 'pre') {
        app.cmp.openSecondPath();
        app.refs.stale = true;
      } else {
        app.cmp.scene.slits[1].open = e.target.checked;
        markTargetChanged(e.target.checked ? '遮板 B 手动打开' : '遮板 B 关闭');
      }
    });
    $('btnOpenB').addEventListener('click', () => {
      $('chkB').checked = true;
      if (app.cmp.phase === 'pre') {
        app.cmp.openSecondPath();
        for (const E of [app.cmp.A, app.cmp.B]) for (const ch of E.chains) ch.f = K.evalPath(app.cmp.scene, ch.state);
        app.refs.stale = true;
      } else if (!app.cmp.scene.slits[1].open) {
        $('chkB').checked = true;
        app.cmp.scene.slits[1].open = true;
        markTargetChanged('中途打开第二条亮路 B（剧本外时刻）');
      }
    });
    $('chkUniform').addEventListener('change', doReset);
    $('btnReinit').addEventListener('click', () => {
      const modesA = app.cmp.A.independentReinitialize();
      const modesB = app.cmp.B.independentReinitialize();
      app.cmp._seedMissingModes ? app.cmp._seedMissingModes(app.cmp.A) : null;
      app.cmp._seedMissingModes ? app.cmp._seedMissingModes(app.cmp.B) : null;
      app.cmp.emit('restart', '手动独立初始化：A=' + modesA.join(',') + ' B=' + modesB.join(','));
    });

    // 分段选择
    $$('#runSeg button').forEach(b => b.addEventListener('click', () => {
      $$('#runSeg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); app.ui.run = b.dataset.run;
      renderStageSeg(true);
    }));
    // 阶段按钮是动态生成的，用事件委托
    $('stageSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-stage]');
      if (!b) return;
      app.ui.stage = b.dataset.stage === 'compose' ? 'compose' : b.dataset.stage;
      renderStageSeg(true);
    });
    $$('#viewSeg button').forEach(b => b.addEventListener('click', () => {
      $$('#viewSeg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); app.ui.view = b.dataset.view;
      renderRefCanvases();
    }));
    $('chkEvidence').addEventListener('change', e => app.ui.evidence = e.target.checked);

    // tabs
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      $$('.tabpane').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
      setTimeout(() => { drawSupport(); drawTimeline(); renderRefCanvases(); }, 30);
    }));

    $('btnGenRefs').addEventListener('click', () => generateRefs(false));
    $('btnUniformBench').addEventListener('click', runUniformBench);

    // 诊断
    $('selPolicy').addEventListener('change', e => {
      app.ui.policy = e.target.value;
      app.cmp.emit('ui', '诊断策略切换为 ' + e.target.selectedOptions[0].textContent);
    });
    $$('#diagRunSeg button').forEach(b => b.addEventListener('click', () => {
      $$('#diagRunSeg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); app.ui.diagRun = b.dataset.drun;
      renderDiagPanel();
    }));
    $('actContinue').addEventListener('click', () => {
      if (app.geometryDirty) {
        app.cmp.emit('fail', '内核拒绝“继续”：sceneVersion 已变，继续旧 b 阶段会产生错误权重。请重新归一或重启。');
        renderLog();
      } else { app.cmp.continueAccumulation(0); }
    });
    $('actStage').addEventListener('click', () => {
      app.cmp.renormalizeStaged(); app.geometryDirty = false;
      app.ui.stage = 'last'; renderStageSeg(true);
    });
    $('actRestart').addEventListener('click', () => {
      app.cmp.restartChains(app.ui.diagRun, { enableGlobal: false }); app.geometryDirty = false;
      focusRunLatestStage(app.ui.diagRun);
    });
    $('actRestartGlobal').addEventListener('click', () => {
      app.cmp.restartChains(app.ui.diagRun, { enableGlobal: true }); app.geometryDirty = false;
      focusRunLatestStage(app.ui.diagRun);
    });

    // 主图像素 hover
    const fc = $('filmMain');
    fc.addEventListener('pointermove', ev => {
      const img = app.lastMainImg; if (!img) return;
      const r = fc.getBoundingClientRect();
      const ix = Math.floor((ev.clientX - r.left) / r.width * img.W);
      const iy = Math.floor((ev.clientY - r.top) / r.height * img.H);
      if (ix < 0 || iy < 0 || ix >= img.W || iy >= img.H) return;
      const p = (iy * img.W + ix) * 3;
      const py = -1.4 + (ix + .5) / img.W * 2.8;
      const pz = -0.95 + (img.H - iy - .5) / img.H * 1.9;
      const hv = $('filmHover');
      hv.style.display = 'block';
      hv.style.left = (ev.offsetX + 14) + 'px'; hv.style.top = (ev.offsetY + 10) + 'px';
      hv.textContent = `py=${py.toFixed(3)} pz=${pz.toFixed(3)}\nL=${K.lumRGB(img.data[p], img.data[p + 1], img.data[p + 2]).toExponential(3)}\ncount=${img.counts ? img.counts[iy * img.W + ix] : '—'}`;
    });
    fc.addEventListener('pointerleave', () => { $('filmHover').style.display = 'none'; });

    setupSceneDrag();
    window.addEventListener('error', (e) => {
      try { app.cmp.emit('fail', 'window.error: ' + e.message); } catch (_) { /* noop */ }
    });
  }

  function renderAll() { syncControlLabels(); renderStats(); renderDiagPanel(); }

  // ---------------- 启动 ----------------
  function boot() {
    initSliders();
    app.cmp = new K.Comparison({});
    bindEvents();
    doReset();
    requestAnimationFrame(frame);
    setTimeout(() => generateRefs(true), 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
