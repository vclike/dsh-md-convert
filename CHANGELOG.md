# Changelog

本项目所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.7.16] - 2026-10-09

### Added(新增能力)

- **文中插图进 md**(此前 `extractImages: false`,图片根本没被提取)。
  - `extract_text.py` 新增 `_page_img_blocks()`:原 `_page_img_ratio()` 只累加面积、
    **丢弃图块坐标**;现同时返回坐标,占比口径不变(visionHints 不受影响)。
  - 新增 `--extract-images <dir>` / `--image-min-area`(默认 0.02)/
    `--image-max-area`(默认 0.90)三个开关。
  - **双面积闸是实测得出的**:扫描件 PDF **每页就是一张整页大图**
    (实测 97 页**全部** areaRatio=1.0),抽出来等于复制原页面 → 上闸拦掉;
    分隔线/logo 等装饰件面积过小 → 下闸拦掉;只有介于两者之间的才是真正的文中插图。
  - `convert.js` 新增纯函数 `injectImages()`:把插图插进**对应页锚点块内**,
    md 里用 `![第 N 页插图](images/pNNN_XX.png)`(B1 相对路径,目录锚定到产物输出目录)。
- **多 agent 并发 vision 编排**。
  - `plan.json` 新增 `orchestration` 块,并**写进工具结果文本** ——
    只有回给宿主 agent 的内容才会被执行,只写在 plan 里等人去读则并发永远不会发生。
  - 架构约束:插件**无法自行派生子 agent**(无 spawn/delegate 能力),
    并发由宿主 agent 执行,与 Deep Research / agent team 同一机制。
- **提示词图片规则**(vision-ocr.md)。
  - 按"有没有信息量"二分:有信息量的图用相对路径引用 + 必须写简述(替代文字);
    装饰性图件只写 `<!-- 装饰性图件已省略 -->` 不引用文件;
    **图里是表格或文字的一律转写成 Markdown 表格/文字**,绝不整块当图片跳过。
  - 新增 `{{FIGURE_FILES}}` 变量,注入本批**真实存在**的插图候选(页号过滤),
    杜绝模型臆造图片路径。
  - 新增"批次自足"章节 + 扩充自检清单:禁止跨批补写、禁止"接上页/续"衔接语。
  - **修正跨页表格规则**:原模板要求加 `<!-- 表格跨页,未完 -->`,而装配按锚点合并,
    这类注释会留在成品里像缺陷 → 改为各页照常转写可见部分 + 表头行每页重复。

### Changed(变更)

- `vision.pagesThreshold` 默认 `0 → 30`,并附**语义澄清注释**:
  这**不是性能阈值**。实测本地 OCR 5.9s/页、vision 并发 3 路仍 ~15s/页,
  且 `T_vis < T_local ⟺ V/C < L` **与页数无关** —— 时间从不构成换轨理由。
  真正依据是宿主 `ocr.foregroundMaxPages=30` 的前台作业门槛。
  换轨仍需 `complexityRatio(40%)` 联合把关,纯文字长文档不会被盲目送去 vision。
- 新增配置:`vision.model`(默认"",空=跟随宿主)、`vision.maxConcurrency`(默认 3)、
  `vision.imageMode`(默认 `embed`)、`vision.imageMinArea`(0.02)、`vision.imageMaxArea`(0.90)。
- `renderTemplate(template, vars, {strict})`:内置模板走 **strict**(变量漏传抛错,
  避免残缺提示词静默发给转写 agent);**自定义模板保持宽松**(既有契约,缺失变量→空串)。

### Fixed(修复)

- `textlayer.js` 返回时**重建** pages 对象、只保留 `{no,imgRatio}`,把 python 透出的
  `images`/`img_blocks` 全丢了 —— 表现为"抽图成功但 md 里没有图"。
- `convert.js` 文字层调用点**未透传 `vision` 配置**,导致 `imageMode` 恒为空、功能静默失效;
  且插图目录未锚定到产物目录。
- `extract_text.py` 缺 `import os`(新增抽图路径必然 NameError);误用不存在的 `args.ocr_scale`。

### 验证

- 端到端(真实并发跑 2 个子 agent,4 页韩文简报):
  两批锚点各自对齐 `[01,02]` / `[03,04]`;装配 `coverage 4/4`、`findings 0`;
  标题层级正确、`[표 1]` 转成 Markdown 管道表格、装饰图件记为省略注释、
  **无残留模板变量 / 无开场白 / 无跨批衔接语**;批次交界无断裂。
- `node --test` 185/185;`test:py` 全 PASS;golden 18 类无退化。

## [0.7.15] - 2026-10-09

### Fixed(修复)

- **多栏页阅读顺序错乱**(W2-8,由新增的中文样本 ⑱ 暴露)。
  - 根因:`route_page` 恒按 `(y_top, x_left)` 排序 —— "从上到下、同一行从左到右"。
    多栏页因此**逐行穿插**(第1栏第1行 -> 第2栏第1行 -> 第1栏第2行 …)。
  - 实测(⑱ 12 页真实中文页):列序穿插 **40 次**(p1/p6 各 20)。
  - 修复:新增 `column_ids()` + `order_boxes_by_columns()`,多栏按
    "栏内自上而下、栏间自左向右"。单栏时**原样返回原排序,行为完全不变**。
  - 验证:穿插 **40 → 0**;块集合完全一致(纯重排、零丢块);
    锚点 12/12、表头 17→17、CJK 0‰ 均不变。

### 实现要点(都是实测踩出来的)

1. **分栏只看非整宽块**:通栏标题/分隔元素会横跨装订线,把 gutter 盖住 -> 一个空隙都找不到
   -> 永远判成单栏(第一版就是这样,12 页全判单栏,修复等于失效)。
2. **排除贴边间隙**:左右页边距也是"零覆盖带";实测 4.7% 的那条是右边距而非分栏线,
   被当成第三条栏后因块数不足触发守卫 -> 整页被否决。
3. **整宽块单独归位**:通栏标题/页脚按 y 归入"内容区之前/之后",否则会被塞进 0 号列,
   使页脚跑到最前。
4. **保守守卫**:每列须 >=3 块且纵向跨度 >= 内容区 40%,专门挡住"居中插图"造成的假分栏。
5. **零覆盖段扫描用显式 while**:"哨兵 + elif"的写法实测会漏掉整条装订线(同一份 cov,两种写法结果不同)。

### Added(新增测试)

