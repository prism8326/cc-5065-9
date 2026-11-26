/* 真实浏览器冒烟测试：node test/e2e.js */
const { chromium } = require('/workspace/.uitest/node_modules/playwright');

const SHOT = '/workspace/.uitest/shots';
require('fs').mkdirSync(SHOT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:8123/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__APP__ && window.__APP__.cmp, { timeout: 10000 });
  console.log('page booted');

  // 等剧本跑完
  await page.waitForFunction(() => {
    const a = window.__APP__;
    return a && a.cmp && a.cmp.phase === 'done';
  }, { timeout: 60000 });
  console.log('script done');

  const state = await page.evaluate(() => {
    const a = window.__APP__, K = window.MLK, cmp = a.cmp;
    const f0A = cmp.A.stages[0].film, f0B = cmp.B.stages[0].film;
    let diff = 0;
    for (let i = 0; i < f0A.rgb.length; i++) if (f0A.rgb[i] !== f0B.rgb[i]) diff++;
    return {
      phase: cmp.phase,
      crnDiff: diff,
      ratesA: cmp.A.modeRates(1),
      ratesB: cmp.B.modeRates(1),
      accA: cmp.A.acceptanceRate(),
      accB: cmp.B.acceptanceRate(),
      stagesA: cmp.A.stages.length,
      auditErrA: cmp.A.audit()[cmp.A.audit().length - 1].relErr,
      diagB: a.diagnosis.B && { action: a.diagnosis.B.action, status: a.diagnosis.B.regions.find(r => r.id === 'B').status },
      filmStats: document.getElementById('filmStats').innerText.slice(0, 200)
    };
  });
  console.log(JSON.stringify(state, null, 2));

  await page.screenshot({ path: SHOT + '/01-main.png' });

  // 等参照生成
  await page.waitForFunction(() => window.__APP__.refs && window.__APP__.refs.both && !window.__APP__.refs.busy,
    { timeout: 120000 });
  console.log('refs ready');
  await page.waitForTimeout(500);

  // 核对标签
  await page.click('.tab[data-tab="verify"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT + '/02-verify.png' });
  const tableText = await page.$eval('#fractionTable', t => t.innerText);
  console.log('FRACTION TABLE:\n' + tableText.split('\n').slice(0, 4).join('\n'));

  // 均匀对照自测
  await page.click('.tab[data-tab="mc"]');
  await page.click('#btnUniformBench');
  await page.waitForFunction(() => !document.getElementById('btnUniformBench').disabled, { timeout: 30000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOT + '/03-mc.png' });
  const uniMetrics = await page.$eval('#uniMetrics', t => t.innerText);
  console.log('UNI METRICS:\n' + uniMetrics.replace(/\n/g, ' | '));

  // 诊断标签
  await page.click('.tab[data-tab="diag"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: SHOT + '/04-diag.png' });

  // 切换诊断 B 并点“重启并给全局”
  await page.click('#diagRunSeg button[data-drun="B"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOT + '/05-diag-B.png' });
  await page.locator('#timelineCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator('#timelineCanvas').screenshot({ path: SHOT + '/09-timeline.png' });
  await page.screenshot({ path: SHOT + '/10-coverage.png' });
  await page.locator('header.topbar').scrollIntoViewIfNeeded();
  await page.click('#actRestartGlobal');
  await page.waitForFunction(() => window.__APP__.cmp.B.stage && window.__APP__.cmp.B.stage.n > 2000,
    { timeout: 15000 });
  const afterRestart = await page.evaluate(() => ({
    stagesB: window.__APP__.cmp.B.stages.length,
    gB: window.__APP__.cmp.B.cfg.globalProb,
    nB: window.__APP__.cmp.B.stage.n,
    activeRun: document.querySelector('#runSeg button.active') && document.querySelector('#runSeg button.active').dataset.run,
    activeStage: document.querySelector('#stageSeg button.active') && document.querySelector('#stageSeg button.active').textContent,
    stageButtons: document.querySelectorAll('#stageSeg button').length,
    logLast: window.__APP__.cmp.events.slice(-1)[0].msg
  }));
  console.log('after restart B:', JSON.stringify(afterRestart));

  // 轨迹标签
  await page.click('.tab[data-tab="trace"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOT + '/06-trace.png' });

  // 主图伪彩 + 证据叠加
  await page.click('.tab[data-tab="diag"]'); // noop focus
  await page.click('.tab[data-tab="verify"]');
  await page.click('#viewSeg button[data-view="false"]');
  await page.check('#chkEvidence');
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT + '/07-false-evidence.png' });
  await page.click('#viewSeg button[data-view="color"]');
  await page.uncheck('#chkEvidence');

  // 移动端宽度截图
  const mob = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await mob.goto('http://localhost:8123/index.html', { waitUntil: 'domcontentloaded' });
  await mob.waitForTimeout(2500);
  await mob.screenshot({ path: SHOT + '/08-mobile.png', fullPage: false });
  await mob.close();

  // 交互：拖动狭缝滑杆触发 target dirty，然后执行分阶段归一
  await page.evaluate(() => {
    const sl = document.getElementById('slitCyB');
    sl.value = '0.7';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    sl.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const slider = await page.evaluate(() => ({
    dirty: window.__APP__.geometryDirty,
    cy: window.__APP__.cmp.scene.slits[1].cy,
    label: document.getElementById('slitCyBVal').textContent,
    sliderVal: document.getElementById('slitCyB').value
  }));
  const dirty = slider.dirty;
  console.log('slider after input:', JSON.stringify(slider));
  // 单步应被内核拒绝并产生 fail 事件
  await page.click('#btnStep');
  await page.waitForTimeout(100);
  const failLogged = await page.evaluate(() => window.__APP__.cmp.events.some(e => e.kind === 'fail'));
  console.log('fail feedback logged =', failLogged);
  await page.waitForSelector('#kernelToast.show', { timeout: 3000 });
  await page.screenshot({ path: SHOT + '/11-toast.png' });
  const toastShown = await page.$eval('#kernelToast', t => t.classList.contains('show'));
  console.log('kernel toast shown =', toastShown);
  await page.click('.tab[data-tab="diag"]');
  await page.waitForTimeout(150);
  await page.click('#actStage');
  await page.waitForTimeout(200);
  const dirtyCleared = await page.evaluate(() => !window.__APP__.geometryDirty);
  console.log('dirty cleared after stage action =', dirtyCleared);

  // 测试 Playwright 内无页面错误
  await page.waitForTimeout(500);
  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.slice(0, 20).join('\n'));
  } else {
    console.log('NO BROWSER CONSOLE/PAGE ERRORS');
  }
  await browser.close();

  const sliderKept = Math.abs(slider.cy - 0.7) < 1e-9 && Math.abs(+slider.sliderVal - 0.7) < 1e-9 && slider.label === '0.700';
  const stageUiOk = afterRestart.activeRun === 'B' && /阶段3/.test(afterRestart.activeStage || '') &&
    afterRestart.stageButtons === afterRestart.stagesB + 1;
  console.log('dynamic stage seg follows restart =', stageUiOk, '|', afterRestart.activeStage);
  const ok = state.crnDiff === 0 && (state.ratesA.B || 0) > 0.05 && (state.ratesB.B || 0) === 0 &&
    state.diagB.action === 'restart' && state.diagB.status === 'unreachable' &&
    Math.abs(state.auditErrA) < 1e-8 && errors.length === 0 && dirty && sliderKept &&
    failLogged && toastShown && dirtyCleared && stageUiOk;
  console.log('slider value kept =', sliderKept);
  console.log(ok ? 'E2E_RESULT: PASS' : 'E2E_RESULT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
