# 马尔可夫光路实验室 · 狭缝照明制作

路径空间马尔可夫光传输（Path-space Metropolis Light Transport）教学原型，聚焦**狭窄开口与间接/低能量照明**下的采样器行为：模式覆盖、有限预算局限、材质门/帘对照、可复现的参考积分与可核验的压力素材包。

## 图形入口（主要使用方式）

```bash
./start.sh            # 等价 python3 -m http.server 8123
# 浏览器打开 http://localhost:8123/ （也可直接双击 index.html，无需联网/构建）
```

界面由内核 `src/kernel.js`（全局 `MLK`）驱动，所有数字都是采样器的真实运算结果：

| 区域 | 能力 |
| --- | --- |
| 左栏 · 狭缝场景俯视图 | 直接拖动手柄移动狭缝；滑杆改中心/半宽 |
| 左栏 · 门/帘材质 | 同一窄窗在 **全开口 / 不透光滑门 / 暗色帘** 间切换，可调帘透射率 T |
| 左栏 · 采样预算与提议 | 全局跳转预算 g、细扰动 σ、链数、每帧突变、扰动核 |
| 中栏 · 收敛图像 | 真实 MLT 估计器输出（无均值匹配/自动归一化），分阶段查看、证据不足叠加 |
| 中栏 · 两次运行对照 | A（含全支持全局提议）与 B（仅局部有界扰动）CRN 同步对照 |
| 标签页 · 亮度占比核对 | 独立封住任一通路的长曝光参考、能量可加性、b 预测份额核对 |
| 标签页 · 诊断器 | 提议支持域探针、三态决策（沿用链 / 补播新链 / 宣告不可达）、模式轨迹、像素覆盖 |
| 标签页 · 素材包/光照实验窗口 | 载入入库压力素材，移动狭缝、控制采样，预览**通过路径与收敛图像**，分路参考核验与多种子预算研究 |

异常（素材损坏、目标脏上单步、补播失败等）由内核 `emit('fail')` 经界面 toast 与日志提示，不静默吞掉。

## 命令行（仅辅助）

CLI 只负责素材包的构建/重建/核验，交互与可视化都在图形界面：

```bash
node tools/build-pack.js build <mini-symmetric|mini-weighted|door-curtain> <out.json> [bSamples] [refN]
node tools/build-pack.js verify <pack.json>     # 独立重采样核验，失败以非零码退出
node tools/build-pack.js rebuild <pack.json> <out.json>
```

## 测试与证据

```bash
node test/kernel-check.js         # 内核数值：b 归一化、MH 账目、CRN、诊断、参考对照（24 项）
node test/slit-lab-check.js       # 门/帘、三态补播、微缩双缝、多种子预算、素材包（40 项）
node test/pack-integrity-check.js # 入库素材包真实性/指纹/独立重建/造假拦截（43 项）
# 浏览器（需 Playwright chromium 与 .uitest/sysroot 库）：
node test/e2e.js                  # 旧样例端到端，必须运行到底
node test/ui-pack-check.js        # 门/帘 GUI 与光照实验窗口
```

## 核心建模约定

- 状态 θ=(ey,ez,py,pz) 关于面积测度；目标标量 f*=lum(f_RGB)，平稳密度 π=f*/b，b 由独立均匀 MC 显式估计并记录来源。
- 每条缝的 `blocker` 是权威材质字段：`open` 全透光；`door` 使整族路径 f*≡0（像素先变暗且路径族消失）；`curtain` 只把贡献乘以 T（像素变暗但低能量通路仍计入 b 与图像）。
- 诊断三态：透光但现有链支持域够不到 → 补播新链/重启；证据弱 → 可补播或继续累计；滑门关闭 → 正确判决不可达，不补链、不计能量。
- 有限预算结论用**连续固定种子**的多种子研究给出，不筛选幸运种子；模式未覆盖率与像素覆盖率如实报告。

## 入库内容

- `assets/packs/*.json`：自描述光路压力素材包（场景来源、生成参数、解析份额、b 与分路统计、像素光斑归属、内容/场景指纹）。
- `assets/packs/manifest.json`：清单与指纹索引。
- 素材包可被 `MLK.loadStressPack` 直接载入；`MLK.verifyStressPack` 用当前采样器独立重建，任何统计造假或几何篡改都会被指纹/重建核验拒绝。