`selftest_routing.py` 新增 8 项(纯几何、零模型依赖):双栏检出 / 左栏在前 / 右栏在后 /
栏内自上而下 / 零丢块、单栏 0 切分且**顺序与原实现完全一致**、居中插图假分栏被守卫否决。

### Known limitation(已知限制)

- **12 页里只有 2 页被判定为多栏**(p1/p6 试卷类)。OmniDocBench 标注里另有 7 页 `double_column`、
  1 页 `three_column`,本实现的保守规则**故意不碰**(宁可漏判也不错判):报纸/杂志类版面
  (`other_layout`)块结构复杂、无干净装订线,仍可能错序。
  实测 p2 报纸页的"子。我国持证种子企业…"这类半句孤悬**尚未修复**,需另立方案。

## [0.7.14] - 2026-10-09

### Fixed(修复)

- **扫描件链路的公式识别从未真正工作过**(根因不是缺依赖,而是**没初始化**)。
  - 症状:每个公式都产出 `'NoneType' object has no attribute 'predict'`。
  - 真因:公式模型是**懒加载**的(`routing_ocr.__init__` 里 `self.formula = None`,见 W3-5:
    模型 251MB 不愿急加载),而 `parallel_ocr.py` 直接取 `engine.formula` —— 扫描件链路
    **从未调用过 `formula_engine()`**,该属性恒为 `None`。
    `routing_ocr.py` 内部用的是 `formula_engine()`,所以**只有扫描件链路受害**。
  - 修复:改走 `engine.formula_engine()`。
  - 验证:⑱ 中文样本 12 页 —— 真实 LaTeX 公式 **16 处**(原先全是占位符),
    中性占位 **0** 处,内部报错 **0** 处;产物字符 **26370 → 30673(+4303)**。

- **补装缺失依赖 `ftfy`**(Apache-2.0、纯 Python、仅依赖 `wcwidth`)。
  paddleocr 公式管线在推理成功后还要过 paddlex 的 `token2str`,内部 `import ftfy`;
  缺它则公式**必然**失败。注意:这是**第二个**原因 —— 只装 ftfy 而不修上面的懒加载调用,
  实测仍报同样的错(两者都要)。

- **缺依赖时给出可操作的提示**:`deps.js` 新增 `OPTIONAL_MODULES`(ftfy → 公式识别);
  产物里出现 `$$[公式未识别]$$` 时,`warnings` 直接给出
  `请执行 python -m pip install ftfy`,而不是让用户面对 `'NoneType' ... 'predict'`。

### Added(新增测试)

- `selftest_routing.py` 增加 6 项**公式懒加载回归防护**:入口存在、未调用时属性保持 `None`、
  经 `formula_engine()` 能拿到引擎、首次调用才构造、二次调用复用、失败可观测接口存在。
  用工厂函数做测试替身(不用 `__init__` 返回对象 —— 那违反 Python 语义)。
  **负对照验证**:把调用方式回退成 `engine.formula` → 真转换的公式告警重现,护栏有效。

## [0.7.13] - 2026-10-09

### Fixed(修复)

- **内部报错原文不再泄漏进用户产物**(由新增的中文样本 ⑱ 暴露)。
  - 现场(12 页中文试卷):产物里出现
    `$$ [公式识别失败: 'NoneType' object has no attribute 'predict'] $$`
    —— 这是**内部实现细节**,用户既看不懂也不知道该做什么。
  - 根因(定位到具体模块):`ModuleNotFoundError: No module named 'ftfy'`
    —— paddleocr 的公式识别后处理需要 `ftfy`,本机未安装,**每个公式都失败**。
  - 修复:产物里改为中性占位 `$$[公式未识别]$$`(可读、可定位),
    真实原因走 `warnings` 通道:`[公式] N 处公式未能识别…;首个原因:…`
    (`routing_ocr.py` 与 `parallel_ocr.py` 两处原本都会把异常原文写进 md)。
  - 验证(12 页中文样本,34 处公式):
    中性占位 **34** 处、内部报错残留 **0**、warnings 正确给出数量与首个原因;
    并用 `scripts/verify-formula-placeholder.mjs` 证明**唯一变化就是那 34 处文本**,
    还原后与修复前**去空白逐字符相同**(24731 = 24731)—— 零内容丢失。

### Known limitation(已知限制)

- **公式识别在本机仍然不可用**(缺 `ftfy`)。本次只修复了"错误如何呈现",
  **没有安装依赖** —— 安装会改动用户全局 Python 环境,属有副作用的操作,留待确认。
  `ftfy` 为 Apache-2.0 纯 Python 包、仅依赖 `wcwidth`,补装成本极低。

## [0.7.11] - 2026-10-09

### Fixed(修复)

- **宏格式 `docm/xlsm/pptm` 与 `epub` 现在给出可操作的错误提示**(P4 / W4-8 + W4-10)。
  - ⚠️ **计划原写"W4-8 补宏格式白名单",实测判定为错误**:引擎
    `extensionToFormat`(`markitdown-node/dist/index.cjs`)实测只含
    `pdf docx pptx xlsx html htm vtt srt png jpg jpeg tiff tif csv json txt xml rss atom zip ipynb`,
    **不含 docm/xlsm/pptm,也不含 epub**;直接调 `detectFormat` 实测三者均无法解析成格式。
    若按原计划放进白名单,用户会收到 "Unable to detect document format" ——
    正是 `detect.js` 顶部警告的那种**误导性错误**(以为文件坏了)。
  - 正确做法:列入"引擎无后端"集合 `ENGINE_NO_BACKEND_EXT`,并给**针对该格式**的补救建议:
    - `docm` → "请用 Word/WPS 另存为 .docx(去掉宏)后再试"
    - `xlsm` → 另存为 `.xlsx`;`pptm` → 另存为 `.pptx`
    - `epub` → "请先转为 .pdf 或 .html 再试"
  - 此前这些格式走的是通用兜底文案;若沿用图片那句"请先转为 png/jpg 等受支持格式",
    对宏文档是**荒谬建议** —— 现按格式分流。
  - 端到端实测:`docm/xlsm/pptm/epub` 均返回 `E_UNSUPPORTED_FORMAT` + 对应建议;
    `gif` 仍是图片那句建议;未知格式(`xyz`)保持原样不乱给建议。

### Not done(明确不做,附理由)

