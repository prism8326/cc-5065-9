/* 狭缝照明制作 GUI 冒烟：门/帘材质、补播、素材包光照实验窗口。node test/ui-pack-check.js */
const { chromium } = require('/workspace/.uitest/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1100 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:8123/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__APP__ && window.__APP__.cmp, { timeout: 10000 });
  const checks = [];
  const expect = (name, cond, extra) => { checks.push({ name, pass: !!cond, extra: extra || '' }); };

  // 1. 门/帘材质段：默认 B 是 door
  const blocker0 = await page.evaluate(() => window.__APP__.cmp.scene.slits[1].blocker);
  expect('默认 B 材质为不透光滑门', blocker0 === 'door', blocker0);

  // 切到暗色帘
  await page.click('#blockerSeg button[data-blocker="curtain"]');
  await page.waitForTimeout(100);
  const curtain = await page.evaluate(() => {
    const s = window.__APP__.cmp.scene.slits[1];
    return { blocker: s.blocker, T: s.T, transmits: window.MLK.slitTransmits(s), dirty: window.__APP__.geometryDirty };
  });
  expect('切帘：blocker=curtain 且仍透光', curtain.blocker === 'curtain' && curtain.transmits === true, JSON.stringify(curtain));
  expect('改材质触发目标脏标记', curtain.dirty === true);

  // 帘的低能量通路：分阶段归一后能被估计且 b>门版（调用界面按钮绑定的同一内核 API）
  await page.evaluate(() => window.__APP__.cmp.renormalizeStaged());
  await page.waitForTimeout(150);
  const bCurtain = await page.evaluate(() => window.__APP__.cmp.A.stage.b);

  await page.click('#blockerSeg button[data-blocker="door"]');
  await page.waitForTimeout(80);
  await page.evaluate(() => window.__APP__.cmp.renormalizeStaged());
  await page.waitForTimeout(150);
  const bDoor = await page.evaluate(() => window.__APP__.cmp.A.stage.b);
  expect('帘版 b 严格大于门版（低能量通路计入）', bCurtain > bDoor, bCurtain.toExponential(3) + ' > ' + bDoor.toExponential(3));
  await page.evaluate(() => { const c = window.__APP__.cmp; c.A.run(6000); c.B.run(6000); });
  const doorRegion = await page.evaluate(() => {
    const d = window.MLK.evaluateDiagnosis(window.__APP__.cmp, 'B', { probes: 300 });
    return { status: d.regions.find(r => r.id === 'B').status, policy3: d.policy3 };
  });
  expect('门版 B 判决 closed 且三态=continue', doorRegion.status === 'closed' && doorRegion.policy3 === 'continue', JSON.stringify(doorRegion));

  // 2. 素材包/光照实验窗口
  await page.click('.tab[data-tab="pack"]');
  await page.waitForTimeout(400);
  const optCount = await page.$$eval('#packSelect option', os => os.length);
  expect('素材包清单载入 ≥3 项', optCount >= 3, 'options=' + optCount);

  await page.selectOption('#packSelect', 'mini-weighted.json');
  await page.click('#btnPackLoad');
  await page.waitForSelector('#packVerifyBadge.pre', { timeout: 30000 });
  const badge = await page.$eval('#packVerifyBadge', e => e.textContent);
  expect('素材包载入并核验通过', /核验通过/.test(badge), badge);

  // 移动狭缝（滑杆）
  await page.evaluate(() => {
    const sl = document.getElementById('packCyB');
    sl.value = '0.35';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const moved = await page.evaluate(() => window.__PACK_LAB__.scene.slits[1].cy);
  expect('实验窗口可移动狭缝', Math.abs(moved - 0.35) < 1e-9, String(moved));

  // 运行采样器（真实运算）
  await page.click('#btnPackRun');
  await page.waitForFunction(() => {
    const a = window.__PACK_LAB__;
    return a && a.exp && a.exp.totalSteps > 0;
  }, { timeout: 15000 });
  const runInfo = await page.evaluate(() => {
    const e = window.__PACK_LAB__.exp;
    return { steps: e.totalSteps, chains: e.chains.length, stats: document.getElementById('packStats').innerText.slice(0, 120) };
  });
  expect('采样器实际运行并产出统计', runInfo.steps > 0 && /能量/.test(runInfo.stats), JSON.stringify(runInfo).slice(0, 160));

  // 分路参考核验（实际运算）
  await page.click('#btnPackRef');
  await page.waitForFunction(() => /可加比/.test(document.getElementById('packVerifyOut').textContent), { timeout: 30000 });
  const refTxt = await page.$eval('#packVerifyOut', e => e.textContent);
  expect('分路参考核验输出可加比与解析份额', /分路光斑来源/.test(refTxt) && /1\.0/.test(refTxt));

  // 多种子研究（不挑种子）
  await page.click('#btnPackStudy');
  await page.waitForFunction(() => /miss=/.test(document.getElementById('packStudyOut').textContent), { timeout: 30000 });
  const studyTxt = await page.$eval('#packStudyOut', e => e.textContent);
  expect('多种子研究展示覆盖失败率且声明未筛选', /连续种子未筛选/.test(studyTxt) && /miss=/.test(studyTxt));

  // 异常路径：导入损坏 JSON 必须由界面提示，不崩溃
  const bad = await page.evaluateHandle(() => new Blob(['{"format":"wrong"}'], { type: 'application/json' }));
  const fileInput = await page.$('#packFile');
  await fileInput.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"wrong"}') });
  await page.waitForSelector('#packError:not([hidden])', { timeout: 5000 });
  const errShown = await page.$eval('#packError', e => /异常/.test(e.textContent));
  expect('损坏素材包由马尔可夫光路界面提示异常', errShown);

  await page.screenshot({ path: '/workspace/.uitest/shots/12-pack-lab.png', fullPage: false });

  if (errors.length) console.error('BROWSER ERRORS:\n' + errors.slice(0, 20).join('\n'));
  else console.log('NO BROWSER CONSOLE/PAGE ERRORS');

  let allPass = errors.length === 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS ' : 'FAIL ') + c.name + (c.extra ? ' — ' + c.extra : ''));
    if (!c.pass) allPass = false;
  }
  await browser.close();
  console.log(allPass ? 'UI_PACK_RESULT: PASS' : 'UI_PACK_RESULT: FAIL');
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
