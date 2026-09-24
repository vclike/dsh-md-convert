# dsh-md-convert 0.6.0 — 三引擎路由基准实测（bench）

> 实测目的：为 T2（auto 路由决策 / etaSec 标定 / 探针预算）提供真机数据依据。
> 样本：`采购文件.pdf`（97 页纯图扫描件，A4，中文，含 44 个表格区域、4 处印章、0 公式）——
> 即本次升级要解决的「97 页纯图 PDF 同步调用被宿主中断」的真实样本。
> 所有数字为真机单次实测（OS 文件缓存已热），非平均值；不同机器/负载会有出入。

## 实测环境

| 项 | 值 |
| --- | --- |
| OS | Windows（DSH 宿主机） |
| CPU | 22 逻辑核 |
| RAM | 32 GB |
| Python | 3.11.9 |
| 引擎 | routing_ocr.py 的 RoutingOCR（PP-DocLayout-L + RapidOCR + SLANet/SLANeXt + RT-DETR + PP-FormulaNet_plus-S） |
| 渲染 | pypdfium2，scale=2（≈144dpi），最长边限 1600px |
| 备注 | `FLAGS_use_mkldnn=0`（沿用 routing_ocr.py 设定，CPU 推理稳定优先；开启 mkldnn 预计可再提速，属后续调优项） |

## TL;DR（路由默认值依据）

| 决策点 | 实测结论 |
| --- | --- |
| 97 页全量本地 OCR 可行性 | ✅ workers=1 实测 23.3 min 全绿；workers=4 线性估算 ≈ 6-7 min（待真机复核）——后台作业化后完全可用 |
| 渲染成本 | 97 页 16.1s（vision/local 两链路共同的固定开销，可忽略） |
| 探针成本 | 3 页抽样 10.6-11.4s（模型加载 4.2-4.8s + 约 1.9-2.5s/页）——**超出 ≤8s 目标**，建议 t2 将探针作为后台作业内步骤而非交互阻塞步骤 |
| 复杂度阈值校验 | 真样本区域级 (tables+formulas)/all = **6.1%**，远低于默认 visionComplexityRatio=0.4 → auto 正确走 local；页级口径 41% 页含表（两口径勿混淆，见 §4） |
| 内存预算 | workers=1 峰值 2.45GB；每加一个 worker 估 +1.5~2GB（模型栈各加载一份），workers=8 时估 ~13-17GB |

## 1. 渲染导出（render_pages.py，T3 vision 链路复用）

| 指标 | 值 |
| --- | --- |
| 97 页全量导出 PNG | **16.1s**，峰值内存 1.28GB，exit 0 |
| 输出 | 97 张 p-01.png...p-97.png + 单行 JSON 清单（ok/pages/dir/files） |

## 2. 页级并行 OCR（parallel_ocr.py）

### 2.1 workers=1（进程内路径）97 页全量实测

| 指标 | 值 |
| --- | --- |
| 端到端总耗时 | **1398.7s ≈ 23.3 min**（渲染阶段 ~17s + OCR 阶段 1381.3s） |
| 页均耗时 | 14.2s/页 |
| 峰值内存（主进程=单 worker 同进程） | 2.45GB |
| 结果 | 97/97 页成功，0 warning，exit 0；NDJSON 97 个 page 事件逐页流式输出 |
| 页耗时分布 | min 2.6s（第40页）/ max 36.3s（第27页）/ P50 ≈ 10.6s |

### 2.2 按页型分解（探针全量分类 × 实测耗时 join）

| 页型 | 页数 | 页均耗时 | 说明 |
| --- | --- | --- | --- |
| 纯文字页 | 57 | **16.1s** | 密集中文正文，RapidOCR 行数多，是耗时大头 |
| 含表格页 | 40 | **11.3s** | 表格结构+单元格模型快，单元格内文字少 |
| 空白页 | 0 | — | 本样本无；fixture 冒烟中空白页 ≈1.7s（仅版面分析） |

> 反直觉点：含表格页反而快于纯文字页——采购文件正文密密麻麻（600+ 字/页），
> 文字行识别数量远超表格单元格。**按页数估算耗时不可靠，按区域密度估算才准。**

### 2.3 workers = 2 / 4 / 6 三档对比 ⚠️ 受限说明

**本基准报告作者的开发会话运行在 DSH agent 沙箱内（禁命名管道），multiprocessing.Pool
无法创建（`connection.Pipe` → WinError 5，已实测确认属沙箱边界而非代码缺陷）**，
Pool 并行路径无法在此环境实测。已验证的替代覆盖：

- Pool 失败时的降级行为：`start` → `done(warnings 含「致命错误」)` → exit 1，`--resume` 可无损接续 ✅
- `--workers 1` 进程内路径：与 Pool(1) 语义一致（顺序执行、模型加载一次），全链路功能实测 ✅
- Pool 真实并行**在 DSH 插件运行时（dsh web 进程，无沙箱）不受限**——T2 的 ctx.jobs 后台作业联调即真实验证环境

**补测命令**（任一非沙箱 PowerShell 终端运行，每档约 5-25 min）：

```powershell
cd D:\WorkSpace\Planing-Workdeck\.tmp\dsh-md-convert-dev
python lib\py\parallel_ocr.py ..\采购文件识别\采购文件.pdf --scale 2 --workers 2 --resume ..\mdc-bench\bench-w2.state.json
python lib\py\parallel_ocr.py ..\采购文件识别\采购文件.pdf --scale 2 --workers 4 --resume ..\mdc-bench\bench-w4.state.json
python lib\py\parallel_ocr.py ..\采购文件识别\采购文件.pdf --scale 2 --workers 6 --resume ..\mdc-bench\bench-w6.state.json
```

