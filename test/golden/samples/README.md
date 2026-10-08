# golden 样本(W0-2)

6 类样本,覆盖计划 §W0-2。**大样本是本地资产,不入库**(缺失时 `test:golden` 显式 SKIP 对应类别)。

| 文件 | 类别 | 来源 | 入库 |
|---|---|---|---|
| `char-layer-11p.pdf` | ① 逐字符文字层 | `改进研究/corpus/c1-brief-11p.pdf` | 否(3.9MB) |
| `textlayer-multi-img.pdf` | ② 正常文字层+多图 | `D:\Downloads\火山方舟_Agent 进化_1789355515.pdf` | 否(4.6MB) |
| `scan-4p.pdf` | ③ 纯图扫描件 | `改进研究/corpus/scan-4p.pdf` | 是 |
| `office-cn-table.docx` | ④ Office | `make_golden_samples.py` 生成 | 是 |
| `bigtable-34p.pdf` | ⑤ 大表格 | `改进研究/corpus/c2-need-34p.pdf` | 否(27MB) |
| `gbk-text.txt` | ⑥ GBK 文本 | `make_golden_samples.py` 生成 | 是 |

恢复:`python test/make_golden_samples.py`(需源文件在位)。
扫描件类别默认不参与 `test:golden`(慢),用 `MDC_GOLDEN_SCAN=1` 打开。
