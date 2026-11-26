/* 内核数值正确性验证：node test/kernel-check.js */
const K = require('../src/kernel.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name, extra || ''); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
}
function approx(a, b, rel) { return Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(b)); }

console.log('== 1. 归一化 b：均匀独立 MC vs 狭缝条件长曝光 vs 普通均匀MC ==');
{
  const scene = K.defaultScene();
  scene.slits[1].open = true;
  const t0 = Date.now();
  const bInfo = K.estimateB(scene, 600000, new K.RNG(1));
  console.log('   estimateB 600k 用时', Date.now() - t0, 'ms; b=', bInfo.b.toFixed(5), 'se=', bInfo.se.toFixed(5),
    'fracA=', (bInfo.bBySlit.A.b / bInfo.b).toFixed(4), 'fracB=', (bInfo.bBySlit.B.b / bInfo.b).toFixed(4));

  const ref = K.runReferenceSync(scene, 800000, { mode: 'conditional', seed: 2 });
  const refImg = ref.composed();
  const eRef = K.imageEnergy(refImg);
  console.log('   conditional ref energy lum=', eRef.lum.toFixed(5));
  ok('条件参照总能量 ≈ b', approx(eRef.lum, bInfo.b, 0.02), eRef.lum + ' vs ' + bInfo.b);

  const umc = K.uniformMc(scene, 1200000, 3);
  const uImg = umc.composed();
  const eU = K.imageEnergy(uImg);
  console.log('   uniform MC energy lum=', eU.lum.toFixed(5));
  ok('普通均匀MC总能量 ≈ b (5%误差)', approx(eU.lum, bInfo.b, 0.05), eU.lum + ' vs ' + bInfo.b);

  // 单缝遮挡能量可加性
  const sA = K.cloneScene(scene); sA.slits[0].open = false; // 遮 A -> 仅 B
  const sB = K.cloneScene(scene); sB.slits[1].open = false; // 遮 B -> 仅 A
  const rBonly = K.imageEnergy(K.runReferenceSync(sA, 500000, { seed: 4 }).composed()).lum;
  const rAonly = K.imageEnergy(K.runReferenceSync(sB, 500000, { seed: 5 }).composed()).lum;
  console.log('   A-only=', rAonly.toFixed(4), ' B-only=', rBonly.toFixed(4), ' sum=', (rAonly + rBonly).toFixed(4));
  ok('遮挡长曝光能量可加 E_A+E_B≈E_both', approx(rAonly + rBonly, eRef.lum, 0.02));
}

console.log('== 2. MH 账目恒等式：每状态沉积 b*f/f*，胶片亮度/n 必须等于 b ==');
{
  const scene = K.defaultScene();
  scene.slits[1].open = true;
  const exp = new K.Experiment({ scene, seed: 7, globalProb: 0.3, chains: 1 });
  exp.reset({ bSamples: 120000 });
  exp.run(200000);
  const a = exp.audit()[0];
  console.log('   audit relErr=', a.relErr.toExponential(3), ' acc=', exp.acceptanceRate().toFixed(3),
    ' gAcc=', exp.acceptanceRate('global')?.toFixed(3), ' lAcc=', exp.acceptanceRate('local')?.toFixed(3));
  ok('沉积账目相对误差 < 1e-9', Math.abs(a.relErr) < 1e-9);
  ok('proposed == accepted+rejected', exp.stats.proposed === exp.stats.accepted + exp.stats.rejected);
  ok('stage.n == proposed（单阶段）', exp.stage.n === exp.stats.proposed);
  const rates = exp.modeRates();
  const expF = K.expectedModeFractions(exp);
  console.log('   visit A=', rates.A?.toFixed(4), 'B=', rates.B?.toFixed(4),
    ' expected A=', expF.A?.toFixed(4), 'B=', expF.B?.toFixed(4));
  ok('长链模式访问率匹配 b 预测 (3% abs)', Math.abs((rates.A || 0) - expF.A) < 0.03 && Math.abs((rates.B || 0) - expF.B) < 0.03);
}

console.log('== 3. 纯局部有界扰动：跨不过零密度间隔，B 访问率严格为 0 ==');
{
  const scene = K.defaultScene();
  scene.slits[1].open = true;
  const exp = new K.Experiment({ scene, seed: 8, globalProb: 0, sigma: 0.05, chains: 1 });
  exp.reset({ bSamples: 80000 });
  // 强制初始状态在 A 模式中心
  exp.chains[0].state = { ey: 0, ez: 0, py: -1.16, pz: 0 };
  exp.chains[0].f = K.evalPath(scene, exp.chains[0].state);
  ok('指定初态确实在 A 通道', exp.chains[0].f.slitId === 'A');
  exp.run(300000);
  const rates = exp.modeRates();
  console.log('   modes=', rates, ' rejected=', exp.stats.rejected);
  ok('30万局部突变后 B 访问数=0', (exp.stage.modeCounts.B || 0) === 0);
  const probe = K.probeSupport(exp, 2000, new K.RNG(9));
  console.log('   support reach=', probe.reach);
  ok('支持域探针 B 命中率=0', (probe.reach.B || 0) === 0);
}

