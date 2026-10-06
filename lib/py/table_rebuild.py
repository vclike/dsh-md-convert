# -*- coding: utf-8 -*-
"""
dsh-md-convert — PDF 表格重建(v0.6.9 P1-A 第二轮:字符级归属)

原理: 文字层 PDF 的表格由矢量线框(PATH 对象)+单元格文本构成——
  ① 线框检测: PATH 对象 bounds 按形态分类(横线/竖线),坐标聚类成行/列边界;
  ② 网格判定: 横线≥2组 且 竖线≥2组 → 行x列网格(单元格数≥3,排除装饰线);
  ③ 字符级归属(v0.6.9): 每字符中心点落哪个行带/列带,该字符归哪个格。
     演进: v1 矩形内缩取词(get_text_bounded 相交语义→跨界切碎,实测
     "PE(TTM)"→"PE(T|TM)")→ v2 行框中心点归属(文本框粒度≠线框粒度时
     串列,实测 CapEx 表 "~910-930 亿美元" 分居两格)→ v3 字符级(终版)。
  ④ 词界: PDF 真空格字符为权威词界;几何间隙(>max(2.5pt,0.45×前字宽))
     为 fallback;格内按阅读序重排(y 顶降序分行——字形垂直重叠判定,下划线
     等低基线字符不拆行——x 升序拼接,竖线转义)。
降级: 无线框表格(纯对齐排版)检测不到网格 → 返回空列表,文本流保持原状。
跨页表格 v1 不合并(每页独立检测)。已知边界: 紧贴网格内侧的通栏注释段
(字符中心在区域内)会归入最近行带——几何正确优先。
"""
import ctypes

try:
    import pypdfium2.raw as pdfium_c
except Exception:  # pragma: no cover
    pdfium_c = None

PATH_TYPE = 2
# 线条形态阈值(pt):高度≤此值视为横线,宽度≤此值视为竖线
LINE_THICKNESS = 1.5
# 线段最短有效长度(pt),排除短装饰
LINE_MIN_LEN = 4.0
# 坐标聚类容差(pt)
CLUSTER_TOL = 2.0
# 行带/列带归属的边缘容差(pt):中心点距边界 ≤ 此值视为落带内
BAND_TOL = 2.0
# 词界几何 fallback 的间隙阈值(pt)与相对字宽比例
CHAR_GAP_MIN = 2.5
CHAR_GAP_RATIO = 0.45
# 表格资格:行列边界数(横线组/竖线组)最小值
MIN_ROW_LINES = 2
MIN_COL_LINES = 2


def _cluster(vals, tol=CLUSTER_TOL):
    """坐标聚类(容差合并): [(代表值, 数量)],按代表值升序。"""
    if not vals:
        return []
    vals = sorted(vals)
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [(round(sum(g) / len(g), 1), len(g)) for g in groups]


def detect_tables(page, tp):
    """检测页内线框表格。

    返回 [{"rect": (x0,y0,x1,y1), "rows": [y边界], "cols": [x边界]}, ...](按 y 降序);
    检测失败/无表格 → []。
    """
    if pdfium_c is None:
        return []
    try:
        hlines, vlines = [], []
        count = pdfium_c.FPDFPage_CountObjects(page.raw)
        for i in range(min(count, 4096)):
            obj = pdfium_c.FPDFPage_GetObject(page.raw, i)
            if not obj:
                continue
            if pdfium_c.FPDFPageObj_GetType(obj) != PATH_TYPE:
                continue
            l, b, r, t = ctypes.c_float(), ctypes.c_float(), ctypes.c_float(), ctypes.c_float()
            if not pdfium_c.FPDFPageObj_GetBounds(obj, ctypes.byref(l), ctypes.byref(b), ctypes.byref(r), ctypes.byref(t)):
                continue
            wd, ht = r.value - l.value, t.value - b.value
            if ht <= LINE_THICKNESS and wd > LINE_MIN_LEN:
                hlines.append(b.value)
            elif wd <= LINE_THICKNESS and ht > LINE_MIN_LEN:
                vlines.append(l.value)
        hc = _cluster(hlines)
        vc = _cluster(vlines)
        if len(hc) < MIN_ROW_LINES or len(vc) < MIN_COL_LINES:
            return []
        ys = [g[0] for g in hc]
        xs = [g[0] for g in vc]
        rect = (min(xs), min(ys), max(xs), max(ys))
        return [{"rect": rect, "rows": ys, "cols": xs}]
    except Exception:
        return []