### 2.4 线性外推估算（供 etaSec 标定，待 §2.3 复核）

OCR 阶段 1381s 为单 worker 真实值；模型每 worker 加载 ~13-25s（含懒加载表格模型）：

| workers | 估算总耗时 | 估算峰值内存 |
| --- | --- | --- |
| 1（实测） | 23.3 min | 2.45GB |
| 2 | ~12-13 min | ~4-4.5GB |
| 4 | **~6-7 min** | ~7-9GB |
| 6 | ~4.5-5.5 min | ~10-13GB |

etaSec 建议公式：`eta ≈ 20s（渲染+启动）+ 页数 × 页均区域密度系数 / workers`；
97 页 workers=4 标定值 **≈ 400s**（保守可报 420s）。

## 3. 复杂度探针（--probe）

### 3.1 实测耗时

| 指标 | 值 |
| --- | --- |
| 抽样 3 页（1,33,65）总耗时 | **10.6s**（进程内计时）/ 11.4s（含 Python 启动的墙钟） |
| 分解 | 版面模型加载 4.2-4.8s（含 paddle import）+ 每页版面分析 1.9-2.5s + 渲染 <0.1s/页 |
| 峰值内存 | 682MB（仅加载 PP-DocLayout-L，不加载表格/公式/RapidOCR） |
| 对照目标 | **超出「3 页 ≤8s」目标约 2.6-3.4s** |

超标归因与建议：
1. 刚性成本在 paddle 框架 import + 模型初始化（~4.2-4.8s/进程），进程内无法再压；
2. 每页版面前向 ~1.9s 由模型固定输入尺寸决定，降渲染 scale 收益可忽略；
3. **建议 t2**：探针在 auto 路由中作为后台作业内的路由步骤（11s 相对后续数分钟任务可忽略），
   而非交互式阻塞步骤；若必须压缩，抽样 2 页（≈8.6s）或降低抽样页数。
4. 探针失败降级：已实现——模型加载/页分析失败输出 `error` 字段且 exit 1，Node 侧按「默认走 local」处理。

### 3.2 真样本探针读数（路由依据）

| 口径 | 值 | 含义 |
| --- | --- | --- |
| 区域级 (tables+formulas)/(tables+formulas+textRegions) | **6.1%**（44 表格区 / 682 文字区 / 0 公式；另有 4 印章不计入分母） | t2 的 visionComplexityRatio 比较口径；远低于 0.4 → **auto → local 正确** |
| 页级「含 ≥1 表格的页」占比 | 41%（40/97 页） | 仅参考，勿与区域级混用；本样本即使按此口径也在 0.4 阈值边缘 |

结论：97 页采购文件本地并行 OCR 完全可胜任（23.3min 单进程 / 估算 6-7min@4workers）；
vision 任务书链路留给区域级复杂度真超标（表格/公式密集型）或用户显式 engine=vision 的场景。

## 4. 协议与降级验证记录（5 页自制 fixture + 真样本冒烟矩阵）

| 用例 | 结果 |
| --- | --- |
| NDJSON 流式（start/97×page/done） | ✅ 逐页即时输出（非一次性），单行 JSON + flush |
| 页锚点 `<!--PAGE:NN-->...<!--/PAGE:NN-->` 两位补零 | ✅ 97 页格式一致；空白页输出纯锚点对 |
| page.stats {tables,formulas,textChars} | ✅ 表格页 tables=1、文字页 textChars=608、印章页 stamps 走 `<!-- 印章 -->` 注释 |
| 失败页降级 | ✅ 渲染/OCR 失败页发占位注释页事件 + 计入 done.warnings + state 标 failed，不中断整体 |
| --resume 全量跳过 / 部分重试（failed 页重跑、done 页跳过） | ✅ |
| 坏 state.json（corrupt）/ 不匹配 state（pdf/scale/total） | ✅ 告警并忽略旧状态，全量重跑 |
| 重试成功后旧警告清除 | ✅ done.warnings 取实时状态视图 |
| --probe 输出（tables/formulas/textRegions/stamps） | ✅ 文字页 4 区 / 表格页 1 表 / 空白页全零 |
| --probe 非法页号（"abc,999,0"） | ✅ error 事件 + exit 1，不加载 paddle |
| Pool 被禁环境（WinError 5） | ✅ 优雅降级为 done(致命错误) + exit 1，resume 可接续 |
| stdout/stderr 纪律 | ✅ stdout 仅协议行；诊断/计时全走 stderr；两者均强制 UTF-8 |

## 5. 已知观察（非本任务修复项）

1. **表格列序偶发错乱**：`routing_ocr.py` 参考实现的 `table_full` 在单元格数 ≠ 行×列时
   走行聚类回退路径，本样本第 4-6 页出现列序颠倒/错位（参考实现行为，T1 未改动它）。
   复杂版面正是 vision 路由的目标场景，与「探针换轨」设计互洽；如需本地侧改善属后续迭代。
2. 标题层级由版面标签决定，个别「第X章」识别为 `##` 重复词（如「第一 一 章」），属 RapidOCR
   行级识别噪声，参考实现行为。
3. Pool 并行路径的 2/4/6 实测数据见 §2.3 补测命令，欢迎在非沙箱终端补充后回填本文件。