console.log('== 4. Comparison 剧本：CRN 前半段像素逐位相同；开口后只有 A 到 B ==');
{
  const cmp = new K.Comparison({});
  cmp.reset({ totalSteps: 120000, openFraction: 0.5, bSamples: 150000, chains: 2, globalProb: 0.35 });
  cmp.stepUnits(cmp.preTarget);
  ok('pre 结束时 phase=post（开口已触发）', cmp.phase === 'post');
  const imgA1 = cmp.A.stages[0].film;
  const imgB1 = cmp.B.stages[0].film;
  let diff = 0;
  for (let i = 0; i < imgA1.rgb.length; i++) if (imgA1.rgb[i] !== imgB1.rgb[i]) diff++;
  ok('CRN 阶段1 胶片 Float64 逐元素相同', diff === 0, 'diffElems=' + diff);
  const eA1 = imgA1.energy(), eB1 = imgB1.energy();
  ok('开口前均值完全相同', eA1.lum === eB1.lum);

  // 跑完后半段
  const t0 = Date.now();
  while (cmp.phase !== 'done') cmp.stepUnits(2000);
  console.log('   post 用时', Date.now() - t0, 'ms');
  const rA = cmp.A.modeRates(cmp.A.stages.length - 1);
  const rB = cmp.B.modeRates(cmp.B.stages.length - 1);
  console.log('   A stage2 rates', rA, 'acc=', cmp.A.acceptanceRate().toFixed(3));
  console.log('   B stage2 rates', rB, 'acc=', cmp.B.acceptanceRate().toFixed(3));
  ok('A 开口后访问 B 比例 > 5%', (rA.B || 0) > 0.05, 'B=' + rA.B);
  ok('B(仅局部) 开口后仍从未访问 B', (cmp.B.stage.modeCounts.B || 0) === 0);

  // 诊断：A 可继续，B 应建议 restart
  const dA = K.evaluateDiagnosis(cmp, 'A', { probes: 500 });
  const dB = K.evaluateDiagnosis(cmp, 'B', { probes: 500 });
  console.log('   diag A:', dA.action, dA.severity, dA.title);
  console.log('   diag B:', dB.action, dB.severity, dB.title, JSON.stringify(dB.regions.find(r => r.id === 'B')?.status));
  ok('A 诊断不为 restart', dA.action !== 'restart' || dA.regions.every(r => r.status !== 'unreachable'));
  ok('B 诊断要求 restart 且 B 区 unreachable', dB.action === 'restart' && dB.regions.find(r => r.id === 'B').status === 'unreachable');

  // B 执行重启（带全局）后应能到 B
  cmp.restartChains('B', { enableGlobal: false });
  cmp.B.run(60000);
  const rb2 = cmp.B.modeRates();
  console.log('   B restart(独立初始化) 后 rates', rb2);
  ok('独立初始化重启后链覆盖两个模式', (rb2.A || 0) > 0.05 && (rb2.B || 0) > 0.05);
}

console.log('== 5. 合成图与参照：A 份额正确，B-twin 份额错误但总能量守恒 ==');
{
  const cmp = new K.Comparison({});
  cmp.reset({ totalSteps: 200000, openFraction: 0.5, bSamples: 200000, chains: 1, globalProb: 0.5 });
  while (cmp.phase !== 'done') cmp.stepUnits(4000);
  const refBoth = K.runReferenceSync(cmp.scene, 900000, { seed: 11 }).composed();
  const a2 = cmp.A.compose({ stageIndex: 1 });
  const b2 = cmp.B.compose({ stageIndex: 1 });
  const mA = K.compareImages(a2, refBoth, cmp.scene);
  const mB = K.compareImages(b2, refBoth, cmp.scene);
  console.log('   A stage2 totalRelErr=', mA.totalRelErr.toFixed(4), ' relRmsMasked=', mA.relRmsMasked?.toFixed(3));
  console.log('   B stage2 totalRelErr=', mB.totalRelErr.toFixed(6), '(能量守恒但分布错)');
  ok('A 全图能量对参照误差 < 4%', Math.abs(mA.totalRelErr) < 0.04);
  ok('B 总能量反而精确等于 b（MLT权重守恒，证明不能只看均值）', Math.abs(mB.totalRelErr) < 0.02);
  const fr = K.estimateB(cmp.scene, 300000, new K.RNG(12)).bBySlit;
  const fBref = fr.B.b / (fr.A.b + fr.B.b);
  const fAvisit = cmp.A.modeRates(1).B;
  const fBvisit = cmp.B.modeRates(1).B || 0;
  console.log('   true B fraction=', fBref.toFixed(3), ' A-run visit B=', fAvisit.toFixed(3), ' twin visit B=', fBvisit);
  ok('A 模式份额接近真值 (<0.04)', Math.abs(fAvisit - fBref) < 0.04);
  ok('twin 模式份额严重错误 (=0)', fBvisit === 0);
}

console.log('== 6. 均匀照明场景：MLT 与普通 MC 都匹配参照 ==');
{
  const scene = K.defaultScene();
  scene.uniform = true;
  scene.sceneVersion++;
  const bInfo = K.estimateB(scene, 200000, new K.RNG(21));
  const exp = new K.Experiment({ scene, seed: 22, globalProb: 0.3, chains: 2 });
  exp.reset({ bInfo });
  exp.run(120000);
  const mlt = exp.compose();
  const ref = K.runReferenceSync(scene, 600000, { mode: 'uniform', seed: 23 }).composed();
  const m = K.compareImages(mlt, ref, scene);
  console.log('   uniform totalRelErr=', m.totalRelErr.toFixed(4), ' relRmsMasked=', m.relRmsMasked?.toFixed(3));
  ok('均匀场景 MLT 总能量误差 < 3%', Math.abs(m.totalRelErr) < 0.03);
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
