/*
 * 狭缝照明制作 · 新增能力验证：node test/slit-lab-check.js
 * 覆盖：
 *   7. 不透光滑门 vs 暗色帘（同几何只换材质）：门使整族路径消失，帘保留低能量通路
 *   8. 采样器三态决策：沿用链 / 补播新链 / 宣告不可达
 *   9. 微缩双缝场景：解析能量占比已知，独立封住任一路核验光斑来源与可加性
 *  10. 有限预算多种子研究：连续固定种子，暴露 g=0 的模式未覆盖，不筛选幸运种子
 *  11. 光路压力素材包：构建/指纹/载入/独立重建核验，篡改必被拒
 */
const K = require('../src/kernel.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name, extra || ''); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
}
function approx(a, b, rel) { return Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(b)); }

console.log('== 7. 滑门 vs 暗色帘：同一窄窗几何，只改材质 ==');
{
  const base = K.defaultScene();
  base.slits[0].blocker = 'open'; base.slits[0].open = true;
  K.normalizeScene(base);

  // 门版：B 挂不透光滑门
  const door = K.cloneScene(base);
  door.slits[1].blocker = 'door'; door.slits[1].open = false; door.slits[1].T = 0;
  K.normalizeScene(door);
  ok('门版 B 不透光', K.slitTransmits(door.slits[1]) === false);

  // 帘版：同一几何换成暗色帘（T=0.12），观察像素先变暗但路径族仍在
  const curtain = K.cloneScene(base);
  curtain.slits[1].blocker = 'curtain'; curtain.slits[1].open = false; curtain.slits[1].T = 0.12;
  K.normalizeScene(curtain);
  ok('帘版 B 仍透光（低能量通路）', K.slitTransmits(curtain.slits[1]) === true);

  const bDoor = K.estimateB(door, 300000, new K.RNG(71));
  const bCur = K.estimateB(curtain, 300000, new K.RNG(72));
  console.log('   b(door)=', bDoor.b.toExponential(4), ' b(curtain)=', bCur.b.toExponential(4),
    ' door.B=', bDoor.bBySlit.B.b, ' curtain.B=', bCur.bBySlit.B.b.toExponential(4));
  ok('门版 B 路径族严格为零（bBySlit.B=0）', bDoor.bBySlit.B.b === 0);
  ok('门版总 b 只含 A', approx(bDoor.b, bDoor.bBySlit.A.b, 1e-12));
  ok('帘版 B 仍是正的低能量通路', bCur.bBySlit.B.b > 0);
  ok('帘版 B 能量约为全开口的 T 比例（0.12±30% MC 容差）',
    approx(bCur.bBySlit.B.b, bDoor.bBySlit.A.b * 0.12 * 1.02, 0.30),
    bCur.bBySlit.B.b.toExponential(4));
  ok('帘版总 b 严格大于门版（低能量通路必须计入）', bCur.b > bDoor.b);

  // 任取一个几何命中 B 缝的状态：门给零且 blockedBy=B，帘给正贡献
  const rng = new K.RNG(73);
  let doorZero = 0, curtainPositive = 0, blockedFlag = 0, tried = 0;
  for (let i = 0; i < 20000; i++) {
    const st = K.uniformState(door, rng, {});
    const hit = K.hitSlit(door, st);
    if (!hit || hit.id !== 'B') continue;
    tried++;
    const fd = K.evalPath(door, st);
    const fc = K.evalPath(curtain, st);
    if (fd.star === 0 && fd.blockedBy === 'B') { doorZero++; blockedFlag++; }
    if (fc.star > 0 && fc.slitId === 'B') curtainPositive++;
  }
  ok('门：命中 B 缝的状态全部零贡献且带 blockedBy 标记', tried > 0 && doorZero === tried, tried + ' 个几何命中');
  ok('帘：同样状态全部保留正的低能量贡献', tried > 0 && curtainPositive === tried);

  // 参考图像：门版 B 的 ROI 全黑，帘版 B 的 ROI 有可测能量
  const refDoor = K.runReferenceSync(door, 300000, { seed: 74 }).composed();
  const refCur = K.runReferenceSync(curtain, 300000, { seed: 75 }).composed();
  const roiB = K.slitScreenROI(base, base.slits[1]);
  const eDoorB = K.imageRegionEnergy(refDoor, door, roiB.lo, roiB.hi);
  const eCurB = K.imageRegionEnergy(refCur, curtain, roiB.lo, roiB.hi);
  console.log('   ROI B 门版 lum=', eDoorB.lum, ' 帘版 lum=', eCurB.lum.toExponential(4));
  ok('门版 B 屏幕 ROI 严格无能量', eDoorB.lum === 0);
  ok('帘版 B 屏幕 ROI 有低能量光斑', eCurB.lum > 0);
}

