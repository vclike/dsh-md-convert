# golden 样本(W0-2 + v0.7.12 扩充)

**18 类样本**。**大样本与外部数据集样本是本地资产,不入库**(缺失时 `test:golden` 显式 SKIP 对应类别)。

> 完整的来源 / 许可 / 入库判定 / 恢复方式见同目录 **[`SOURCES.md`](SOURCES.md)** —— 新增样本必须登记。
> 入库策略见 `.gitignore`(**默认拒绝 + 白名单**):外部样本一律不入库。

## 自持样本(可由脚本重建)

| 文件 | 类别 | 恢复 |
|---|---|---|
| `gbk-text.txt` | ⑥ GBK 文本 | `python test/make_golden_samples.py` |
| `office-cn-table.docx` | ④ Office | 同上 |

## 用户提供的真实文档(不入库的大样本)

| 文件 | 类别 | 大小 |
|---|---|---|
| `char-layer-11p.pdf` | ① 逐字符文字层 | 3.9MB |
| `textlayer-multi-img.pdf` | ② 正常文字层+多图 | 4.6MB |
| `bigtable-34p.pdf` | ⑤ 大表格 | 27MB |
| `scan-4p.pdf` | ③ 纯图扫描件 | 584KB(已入库) |

## 外部开源来源(不入库,用脚本拉取)

| 文件前缀 | 类别 | 来源 | 拉取方式 |
|---|---|---|---|
| `dl-*.docx` / `dl-*.pdf` | ⑦–⑰ Docling(MIT) | docling `tests/data/` | `node scripts/fetch-golden-docling.mjs` |
| `zh-omnidocbench-12p.pdf` | ⑱ 中文页 | OmniDocBench(**仅研究用途**) | `fetch-omnidocbench-zh.mjs` → `select-…` → `fetch-zh-images.mjs` |

## 运行

- 默认单测(`node --test`):只跑 `light` 类(docx/文本,<1.2s)
- `npm run test:golden`:跑全部非 slow 类
- `MDC_GOLDEN_SCAN=1`:额外跑慢类别(③ 纯图扫描件 ⑱ 中文页,均约 10s/页)