- **W4-9 worker 回传 `json` + `format`**:实测引擎 `convert()` 确实返回
  `json_content`(结构化 JSON)与 `document`,技术上可回传。但**全仓无任何消费方**
  (`grep json_content|\.json` 无命中),插件产物就是 markdown。
  增加一个无人读取的字段属于本仓库多处明确反对的"无需求的功能膨胀",
  故**不做**,在此记录以免日后重复讨论。
  (注意:计划里的 `--json` 是 **CLI 结果 JSON**,与本项原意不同,该项已完成。)

### Verified(验证)

- 新增 3 项单测(共 8 项 detect 测试全绿):宏格式/epub 不得进白名单、
  每个无后端格式都有针对性建议且**不得**被建议"转为图片"、黑白名单不得交叉。
- `node --test` **180/180**(新增 3 项)、`test:py` 全 PASS、golden 无退化(含扫描件)。

## [0.7.10] - 2026-10-09

### Fixed(修复)

- **页眉页脚"判定带位置、应用不带位置"导致大面积误杀正文**(本轮实测发现的最大内容损失):
  `_detect_headers_footers()` 只在**边距带内**收集候选,但剥离时只判断
  `归一化文本 ∈ strip_set` —— **不看该行在不在边距带**。于是同一文本只要在边距带里出现过一次,
  整页**任何位置**的同名行都会被剥掉。
  - 实测(3 份真实样本,剥离总量 / 其中**页中部误杀**):
    | 样本 | 修复前剥离 | 页中部误杀 | 修复后剥离 | 页中部误杀 |
    |---|---|---|---|---|
    | bigtable-34p | 324 | **271(84%)** | 53 | 0 |
    | char-layer-11p | 574 | **351(61%)** | 223 | 0 |
    | textlayer-multi-img | 55 | 5 | 50 | 0 |
  - 典型现场(bigtable-34p p34): 单个字符 `"` 在边距带里出现一次,
    就把**页中部**(y≈0.48–0.60)的 12 行正文一起剥掉。
  - 修复:剥离时补回同一个边距带判据,让"判定位置"与"剥离位置"一致。
  - **真页码仍被正确剥离**(实测边距带内 `1 12 2 3 4 9 2026` 共 53 次照常剥)—— 没有为治误杀而漏剥。
  - 端到端:`bigtable-34p` 产物 **17504 → 18158 字符(+654 正文回归)**;
    锚点 23/23、表 13、CJK 0‰ 均未变;扫描件链路(97 页)完全不受影响。

### Verified(验证)

- 回归自测入 `selftest_extract.py`,且**放在 SKIP 判断之前**(纯逻辑、不依赖 PDF 样本),
  默认 `test:py` 就会执行 —— 否则整条 selftest 在默认路径下被 SKIP,断言从未跑过(本轮踩过)。
- **负对照**:把 `in_zone` 判据去掉模拟回退 → 实测
  `AssertionError: 页中部的同名行必须保留(修复前会被误杀)` 且 exit 1;还原后 exit 0。
- 回归:`node --test` 177/177、`test:py` 全 PASS、golden 默认与含扫描件均无退化、
  97 页扫描件验收 exit 0(表格行 536、锚点 97、内容守恒全部不变)。

### 过程中的两次自我纠正(如实记录)

1. p34 的剥离量先后被测成 **6 行**(我用 `--margin 0.06`,而真实默认是 `MARGIN_RATIO=0.12`)、
   又被测成 **34 行**(直接跑 `extract_text.py` 但那次运行 md 为空)。
   最终用真实默认边距 + pypdfium2 路径测得 **18 行**,才定位到真正的缺陷。
   —— 两次都是"探针没走真实调用条件",与 v2 计划里写下的纪律同源。
2. 用 PowerShell `Set-Content -Encoding utf8` 做负对照,**第三次**给源码文件加了 BOM 并破坏
   docstring;已 `git checkout` 还原并改用 node 读写。本轮已在计划与记忆里登记该纪律。

## [0.7.9] - 2026-10-09

### Added(新增可观测性,P3 / W1-3 残项 / W1-5)

目的:**防静默丢字** —— 字符消失但没人知道。两项都**只观测,不改行为**。

- **W1-3 表格重建的字符丢弃计数**(`notes.table_chars_dropped`):
  `table_rebuild.rebuild_table_md()` 里,落在检测 band/列之外的字符原本 `continue` 掉,无任何痕迹。
  现计数并透出告警 `[表格] 表格重建有 N 个字符落在检测网格之外被丢弃(仅观测,未修复)`。
  **改归属策略(字符中心 + 列宽众数)是 W1-3 的另一半,风险更高,单独立项**,不在本次动。
- **W1-5 单页剥离峰值**(`notes.stripped_lines_max_page` + `_max_page_no`):
  整册 `stripped_lines` 看不出"某一页被剥掉大半"。现记录单页峰值,
  ≥20 行时告警 `[页眉页脚] 第 N 页单页剥离 M 行(可能误杀正文,请人工抽检该页)`。

### Verified(实测,不是推测)

- **真实样本上 `table_chars_dropped` 实测为 0**:`bigtable-34p` 实测 `tables_pymupdf=13 / tables_legacy=0`
  —— W2-4 之后 **pymupdf `find_tables` 几乎总是胜出**,自研几何重建路径基本不跑,
  故"字符被静默丢弃"在当前真实文档上**并未发生**。计数器已用构造用例证明**可达**(见下),不是死代码。
- **计数器可达性自测**:用假 `_table_chars` 构造"字符落在网格外"(1 个 y 在 band 外、1 个 x 在列外),
  实测 `chars_dropped=2` 且网格内字符 `B` 仍正常输出;`reset_stats()` 能清零。已入 `selftest_tables.py`。
- **W1-5 立刻抓到真信号**:`bigtable-34p` 实测 **p34 单页剥离 34 行**(整册 251 行)——
  这正是"某一页被剥掉大半"的形态,人工抽检整册根本不会注意到。

### 已知限制

- 两项都只**观测**不修复:表格字符丢弃真要治需改归属策略(另立项);
  页眉页脚误杀要治需先确认 p34 那 34 行是否真是页眉(尚未人工核)。
- 阈值 20 行是经验值,未在更多真实文档上标定。

## [0.7.8] - 2026-10-09

### Added(新增,W0-4 零依赖评测指标)

之前所有质量改动只能靠**人工抽检**(肉眼看 md),既慢又不可回归。本次给 golden 基线补三个
**零依赖**指标(不引入 docling-eval/TEDS,先量依赖足迹再决定):

