# golden 样本来源台账

**每个样本的来源、许可、是否入库、恢复方式,一律记在这里。**
新增样本必须同时更新本文件,否则视为未完成。

## 判据:可入库 vs 仅本地

| 情形 | 判定 | 依据 |
|---|---|---|
| 自生成(脚本产出) | ✅ 可入库 | 许可自持 |
| 用户提供的真实文档 | ✅ 可入库(需用户确认用途) | 非商用样本 |
| **MIT / Apache-2.0 等允许再分发的开源仓库** | ✅ 可入库 | 保留许可与出处 |
| **许可声明为"仅研究用途 / 禁止商用"的数据集** | ❌ **不入库**,仅本地 | 条款禁止**再分发** |
| **无许可声明的仓库/权重** | ❌ **禁止引入** | 无授权 = 不可用 |
| 体积仅影响"是否愿意入库",**不影响**能否本地使用 | | |

> **关键区分:能否使用 ≠ 能否再分发。**
> 插件本身非商用,但一旦把文件**提交进 git 或打进 tgz** 就是**再分发**,
> 会突破"仅研究用途"条款。故此类样本一律本地使用、不入库、不打包。

## 现有样本

| 文件 | 类别 | 来源 | 许可 | 入库 | 恢复方式 |
|---|---|---|---|---|---|
| `gbk-text.txt` | ⑥ GBK 文本 | `test/make_golden_samples.py` 生成 | 自持 | ✅ | `python test/make_golden_samples.py` |
| `office-cn-table.docx` | ④ Office | 同上 | 自持 | ✅ | 同上 |
| `scan-4p.pdf` | ③ 纯图扫描件 | 用户提供的真实扫描页(采购文件节选) | 用户提供,非商用 | ✅ | 需用户重新提供 |
| `char-layer-11p.pdf` | ① 逐字符文字层 | 用户提供的真实文档 | 用户提供,非商用 | ❌ | 同上 |
| `textlayer-multi-img.pdf` | ② 正常文字层+多图 | 用户提供的真实文档(火山方舟) | 用户提供,非商用 | ❌ | 同上 |
| `bigtable-34p.pdf` | ⑤ 大表格 | 用户提供的真实文档(需求梳理) | 用户提供,非商用 | ❌ | 同上 |

## 外部开源来源(进行中)

| 来源 | 许可 | 用途 | 入库 | 说明 |
|---|---|---|---|---|
| **docling** `tests/data/` | **MIT** | 补齐格式多样性(pdf/docx/pptx/xlsx/html/epub) | 计划入库(小文件) | [docling-project/docling](https://github.com/docling-project/docling);自带 groundtruth(.md/.itxt)。**局限:几乎全是英文**(arXiv 论文/报纸),不覆盖中文缺陷 |
| **OmniDocBench** | 代码 Apache-2.0 / **数据集"仅研究用途,禁止商用"** | 中文页 + 权威标注(阅读顺序/表格 HTML) | ❌ **仅本地** | [opendatalab/OmniDocBench](https://github.com/opendatalab/OmniDocBench);HF 上**只有 PNG + JSON,没有 PDF**,需自行封装 |
| **CDLA** | **无许可声明** | 中文版面 | ❌ **禁止引入** | [buptlihang/CDLA](https://github.com/buptlihang/CDLA);最后提交 2021-09,无 license 字段 |
| MinerU ONNX 权重 | **需回溯** | 表格档 | ⛔ 阻塞 | HF `MinerU-4_models_onnx` 无 license 声明;且权重要**打进 tgz 分发** |

## 实测事实(2026-10-09 核实)

- `npm pack` 产出的 tgz **不含任何样本/测试**(41 条目,`files` 仅含 `lib` + 文档)—— 再分发面已被机制排除。
- OmniDocBench:HuggingFace `opendatalab/OmniDocBench` 共 **1662 个文件 = 1651 张 PNG + 1 个 JSON**,
  **没有 PDF**;`OmniDocBench.json` **40.25 MB**;单张中文页 PNG 约 **0.19 MB**。
- OmniDocBench 的语言是**标注属性**(`page_attribute.language`),**不能靠文件名筛**
  (文件名含 `_zh_` 的只有 20 个,远少于实际中文页数)。