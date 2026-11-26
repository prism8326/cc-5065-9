#!/usr/bin/env node
/*
 * 光路压力素材包构建/重建/校验命令行（仅辅助马尔可夫光路；图形入口见 index.html 的“素材包/光照实验窗口”）。
 *
 * 用法：
 *   node tools/build-pack.js build <kind> <out.json> [bSamples] [refN]
 *       kind: mini-symmetric | mini-weighted | door-curtain
 *   node tools/build-pack.js verify <pack.json>
 *   node tools/build-pack.js rebuild <pack.json> <out.json>   # 用当前内核重新估计并落盘新包
 *
 * 所有数字都由 src/kernel.js 的真实采样器产生；校验失败以非零码退出，绝不伪报。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require(path.join(__dirname, '..', 'src', 'kernel.js'));

function makeScene(kind) {
  if (kind === 'mini-symmetric') {
    return K.miniScene({ hw: 0.022, tintA: [0.70, 0.85, 1.00], tintB: [1.00, 0.86, 0.66], name: 'mini-symmetric' });
  }
  if (kind === 'mini-weighted') {
    // 已知 80/20 能量占比的加权双缝（等几何，差异只来自 tint）
    return K.miniScene({ hw: 0.020, tintA: [1, 1, 1], tintB: [0.25, 0.25, 0.25], name: 'mini-weighted' });
  }
  if (kind === 'door-curtain') {
    // A 全开口、B 暗色帘 T=0.12 的窄窗压力场景：低能量通路必须被计入
    const sc = K.miniScene({ hw: 0.020, tintA: [1, 1, 1], tintB: [1, 0.86, 0.66], name: 'door-curtain' });
    sc.slits[1].blocker = 'curtain';
    sc.slits[1].open = false;
    sc.slits[1].T = 0.12;
    return K.normalizeScene(sc);
  }
  throw new Error('未知 kind: ' + kind + '（可选 mini-symmetric | mini-weighted | door-curtain）');
}

function cmdBuild(kind, out, bSamples, refN) {
  const scene = makeScene(kind);
  const t0 = Date.now();
  const pack = K.buildStressPack(scene, {
    kind, name: kind, bSamples: bSamples || 400000, refN: refN || 400000,
    sourceDescription: 'tools/build-pack.js build ' + kind + ' → src/kernel.js MLK.buildStressPack'
  });
  fs.writeFileSync(out, JSON.stringify(pack, null, 2) + '\n');
  const verify = K.verifyStressPack(pack);
  console.log('构建完成', kind, '→', out, ' 用时', ((Date.now() - t0) / 1000).toFixed(1), 's');
  console.log('fingerprint', pack.fingerprint, ' b=', pack.normalization.b.toExponential(5),
    ' 解析份额', JSON.stringify(pack.analyticFractions));
  for (const c of verify.checks) console.log('  [' + (c.pass ? 'OK' : 'XX') + ']', c.name, '—', c.detail);
  if (!verify.ok) { console.error('构建后自检失败，拒绝写入伪报素材包'); process.exit(2); }
}

function cmdVerify(file) {
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = K.verifyStressPack(pack);
  console.log('校验素材包', file);
  for (const c of v.checks) console.log('  [' + (c.pass ? 'OK' : 'XX') + ']', c.name, '—', c.detail);
  if (!v.ok) { console.error('VERIFY_FAILED:', v.failure || '存在未通过检查'); process.exit(3); }
  console.log('VERIFY_OK');
}

function cmdRebuild(file, out) {
  const old = K.loadStressPack(JSON.parse(fs.readFileSync(file, 'utf8')));
  const pack = K.buildStressPack(old.scene, {
    kind: old.kind, name: old.name + '-rebuilt', bSamples: old.params.bSamples, refN: old.params.refN,
    sourceDescription: 'tools/build-pack.js rebuild（独立重采样）'
  });
  fs.writeFileSync(out, JSON.stringify(pack, null, 2) + '\n');
  console.log('重建完成 →', out, '新 fingerprint', pack.fingerprint, '（场景指纹保持', pack.source.sceneFingerprint, '）');
}

const [, , cmd, a, b, c, d] = process.argv;
try {
  if (cmd === 'build') cmdBuild(a, b, parseInt(c, 10) || 0, parseInt(d, 10) || 0);
  else if (cmd === 'verify') cmdVerify(a);
  else if (cmd === 'rebuild') cmdRebuild(a, b);
  else {
    console.error('用法: build <kind> <out> | verify <pack> | rebuild <pack> <out>');
    process.exit(1);
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(4);
}