- `editDistance(a,b)`:归一化编辑距离。现有 `chars ≥ 基线 97%` 判据**放过**"丢一大段/重排"
  (字符数几乎不变),本指标把差异变成可比数值。先剥公共前后缀再跑 Levenshtein DP;
  长度超限时退化为行级 Jaccard,避免 O(n²) 卡死。
- `wrapStats(md)`:段内硬换行处数 / 正文行数 —— **v0.7.6 修复的缺陷类型的量化兜底**。
- `tableStats(md)`:表格数 / 数据行数 / **列数不一致的行数**(列序错乱的代理指标)。

### Verified(验证)

- **独立佐证 0.7.6 的修复**:新指标实测 6 类样本中 PDF/扫描件/Office 的 `wraps` **全为 0**
  (修复前扫描件为 7 处)—— 不再只靠我自己的推理判断修复有效。
- **负对照证明新护栏有牙齿**:临时把 `joinWrappedCjkLines` 改成恒等函数(模拟修复被回退),
  `golden --check` 实测报 `✗ 段内硬换行增加:0 → 7(v0.7.6 的修复被回退)` 且 exit 1。
- 回归:`node --test` **177/177**(+6)、`test:py` PASS、golden 默认与含扫描件 `--check` 均无退化。

### 已知限制

- `wrapStats` **只从 md 文本判断**,无法区分"OCR 按栏宽硬换行"与"源文件本来就分行排版":
  gbk-text 样本(纯文本,源文件本就分 4 行)实测 `wraps=2`,而它的转换输出**完全正确**。
  故 `wraps` 只能在**同一份样本多次运行之间**做回归对比,**不能跨文档比较,也不是绝对质量分**。

## [0.7.7] - 2026-10-09

### Fixed(修复)

- **扫描件指标恒为 0 —— 基线形同虚设**(golden harness 缺陷,不是产品缺陷):
  不同链路返回形状不同 —— 文字层/Office 直接回 `md` 内容,而**扫描件链路只回 `outFile`(路径)**;
  `metricsOf()` 原先只读 `r.md` → 扫描件类别 `chars=0 anchors=0`。
  **若不修,写进 `baseline.json` 的就是一个"永远是 0 却一直通过"的空基线,比没有基线更危险。**
  - 修复:`metricsOf()` 在无 `md` 时从 `outFile` 读盘;并加**防呆** ——
    `ok=true` 但 `chars=0` → 显式 SKIP 并打印返回键,**绝不写出全 0 基线**。
  - 修复后扫描件基线:**chars=2550 anchors=4 tables=3 cjk=0‰**(4 页样本,页覆盖正确)。
- **`--write` 会静默删掉慢类别基线**:不带 `MDC_GOLDEN_SCAN=1` 跑 `--write` 时,
  `out` 从空对象开始 → 扫描件项被**无声删除**。现在跳过时**保留旧基线项**并打印提示。

### 已知限制

- 扫描件基线**默认不参与** `npm run test:golden`(耗时约 40s),需显式 `MDC_GOLDEN_SCAN=1`;
  故扫描件退化不会拦住普通单测,只拦住带该环境变量的基线校验。

## [0.7.6] - 2026-10-09

### Fixed(修复)

- **扫描件段内硬换行未合并**(整册审计新发现的最高价值缺陷,97 页真实扫描件实测):
  OCR 按**版面栏宽**硬换行,把中文词从中间切开:
  `…活动策划、执行与搭` ⟶换行⟶ `建,服务内容包含:…`。
  - 实测:**415 处**,分布 **55/72 有内容页**,占正文行 **39.6%**;非空行 1941 → 1526(−21.4%)。
  - 为什么之前没治:`cjk.js` 的 R5 明确"绝不删换行/绝不跨行合并" —— 它是为**行内空格注入**
    设计的,没覆盖 OCR 栏宽换行。这是**另一类**缺陷,不是同一类。
  - 新增 `joinWrappedCjkLines()`:先做 R0 结构保护(表格行/标题/列表/分隔线/锚点/fenced code),
    再在**页内**合并(绝不跨 `<!--PAGE:NN-->`,否则破坏页覆盖语义),且仅当
    「前行以 CJK 结尾 ∧ 后行以 CJK 开头 ∧ 前行**不以句末标点**收尾」。
  - **实测过的两个陷阱**(不是推测):
    ① 415 处候选里 **113 处紧邻表格/标题/列表行** → 没有结构保护会破坏表格;
    ② 编号条款行(`4. 根据所制定活动流程,…以`)长得像列表项,第一版守卫把它当结构行,
    漏合 **8 处** → 已对"以 `N.` 起始且不以句末标点收尾"的行放行。
  - 验证(真实 97 页):可合并处 **415 → 0**;PAGE 锚点 **97 → 97**;表头分隔行 **32 → 32**;
    表格行 **536 → 536**;CJK 注入 **528 → 0**;**去空白后逐字符相同(零丢字)**。
  - 告警新增 `[断行合并] 合并段内硬换行 N 处`(与 `[中文归并]` 同一语义)。

### 已知限制

- 判据「前行不以句末标点收尾」是启发式:极少数**句中即以逗号/顿号收尾**的长句,
  其后紧跟的续行仍不会被合并(实测残留 **0 处**,但换文档后需复测)。

## [0.7.5] - 2026-10-09

### Fixed(修复)

- **扫描件链路缺中文行间空格归并**(整册审计发现的真缺口):OCR 把表格单元格内的多行用
  `" "` 拼接 → 中文词被空格切开(`场 玻`、`展示 区`)。W2-1 的归并只接在**文字层**双引擎上,
  **扫描件链路的 md 从来没经过它**。
  - 实测:97 页真实扫描件整册 **468 处**注入,而文字层类别实测 **0 处** —— 同一条缺陷一直没人治。
  - 修复:`jobs.js` 在**每页 md 写入 pageMap 前**归并(增量 md 也干净),并透出
    `[中文归并] 归并中文行间空格 N 处`;`convert.js` 下发 `cjkMerge`。
  - 验证:3 页真实扫描件 A/B **48 → 0**(表行 34 = 34,字符仅少掉那些空格);
    97 页既有产物**离线重放**:**468 → 0**(表行 536 = 536、锚点 97 = 97)。