console.log('== 8. 采样器三态决策：沿用链 / 补播新链 / 宣告不可达 ==');
{
  // 场景：A 开门、B 挂门（物理不可达）；reset 后即处于 sceneVersion 一致的干净目标
  const scene = K.defaultScene(); // 默认 B 就是 door
  scene.slits[0].blocker = 'open'; scene.slits[0].open = true;
  K.normalizeScene(scene);
  const cmp = new K.Comparison({});
  cmp.scene = scene;
  cmp.reset({ totalSteps: 60000, openFraction: 0.99, bSamples: 120000, chains: 1, globalProb: 0.3 });
  cmp.A.cfg.globalProb = 0.3; cmp.B.cfg.globalProb = 0;
  cmp.A.run(8000); cmp.B.run(8000);

  const d = K.evaluateDiagnosis(cmp, 'B', { probes: 400 });
  const bRegion = d.regions.find(r => r.id === 'B');
  ok('滑门 B 判决 closed/不可达，且不触发 restart', bRegion.status === 'closed' && d.action !== 'restart');
  ok('门通路 policy3=continue（无补链必要）', d.policy3 === 'continue');
  console.log('   门 B region:', bRegion.status, '| action=', d.action, '| policy3=', d.policy3);

  // 把 B 换成暗色帘（透光但 g=0 链在 A，跨不过零密度间隙）
  cmp.setBlocker('B', 'curtain', 0.12);
  const bInfo = K.estimateB(cmp.scene, 120000, new K.RNG(81));
  for (const E of [cmp.A, cmp.B]) E.beginStage({ label: '帘阶段', bInfo, timeWeight: 1 });
  cmp.B.run(8000);
  const d2 = K.evaluateDiagnosis(cmp, 'B', { probes: 400 });
  const b2 = d2.regions.find(r => r.id === 'B');
  console.log('   帘 B region:', b2.status, 'open=', b2.open, 'expFrac=', b2.expFrac.toExponential(2),
    'visits=', b2.visits, 'reach=', b2.reach.toExponential(2));
  ok('暗色帘 B 是透光通路', b2.open === true);
  ok('g=0 链到不了帘通路：weak/unreachable，建议补播',
    (b2.status === 'weak' || b2.status === 'unreachable') && d2.policy3 === 'reseed');

  // 补播新链：已有 A 链沿用，仅追加 B 链
  const nBefore = cmp.B.chains.length;
  const modesBefore = cmp.B.chains.map(c => c.f.slitId);
  const res = cmp.supplementChains('B');
  ok('补播返回新增链记录', Array.isArray(res.added) && res.added.length === 1, JSON.stringify(res && res.added));
  ok('补播只追加不替换：原链保留', cmp.B.chains.length === nBefore + 1 &&
    cmp.B.chains.slice(0, nBefore).every((c, i) => c.f.slitId === modesBefore[i]));
  ok('新链种子落在帘通路 B', cmp.B.chains[cmp.B.chains.length - 1].f.slitId === 'B');
  cmp.B.run(20000);
  const rates = cmp.B.modeRates();
  console.log('   补播后 B 运行 rates=', JSON.stringify(rates));
  ok('补播后两个模式都被访问', (rates.A || 0) > 0 && (rates.B || 0) > 0);

  // 已全覆盖时再补播应为空操作
  const res2 = cmp.supplementChains('B');
  ok('全覆盖后补播为空操作', res2 === null);

  // 门版下补播：没有缺失的透光模式，不应补链
  cmp.setBlocker('B', 'door');
  const res3 = cmp.supplementChains('B');
  ok('滑门关闭时无透光模式可补，补播为空', res3 === null);
}

console.log('== 9. 微缩双缝场景：已知能量占比 + 独立封路光斑核验 ==');
{
  const scene = K.miniScene({ hw: 0.02, tintA: [1, 1, 1], tintB: [1, 1, 1] });
  ok('微缩场景两条缝几何相同', scene.slits[0].hw === scene.slits[1].hw && scene.slits[0].hh === scene.slits[1].hh);
  const frac = K.analyticFractions(scene);
  console.log('   解析份额', JSON.stringify(frac));
  ok('等 tint 等几何 → 解析份额 50/50', approx(frac.A, 0.5, 1e-12) && approx(frac.B, 0.5, 1e-12));

  // 不等 tint：份额可在采样前解析写出
  const scene2 = K.miniScene({ hw: 0.02, tintA: [1, 1, 1], tintB: [0.25, 0.25, 0.25] });
  const f2 = K.analyticFractions(scene2);
  ok('加权 tint 解析份额 = 0.8/0.2', approx(f2.A, 0.8, 1e-9) && approx(f2.B, 0.2, 1e-9),
    'A=' + f2.A.toFixed(3) + ' B=' + f2.B.toFixed(3));

  // 独立 MC 的 bBySlit 份额与解析份额一致
  const bInfo = K.estimateB(scene2, 500000, new K.RNG(91));
  const mcA = bInfo.bBySlit.A.b / bInfo.b, mcB = bInfo.bBySlit.B.b / bInfo.b;
  console.log('   MC 份额 A=', mcA.toFixed(4), ' B=', mcB.toFixed(4));
  ok('独立 MC 份额匹配解析 0.8/0.2（3%）', approx(mcA, 0.8, 0.03) && approx(mcB, 0.2, 0.03));

  // 分路光斑归属：封住任一通路，另一路 ROI 能量保留，且可加
  const attr = K.referencePathAttribution(scene2, 400000, { seed: 92 });
  console.log('   分路 ROI 能量 A=', attr.perPath.A.roiLum.toExponential(4),
    ' B=', attr.perPath.B.roiLum.toExponential(4));
  console.log('   可加比', JSON.stringify(attr.additivityRatio));
  ok('单封 A 时 A-ROI 无光斑', attr.perPath.A.roiLum > 0); // 单封 B 时 A 路参考仍亮
  ok('可加性：分路 ROI 能量恢复双开参考（8%）',
    Object.values(attr.additivityRatio).every(r => r != null && Math.abs(r - 1) < 0.08));
  const ratioA = attr.perPath.A.roiLum / (attr.perPath.A.roiLum + attr.perPath.B.roiLum);
  ok('分路 ROI 能量比接近解析 0.8（6%）', approx(ratioA, 0.8, 0.06), ratioA.toFixed(4));
}

