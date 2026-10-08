# dsh-md-convert — Agent 使用指南

> 面向 AI agent:`md_convert` / `md_convert_assemble` 工具怎么用、何时用、出错怎么处理。人类用户请看 README.md / README.en.md。

## 工具是什么

`md_convert` 把 Office/PDF(含扫描件)转换为保留结构的 Markdown:

- `.docx/.xlsx/.pptx`、`.pdf`(有文字层)、`.doc/.xls/.ppt` → MarkItDown 直转(同步,快)
- `.png/.jpg/.jpeg/.tif/.tiff` → **本地 RapidOCR 优先**(v0.7.2,模型随包内置 → 完全离线、不写工作目录);失败或无文本回落 MarkItDown/tesseract
- `.md/.markdown/.txt` → 直接读取(带**编码探测**:UTF-8/UTF-16 BOM → 严格 UTF-8 → GB18030 回落)
- `.zip` → MarkItDown(**递归**转换包内每个文件);`.gif/.bmp/.webp` **不支持**(引擎无后端,报 `E_UNSUPPORTED_FORMAT`)
- `.pdf` 扫描件/无文字层 → **三层引擎路由**(v0.6.0):
  1. **复杂度探针**:抽样 3 页(首页/1/3/2/3 处)做版面分析;
  2. 表格/公式区域占比 > 40%(可配 `vision.complexityRatio`)→ **vision 任务书**(`engine` 也可显式指定);
  3. 否则 → **页级并行本地 OCR**(NDJSON 流式,任意页数;OCR 类长任务自动转**后台作业**)。

**安全护栏(v0.6.1)**:
- **前台页数闸门**:`background=false` 且本地 OCR 页数 > `ocr.foregroundMaxPages`(默认 30)→
  拒绝执行(`E_FOREGROUND_LIMIT`),返回替代路线(background/vision/resume)与 ETA——
  前台长 OCR 会占满 CPU/内存拖垮整机,收到该错误请改走建议路线,不要硬闯。
- **后台启动降级链**:后台启动被宿主拒绝时自动降级(带 owner → 无主后台 → 前台)并在
  `warnings` 说明原因;`warnings` 含「无主启动」时,完成**不会**自动送达,须主动轮询 `job_output`。

**引擎路由决策(v0.6.2,返回的 `decision` 字段会说明本次路线)**:
- 有文字层 → markitdown 直提;markitdown 在宿主内失败 → pypdfium2 兜底(秒级,
  纯文字无版面结构,`warnings` 注明原因)——**有文字层绝不 OCR**。
- 无文字层 → 表格/公式占比 ≤40% 本地 OCR(后台优先,前台 30 页闸门);
  \>40% vision 模型阅读(agent 编排子代理并行,复杂表格/印章质量更优)。

**v0.7.2 文字层产物相关(有文字层 PDF)**:
- **中文行间空格归并**默认开启(pymupdf4llm 的 span 拼接会在中文行间插空格;自研链的标题续行/
  表格词界同样注入)。两个候选引擎**都先归并再比优**,所以 `warnings` 里的
  `[中文归并] 归并中文行间空格 N 处` 是**已修复**的计数,不是残留问题。
- **表格默认用 PyMuPDF `find_tables()`**(单元格干净、假表已过滤);`quality.signals` 新增
  `cjkSpaceInjection / cjkSpacePer1k`(只观测,不影响 score 与 `suggestVision`)。
- **加密 PDF**(需用户密码)→ 直接 `E_ENCRYPTED`,不会白跑 OCR 路由;仅 owner 密码的文件正常转换。

**适用**:用户要求转 md、提取文档内容、批量转换。
**不适用**:只需读内容用 `pdf_read`/`docx_read` 等;生成文档用 `docx_create`/`pdf_create` 等;视觉保真(字体/颜色)Markdown 表达不了,直接告知用户。

## 怎么调用

```jsonc
// 单文件(推荐显式 outDir,避免与源文件混放)
md_convert({ "file": "contract.pdf", "outDir": "./md" })
// → { ok: true, background: false, output: "./md/contract.md", chain: "markitdown", warnings?: [] }

// 大部头扫描件(默认 background=auto):OCR 类一律后台,立即返回 jobId
md_convert({ "file": "97页扫描件.pdf", "outDir": "./md" })
// → { ok: true, background: true, jobId: "…", etaSec: 404,
//     statePath: "…/97页扫描件.state.json", progressPath: "…/97页扫描件.progress.json" }
// 轮询 job_output(jobId);取消 job_kill(jobId)(已完成页保留,可 resume 续跑);
// 完成通知会自动送达,届时 job_output 读取 {status:"completed"|"killed"|"failed", output}

// 断点续跑:接续 .state.json 已完成页,仅重试失败页
md_convert({ "file": "97页扫描件.pdf", "resume": true, "outDir": "./md" })

// 强制引擎(跳过探针):表格/公式密集版面建议 vision;普通文本版面用 local
md_convert({ "file": "scan.pdf", "engine": "vision", "outDir": "./md" })
// → { ok: true, mode: "vision-brief", planPath: "…/scan.vision/plan.json", batches: [...] }
```