- **跨页合并后出现"空页"**:片段页块的表行被搬进上一页后该页块变空 → 读者会以为该页没内容
  (实测 97 页扫描件有 **11 个**这样的页块)。现在补一句
  `<!-- 本页内容为上页表格续接(已合并) -->`;同一链里多个空页**都会**标注;锚点语法不变。
- **内部错误记录**(由真实数据 A/B 与单测同时抓出):第一版把 `collapseCjkSpaces()` 当字符串用
  —— 它返回 `{md, removed, ...}` **对象** → pageMap 里写成了 `[object Object]`,
  产物只剩 157 字符/0 表行。已修并补单测。

### 已知限制(有证据,未修)

- **宽表跨页的列结构不稳**:整册审计发现 9 处相邻页表格**列数逐页不同**(5/7、13/12、19/13…),
  这些其实是同一条上百行的报价表续接。`mergeCrossPageTables` 按"列数相同"守卫**正确地拒绝**了
  合并,但根因是 SLANet 对宽表逐页给出不同列结构 —— 需要"按列 x 位置跨页对齐"才能治,
  属后续项(本轮不引入)。

## [0.7.4] - 2026-10-09

> **扫描件速度**:用户指出"90 多页要十几分钟不现实,可能还不如上传第三方"。据此做了三组实测,
> 找到了**真正的瓶颈**(不是 worker 数),修复后**同夹具 167.9s → 53.9s(3.1×)**,
> 内容无丢失。

### Fixed(修复)

- **扫描件每页重复做 18 次 OCR 检测**(速度主因):扫描件链路的文本区域是**逐区域**裁图后
  各调一次 `RapidOCR(crop)` —— 每次调用都会**重跑一遍 DBNet 检测**。实测文本页(19~21 个区域)
  两页共 36 次调用、耗时 51.9s,**占单页耗时 44.6%**;而渲染仅 0.19s。
  - 修复:新增 `RoutingOCR.begin_page()/end_page()` —— 整页**先做一次** RapidOCR,文本区域按
    几何(中心点落区)复用这批行,表格填格也复用(把行坐标折算到表格裁图坐标系)。
    递归路径(单列表格→内部版面)坐标系不同,临时关闭上下文退回逐区域模式。
    `DSH_OCR_PER_REGION=1` 可强制回旧行为(A/B 与回退)。
  - **实测 A/B**(8 页真实扫描片段,workers=4,同夹具):
    墙钟 **167.2s → 60.8s(2.75×)**;正文 4739 → 4773 字符;表行 36 → 36;锚点 8 → 8;
    逐页正文比 0.98~1.06×(p8 反而 +6%,召回更好);中文单空格注入 59 → 57。
  - 修复前后端到端(含 worker 扫描):**167.9s → 53.9s(3.1×)**,21s/页 → **6.7s/页**。
- **每个 worker 未钉线程数**(超订):`lib/py` 此前**完全没有** `OMP/MKL/OpenMP` 线程控制,
  N 路 worker 即 N×核数线程互相抢。已在 Node 侧 spawn 时下发
  `DSH_OCR_THREADS`/`OMP_NUM_THREADS`/`MKL_NUM_THREADS`/`OPENBLAS_NUM_THREADS`
  (= 核数/worker 数;`threads` 可显式覆盖),python 侧 `_init_worker()` 兜底并
  `paddle.set_num_threads`。

### 实测结论(worker 并行**不是**提速杠杆)

| workers | 墙钟(修复前) | 墙钟(修复后) | 单页中位(修复后) |
| --- | --- | --- | --- |
| 2 | 167.9s | **53.9s** | 9.3s |
| 4 | 168.1s | 58.0s | 20.2s |
| 6 | 178.2s | 61.9s | 29.3s |
| 8 | 179.4s | 66.7s | 44.1s |

- 修复前后**两种情况下加 worker 都不提速**(修复前 2→8 路 167.9→179.4s);根因是单页工作
  本身就吃满机器,加进程只是分摊同一份 CPU 并放大超订。**默认 4 路仍在最优 8% 内,不改**。
- 8 页夹具为窗口:97 页扫描件预计从约 40 分钟降到 **约 12 分钟**(按 7.2s/页 × 97)。

## [0.7.3] - 2026-10-09

> **说明**:0.7.2 仅本地打包、未对外发布;其后又落了 3 项**扫描件表格修复**(W2-5 跨页观测、
> 表格列序错乱、跨页续接合并)与 `routing_ocr.py` 的 `_utf8_stdio` 补齐,故版本号升至
> **0.7.3** 并重打包。版本号进 state 复用键 → 升级后旧的断点/探针缓存**自动失效**
> (算法已变,不得复用旧产物)。

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
- **非 UTF-8 中文文本静默乱码**(W4-3):`.md/.markdown/.txt` 此前用
  `readFileSync(path, "utf8")` **硬读** —— GBK/GB18030 编码的中文文件会变成乱码却仍返回
  `ok:true` 且无任何告警(静默内容损坏)。改为 **BOM 优先 → 严格 UTF-8(fatal,不产生
  替换符)→ GB18030 回落**,非 UTF-8 时在 warnings 透出 `[编码] 非 UTF-8 文本已按 … 解码`。
  新增 `test/encoding.test.js`(3 项:GB18030 解码+告警 / UTF-8 无 BOM / UTF-8 BOM 不残留)。
- **格式白名单与引擎能力对齐**(W4-1):
  - **假支持**:`gif/bmp/webp` 此前在白名单里,但 markitdown-node **没有**对应 backend
    (内容嗅探返回 null)→ 用户收到 `Unable to detect document format`,**会以为文件损坏**。
    实测引擎直吃 gif 即此错。现在移出白名单 → 明确 `E_UNSUPPORTED_FORMAT` +
    可操作提示(`请先转为 png/jpg 等受支持格式`)。
  - **漏支持**:`zip` 引擎有 `ZIPBackend`(mapping 里有 zip、`unzipper` 已在依赖内)却被本
    白名单误挡 → 现在放行,实测可转换(会**递归转换**包内每个文件,由 180s 桥超时兜底)。
  - 白名单改为**镜像**引擎的 `extensionToFormat`(`dist/index.cjs:2032-2057`)并加**防漂移
    单测**:白名单与引擎 mapping 必须双向一致,否则测试失败。
    新增 `test/detect.test.js`(5 项)。
