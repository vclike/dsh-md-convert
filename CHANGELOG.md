# Changelog

本项目所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