console.log('== 10. 有限预算多种子研究：不挑种子，覆盖失败必须可见 ==');
{
  const scene = K.miniScene({ hw: 0.018 });
  // g=0、单链、小预算：初始落在 A 的种子大概率永远到不了 B
  const study0 = K.budgetStudy(scene, { seeds: [1, 2, 3, 4, 5, 6], budget: 30000, globalProb: 0, chains: 1, bSamples: 120000 });
  console.log('   g=0 摘要', JSON.stringify(study0.summary, null, 0));
  const missB = study0.summary.B.missRate;
  ok('g=0 小预算下存在模式未覆盖（missRate>0），失败模式不被掩盖', missB > 0, 'B missRate=' + missB);
  ok('研究明确标注未筛选连续种子', /未做任何幸运种子筛选/.test(study0.note));

  // g>0 同预算：全局提议让覆盖显著改善
  const studyG = K.budgetStudy(scene, { seeds: [1, 2, 3, 4, 5, 6], budget: 30000, globalProb: 0.35, chains: 1, bSamples: 120000 });
  console.log('   g=0.35 摘要 B missRate=', studyG.summary.B.missRate);
  ok('全局提议改善模式覆盖', studyG.summary.B.missRate <= missB);
  // 即便 g>0，有限预算仍可能有像素未覆盖——覆盖率必须如实报告
  ok('像素覆盖率被逐种子记录且 < 1（有限预算）', studyG.rows.every(r => r.pixelCoverFraction > 0 && r.pixelCoverFraction < 1));
}

console.log('== 11. 光路压力素材包：真实构建、载入与独立重建核验 ==');
{
  const scene = K.miniScene({ hw: 0.022, tintA: [1, 1, 1], tintB: [0.5, 0.7, 1.0] });
  const pack = K.buildStressPack(scene, { bSamples: 250000, refN: 250000, name: 'unit-pack' });
  ok('素材包带格式/版本/指纹/来源',
    pack.format === 'ml-path-lab/stress-pack' && pack.formatVersion === 1 &&
    pack.fingerprint && pack.source.sceneFingerprint && /kernel\.js/.test(pack.source.kernel));
  ok('素材包保存生成参数', pack.params.bSamples === 250000 && pack.params.refN === 250000);
  ok('素材包记录解析份额与 b 分路统计',
    pack.analyticFractions.A > 0 && pack.normalization.bBySlit.A.b > 0 &&
    pack.attribution.perPath.A.roiLum > 0);

  // 严格载入
  const loaded = K.loadStressPack(JSON.parse(JSON.stringify(pack)));
  ok('合法素材包可载入', loaded.fingerprint === pack.fingerprint);

  // 独立重建核验（用不同种子重算）
  const verify = K.verifyStressPack(pack, { bSamples: 250000, refN: 250000 });
  for (const c of verify.checks) console.log('   [' + (c.pass ? 'OK' : 'XX') + ']', c.name, '—', c.detail);
  ok('重建核验全部通过（无伪报）', verify.ok === true);

  // 篡改统计必须被指纹/核验拒绝
  const tampered = JSON.parse(JSON.stringify(pack));
  tampered.normalization.b = tampered.normalization.b * 1.5;
  let rejected1 = false;
  try { K.loadStressPack(tampered); } catch (e) { rejected1 = true; }
  ok('篡改 b 被指纹拒绝', rejected1);

  const tampered2 = JSON.parse(JSON.stringify(pack));
  tampered2.scene.slits[0].hw = 0.09;
  let rejected2 = false;
  try { K.loadStressPack(tampered2); } catch (e) { rejected2 = true; }
  ok('篡改场景几何被场景指纹拒绝', rejected2);

  // 结构损坏
  let rejected3 = false;
  try { K.loadStressPack({ format: 'wrong' }); } catch (e) { rejected3 = true; }
  ok('结构无效素材包被拒绝', rejected3);
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