- **加密 PDF 的误导性错误码**(W4-5):加密 PDF 此前先白跑文字层两层,再落**扫描件路由**,
  最后报 `E_OCR_RUN`「PDF 打开失败」——**用户看不到"加密"这个真因**。
  (更正实测:旧路径的额外时间浪费其实很小 —— 探针 0.33s + OCR 尝试 0.34s,因为打开 PDF
  即失败、未加载任何模型;本项价值在**错误码与文案的正确性**,不在省时。)
  - 新增错误码 **`E_ENCRYPTED`**(码表只追加不改既有码)。
  - `extract_text.py` / `parallel_ocr.py` 在打开失败时按 `password`/`encrypt` 判据给出
    明确文案;`textlayer.js` **透传 python 侧错误码**(并修:非 0 退出时会吞掉结构化错误);
    `convert.js` 与 `lib/index.js` 在拿到 `E_ENCRYPTED` 时**立即收敛**,不再尝试 markitdown
    或扫描件路由。
  - 判据已验证:**仅"用户密码"加密**才抛 `Incorrect password error`;**owner 密码(权限加密)
    的文件能正常打开**,不会误判。
    新增 `test/encrypted.test.js`(1 项:报 E_ENCRYPTED、文案含"加密"、无 OCR 路由痕迹、
    attempts 仍记录文字层为何不可用)。
- **`autoInstallDeps` 开关实际无法生效**(W5-2):文字层依赖自动补装读的是 `opts.depsAutoInstall`
  —— 全仓**没有任何调用方**设置该键(默认值 / 工具层 / CLI 一律用 `autoInstallDeps`),
  条件恒为真,唯一设置它的是测试注入 → **该开关关不掉**。现改读真实键 `autoInstallDeps`,
  测试同步改注入名,并在 v0.7.1 段落下补勘误(其发版说明把键名误写成 `depsAutoInstall`)。
  负向验证:`autoInstallDeps:false` 时 `pythonText` 只被调用一次(补装路径未被触发)。
- **扫描件表格列序错乱**(实测定位并修复):`routing_ocr.py` 的 `table_full` 在
  `cell 数 == 行×列` 时按**检测顺序每 ncols 个切一段**,而 cell 检测器只按 `(y1, x1)` 大致排序
  —— 同一视觉行的 cell 顶边 y1 相差 0.1~0.2px,排序被打乱后盲目切片就**逐行错位**。
  实测(采购文件 97p 扫描件 p4 线条表):48 cell = 16 行 × 3 列,恰好走主路径,
  15 个数据行里**只有 7 行的条款号落在第 1 列**(`服务要求 | 1.3.2 | …`、
  `3.2.4 | 2,300,000.00元… | 最高限价`)。而**正确的几何装配法本就在同一函数的 else 分支**
  (仅在 cell 数不符时才启用)——主路径反而是错的。
  - 新增纯函数 `cells_to_grid()`:行边界**不猜容差** —— 既然结构模型已给出 `nrows`,就取 cy
    (垂直中心)序列中**最大的 nrows-1 个间隙**当行边界(零参数,不受单元格高度差异影响;
    曾用"0.5×中位高"当容差 → 被 h=229 的高单元格放大到 ~50px,把相距 34px 的两行误并);
    行内按 x 排序;合并/漏检导致的**少格行按列槽就近落格并留空**(不顶替)。
  - `table_full` 主路径统一改走它;分隔线改为按**最宽行**定宽(原按 `grid[0]`,短行会让表宽不一致)。
  - **实测前后对照**(同一 crop、同一模型输出,生产路径):条款号命中率 **7/15 → 15/15**;
    `3.2.4 | 最高限价 | 2,300,000.00元（含税）…` 恢复正确列序。
  - 新增 `lib/py/selftest_routing.py`(11 项:y1 打乱列序 / 高单元格不得并行 / 少格行留空 / 边界)。
  - 顺带修:本文件 CLI **缺 `_utf8_stdio()`**(extract_text / parallel_ocr / render_pages 都有)
    → GBK 控制台下打印中文 JSON 会 `UnicodeEncodeError` 崩溃;已补上。
- **跨页表格续接被切成两张、片段首行被"提升"成表头**(实测修复,扫描件链路):
  `routing_ocr.table_full` 只能看到本页,分页切断的**续接片段会把首行数据当表头**输出
  (实测采购文件 p4→p5:`| 备注：如需缴纳投标保证金… |  |  |` 成了 p5 的表头),
  于是一张表变成两张、表头语义错误。
  - 新增 `lib/core/jobs.js::mergeCrossPageTables()`(纯函数):仅当两表之间**只隔空行/页锚点**、
    列数相同、都有分隔行时才并;片段首行与上一页表头**文本相同** → 视为重复表头丢弃;
    否则**保留为数据行**(它是被提升的真数据),只丢掉片段的分隔线;支持链式(连跨 3 页以上)。
  - **锚点语义不被破坏**:续接行并入**上一页块内**(表格之后、该页闭合锚点之前),
    片段页块保留自己的锚点。只在**最终装配**调用 —— 运行中的增量 md 仍保持逐页片段
    (逐页可写、可被 job_kill 中断)。
  - 实测(97 页真实产物的 p4→p5 区间):分隔行 **2 → 1**、备注行保留、四个页锚点完整、**幂等**;
    全文表行 29 → 27(另一处边界丢弃了重复表头与分隔线,内容不丢)。
  - 新增 3 项单测(数据行续接 / 重复表头 / 不该并的三种情形)。

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
- **图片改走本地离线 OCR**(W4-2):图片此前只走 markitdown 的 tesseract.js —— 语言硬编码
  `chi_sim+eng`、**首次使用要从 jsdelivr CDN 下载 traineddata 且默认写进当前工作目录**
  (污染用户工作区)、失败后无任何离线回退(直接 `E_MARKITDOWN`)。而本插件扫描件链路本就在用
  PaddleOCR/RapidOCR,且 **rapidocr 的 ONNX 模型随包内置** → 完全离线、零 CDN、零 CWD 写入。
  图片本质就是"一页扫描件",现改为**优先本地 `lib/py/ocr_image.py`(RapidOCR)**,
  失败或无文本再回落 markitdown/tesseract(回落时 warnings 明确透出原因)。
  实测:含中文 PNG **2.0s** 完成识别,三行中文全部识别(仅全角逗号/冒号轻微差异),无网络依赖。
  - 过程中修掉一个真实缺陷:`ocr_image.py` 首版漏了 `_utf8_stdio()`,而插件其余 python 入口
    (extract_text / parallel_ocr / render_pages)都有 —— 未设 `PYTHONIOENCODING` 时(即插件
    宿主的真实环境)stdout 会以 **GBK** 写出中文,Node 按 UTF-8 解码即**乱码**。
    该问题由新单测在无环境变量下复现并修复。
