# Changelog

本项目所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.7.2] - 未发布(进行中)

**逐字符文字层链路正确性修复 + 中文行间空格归并**。来源:开源组件级调研 + 只读代码审计
驱动的《质量与速度改进计划 v2》;本轮落地 W1 全部 + W2 的归并与采纳判据部分。

### Fixed(修复)

- **逐字符文字层采纳基线错误**(W1-1):采纳守卫原用 `_page_lines` 的逐 rect
  `get_text_bounded` 之和当基线,而逐字符页的 per-char rect 相互重叠 → 同一字符被重复取到
  → 基线虚高约 10%,把**正确**的行重建判为"内容变少"而拒绝;被拒页回退到同样重叠的 rect
  路径,产出逐字符/交错乱码(如 `E圣` / `RE招IMAG标ININ概G`)。改用**页面真实非空白字符数**
  作基线(`CHAR_REBUILD_MIN_RATIO=0.90`;真机校准:采纳页实测比 1.042~1.112)。
  实测 c1(11 页 Word 导出):`char_rebuilt_pages` 3→9,`stripped_lines` **378→2**
  (那 378 行"页眉页脚"此前是重复计数造成的假象)。
- **中英文本流交错**(W1-6):y 聚类条件"垂直重叠即同行"会被高大的装饰英文标题
  (字高 21~23.6)传递桥接,与中文标题(13.6)合成一行,按 x 排序后逐字交错。新增
  `_split_row_by_size()`:按"唯一字高降序相邻比值的最大间隙 ≥1.5 且高字一侧为少数(≤40%)"
  拆分 —— 正文行尾的小字号标点(实测 h=1.5 混 11.9)因高字一侧是多数而不拆。
- **页眉页脚剥离清空整页**(W1-7,由 W1-6 暴露):装饰标题在每页重复 → 被判重复页眉剥离,
  封面页**唯一**内容被剥空。不变量:剥离后若本页既无留存行也无表格块,则撤销本页剥离
  (`notes.strip_protected_pages`)。
- **逐字符定位触发判据缺口**(W1-4):原判据 `avg_chars_per_box<1.5` 会被 rect 重叠放大,
  漏掉同样逐字符定位的页(实测 68 框/68 真实字符 = 1.00 字/框,却因 avgbox=2.324 漏触发)。
  补第二支 `真实字符数/行框数 <= 1.2`(真机校准:c1 逐字符页 1.00~1.04,c2 正常页 3.13~5.81)。

### Added(新增)

- **中文行间空格归并** `lib/core/cjk.js`(W2-1):纯规则、零新增依赖、幂等。
  pymupdf4llm 在 span 拼接处无条件插空格(`helpers/pymupdf_rag.py:676` 的 `" ".join`),
  自研链的标题续行/表格词界同样注入 → 实测中文文档 5.04~15.25‰。
  规则:R0 保护 fenced/行内 code;R1 只删 CJK↔CJK 的**单个**半角空格(保留 `\t` 与连续
  ≥2 空格);R2 CJK↔拉丁/数字不动;R3 标点↔拉丁不动;R4 数字被打散只观测;R5 绝不删换行;
  R7 幂等+计数。业界无现成库(jieba 对"注入空格"判别力≈0,不予引入)。
  配置 `cjkMerge`(默认 true)/ CLI `--no-cjk-merge`;归并 ≥5 处时 warnings 透出计数。
- **采纳判据改为"归并后比优"**(W2-3):两个候选**都先归并再比 score**,避免"结构好但中文
  被插空格"的候选胜出;自研链 / pymupdf4llm / markitdown 兜底三条路径全覆盖。

### 实测(CLI 端到端,真实中文文档)

| 文档 | 归并前注入 | 归并后 | CJK 字符 | 表格行 |
| --- | --- | --- | --- | --- |
| c1 brief 11p | 12 处 (5.09‰) | **2 处 (0.85‰)** | 2359 → 2359 | 0 → 0 |
| c2 需求梳理 34p | 72 处 (6.18‰) | **5 处 (0.43‰)** | 11656 → 11656 | 91 → 91 |

零内容丢失;残留 7 处均为应当保留者(连续 ≥2 空格 2 处、行内 code 内 5 处)。
`node --test` **125/125**(新增 `test/cjk.test.js` 8 项)。

## [0.7.1] - 2026-10-06

