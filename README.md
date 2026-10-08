# dsh-md-convert

[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

将 Office 文档与 PDF(含扫描件)转换为**保留结构级排版**的 Markdown。**五引擎置信度驱动调度**:文字层 PDF 走 [PyMuPDF4LLM](https://github.com/pymupdf/pymupdf4llm) 段落合并直提(主)与自研 pypdfium2 结构增强链(兜底),扫描件走本地 OCR/视觉任务书探针分流,Office 走 [MarkItDown](https://github.com/microsoft/markitdown)。提供 **CLI 命令行**与 **dsh agent 工具**(`md_convert`)双入口。

- **AI Agent 使用规范**:[README.agent.md](README.agent.md)(错误码处理/批量规范/调用约定)
- English: [README.en.md](README.en.md)

## 支持格式与转换链路(v0.7.2)

| 输入 | 链路 | 说明 |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | **MarkItDown 子进程桥**(主引擎) | XML 结构无损映射:标题/列表/表格/段落原生保留 |
| `.pdf`(含文字层) | **PyMuPDF4LLM 段落合并直提**(主引擎,v0.6.14+)→ 质量信号触发时自研 **pypdfium2 结构增强链**二次对比(表格重建/标题层级/链接保留/页眉页脚剥离/PAGE 锚点/逐页图像占比);**逐字符定位文字层**(Word 导出常见)自动切换字符坐标重建 | 产物附 `quality` 质量信号(score/issues/suggestVision,含中文行间空格注入率)。**两个候选都先做中文归并再比优**;表格默认用 PyMuPDF `find_tables()`(单元格干净 + 假表过滤),`--legacy-tables` 可回到自研几何法 |
| `.pdf`(扫描件/纯图) | **三层引擎路由**(v0.6.0):① 复杂度探针抽样 3 页 → ② 表格/公式占比超阈值走 vision 任务书,否则 ③ **页级并行本地 OCR**(NDJSON 流式 + 断点续跑,任意页数) | 标题/正文/表格/公式/印章,纯 CPU、轻量模型。**同文档重复转换默认按键复用断点**(插件版本 + 渲染倍率 + 文档指纹),探针结论亦缓存 |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM(Windows)或 LibreOffice(其余平台)另存为新格式 → MarkItDown | 后端自动探测,可配置 |
| `.png` / `.jpg` / `.jpeg` / `.tif` / `.tiff` | **本地 RapidOCR 优先**(v0.7.2) | 模型随包内置 → **完全离线、零 CDN、不写工作目录**;失败或无文本时回落 MarkItDown(tesseract.js)并在 warnings 说明原因 |
| `.html` / `.csv` / `.json` / `.xml` / `.rss` / `.atom` / `.ipynb` / `.srt` / `.vtt` / `.zip` | MarkItDown | MarkItDown 支持的全部格式。`.zip` 会**递归转换**包内每个文件(由子进程桥超时兜底) |
| `.md` / `.markdown` / `.txt` | 直接读取(带**编码探测**,v0.7.2) | UTF-8 / UTF-16 BOM → 严格 UTF-8 → **GB18030 回落**;非 UTF-8 在 warnings 透出 `[编码]`(BOM 属合法 UTF-8,只剥不告警) |

> **引擎显式指定**:`engine:"pymupdf4llm"` 强制段落合并直提(跳过自研直提优先级);
> `engine:"local"/"vision"` 强制扫描件路由;默认 `engine:"auto"` 全自动调度。

> **不支持**:`.gif` / `.bmp` / `.webp` —— 解析引擎没有对应后端(此前被白名单误放行,用户会看到
> 误导性的 `Unable to detect document format`;现在直接返回 `E_UNSUPPORTED_FORMAT` 并提示先转格式)。

> **加密 PDF**:需要**用户密码**的文件返回 `E_ENCRYPTED`(暂不提供密码通道);仅 owner 密码
> (权限加密)的文件可正常转换。

> **"结构级排版"** = 标题层级(H1–H6)、列表、表格(管道表格)、段落顺序均保留。
> Markdown 本身无法表达字体/字号/颜色/缩进等视觉细节,任何转换器都不会保留它们——这是格式本质。

## 环境依赖

### 依赖分级一览

| 级别 | 依赖 | 安装 | 缺失后果 |
| --- | --- | --- | --- |
| **必需** | Node.js ≥ 18 | 手动 | 插件不运行 |
| **必需**(PDF 路由) | Python 3.10+ | 手动(`python`/`py`/`python3` 自动探测) | PDF 无法转换 |
| **推荐**(PDF 文字层主链) | `pip install pymupdf4llm pypdfium2` | **首次转换自动安装并重试**;也可手动 | 自动降级:文字层主链不可用 → markitdown 兜底(质量下降),warnings 附修复命令 |
| **按需**(扫描件/图片) | OCR 全家桶:`paddlepaddle` `paddleocr` `paddlex[ocr]` `rapidocr` `onnxruntime` + 模型(数百 MB) | **首次转换自动检测+默认自动安装**(`dsh-md-convert deps` 可手动) | 扫描件路由不可用 → 建议 `engine:"vision"`;图片回落 MarkItDown/tesseract(首次需联网下 traineddata) |
| **按需**(老格式 `.doc/.xls/.ppt`) | Windows: WPS Office 或 Microsoft Office;Linux/macOS: LibreOffice | 手动 | 老格式不可转换 |

### 扫描件 OCR 模型说明

- **CPU 为主、轻量模型优先、性价比优先**:模块化路由流水线——`PP-DocLayout-L` 版面分析(轻量)按区域路由,**文字走 RapidOCR(PP-OCRv6 ONNX,最快)**,表格走 SLANet+RT-DETR,**公式走 FormulaNet-Plus-S(轻量)**;标题层级由版面模型识别。质量有基本保证,但为效率做了取舍(如复杂版面/超小字号可能识别不全)
- Linux 无头服务器建议安装中文字体 `fonts-noto-cjk`
- **模型本地化**:OCR 模型首次经 `dsh-md-convert deps` 联网下载到本地缓存(`~/.paddlex/official_models/`,约数百 MB);**之后运行完全离线**,不做任何网络检查,断网可正常 OCR

**依赖自动安装(默认开启)**:首次转换扫描件时,插件自动检测 Python 与 OCR 依赖
(`paddlepaddle` `paddleocr` `paddlex[ocr]` `pypdfium2` `rapidocr` `onnxruntime`),
**有则直接使用,缺则自动 `pip install`**,无需手动操作。可用 `--no-auto-install-deps` 关闭,或手动预装:

```sh
pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2 rapidocr onnxruntime
```

> 路由 OCR = PP-DocLayout-L 版面分析(阈值 0.3)+ 区域路由:文字→RapidOCR、
> 表格→SLANet 结构+RT-DETR 单元格+OCR 填格、公式→FormulaNet-S、印章→注释。

## 安装

### 作为 DSH 插件

```sh
dsh plugin --profile web add github:yakoylp/dsh-md-convert
```

安装后重启 `dsh web`,agent 获得 `md_convert` 工具。CLI 命令 `dsh-md-convert` 随 profile 的 `node_modules/.bin` 暴露。

### 后台作业部署(v0.6.0,OCR 长任务不中断的前提)

`md_convert` 的 `background=auto|true` 会把 OCR 类长任务(大页数扫描件)挂到 **ctx.jobs 后台作业**:
立即返回 `{ok, background:true, jobId, etaSec}`,用 `job_output(jobId)` 轮询,`job_kill` 可取消
(进程树终止,已完成页保留在 `.state.json`,可 `resume:true` 接续)。

**前置条件(必须)**:组合中加载官方后台作业控制器两个包:

```sh
dsh plugin --profile web add github:deepseek-ai/dsh-jobs
dsh plugin --profile web add github:deepseek-ai/dsh-tool-jobs
```

或在 profile 的 `cordis.patch.yml` 组合中插入:

```yaml
- insert:
    - id: dsh-jobs
      name: "@deepseek-ai/dsh-jobs"
    - id: tool-jobs
      name: "@deepseek-ai/dsh-tool-jobs"
    - id: dsh-md-convert
      name: dsh-md-convert
```

**前台降级行为(v0.6.1 降级链)**:未安装上述控制器,或后台作业启动被宿主拒绝
(如 owner 校验失败)时,`background=auto|true` **不会失败**——先尝试无主(unowned)
后台作业,仍不行则回退前台执行,返回结果附 `background:false` 与降级 warning
(缺控制器 / 启动失败原因;无主作业完成后不会自动注入会话,需 `job_output(jobId)` 轮询)。
前台路径同样具备 NDJSON 流式增量落盘(`.md` 逐页更新 + `.state.json` 断点)与
`exec.signal` 取消能力,但受单次工具调用时长约束——**长文档场景强烈建议安装控制器**。

**前台页数闸门(v0.6.1)**:`background=false` 且本地 OCR 页数 > `ocr.foregroundMaxPages`
(默认 30,0=不限制)时拒绝执行(稳定错误码 `E_FOREGROUND_LIMIT`),附后台 / vision /
resume 替代路线与 ETA 提示——前台长任务会占满 CPU/内存拖垮整机(97 页实测:前台
8 workers 10 分钟仅 18 页且系统卡死)。

### 引擎路由决策表(v0.6.2)

| 输入特征 | 引擎 | 耗时(97 页参考) | 说明 |
| --- | --- | --- | --- |
| docx/xlsx/pptx(Office 结构化) | **markitdown 子进程桥** | 毫秒~秒 | 表格原生 md 化(结构标记→标准表格) |
| PDF 有文字层 | **pypdfium2 结构增强直提** | 秒级 | 表格重建/标题层级/链接保留/页眉页脚剥离(见下);markitdown 子进程桥兜底,失败原因随 `warnings` 透出 |
| 无文字层 + 版面简单(表格/公式 ≤40%) | **本地并行 OCR** | ≈6-10 分钟(4 workers,后台) | 零 token;后台优先,前台 30 页闸门 |
| 无文字层 + 版面复杂(表格/公式 >40%) | **vision 模型阅读** | ≈25 分钟(8 路子代理) | 语义质量优先,复杂表格/印章/公式更准 |

决策原则:**有文字层绝不 OCR**;无文字层按复杂度分流(简单→本地 OCR,复杂→模型阅读);
长任务后台优先、前台有闸门;每一次降级(引擎切换/后台失败/闸门拦截)都通过
`warnings` 与 `decision` 字段透出原因,不再静默。

### 文字层结构增强与页级局部 vision(v0.6.4)

pypdfium2 兜底链路(v0.6.3+)在纯文字提取之上叠加确定性结构增强,均可独立开关:

- **链接保留**:raw `FPDFLink` API 提取 URI 链接;URL 尾段文件名能在正文回查时内联为
  `[文件名](url)`,其余入页尾「本页链接:」脚注——URL 零丢失(`--no-links` 关闭)。
- **页眉页脚剥离**:边距带 + 跨页重复(≥60% 页数) + 版权/页码正则(`--no-headers` 关闭)。
- **孤儿符号回挂**:与正文断行的列表符回挂为 `- 正文`;连续符号行(页边距布局幽灵)丢弃。
- **标题层级重建**(v0.6.4):行框高度聚类正文字号,节标题 → `##`、小节标题 → `###`,
  跨中西文字号差的拆行标题自动合并(`--no-headings` 关闭)。
- **逐页图像占比 → visionHints**(v0.6.4):raw 页面对象枚举(零渲染)统计每页图像面积占比,
  ≥15% 的页随结果返回 `visionHints:{threshold,pages,detail}`,提示其内嵌截图文字不在文字层。

对 visionHints 命中的页,可做**页级局部视觉重转**(只渲染/转写命中的页,其余页仍用文字层):

```sh
# ① 常规转换 → 结果携带 visionHints:{pages:[5]}
md_convert({ file: "doc.pdf" })
# ② 对命中页出子集任务书 → 产物仅含第 5 页
md_convert({ file: "doc.pdf", engine: "vision", onlyPages: "5" })
# ③ md_convert_assemble 装配子集 → 把产物中的 <!--PAGE:05--> 块
#    替换进①产物 md 的同名锚点块,即完成局部增强合并
md_convert_assemble({ planPath: "<doc.vision>/plan.json" })
```

子集计划的 `plan.source.pageList` 声明覆盖页;装配覆盖率只考察子集,
产物文件名为 `<名>-p5-p7.md`(不覆盖全页版)。

### 独立命令行(不装进 DSH)

```sh
git clone https://github.com/yakoylp/dsh-md-convert.git
cd dsh-md-convert
npm install
npm link          # 全局获得 dsh-md-convert 命令
# 或直接调用
node lib/cli.js <文件...> -o <输出目录>
```

## 命令行用法

```sh
# 基本:批量转换
dsh-md-convert a.docx b.pdf -o ./md

# 老格式(自动探测:Windows 用 WPS→Office,Linux/macOS 用 LibreOffice)
dsh-md-convert old.doc old.xls old.ppt -o ./md

# 强制指定老格式后端
dsh-md-convert old.doc -o ./md --legacy-backend wps

# 扫描件:自动走三层路由(复杂度探针 → vision 任务书 / 页级并行 OCR;缺依赖自动安装)
dsh-md-convert scan.pdf -o ./md

# v0.6.0:后台模式(立即打印 jobId,stderr 逐页进度,.md/.progress.json 随跑随写可轮询)
dsh-md-convert convert scan.pdf -o ./md --background true --workers 2

# v0.6.0:断点续跑(接续 .state.json 已完成页,仅重试失败页)
dsh-md-convert convert scan.pdf -o ./md --resume

# v0.6.0:强制引擎(跳过探针)
dsh-md-convert convert scan.pdf -o ./md --engine local     # 或 --engine vision

# --workers 1:进程内快速路径,不启进程池(兼容禁用命名管道的沙箱/容器;语义=Pool(1))
dsh-md-convert convert scan.pdf -o ./md --workers 1

# 指定 Python 解释器(多 Python 环境时)
dsh-md-convert scan.pdf -o ./md --ocr-python "C:\path\to\python.exe"

# 检查 / 安装 OCR 依赖与模型
dsh-md-convert check        # 只检查状态,不安装
dsh-md-convert deps         # 安装缺失依赖并预下载 OCR 模型到本地(需联网一次,之后离线可用)

# v0.7.2:目录输入(展开为其中受支持文件批量转换;跳过的文件逐条打印原因)
dsh-md-convert ./素材 -o ./md
dsh-md-convert ./素材 -o ./md -r     # -r/--recursive 递归子目录

# v0.7.2:关闭中文行间空格归并(默认开启)
dsh-md-convert c2.pdf -o ./md --no-cjk-merge

# v0.7.2:表格回到自研几何重建法(默认用 PyMuPDF find_tables,A/B 与回退用)
python lib/py/extract_text.py c2.pdf --legacy-tables
```

完整选项见 `dsh-md-convert --help`。

## 错误码与退出码

失败时**必定携带稳定错误码**,调用方(CLI / agent / 二次开发)可据此分类处理:

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | 源文件不存在 | 检查路径 |
| `E_UNSUPPORTED_FORMAT` | 扩展名不受支持 | 更换格式 |
| `E_MARKITDOWN` | MarkItDown 转换失败 | 多为文件损坏或引擎无对应后端;可重试 |
| `E_ENCRYPTED` | PDF 已加密(需要**用户密码**,v0.7.2) | 用密码解除保护后重试(插件暂不提供密码通道;仅 owner 密码的文件不受影响) |
| `E_LEGACY_CONVERT` | 老格式另存失败(COM/LibreOffice) | Windows 需 WPS/Office、其余平台需 LibreOffice;已内置自动重试 |
| `E_OCR_DEPS` | 缺 OCR 依赖(自动安装失败/已禁用) | 执行 `dsh-md-convert deps` |
| `E_OCR_RUN` | OCR 执行失败(进程级/致命错误) | 已完成页保留于 `.state.json`,可 `--resume` 接续 |
| `E_OCR_TIMEOUT` | 前台 OCR/探针超时(后台作业不限时) | 已完成页已落盘,可 `--resume` 接续 |
| `E_OCR_EMPTY` | 扫描件未识别出内容 | 检查扫描质量 |
| `E_VISION_PLAN` | vision 任务书链路失败 | 检查 vision 配置;或回退 `engine=local` |
| `E_ASSEMBLE` | 装配失败(plan 损坏/结构无效/非合法 UTF-8) | 重新生成任务书;检查各批 output 编码 |
| `E_OUTPUT` | 输出写入失败 | 检查 outDir 权限/磁盘 |
| `E_UNKNOWN` | 其他错误 | 查看 error 消息 |

**CLI 输出格式**(批量时每行可定位到具体文件):

```
✓ markitdown  → ./md/a.md
✗ [E_OCR_EMPTY] 扫描件未识别出任何内容  C:\docs\扫描件.pdf
✗ [E_FILE_NOT_FOUND] 文件不存在:...  C:\docs\缺失.docx
```

**退出码**:`0` 全部成功 / `1` 存在失败(失败行含 `[错误码]` 与源文件路径)/ `2` 参数错误。

## Agent 工具

安装插件后,agent 可用 `md_convert` 工具:

```
md_convert({ file: "报告.docx", outDir: "./md" })
→ { ok: true, background: false, output: "./md/报告.md", chain: "markitdown", warnings: [] }

md_convert({ file: "97页扫描件.pdf", background: "auto" })
→ { ok: true, background: true, jobId: "…", etaSec: 2160,
    statePath: "…/97页扫描件.state.json", progressPath: "…/97页扫描件.progress.json" }
// 轮询: job_output(jobId);取消: job_kill(jobId)(已完成页保留,可 resume 续跑)

md_convert({ file: "扫描件.pdf", resume: true })           // 断点续跑
md_convert({ file: "扫描件.pdf", engine: "vision" })       // 强制 vision 任务书
```

**参数**(`background`/`engine` 缺省读插件配置):

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `file` | 路径(必填) | 源文件 |
| `outDir` | 目录 | 输出目录(默认插件配置或工作区) |
| `forceOcr` | boolean | 强制 PDF 走 OCR 路由 |
| `background` | `auto`(默认)/`true`/`false` | OCR 类长任务后台作业化;**缺后台控制器时自动降级前台并附 warning,不失败**;文本层直提等快链路始终同步 |
| `engine` | `auto`(默认)/`local`/`vision` | 扫描件引擎;auto=复杂度探针换轨(表格/公式占比>阈值→vision) |
| `resume` | boolean | 断点续跑:接续 `.state.json` 已完成页,仅重试失败页 |

**插件配置**(`cordis.patch.yml` / DSH 配置面板;工具参数可逐次覆盖同名项):

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `cjkMerge` | `true` | **v0.7.2**:中文行间空格归并(纯规则、零新增依赖、幂等)。置 `false` 关闭 —— 仅在需要与旧产物逐字节对比时使用 |
| `outDir` | 会话工作区 | 输出目录 |
| `forceOcr` / `engine` / `background` | `false` / `auto` / `auto` | 同参数表默认值 |
| `autoInstallDeps` | `true` | 缺 OCR 依赖时自动 pip 安装 |
| `ocr.python` | 自动探测 | Python 解释器(`python`/`py`/`python3`) |
| `ocr.workers` | `0`(资源感知) | 并行 worker;`1`=进程内快速路径(沙箱/调试) |
| `ocr.foregroundMaxPages` | `30` | 前台 OCR 页数闸门;`0` 不限制 |
| `vision.complexityRatio` | `0.4` | 表格+公式区域占比换轨阈值 |
| `vision.autoBrief` | `true` | 文字层发现截图页时自动生成 `onlyPages` 子集任务书 |
| `legacy.backend` | `auto` | WPS / Office / LibreOffice 自动探测 |

### 装配与复查:`md_convert_assemble`

vision 链路(复杂版面)的收口工具:各批转写完成后,读 T3 的 plan.json 做确定性完整性校验并装配最终 md。

```
md_convert_assemble({ planPath: "md/采购文件.vision/plan.json" })
→ { ok: true, output: "md/采购文件.md", coverage: { found: 97, total: 97 }, findings: [] }

md_convert_assemble({ planPath: "…", review: true })   // 对可疑页生成复查任务书
```

**确定性校验项**(非 AI 判断,可复现):各批 output 存在且非空;PAGE 锚点覆盖 1..总页数
(无缺页/无重复/无越批);UTF-8 合法(严格解码,失败即致命);GBK 双重编码乱码特征
(U+FFFD/锟斤拷系/Latin-1 连续串);极短页统计(剥离注释后可见字符 <10)。

- 全部通过 → 按 PAGE 序合并写最终 md,返回 `findings: []`
- 有问题 → 仍装配(缺页写占位锚块)并返回 `findings`(每项 `{page, severity, problem, evidence}`)
- `review:true` → 生成 `<名>-vision/plan 同目录/<名>-review.md` 复查任务书(指向原 PNG +
  逐字校正提示词 + 整批重写输出契约),并把受影响批次 `outputFile` 更新为
  `outputs/review-batch-NN.md`;复查完成后**重新调用本工具**即再次校验装配

CLI 等价:`dsh-md-convert assemble <plan.json> [--review]`(全绿退出 0,有 findings 退出 1)。

插件配置(`cordis.patch.yml`,Schemastery 校验,零硬编码):

```yaml
- insert:
    - id: dsh-md-convert
      name: dsh-md-convert
      config:
        outDir: ""              # 输出目录;空则用会话工作区
        forceOcr: false         # 强制 PDF 走 OCR
        ocrScale: 2             # PDF 渲染倍率
        autoInstallDeps: true   # 缺 OCR 依赖时自动 pip 安装
        background: "auto"      # OCR 类任务后台作业化: auto | true | false
        engine: "auto"          # 扫描件引擎路由: auto | local | vision
        ocr:
          python: ""            # Python 解释器(空则自动探测)
          workers: 0            # 并行 worker;0=资源感知 min(CPU,4,内存预算);1=进程内快速路径(沙箱/容器)
          foregroundMaxPages: 30 # 前台 OCR 页数闸门;0=不限制(超限拒绝并指引后台/vision/resume)
          probeTimeoutMs: 120000
          runTimeoutMs: 7200000 # 前台 OCR 超时(后台作业不限)
          etaPerPageSec: 15     # ETA 估算单页均耗
        vision:
          pagesThreshold: 0     # 可选强制换轨闸(页数);0=不限,纯复杂度换轨
          complexityRatio: 0.4  # 表格+公式区域占比换轨阈值
          batchSize: 8          # vision 每批页数(过大上下文过载,过小批次数膨胀)
          renderScale: 2        # vision PNG 渲染倍率(≈144dpi)
          promptTemplate: ""    # 自定义提示词模板路径(空=内置 lib/py/prompts/vision-ocr.md)
        legacy:
          backend: "auto"       # auto | wps | office | libreoffice
```

## 老格式转换后端

`.doc/.xls/.ppt` 先另存为现代格式再交给 MarkItDown。后端自动按平台选择:

| 平台 | auto 后端 | 实现 |
| --- | --- | --- |
| Windows | **WPS → MS Office** | COM(PowerShell 脚本);WPS/Office 正在运行时自动重试(不会杀用户进程) |
| Linux / macOS | **LibreOffice** | `soffice --headless --convert-to`,需安装 LibreOffice(自动探测 `soffice`/`libreoffice`) |

可用 `--legacy-backend wps | office | libreoffice` 显式指定(如 Windows 无 WPS/Office 但装了 LibreOffice,可强制 `--legacy-backend libreoffice`)。

## 临时文件清理

- 每次转换使用独立临时目录(`%TEMP%/dsh-md-convert-*`),结束即删除
- 进程异常退出时,`exit`/信号钩子兜底清理,下次运行自动清扫历史残留
- v0.6.0 并行 OCR:页 PNG 由 Python 侧临时目录自管理(运行结束自动清理);输出目录旁的
  `<名>.md`(逐页增量)、`<名>.state.json`(断点状态)、`<名>.progress.json`(进度镜像)为持久产物,支持续跑与观测
- **断点状态所有权**:`.state.json` 由 Python 侧**独占写**(断点权威:pdf/scale/total 匹配校验 + 原子落盘),
  Node 消费端只读;Node 侧的逐页进度(含 stats 聚合)另写 `.progress.json` 镜像。
  两侧不互写同一文件——双写会在原子替换窗口竞态损坏,这是有意的设计归属
- vision 工作目录 `<名>.vision/`(PNG/plan/提示词/批次产出)持久保留,供复查与再装配;确认无需复查后可整目录删除
- 调试可用 `--keep-temp` 保留中间文件

## 测试

```sh
npm test                       # 单元测试:node --test(路由决策阈值/NDJSON 解析与锚点 upsert/
                               # state.json 断点续跑/后台作业返回结构/优雅降级)
node lib/cli.js convert test/fixtures/sample3.pdf -o .tmp/smoke --force-ocr --background true --workers 1
                               # 3 页纯图 fixture 冒烟:立即打印 jobId → 进度 → md 锚点完整
                               # (workers 1=进程内快速路径,兼容禁命名管道的沙箱/容器)
```

> 多 worker(`--workers 2`)走 multiprocessing.Pool,需环境允许命名管道;
> 受限环境(容器/沙箱)请用 `--workers 1`,语义与 Pool(1) 一致。

## 已知问题

- **paddlepaddle ≥3.3 的 oneDNN 与 PIR 静态图不兼容**会导致推理崩溃,插件已自动禁用
  (`FLAGS_use_mkldnn=0` + `enable_mkldnn=False`),无需手动处理。
- 扫描件 OCR 质量取决于版面清晰度;复杂版面/超小字号页面可适当提高 `--ocr-scale`(如 3)换取精度,耗时相应增加。

## 限制

- **加密 PDF** 需要用户密码时明确报 `E_ENCRYPTED`(仅 owner 密码/权限加密的文件可正常转换);损坏文件同样给出明确错误码
- 图片走**本地 RapidOCR**(离线);若 OCR 依赖缺失则回落 MarkItDown/tesseract(**首次需联网**下载 traineddata 到工作目录)
- MarkItDown 不支持的格式(如 `.pages/.key` 等)会明确报"不支持"
- **效率优先的取舍**:路由 OCR 选用轻量模型(版面 PP-DocLayout-L、文字 RapidOCR、公式 FormulaNet-S),速度优先,
  质量有基本保证;复杂表格(多层合并/斜线表头)、复杂多栏版面、超小字号可能存在识别不完整
- OCR 模型首次需联网预下载(约数百 MB 到 `~/.paddlex/`),之后完全离线、秒级加载

## 许可证

[MIT](LICENSE) © 2026 yakoylp
