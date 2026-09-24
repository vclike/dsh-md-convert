# dsh-md-convert

[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

将 Office 文档与 PDF(含扫描件)转换为**保留结构级排版**的 Markdown,基于 [MarkItDown](https://github.com/microsoft/markitdown) 引擎。提供 **CLI 命令行**与 **dsh agent 工具**(`md_convert`)双入口。

- **AI Agent 使用规范**:[README.agent.md](README.agent.md)(错误码处理/批量规范/调用约定)
- English: [README.en.md](README.en.md)

## 支持格式与转换链路

| 输入 | 链路 | 说明 |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | MarkItDown 直转 | 标题/列表/表格/段落保留为 Markdown |
| `.pdf`(含文字层) | MarkItDown 直转 | 文字层为空时**自动进入扫描件三层路由** |
| `.pdf`(扫描件) | **三层引擎路由**(v0.6.0):① 复杂度探针抽样 3 页 → ② 表格/公式占比超阈值走 vision 任务书,否则 ③ **页级并行本地 OCR**(NDJSON 流式 + 断点续跑,任意页数) | 标题/正文/表格/公式/印章,纯 CPU、轻量模型;长文档不再受单次同步调用时长限制 |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM(Windows)或 LibreOffice(其余平台)另存为新格式 → MarkItDown | 后端自动探测,可配置 |
| `.html/.csv/.json/.xml/.ipynb/.md/.txt/...` | MarkItDown / 直接读取 | MarkItDown 支持的全部格式 |

> **"结构级排版"** = 标题层级(H1–H6)、列表、表格(管道表格)、段落顺序均保留。
> Markdown 本身无法表达字体/字号/颜色/缩进等视觉细节,任何转换器都不会保留它们——这是格式本质。

## 环境依赖

- **Node.js ≥ 18**
- 老格式转换(`.doc/.xls/.ppt`):Windows 需本机装有 **WPS Office** 或 **Microsoft Office**(COM 自动探测);Linux/macOS 需 **LibreOffice**(`apt install libreoffice`,自动探测 `soffice`)
- **扫描件 OCR 以 CPU 为主、轻量模型优先、性价比优先**:模块化路由流水线——`PP-DocLayout-L` 版面分析(轻量)按区域路由,**文字走 RapidOCR(PP-OCRv6 ONNX,最快)**,表格走 SLANet+RT-DETR,**公式走 FormulaNet-Plus-S(轻量)**;标题层级由版面模型识别。质量有基本保证,但为效率做了取舍(如复杂版面/超小字号可能识别不全)
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

**前台降级行为**:未安装上述控制器时,`background=auto|true` **不会失败**——自动回退前台执行,
返回结果附 `background:false` 与 warning「后台作业控制器未安装,已回退前台」。前台路径同样具备
NDJSON 流式增量落盘(`.md` 逐页更新 + `.state.json` 断点)与 `exec.signal` 取消能力,
但受单次工具调用时长约束——**长文档场景强烈建议安装控制器**。

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
```

完整选项见 `dsh-md-convert --help`。

## 错误码与退出码

失败时**必定携带稳定错误码**,调用方(CLI / agent / 二次开发)可据此分类处理:

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | 源文件不存在 | 检查路径 |
| `E_UNSUPPORTED_FORMAT` | 扩展名不受支持 | 更换格式 |
| `E_MARKITDOWN` | MarkItDown 转换失败 | 多为文件损坏/加密,可重试 |
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
          workers: 0            # 并行 worker;0=默认 min(CPU,8);1=进程内快速路径(沙箱/容器)
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

- 加密/损坏文件、部分复杂版面可能转换失败(会给出明确错误)
- MarkItDown 不支持的格式(如 `.pages/.key` 等)会明确报"不支持"
- **效率优先的取舍**:路由 OCR 选用轻量模型(版面 PP-DocLayout-L、文字 RapidOCR、公式 FormulaNet-S),速度优先,
  质量有基本保证;复杂表格(多层合并/斜线表头)、复杂多栏版面、超小字号可能存在识别不完整
- OCR 模型首次需联网预下载(约数百 MB 到 `~/.paddlex/`),之后完全离线、秒级加载

## 许可证

[MIT](LICENSE) © 2026 yakoylp