**依赖标注与自动补装**(发版后自查发现的缺口):PDF 文字层主链依赖
(pypdfium2/pymupdf4llm)此前无检测与提示——新用户环境缺失时直提静默降级
到 markitdown 兜底,用户无从知晓。

### Added(新增)

- **依赖缺失自动安装+重试**:直提失败且原因匹配 No module named
  (pypdfium2/pymupdf4llm)时,自动 pip 补装并重试一次
  (`depsAutoInstall:false` 可禁);仍失败则 warnings 附精确 pip 修复命令。
- README **依赖分级一览表**(必需/推荐/按需三级,缺失后果列明)。
- PY_MODULES 纳入 pymupdf4llm(`dsh-md-convert deps` 命令自动覆盖)。

## [0.7.0] - 2026-10-06

**五引擎置信度驱动体系正式版**(0.6.1→0.6.15 十四个版本的收束,独立仓库首发)。
完整说明见 [Release v0.7.0](https://github.com/vclike/dsh-md-convert/releases/tag/v0.7.0)。

### 核心能力

- PDF 文字层:**PyMuPDF4LLM 段落合并直提**(主)+ **pypdfium2 结构增强链**
  (表格重建/标题层级/链接保留/页眉页脚剥离/PAGE 锚点/逐页图像占比)+ **逐字符
  定位坐标重建**(Word 导出字符级定位,纯几何零 token)
- **质量信号闭环**:assessMdQuality(表格碎片化/逐字符/列抖动)→ score<70
  自动引擎接管 → `[质量修复]`/`[质量信号]` 透明告警
- 扫描件:探针分流(复杂度 ≤40% 本地 OCR / >40% vision 任务书)+ 前台闸门
  + 三级降级链
- Office:markitdown 子进程桥(XML 无损映射)
- 可观测性:elapsedMs / decision.timings / progress.pageSeconds / quality

## [0.6.15] - 2026-10-06

**段落合并调度修复 + engine 显式选项**(用户实证驱动:五粮液一段话被直提拆成
三段——逐字符重建只恢复"行",段落边界未恢复,而质量信号测不出段落质量)。

### Added(新增)

- **engine:"pymupdf4llm" 显式选项**:强制走 pymupdf4llm 段落合并直提,
  跳过自研直提优先级(用户可显式指定引擎)。

### Changed(变更)

- **二次提取触发条件扩展**:char_rebuilt_pages>0(逐字符重建来源)的文档
  同样触发 pymupdf4llm 二次提取,且 ok 即采纳(段落合并是确定收益,
  score 测不出段落质量;采纳阈值放宽至不低于直提 -10)。
  实测五粮液:直提版一段话碎成三段 → pymupdf4llm 版完整一段(12.3s/53 页)。

## [0.6.14] - 2026-10-06

**PyMuPDF4LLM 引擎引入**(开源调研驱动,用户决策):文字层赛道成熟开源
(pymupdf/pymupdf4llm,2K star,纯几何无 ML),其段落合并/表格检测与自研链
短板精确互补(开源格局调研 2026-10-06)。

### Added(新增)

- **pymupdf4llm 二次提取引擎**(lib/py/pymupdf4llm_extract.py +
  textlayer.js pymupdf4llmExtract):质量信号触发(assessMdQuality score<70)
  时自动用 pymupdf4llm 重提,产物包 PAGE 锚点(与自研链协议一致),分数更高
  则接管(chain=`pymupdf4llm(段落合并直提)`,warnings 附 [质量修复]);依赖可选
  (`pip install pymupdf4llm`),未安装优雅跳过。
- 真机对比(三样本):工业富联含空单元格表格行 82%→4.5%(quality score
  59→100),五粮液/火山均 100;耗时 7-12s(质量信号触发才走,健康文档不受影响)。
- convertPdfTextLayer 质量评估收敛为单点(内部 assess,调用方透传 quality)。

[0.6.14]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.13...v0.6.14

## [0.6.13] - 2026-10-06

**逐字符文字层兜底**(五粮液 53 页采购文件实测驱动的质变级修复):部分 Word 导出
PDF 启用**字符级定位**——每字符一个独立行框(全册 1.1 字符/框),视觉渲染完全
正常但直提逐字断裂不可读(21307 非空行中 21165 行 ≤2 字符)。

### Added(新增)

- **`_char_rebuild_lines`**(extract_text.py): 字符坐标重建阅读行——每字符
  get_charbox 取 (x,y),y 聚类成行(字形垂直重叠判定,下划线不拆行),行内
  x 升序拼接(间隙 >max(2.5pt,0.45×前字宽) 还原词界)。纯几何零 token。
- 触发判据: 行框平均 <1.5 字符/框(字符级定位特征);notes 新增
  `char_rebuilt_pages`。竖排单列文字重建后恰为正确阅读序(每字符独立 y);
  多列竖排不支持(诚实边界)。
- 实测: 五粮液 53 页 0.89s,21307 行碎片 → 1161 行(≤2 字符 99.3%→1%),
  标题重建恢复(0→2),13 张表格重建不受影响;火山/工业富联零误触发。

[0.6.13]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.12...v0.6.13

## [0.6.12] - 2026-10-06

**文字层质量信号检测器**(P1,置信度驱动闭环的最后一块):此前用户拿到直提产物
无法知道"该不该走 vision 重转"——工业富联直提版 314 个空表格列行、citation
切碎,靠 vision 对照才被发现。现在直提完成时自动报告质量分,低分附 vision
重转建议,零判断成本。

### Added(新增)

- **assessMdQuality**(`lib/core/quality.js`,纯函数链路无关):
  - 信号①**表格碎片化**:含空单元格的表格行占比 ≥50% 触发(真机三样本校准:
    工业富联 82% vs 火山 0%,区分度完美;极至无表格不适用)
  - 信号②**表格列数抖动**(相邻行列数不一致占比,监控字段低权重)
  - 信号③**逐字符/竖排文字层极端档**(短行 ≤4 字符占比 ≥90% 触发):
    五粮液采购文件实测 shortLineRatio=1.0(Word 导出逐字符定位,直提完全不可读),
    正常区间 25-38%,距离 3 倍非过拟合;触发时 score≤30,建议整册 vision
  - 信号④**短行占比**——观测字段(0.9 以下不触发)
  - 输出 `{score, signals, issues, suggestVision, reason}`;score<70 →
    suggestVision=true,warnings 附 vision 重转建议
- 直提路径接线(convert.js modern branch + index.js fast path):结果附
  `quality` 字段,suggestVision 时警告并入 `[质量信号] ...` 前缀。
- OUTPUT_SCHEMA 新增 quality 字段文档。

[0.6.12]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.11...v0.6.12

## [0.6.11] - 2026-10-06

### Fixed(修复)

- **vision 产物命名隔离**:全页 vision 装配产物加 `-vision` 后缀
  (`<名>-vision.md`)——实测视觉装配曾覆盖同名直提产物(工业富联对照实验
  2026-10-06);两版必须并存供对比/锚点合并。

## [0.6.10] - 2026-10-06

### Fixed(修复)

- **链接提取协议白名单**:仅保留 `http/https/mailto`;过滤 PDF 内部跳转锚点
  (实测极至地点推荐.pdf 单页 9 条 `af://n29` 引用角标链接被当外链,
  纯噪音脚注占产物近 10%)。真外链回归:火山 install.sh 3 内联+8 脚注完整保留。

## [0.6.9] - 2026-10-06

**表格对齐算法第二轮迭代**(17 页投资分析报告实测驱动):v0.6.6 矩形内缩取词在该
文档上严重切碎("PE(TTM)"→"PE(T|TM)"、"35.8x"→"35.|8x")。

### Changed(变更)

- **字符级归属**(table_rebuild.py 全量重写):单元格取词从"矩形内缩
  (get_text_bounded 相交语义)"改为"每字符中心点归属行带/列带"——跨界文本
  不再切碎;词界以 **PDF 真空格字符为权威信号**(几何间隙 fallback:间隙 >
  max(2.5pt, 0.45×前字宽));格内按阅读序重排(y 顶降序分行——**字形垂直重叠
  判定**,下划线等低基线字符不拆行;x 升序拼接)。
- 迭代过程三轮实证:相交取词(切碎)→ 行框中心点(文本框粒度≠线框粒度时串列)
  → 字符级(终版)。火山 PDF 回归保持完美;工业富联 PE 表列语义正确
  ("PE(TTM) | ~35.8x | 近5年 | 89.9%分位")。

### 已知边界(诚实声明)

- 源 PDF 文字层文本框与线框列边界**系统性错位**的文档(如工业富联 CapEx 表
  "2025年Ca|pEx"),字符中心确实落在隔壁带——这是源文档文字层质量问题,继续调
  阈值会过拟合;此类文档的正确路径是 vision 路由(文字层质量信号已在路线图)。

[0.6.9]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.8...v0.6.9

## [0.6.8] - 2026-10-06

**可观测性批次**(16 页扫描件实测驱动的效率分析基建):此前"16 页跑了约 5-6 分钟,
bench 说 4 workers 理论约 1 分钟,差在哪"完全无法回答——没有数据。

### Added(新增)

- **总耗时透出**:md_convert 所有返回路径附 `elapsedMs`(工具层计时,含探针/
  引擎/装配全链路;后台作业返回时为启动耗时)。
- **扫描件路由分段计时**:decision.timings = `{depsMs, probeMs, engineMs}`
  (依赖就绪/复杂度探针/主引擎执行),vision 回退场景另附 `fallbackMs`。
- **OCR 逐页耗时**:parallel_ocr page 事件携带 `duration`(秒),progress.json
  新增 `pageSeconds` 映射(逐页,断点续跑时保留前轮数据);workers 并行有效性
  与模型冷加载占比自此有据可查。

### Fixed(修复)

- python `ok=true` 但文本过短时,attempts 的 error 为 undefined(v0.6.7 引擎
  调序后兜底链需要读它),补"文字层为空或过短"错误信息。

[0.6.8]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.7...v0.6.8

## [0.6.7] - 2026-10-06

**PDF 文字层引擎调序**:pypdfium2 结构增强链升为主引擎,markitdown 降为兜底。
依据(2026-10-06 双链路对照实证):独立环境两引擎正文内容一致,而 pypdfium2 链
独占结构增强(表格重建/标题层级/链接保留/页眉脚剥离/PAGE 锚点/visionHints)——
PDF 赛道 6 项结构能力 6:0,正文打平;且宿主内主路径省一次子进程桥往返。
markitdown 的"结构级排版"对 docx/html 成立(turndown 主场),对 PDF 从未成立
(PDF 表格拍平实测);Office 场景 markitdown 仍为主引擎且正确,本次仅调 PDF。
**可逆决策**:golden 样本库若出现增强链翻车样本,优先级随时调回。

### Changed(变更)

- `convertPdfTextLayer` 引擎顺序:pypdfium2(结构增强直提,chain 更名
  `pypdfium2(结构增强直提)`)→ markitdown 兜底(`markitdown(文字层兜底)`,
  桥接降级 warning 照常透出);attempts 顺序同步。
- 工具 description 与 README 路由表同步新优先级。

## [0.6.6] - 2026-10-06

**PDF 表格重建落地(P1-A)+ visionHints 自动闭环(P1-B)+ 基准库 v1(P1-C)**——
"无论扫描版/文字层 PDF/Office,均能准确提取文字、表格"的目标形成闭环:Office 表格
markitdown 原生支持;文字层 PDF 表格线框重建;扫描件表格走既有 vision 路由;
截图文字经自动子集任务书补全。108 项测试全绿(+6 基准库)。

### Added(新增)

- **线框表格重建**(`lib/py/table_rebuild.py` + `extract_text.py --no-tables`):
  PATH 对象 bounds 按形态分类(横/竖线,厚度≤1.5pt)→ 坐标聚类(2pt 容差)成行/列
  边界 → 网格;单元格文本内缩 1pt 取词防串格,竖线转义;区域内文本行由表格块替代,
  按 y 序交错回正文流。真机校准:火山 PDF P4 运行时表 探针一击命中
  (横线 5 组→4 行、竖线 4 组→3 列,4×3=12 单元格与真值一致);P4+P7 两表
  全部重建(`tables_rebuilt:2`)。无线框表格(纯对齐排版)诚实降级不重建。
- **visionHints 自动闭环**(P1-B):文字层发现截图页 → 自动生成 onlyPages 子集
  任务书(`maybeAutoVisionBrief`),结果附 `autoBrief:{planPath,pages,batches}`,
  渲染提示装配指引;失败降级为仅 visionHints 提示不阻塞。`vision.autoBrief`
  配置(默认 true)。截图文字"提示→人工"升级为"提示→任务书就绪"。
- **基准库 v1**(`test/golden.test.js`,P1-C):真实样本结构增强断言——协议字段/
  页眉脚剥离/标题重建/链接保留/表格重建/开关生效/确定性,`MDC_GOLDEN_PDF` 门控
  (缺样本/缺依赖优雅 SKIP)。样本库随真实场景持续喂养,引擎/阈值改动后
  `node --test test/golden.test.js` 防退化。

### Changed(变更)

- `extract_text.py` notes 新增 `tables_rebuilt`;主流程表格区域文本在页眉脚
  剥离/孤儿回挂/标题重建之前剔除(避免表格内容参与正文启发式)。

### Fixed(修复)

- PDF 文字层 markitdown **成功**路径透出子进程桥降级 warning——此前仅 Office 路径
  透出,PDF 成功路径经 `.then((r) => r.md)` 把宿主缺陷取证(进程内失败原因)丢弃。

[0.6.8]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.7...v0.6.8

[0.6.7]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.6...v0.6.7

[0.6.6]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.5...v0.6.6

## [0.6.5] - 2026-10-06

**修复 markitdown 在 DSH/Electron 宿主内全线不可用**:真机对照实证——同一台机器,
独立 Node 环境 docx/PDF markitdown 全绿,宿主进程内连 docx 都抛
`createRequire.resolve.paths is not a function`(模块解析链缺陷,Office 格式此前
无兜底直接硬失败;PDF 的 pypdfium2 兜底恰已绕开)。方案:**子进程桥**。

### Added(新增)

- **markitdown 双引擎桥**(`lib/core/markitdown.js`):① 进程内 require
  (独立环境最快路径)→ ② 失败即降级 **ELECTRON_RUN_AS_NODE=1 子进程 worker**
  (`lib/worker/markitdown-worker.cjs`,原生 Node 语义,require 解析链完整),
  两次尝试均记入 attempts 随错误透出;双失败 → `E_MARKITDOWN` 摘要;
  降级成功附 warning(含进程内失败原因)。与 python 桥(extract_text)同构。
- **onlyPages 等能力不变**;docx/xlsx/pptx 在宿主内恢复可用(经子进程桥)。

### 检测与修复过程(真机证据链)

1. docx 样本宿主内 `E_UNKNOWN: createRequire.resolve.paths...` → PDF 场景
   10-05 事故同根因,当时仅修「失败被吞」,宿主兼容性本身一直坏;
2. 独立环境同一文件 markitdown 直提成功(含此前必兜底的火山 PDF)→
   排除包问题,锁定宿主模块环境;
3. `resolve.paths` 静态搜索:dshmarket 两处命中均有 try/catch(巧合排除),
   确切无保护调用点在宿主侧(app.asar 归档,外部不可深挖)→ 选子进程桥绕开。

[0.6.5]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.4...v0.6.5

## [0.6.4] - 2026-10-06

双链路对照实测驱动的第二批:文字层**标题层级重建**与**页级局部 vision 路由骨架**——
图像密集页不再只能整册视觉重转,只对命中页出子集任务书,按锚点块合并回文字层版。
97 项测试全绿(+9),extract_text 活体自验转正(`npm run test:py`)。

### Added(新增)

- **标题层级重建**(`extract_text.py --no-headings` 关闭):行框高度聚类正文字号,
  ≥1.25× 为标题候选、≥1.40× → `##` 其余 `###`;紧邻续行合并(中文标题+西文 run
  拆行、包围盒强重叠形态,如「使用」+「Evolve Skill」)。真机校准:正文 h≈9.5,
  节标题≈1.45×,章标题≈2.48×;曾出现候选阈值差 0.01 漏字(`进化` 12.34 vs 12.35),
  校准后 14 个标题全数命中。
- **逐页图像占比 → visionHints**:raw 页面对象枚举(零渲染)统计 `FPDF_PAGEOBJ_IMAGE`
  面积占**页面面积**比(v0.6.4 两次真机修正:分母由对象面积总和改为页面面积;
  常量改用官方 `FPDF_PAGEOBJ_IMAGE`=3——硬编码 1 曾把 TEXT 对象当图像)。
  ≥15% 的页随结果返回 `visionHints:{threshold,pages,detail}`,真机校准:截图页 0.224,
  纯文字页 ≈0。
- **onlyPages 子集任务书**:`md_convert({engine:"vision", onlyPages:"5,7-9"})` 只渲染/
  转写命中页;`render_pages.py --pages` 子集渲染(manifest 新增 `pageList` 与 files
  按序对应);`computeBatchesForPages` 子集切批;`plan.source.pageList/subset` 落盘,
  子集产物 `<名>-p5-p7.md` 不覆盖全页版,`plan.assemble.merge` 附锚点替换合并指引。
- **assemble 子集感知**:`plan.source.pageList` 存在时覆盖率与合并只考察子集,
  其余页由文字层版承担;尾注标 `页子集`。
- **文字层活体自验转正**(`lib/py/selftest_extract.py` + `npm run test:py`):
  `MDC_TEST_PDF` 指向文字层 PDF 即启用(协议字段/确定性/开关生效/页眉脚剥离/
  单级 # 不新增——bash 注释行与误标不可分,改为对照断言),无环境优雅 SKIP。

### Fixed(修复)

- `FPDF_PAGEOBJ_IMAGE` 硬编码 1(实为 3,1 是 TEXT):首版 img_ratio 把文本对象
  面积当图像,分母错误与常量错误两处真机实测先后暴露并修正。

## [0.6.3] - 2026-10-05

双链路对照实测(火山方舟 PDF:文字层版 vs 视觉版逐页 diff)驱动的一轮文字层
质量升级:链接零丢失、页眉页脚剥离、孤儿符号回挂,并修复 `engine="vision"`
被静默吞掉的缺陷。文字层兜底 88 项测试全绿。

### Added(新增)

- **链接提取**(`extract_text.py --links`,默认开):raw `FPDFLink_Enumerate` +
  `FPDFAction_GetURIPath` 提取 URI 链接;URL 尾段文件名能在正文回查时内联为
  `[文件名](url)`(如 `evolve-setup-claude_code.zip`),其余入页尾「本页链接:」
  脚注——URL 零丢失。实证决策:`FPDFLink_CountRects/GetRect` 在 pypdfium2 raw
  绑定下对部分链接注解触发 access violation,逐链接矩形锚文本路放弃,
  用零风险文本启发式替代。
- **页眉页脚剥离**(`--no-headers` 关闭,默认开):边距带(y 比例) + 跨页重复
  (≥max(2,60% 页数)) + 版权/页码正则,三条件剥除运行时页眉/版权行/页码
  (实测:9 页文档剥离 55 行)。
- **孤儿符号回挂**:与正文断行的列表符/序号回挂为 `- 正文` / `N. 正文`;
  连续符号行(页边距栏布局幽灵)识别并丢弃,不再互挂成 `1. 2.`
  (实测:回挂 4 处,丢弃幽灵 31 处)。
- **提取统计随 `notes` 返回**:links_inlined/links_footnote/stripped_lines/
  orphan_merged/orphan_dropped,质量可观测。
- **vision 路由回归测试**(`test/vision-route.test.js`):显式 `engine="vision"`
  必达任务书 + 渲染失败显式返回 `E_VISION_PLAN`,均注入假渲染不触 Python。

### Fixed(修复)

- **`engine="vision"` 被静默吞掉**:`convertFile` modern-PDF 分支此前无条件先试
  文字层,有文字层的 PDF 上 vision 路由永不可达(`E_VISION_PLAN` 死码)。
  现显式 `engine="vision"` 直达扫描件路由;显式指定时 vision 失败原样报错,
  不静默降级为文字层。
- **成功路径 warnings 不渲染**:`renderOutput` 此前成功时丢弃 `warnings`
  (markitdown 兜底原因只能翻输出文件 footer 获知),现三种成功形态均透出。

[0.6.5]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.4...v0.6.5

[0.6.4]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.3...v0.6.4

[0.6.3]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.2...v0.6.3

## [0.6.2] - 2026-10-05

修复文字层 PDF 在宿主内被误判为扫描件的问题(火山方舟 PDF 实测:markitdown 在
Electron 宿主运行时内返回空,被 `catch { md = "" }` 静默吞掉,误走慢速 OCR),
并把引擎选择固化为一套可解释的路由决策逻辑。

### Added(新增)

- **文字层双引擎**(`convertPdfTextLayer`):markitdown 失败/为空时,用本来就依赖的
  pypdfium2(`lib/py/extract_text.py`,零新增依赖)兜底直提文字层——秒级、页锚点保序;
  每层尝试结果记入 `attempts`,失败原因随 `warnings` 透出,不再静默吞错。
- **引擎路由决策表**(README):有文字层→markitdown(宿主内失败→pypdfium2 兜底);
  无文字层→按复杂度分流(≤40% 本地 OCR,>40% vision 模型阅读);长任务后台优先、
  前台 30 页闸门。文字层链路返回 `decision:{route:"text-layer",via}`。

### Fixed(修复)

- `convertFile` 文字层 `catch { md = "" }` 静默吞错 → 失败原因进 `warnings`
  (如 `markitdown 文字层提取失败(<原因>),已用 pypdfium2 兜底直提`)。
- 工具失败渲染补显 `warnings`(此前后台降级/闸门拦截的具体原因对调用方不可见)。

[0.6.2]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.1...v0.6.2

## [0.6.1] - 2026-10-05

修复 97 页纯扫描采购文件实战暴露的三类缺陷:**后台作业启动失败打穿工具调用**、
**workers 默认无内存预算拖垮整机**、**前台长任务无闸门**。全部修复带回归单测
(81 项全绿,含 spawnStream 部署级真跑)。

### Fixed(修复)

- **后台作业启动降级链**(`startBackgroundConvert`):宿主拒绝 `owner: exec.agent`
  (实测报错 `session "[object Object]" has no live agent (background job owner must be live)`;
  传法与官方插件文档一致,疑似宿主侧契约漂移/回归,待上游取证)时,原实现裸调用
  `jobs.start` 使整个 `md_convert` 调用失败。现逐级降级:带 owner → 无 owner
  (unowned bucket,附 warning 提示轮询 `job_output`)→ 前台执行,任何一级失败都
  不再使调用报错(对齐 dsh-tabbit installer 同位保护)。
- **资源感知默认 workers**(`defaultWorkers`):旧默认 `min(CPU,8)` 在 22 核机即
  8 路并行 PaddleOCR,内存饱和致整机卡顿、单页 33s(bench 单 worker 基准 14.4s)。
  新默认 `min(CPU, 4, 内存预算/2.5GB)`(bench 只标定到 4 workers);Node 侧为
  单一事实源,`workers<=0` 由 `createOcrRun` 解析后显式下传 Python;
  `parallel_ocr.py` 独立 CLI 默认同步对齐(Win32 ctypes / POSIX sysconf)。
  ETA 估算(F5)同步换口径。
- **前台 OCR 页数闸门**(`ocr.foregroundMaxPages`,默认 30,0=不限制):
  `background=false` 前台跑大扫描件会占满 CPU/内存(2026-10-05 事故:97 页前台
  10 分钟仅完成 18 页且拖垮整机)。超限返回 `E_FOREGROUND_LIMIT`(新增稳定错误码)
  并附替代路线(后台 / vision / resume / 解除配置)与本地 ETA 提示;页数探查失败
  (<1s)不设闸不承诺 ETA;vision 任务书链路不受闸。
- **测试保真度 F8-2**(`spawnStream` 直测):断言了句柄上不存在的 `.killed` 属性
  (照测试替身形状写,开发沙箱 EPERM skip 从未真跑);部署级环境首次真跑即失败。
  修正为断言结案结果对象上的 `killed`。

### Changed(变更)

- 工具描述与三语 README 同步:降级链语义、新配置 `ocr.foregroundMaxPages`、
  workers 资源感知默认;CLI `--workers` 帮助文本对齐。
- 单测 81 项(v0.6.0 为 72 项):新增降级链/前台闸门/资源感知 workers 用例;
  spawnStream 直测在宿主级环境真实执行并通过。

[0.6.1]: https://github.com/yakoylp/dsh-md-convert/compare/v0.6.0...v0.6.1

## [0.6.0] - 2026-09-24

解决「长文档纯图 PDF 同步单调用被宿主中断」的结构性缺陷:转换链路升级为
**三层引擎路由 + 后台作业化 + 断点续跑 + vision 任务书闭环**。

### Added(新增)

- **三层引擎路由**(扫描件 PDF):文字层直提(markitdown)→ 复杂度探针抽样 3 页
  (首页 + 1/3 + 2/3,仅版面模型)→ 表格/公式区域占比超过 `vision.complexityRatio`
  (默认 0.4)走 vision 任务书,否则页级并行本地 OCR(任意页数);
  `vision.pagesThreshold`(默认 0=不限)保留为可选强制换轨闸;
  `engine=local|vision` 可跳过探针强制指定;探针失败保守回退本地;复杂度接近阈值时
  返回 hint 建议对比 vision 质量。
- **页级并行 OCR**(`lib/py/parallel_ocr.py`):multiprocessing.Pool 页级并行
  (initializer 一次加载引擎)+ NDJSON 流式输出(start/page/done 逐行 flush)+
  `<!--PAGE:NN-->` 页锚点 + `--resume` 断点续跑(state.json 原子落盘:跳过 done/
  重试 failed/坏状态防护)+ 失败页降级不中断 + `--probe` 复杂度探针 +
  `--workers 1` 进程内快速路径(免管道,兼容沙箱/容器)。
- **后台作业化**(`md_convert` 工具):OCR 类长任务经 `ctx.jobs` 后台执行,
  立即返回 `{ok, background:true, jobId, etaSec}`;`background=auto|true|false`、
  `engine`、`resume` 参数;**缺后台控制器时优雅降级前台并附 warning,不失败**;
  `job_kill` 取消(进程树终止,已完成页保留可续跑);done 结算为官方
  `JobOutcome{status,detail,output}` 契约。
- **vision 任务书生成**(`lib/core/vision.js`):render_pages.py 渲染 PNG →
  连续切批(`vision.batchSize` 默认 8)→ 高保真 OCR 提示词模板实例化
  (内置 `lib/py/prompts/vision-ocr.md`,`vision.promptTemplate` 可整体覆盖)→
  `plan.json` 任务书(批次/页归属/图像清单/输出契约/装配入口)。
- **装配与完整性校验工具 `md_convert_assemble`**:消费 plan.json 对各批 output 做
  确定性校验(存在非空/锚点覆盖 1..N 无缺无重无越批/严格 UTF-8/GBK 双重编码
  乱码特征/极短页统计)→ 按 PAGE 序合并最终 md;有问题仍装配(缺页占位)并返回
  findings;`review:true` 生成复查任务书(原 PNG + 逐字校正提示词 + 整批重写契约)
  并更新 plan.json,复查后重跑即再校验。CLI:`dsh-md-convert assemble <plan.json> [--review]`。
- **配置全面参数化**(Schemastery,零硬编码):`background`/`engine`/
  `ocr.workers|probeTimeoutMs|runTimeoutMs|etaPerPageSec`/
  `vision.pagesThreshold|complexityRatio|batchSize|renderScale|promptTemplate`。
- **新增稳定错误码**:`E_OCR_TIMEOUT`(前台 OCR/探针超时,可 resume)、
  `E_VISION_PLAN`(vision 任务书链路失败)、`E_ASSEMBLE`(装配致命失败)。
- 3 页纯图测试 fixture(文字层 0 字符)+ 97 页装配冒烟生成器
  (`--remove-page N` 演练缺页);单测六套 72 项全绿。

### Changed(变更)

- 扫描件 OCR 从「整份 PDF 一次同步调用」改为页级并行流式消费;
  收尾增加 state↔md 对账(防 job_kill/超时窗口静默丢页,差异页写入 warnings +
  progress 标注)与原子写盘。
- ETA 估算按实际 worker 口径(workers=0 → min(CPU,8))+ 多 worker 固定开销 40s
  (bench.md 标定:97 页 workers=4 ≈ 404s,落在 400-420s 实测区间)。
- CLI 新增 `convert` 子命令与 `--engine/--background/--resume/--review/--workers` 旗标。

### Known Issues(已知问题)

- **多 worker Pool 并行与 ctx.jobs 后台链路待部署阶段实测**:开发会话沙箱禁命名管道,
  `--workers 2+`(multiprocessing.Pool)与 node→python 管道 spawn 在沙箱内 EPERM
  (pipe=EPERM/inherit=OK 已定界,非代码缺陷)。部署验证命令:
  `dsh-md-convert convert 采购文件.pdf -o ./md --background true --workers 2`
  (97 页预期 6-7 分钟,ETA 标定 400-420s);`npm test` 中 spawnStream 直测
  在受限环境自动跳过、部署机自动真跑。
- OCR 质量取决于版面清晰度;复杂表格(多层合并/斜线表头)、超小字号可能识别不全
  (复杂版面建议 `engine:"vision"`)。
- vision 链路产出的复查任务书依赖 agent 编排转写(工具自身不调在线视觉 API)。

[0.6.0]: https://github.com/yakoylp/dsh-md-convert/compare/v0.5.6...v0.6.0
