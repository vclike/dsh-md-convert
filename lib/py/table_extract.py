# -*- coding: utf-8 -*-
"""dsh-md-convert — PyMuPDF find_tables() 表格提取(v0.7.2 W2-4)

为什么新增这条路径(2026-10-08 实测,同一批真实中文文档):
  - 自研 `table_rebuild.py`(几何线框法)在 34 页需求文档上出 9 个表,但**单元格字符
    交错**(如 `| 这 怎 图， 拿 输 谈 图 re |`)——按 band 下标归属在文字层与线框错位时失效;
  - 已装的 pymupdf `Page.find_tables()` 同一份文档出 **14 表/73 行,单元格干净**
    (`拦标价 | 194,000 元（含税）`, `# | 点位 | 内容 | 甲方原始要求`),且只要 0.41s;
  - 零新增依赖: pymupdf 是既有依赖(文字层主链已用 pymupdf4llm)。

必须做**假表过滤**: 实测逐字符定位文字层(PPT 导出)上 find_tables 会把带竖线感的
**文本行**判成 1 行 N 列表(如 ['202','6','.10.20','；'])——11 个"表"全是假的。
故要求 >=min_rows 行 且 >=min_cols 列,并剔除全空表。
"""
import pymupdf  # 与 pymupdf4llm 同源依赖;缺失时调用方按"不可用"处理

# 假表过滤阈值(真机校准: c1 的假表全是 1 行 —— 带竖线感的文本行被当表;真实表最少 2 行 2 列)
MIN_ROWS = 2
MIN_COLS = 2
# "正文塞进单元格"的嫌疑判据(v0.7.2 W2-4): 单单元格超长 → 该页改由自研几何法优先。
#
# 为什么要区分"嫌疑"与"拒收": 实测 golden 样本里**承载验收断言**的表也有 194 字长单元,
# 按长度直接拒收会把它们一起误杀(已实证 golden 两条断言由 False 变 True 的拐点就在此)。
# 故此处**不拒收**, 只把"含超长单元"作为**调用方择优**的信号:
# 该页若自研几何法也检出表格, 则改用自研产物(它在 golden 页上是被断言认可的形态)。
SUSPECT_CELL_LEN = 200
# 单元格内换行替换符: md 表格单元格不能含换行;替换为单个空格后由 CJK 归并统一收口
CELL_NEWLINE_REPLACEMENT = " "


def open_doc(pdf_path):
    """打开 PyMuPDF 文档(失败返回 None;调用方降级到自研几何法)。"""
    try:
        return pymupdf.open(pdf_path)
    except Exception:
        return None


def _cell_text(v):
    """单元格值 → md 安全文本: None→"";换行→空格;`|` 转义。"""
    if v is None:
        return ""
    s = str(v).replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\n", CELL_NEWLINE_REPLACEMENT)
    s = s.replace("|", "\\|")
    return " ".join(s.split())


def _table_md(rows):
    """行列表 → md 表格(首行作表头);少于 2 行返回空串。"""
    if not rows or len(rows) < 2:
        return ""
    width = max(len(r) for r in rows)
    norm = [[_cell_text(c) for c in r] + [""] * (width - len(r)) for r in rows]
    if not any(any(c for c in r) for r in norm):
        return ""  # 全空表(装饰框线)
    out = ["| " + " | ".join(norm[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    for r in norm[1:]:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def _is_fake(rows, min_rows=MIN_ROWS, min_cols=MIN_COLS):
    """假表判定: 行/列过少(带竖线感的**文本行**被当成表) 或 全空(装饰框线)。

    注意: **不**按单元格长度拒收 —— 见 SUSPECT_CELL_LEN 注释(golden 断言由长度拒收会误杀)。
    """
    if not rows or len(rows) < min_rows:
        return True
    width = max(len(r) for r in rows)
    if width < min_cols:
        return True
    return not any(c is not None and str(c).strip() for r in rows for c in r)


def extract_tables(doc, page_index, pdfium_page, min_rows=MIN_ROWS, min_cols=MIN_COLS):
    """提取某页表格 → {"tables": [(y_top,y_bottom,md)], "max_cell_len": int, "candidates": int}。

    tables 与 table_rebuild 同形(y 降序);max_cell_len 供调用方判断"正文塞进单元格"嫌疑。
    """
    empty = {"tables": [], "max_cell_len": 0, "candidates": 0}
    if doc is None or page_index < 0 or page_index >= doc.page_count:
        return empty
    try:
        page = doc[page_index]
        finder = page.find_tables()
    except Exception:
        return empty
    try:
        page_h = float(pdfium_page.get_size()[1])
    except Exception:
        page_h = float(page.rect.height)
    out = []
    max_cell = 0
    cands = 0
    for t in getattr(finder, "tables", []) or []:
        try:
            rows = t.extract()
        except Exception:
            continue
        cands += 1
        if int(t.col_count) < min_cols or _is_fake(rows, min_rows, min_cols):
            continue
        md = _table_md(rows)
        if not md:
            continue
        for r in rows:
            for c in r:
                if c is not None and str(c).strip():
                    max_cell = max(max_cell, len(str(c).strip()))
        x0, y0, x1, y1 = t.bbox
        top = page_h - float(y0)   # PyMuPDF y 向下 → pypdfium2 y 向上
        bot = page_h - float(y1)
        if top < bot:
            top, bot = bot, top
        out.append((top, bot, md))
    out.sort(key=lambda item: -item[0])
    return {"tables": out, "max_cell_len": max_cell, "candidates": cands}


def find_tables_md(doc, page_index, pdfium_page, min_rows=MIN_ROWS, min_cols=MIN_COLS):
    """只要表格列表(保持与 table_rebuild 同形);其余统计见 extract_tables()。"""
    return extract_tables(doc, page_index, pdfium_page, min_rows, min_cols)["tables"]