- **目录/批量输入**(W4-6):CLI 早已支持多文件(`convertMany`),但**目录**参数此前只会被
  当成不支持的扩展名拒绝。现在 `dsh-md-convert <目录...> -o <输出目录>` 会展开为其中的
  受支持文件批量转换,新增 `-r/--recursive` 递归子目录。
  - **不静默丢文件**:跳过的条目逐条打印原因(不支持的扩展名 / 本工具产物
    `*.state.json|*.progress.json|*.probe.json` / 无扩展名);隐藏项(`.` 开头)直接忽略。
  - 目录模式跳过 `.md/.markdown`(几乎必然是本工具产物,再转一次只是把 md 抄成 md);
    但**显式单文件传入 md 照旧转换**(用户明确要求就照做)。
  - 稳定排序(按文件名),批量结果不随文件系统枚举顺序变化;空目录给出明确错误并退出 2。
  - 顺带修一处告警噪声:**UTF-8 BOM 文件不再被报"非 UTF-8"**(BOM 本身就是合法 UTF-8,
    Windows 记事本/PowerShell 常态),只剥 BOM 不告警 —— 由目录批量的端到端验证发现。
    新增 `test/scan.test.js`(3 项)。
- **跨页表格观测**(W2-5;**只观测、不合并**):新增 `table_extract.count_cross_page_pairs()` 与
  `notes.cross_page_table_pairs` —— 统计"上一页末表贴底(≤60pt)+ 本页首表贴顶(≤60pt)+
  两表列数相同"的疑似**被分页切断的表**。
  - **实测 3 份真实样本均为 0 处**(c1 0 表 / c2 13 表 / golden 4 表)→ 因此**不实现合并**:
    在无实测需求时写合并逻辑属功能膨胀。改为把需求变成可观测:真出现时 `convert.js` 透出
    `[表格] 疑似 N 处表格被分页切断(当前不合并;如需合并请提供该样本)`。
  - 判据经**正对照验证**:造一份 2 页 PDF(表底距页底 4pt + 续接表距页顶 40pt + 重复表头),
    经真实链路得到 `跨页候选 = 1` —— 证明"真实样本 0 处"不是探测器失灵。
  - `lib/py/selftest_tables.py` 增 4 项(贴底贴顶同列数计 1 / 未贴底不计 / 列数不同不计 /
    中间空页不计)。
- **页范围 `pages`**(W4-4):`md_convert({file, pages:"1-20,25"})` / CLI `--pages "1-20,25"`,
  1 起页号、支持范围与混排。此前 `onlyPages` 只在 vision 路由生效 —— **文字层 PDF 完全无法限定页数**
  (300 页招标文件只能整册转)。
  - 新增 `lib/core/pagerange.js`(语法单一来源)+ `test/pagerange.test.js`(6 项)。
  - 文字层双引擎都支持:`extract_text.py --pages`(采集循环前过滤)与
    `pymupdf4llm_extract.py --pages`(映射为 pymupdf4llm 的 **0 起**页号)。
  - **锚点保留原始页号**:子集提取时若按 `enumerate` 编号,第 5 页会被错编成 `01`;
    pymupdf4llm 入口还额外校验"返回块数 == 请求页数",不符则拒绝(宁可不产出也不让锚点错位)。
  - **越界必须报错,绝不静默丢弃**:`convertFile` 在转换前用 `pdfPageCount` 校验上界
    —— 实测修复:`--pages 99`(文档 11 页)此前会**回落 markitdown 把整册转成功**(exit=0),
    用户以为页范围生效;现在直接报错退出 1。`pages` 用于非 PDF 也会明确拒绝。
  - 扫描件链路:`vision` 路由映射为 `onlyPages`(完整集合);本地 OCR 走 `--limit-pages`
    (仅支持 `1-N` 前缀),其它形态**明确告警**"未生效"而不是静默按全篇转。
  - 端到端实测(`verify_w44.py`):CLI `--pages 3-5` → 产物锚点 `[3,4,5]`;两个 python 入口
    越界均报"请求的页码超出文档页数(共 11 页):99"。
  - 扫描件链路实测(`verify_w44_scan.py`,3 页真实扫描片段,`--engine local`):
    `--pages 1-2` → 产物锚点 `[1,2]`(前缀经 `--limit-pages` 生效);
    `--pages 2-3` → 锚点 `[1,2,3]` **且告警"未生效"**(不静默);`--pages 9` → exit=1 报"超出文档页数"。
  - 实现中被抓出的两个自身错误:① `pdfPageCount` 是 **async 且两参**(漏 await/漏参都得到 0,
    导致误报 E_OCR_DEPS);② 对 `const o` 整体重新赋值 → `E_UNKNOWN: Assignment to constant variable`。
- **CLI `--json`**(W4-9):结果以**单个 JSON 对象**输出到 stdout,便于脚本/CI/jq 消费
  (`{ok,total,succeeded,failed,jobId?,results:[{ok,file,code,error,outFile,chain,mode,planPath,statePath,progressPath,etaSec,quality,decision,batches,warnings,mdChars}]}`)。
  - **stdout 保证纯 JSON**:vision/依赖等模块会**直接 `console.log`**(如 "vision: 已渲染…"),
    逐个改不现实 → 转换期间把 `console.log` 整体改道 stderr,只把最终 JSON 用原始通道输出。
    实测:① 成功路径 stdout 可被 JSON 解析、人类行在 stderr;② 失败路径仍是纯 JSON 且带 `code`、退出码 1。
  - **不外泄 md 正文**(可能数 MB):只给 `mdChars`。
  - 不带 `--json` 时行为完全不变(人类可读行仍在 stdout)。

### Changed(变更)