def _table_chars(tp, region):
    """区域内字符级坐标: [(cx, cy, ch, cl, cr, cb, ct)]。

    空格字符保留(权威词界信号,见 _join_chars);换行/制表类跳过。
    """
    x0, y0, x1, y1 = region
    try:
        n = tp.count_chars()
        text = tp.get_text_range(0, n)
    except Exception:
        return []
    out = []
    for i in range(min(n, 20000)):
        ch = text[i] if i < len(text) else ""
        if not ch:
            continue
        if ch.isspace() and ch != " ":
            continue
        try:
            l, b, r, t = tp.get_charbox(i)
        except Exception:
            continue
        cx, cy = (l + r) / 2.0, (b + t) / 2.0
        if x0 - BAND_TOL <= cx <= x1 + BAND_TOL and y0 - BAND_TOL <= cy <= y1 + BAND_TOL:
            out.append((cx, cy, ch, l, r, b, t))
    return out


def _join_chars(chars):
    """格内字符 → 文本。

    分行: 字形垂直重叠判定(下划线等低基线字符 y 中心偏移大,Δy 阈值会误拆行)。
    拼接: 行内按字形左边界升序;词界两级判定——①真空格字符输出为空格
    (连续压缩);②几何 fallback 间隙 > max(CHAR_GAP_MIN, CHAR_GAP_RATIO×前字宽)。
    """
    if not chars:
        return ""
    chars = sorted(chars, key=lambda p: (-p[6], p[3]))  # y 顶降序, x 升序
    lines = []
    cur = [chars[0]]
    cur_hi, cur_lo = chars[0][6], chars[0][5]
    for c in chars[1:]:
        b, t = c[5], c[6]
        if b <= cur_hi + 1.0 and t >= cur_lo - 1.0:  # 与当前行字形垂直重叠
            cur.append(c)
            cur_hi, cur_lo = max(cur_hi, t), min(cur_lo, b)
        else:
            lines.append(cur)
            cur = [c]
            cur_hi, cur_lo = t, b
    lines.append(cur)

    parts = []
    for ln in lines:
        ln.sort(key=lambda p: p[3])  # 行内按字形左边界升序
        buf = ""
        prev_r = None
        prev_w = None
        for _cx, _cy, ch, cl, cr, _cb, _ct in ln:
            if ch == " ":
                if buf and not buf.endswith(" "):
                    buf += " "
                if prev_r is not None:
                    prev_r = max(prev_r, cr)
                continue
            if prev_r is not None:
                gap = cl - prev_r
                if gap > max(CHAR_GAP_MIN, CHAR_GAP_RATIO * (prev_w or 0.0)):
                    buf += " "
            buf += ch
            prev_r = cr
            prev_w = cr - cl
        parts.append(buf.strip())
    return " ".join(p for p in parts if p).replace("|", "\\|").strip()


def rebuild_table_md(tp, table):
    """网格 → markdown 表格文本(首行=表头,次行 |---| 分隔)。

    全空表(区域内无任何字符)返回 ""(调用方丢弃,视为装饰线框)。
    """
    ys, xs = table["rows"], table["cols"]
    bands = [(ys[ri - 1], ys[ri]) for ri in range(len(ys) - 1, 0, -1)]
    grid = [[[] for _ in range(len(xs) - 1)] for _ in bands]

    for cx, cy, ch, cl, cr, cb, ct in _table_chars(tp, table["rect"]):
        ri = None
        for bi, (lo, hi) in enumerate(bands):
            if lo - BAND_TOL <= cy <= hi + BAND_TOL:
                ri = bi
                break
        if ri is None:
            continue
        ci = None
        for cj in range(len(xs) - 1):
            if xs[cj] - BAND_TOL <= cx <= xs[cj + 1] + BAND_TOL:
                ci = cj
                break
        if ci is None:
            continue
        grid[ri][ci].append((cx, cy, ch, cl, cr, cb, ct))

    rows_md = [[_join_chars(parts) for parts in row_cells] for row_cells in grid]
    if not any(any(c for c in row) for row in rows_md):
        return ""
    out = ["| " + " | ".join(rows_md[0]) + " |", "| " + " | ".join(["---"] * len(rows_md[0])) + " |"]
    for row in rows_md[1:]:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def rebuild_tables(page, tp):
    """检测+重建,返回 [(y_top, y_bottom, md_table)](y 降序);空串已剔除。"""
    tables = []
    for t in detect_tables(page, tp):
        md = rebuild_table_md(tp, t)
        if md:
            x0, y0, x1, y1 = t["rect"]
            tables.append((y1, y0, md))  # (top, bottom, md)
    tables.sort(key=lambda item: -item[0])
    return tables