- `file`:绝对路径或相对工作区路径;`outDir` 缺省用会话工作区
- `background`:`auto`(默认,OCR 类一律后台)/`true`/`false`(强制同步);缺后台控制器时**自动降级前台并附 warning,不会失败**
- `engine`:`auto`(默认,探针换轨)/`local`/`vision`
- `pages`(v0.7.3):`"1-20,25"` 只转换指定页(1 起,锚点保留原始页号)。**大文档优先用它**——
  先把相关章节转出来,别为了 10 页把 300 页全跑一遍。文字层 PDF 与 vision 路由支持任意集合;
  扫描件本地 OCR 只支持 `"1-N"`(前缀),其它形态会在 `warnings` 里明确说"未生效";
  越界直接失败(`E_UNSUPPORTED_FORMAT`),不会静默输出全篇
- 输出名 = 源文件名去扩展名 + `.md`;同名默认覆盖
- 失败返回 `{ ok: false, code, file, error }`,`code` 是稳定错误码

## vision 链路闭环(engine=vision 或探针判 vision)

1. `md_convert` 返回 `mode:"vision-brief"` + `planPath` + `batches`(每批含 pages/promptFile/outputFile/imageFiles);
2. 读 plan.json,按批编排子代理:**读 prompts/batch-NN.md → 看批内 PNG → 把转写写入对应 outputFile**
   (锚点格式 `<!--PAGE:NN-->…<!--/PAGE:NN-->` 缺一不可);
3. 全部批次产出后调 `md_convert_assemble({ planPath })` → 确定性校验(锚点覆盖/重复/越批/乱码特征/极短页)
   + 按页序合并最终 md,返回 `{ok, output, coverage:{found,total}, findings}`;
4. findings 非空 → `md_convert_assemble({ planPath, review: true })` 生成复查任务书
   (`<名>-review.md`,含原 PNG 路径与逐字校正提示词),按任务书重写受影响批次后**重新 assemble**;
5. coverage/found<total 或 findings 含缺页时,不要把半成品当最终交付。

## 错误码

| code | 含义 | 处理 |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | 文件不存在 | 核对路径后重试,别盲目重试 |
| `E_UNSUPPORTED_FORMAT` | 格式不支持 | 告知用户 |
| `E_MARKITDOWN` | MarkItDown 失败 | 多为损坏或引擎无对应后端;可重试一次 |
| `E_ENCRYPTED` | PDF 已加密,需**用户密码**(v0.7.2) | 告知用户需先解除保护;不要反复重试(重试无用) |
| `E_LEGACY_CONVERT` | 老格式(doc/xls/ppt)转换失败 | 需本机 WPS/Office 或 LibreOffice |
| `E_OCR_DEPS` | OCR 依赖缺失 | 让用户跑 `dsh-md-convert deps` |
| `E_OCR_RUN` | OCR 执行失败/致命错误 | 已完成页保留于 state.json,`resume:true` 接续;持续失败建议降 `--ocr-scale` |
| `E_OCR_TIMEOUT` | 前台 OCR/探针超时(后台作业不限时) | 已完成页已落盘,`resume:true` 接续 |
| `E_OCR_EMPTY` | 未识别出内容 | 告知用户扫描质量差/过暗/方向异常 |
| `E_VISION_PLAN` | vision 任务书链路失败 | 检查文件是否合法 PDF;或回退 `engine:"local"` |
| `E_ASSEMBLE` | 装配致命失败(plan 损坏/非合法 UTF-8) | 重新生成任务书;检查批次 output 编码 |
| `E_OUTPUT` | 输出写入失败 | 检查目录权限/磁盘 |

**报错时必带 `code` 和 `file`**,如:`[E_OCR_EMPTY] C:\docs\scan.pdf`。

## 批量约定

- 一次调用处理一个文件;批量就**循环调用**,按 `file` 定位失败,不依赖返回顺序
  (工具只收单个文件路径;**目录/批量输入是 CLI 能力**,`dsh-md-convert <目录> -o <dir> [-r]`,agent 不要试图把它当工具参数)
- 成功只报输出路径,**不要**把整份 md 贴回对话(费上下文),除非用户要求
- 同一 outDir 批量时同名会覆盖——需先与用户确认或用独立目录
- 后台作业启动后**不要空转轮询**:等完成通知,或先做其他独立工作再 `job_output`
- 长任务的**时间预期读 `progress.json` 的 `etaSec`**(v0.7.3):它按**本次已完成的逐页耗时**推算
  剩余秒数(证据不足时为 `null`),比启动时那个静态 `etaSec` 准得多;启动时的静态值已按实测中位
  从 15s/页 重标定为 27s/页(旧值对表格密集页偏乐观约 1.8×)

## 注意

- **结构化而非视觉**:字体/字号/颜色/缩进不保留,主动告知用户
- 扫描件质量取决于清晰度;复杂表格/多栏/超小字号本地 OCR 可能识别不全——探针判复杂版面会自动走 vision;也可显式 `engine:"vision"`
- 首次使用自动装依赖(缺则 `pip install`);OCR 模型需预先联网下载一次(`dsh-md-convert deps`,数百 MB,之后完全离线),模型未就绪时工具会返回 `E_OCR_DEPS` 并提示先跑该命令
- 后台作业需要组合安装 `@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`;未安装时自动降级前台(warnings 会注明),此时大部头扫描件受单次调用时长约束,建议提示用户装控制器
- 源文件只读,绝不修改;临时文件自动清理
- **同文档重复转换很便宜**(v0.7.2):扫描件按键复用断点(state 校验键 = 插件版本+倍率+文档指纹),
  探针结论亦缓存 → 复跑秒级;但**改了源文件或渲染倍率就会重跑**(键不匹配即视为新任务)