- **扫描件重复转换默认复用断点,不再整册重 OCR**(W3-2)。此前 `resume:false`(默认)
  会先删 `<name>.state.json`/`.progress.json`,同一 PDF 再转一次要整册重跑
  (97 页扫描件实测 1399s)。现在改为**键控复用**:
  - 新增**校验键** `stateKey = 插件版本 + 渲染倍率 + 文档指纹(绝对路径|大小|mtimeMs)`,
    由 Node 侧计算并经 `--state-key` 传给 Python;`_load_state` 键不匹配即忽略旧状态。
    → **改算法/改倍率/换文件/同名另存**都不会命中旧结果(mtime 变化即换键,有单测覆盖)。
  - **默认路径**:键匹配**且**既有 md 有锚点页 → 复用(接续已完成页);
    否则按全新处理:**清状态且不从旧 md 预播种**,绝不拿旧结果。
  - **显式 `resume:true` 保持旧语义**:绝不清状态、不传键(退回 pdf/scale/total 校验),
    保证"继续这份断点"的意图不被键校验挡住,也不破坏 F3 收尾对账。
  - 实测(4 页无文字层扫描件夹具):首次 93.5s → 复跑 **2.1s(45×)**;忽略溯源时间戳后
    md 内容**逐字节一致**。新增 `lib/py/selftest_state.py`(5 项)与 `test/jobs-statekey.test.js`、
    `test/jobs.test.js` 两项决策回归。

- **公式模型改懒加载**(W3-5):`routing_ocr.py` 的 `FormulaRecognition`(PP-FormulaNet_plus-S)
  此前在 `__init__` **急加载**,而同文件自称"懒加载各子模型"(表格结构/单元格早已懒加载)。
  改为 `formula_engine()` 按需构建并在实例内复用。实测:`RoutingOCR()` 构造 6.18s 且不再
  加载公式模型,首次使用才付 **4.98s**;模型 251.4MB → **每 worker 省 251MB 常驻**
  (默认 4 worker ≈ 1GB)。
- **零风险批**(W3-6):
  - `detectPython`/`findMissingModules`/`ocrModelCacheStatus` **结果缓存**(一次转换会命中
    detectPython 2~3 次,单次 27ms;后两者 68ms/30ms);pip 安装成功后 `resetDepsCache()`
    清缓存,避免拿到过期的缺失清单。
  - `isPython` **先试无管道形态**(`stdio:"ignore"` 只看退出码),失败再退回管道形态 →
    受限上下文(容器/沙箱)里不再因管道 EPERM 导致 `detectPython` 恒 null、整条文字层
    主链被静默跳过降级 markitdown(实测 `encoding:'utf8'` EPERM / `stdio:'ignore'` status=0)。
  - 页数探查**复用**:工具层已探查的页数经 `pageCountHint` 传入,省一次 python 冷启。
  - legacy COM 退避改用主线程 `sleepSync`(不再为睡 2.5s 额外冷启一个 powershell)。
  - markitdown **宿主进程内失败粘性标记**(按宿主解析链失败特征置位,只对真实实现生效),
    后续转换直接走子进程桥,省一次注定失败的尝试。

- **文字层表格默认改用 PyMuPDF `find_tables()`**(W2-4,零新增依赖 —— pymupdf 是既有依赖)。
  根因:自研 `table_rebuild.py`(几何 band 归属)在 34 页需求文档上出 9 个表但**单元格字符
  交错**(实测 `| 这 怎 图， 拿 输 谈 图 re |`、`| 拦标 | 价 | 194,000 | 元 （含税） |`);
  同文档 `find_tables()` 出 **13 表/85 行且单元格干净**(`| 拦标价 | 194,000 元（含税） |`)。
  - **假表过滤**:逐字符文字层(PPT 导出)上 `find_tables` 会把带竖线感的**文本行**判成
    1 行 N 列表(c1 实测 11 个:`['202','6','.10.20','；']`)→ 要求 ≥2 行 ≥2 列且非全空。
  - **不按单元格长度拒收**:真机实测 golden 样本里**承载验收断言**的真表也含 194 字长单元,
    按长度过滤会让 golden 两条断言由 True 变 False(已实证)。改为把"含超长单元格
    (>200 字)"当**择优信号**:该页若自研几何法也检出表,则改用自研产物(它在 golden 页上
    是被断言认可的形态);否则用 find_tables。新增 `--legacy-tables` 供 A/B 与回退。
  - 实测(c2):交错代理 62 → 37,经 CJK 归并后**表行含中文空格数 = 0**;
    c1/纯扫描件行为不变(0 表);**golden 六条用例全部通过**。
    新增 `lib/py/selftest_tables.py`(10 项)并接入 `npm run test:py`。

- **ETA 重标定 + 运行中自适应**(W3-8):运行前估算的单页均耗默认 **15s/页 → 27s/页**
  —— 按本机实测分布重标定(**9 页**真实扫描页 15.89 / 18.5 / 20.09 / 22.16 / 23.53 / 27.4 /
  28.06 / 31.3 / 62.8s → 中位 23.5、**均值 27.7**、跨度 15.9~62.8s;默认取 27≈均值,ETA 用于
  排期承诺,宁可略保守);旧值来自 bench.md 的单次标定(14.4s/页),对表格密集页偏乐观约 1.8×。
  - `progress.json` 新增 **`etaSec`**:用**本次已完成的逐页耗时**推算剩余时间,轮询者可据此改排期;
    **证据不足时为 `null`,不编数字**。新增 `adaptiveEtaSec()` 纯函数(jobs.js)并补单测。
  - 为什么两种 ETA 都要:运行前的静态值用于排期承诺,运行中的实测值用于纠正——真实页耗跨度极大
    (同机 18.5~62.8s/页),单点标定必然有偏差。

### Removed(移除)

- **无触发路径的整份 OCR 包装**(W5-3,反熵退役):`lib/core/ocr.js` 的 `ocrPpstructure` 与其
  专属常量 `ROUTING_SCRIPT` 已删除 —— v0.6.0 起扫描件路由只走 `ocrPpstructureParallel`,
  **没有任何配置或错误路径会选择它**,属"两个 owner 并存"的熵。
  **能力未丢**:Python 参考实现 `lib/py/routing_ocr.py` 保留不动(`parallel_ocr.py` 复用其引擎),
  仍可手动 `python lib/py/routing_ocr.py <pdf>` 做对比;退役说明留在 `ocr.js` 头注释里。
  (ocr.js 142 → 102 行;随之移除只被它使用的 `runAsync` 导入。)

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
  (`autoInstallDeps:false` 可禁);仍失败则 warnings 附精确 pip 修复命令。
  > 勘误(v0.7.2):本条原写作 `depsAutoInstall:false`,与真实配置键不符 —— 且代码侧读的正是
  > 这个不存在的键,导致该开关**实际无法生效**。v0.7.2 已改读 `autoInstallDeps`(W5-2)。
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
