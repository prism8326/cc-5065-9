/*
 * 入库素材包真实性核验：node test/pack-integrity-check.js
 * 直接从 assets/packs 读取已提交的 JSON（不是测试临时生成），
 * 校验清单指纹、严格载入、并用当前采样器独立重建。任何伪报/损坏都以非零码失败。
 */
const fs = require('fs');
const path = require('path');
const K = require('../src/kernel.js');

const PACK_DIR = path.join(__dirname, '..', 'assets', 'packs');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name, extra || ''); }
  else { fail++; console.error('  FAIL', name, extra || ''); }
}

const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'));
ok('清单格式正确', manifest.format === 'ml-path-lab/stress-pack-index' && manifest.packs.length >= 3);

for (const entry of manifest.packs) {
  console.log('\n== 素材包', entry.id, '==');
  const file = path.join(PACK_DIR, entry.file);
  ok('素材包文件真实存在', fs.existsSync(file), file);
  const raw = fs.readFileSync(file, 'utf8');
  const pack = JSON.parse(raw);

  // 清单指纹与包内指纹一致
  ok('清单指纹与包指纹一致', pack.fingerprint === entry.fingerprint,
    pack.fingerprint + ' vs ' + entry.fingerprint);

  // 严格载入（结构 + 内容指纹 + 场景指纹）
  let loaded = null;
  try { loaded = K.loadStressPack(pack); ok('严格载入通过', true); }
  catch (e) { ok('严格载入通过', false, e.message); continue; }

  // 来源与参数必须落盘
  ok('保存来源（kernel 路径）', /src\/kernel\.js/.test(loaded.source.kernel));
  ok('保存生成参数（bSamples/refN/seedBase）',
    loaded.params.bSamples > 0 && loaded.params.refN > 0 && typeof loaded.params.seedBase === 'number');
  ok('记录解析能量占比', Math.abs(loaded.analyticFractions.A + loaded.analyticFractions.B - 1) < 1e-9);

  // 独立重建核验（不同随机种子，重算 b 与分路光斑）
  const verify = K.verifyStressPack(loaded, { bSamples: 300000, refN: 300000 });
  for (const c of verify.checks) {
    ok(entry.id + ' · ' + c.name, c.pass, c.detail);
  }

  // 分路 ROI：每路必须有自己的光斑来源记录
  const paths = Object.keys(loaded.attribution.perPath);
  ok('两条光路都有分路光斑记录', paths.length === 2 && paths.includes('A') && paths.includes('B'));
}

// 负面样本：伪造一个指纹正确但统计被改的包，必须在重建核验时暴露
console.log('\n== 负面样本：统计造假必须被重建核验抓出 ==');
{
  const good = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'mini-weighted.json'), 'utf8'));
  const fake = JSON.parse(JSON.stringify(good));
  // 重新计算自洽指纹但把约定 b 改为 10 倍（指纹会覆盖，故直接构造并重新生成指纹）
  fake.normalization.b = fake.normalization.b * 10;
  fake.fingerprint = K.packFingerprint(fake);
  const v = K.verifyStressPack(fake, { bSamples: 300000, refN: 300000 });
  ok('b 造假在重建核验中被抓出', v.ok === false && v.checks.some(c => !c.pass && /b/.test(c.name)));

  const tamperedScene = JSON.parse(JSON.stringify(good));
  tamperedScene.scene.slits[0].hw = 0.08;
  let rejected = false, rejectMsg = '';
  try { K.loadStressPack(tamperedScene); } catch (e) { rejected = true; rejectMsg = e.message; }
  ok('篡改场景几何被指纹拒绝', rejected, rejectMsg);

  // 即使攻击者同时重算内容指纹，场景指纹的存档比对仍会拦住几何修改
  const tamperedScene2 = JSON.parse(JSON.stringify(good));
  tamperedScene2.scene.slits[0].hw = 0.08;
  tamperedScene2.fingerprint = K.packFingerprint(tamperedScene2);
  let rejected2 = false, msg2 = '';
  try { K.loadStressPack(tamperedScene2); } catch (e) { rejected2 = true; msg2 = e.message; }
  ok('重算指纹也无法绕过场景存档指纹', rejected2 && /场景指纹/.test(msg2), msg2);
}

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
