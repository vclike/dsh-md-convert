# -*- coding: utf-8 -*-
"""
dsh-md-convert — PDF 文字层直提兜底(pypdfium2,v0.6.4 结构增强)

用途: markitdown-node 在宿主运行时(Electron 内置 Node)内对部分文字层 PDF
失败/返回空时的秒级兜底——纯文字提取 + 五个确定性结构增强(零 OCR 零新增依赖):

  1. 链接提取(P0-2): raw FPDFLink_Enumerate/FPDFAction_GetURIPath 提取 URI 链接,
     URL 尾段文件名回查正文内联为 [文件名](url);其余降级为页尾脚注,不丢 URL。
  2. 页眉页脚剥离(P0-3): 边距带(y 比例) + 跨页重复(≥60% 且 ≥2 页) + 页脚正则。
  3. 孤儿符号回挂(P0-4): 与正文断行的列表符(•)回挂到下一条内容行;
     连续符号行(页边距栏布局幽灵)识别并丢弃。
  4. 标题层级重建(v0.6.4): 行框高度聚类出正文字号,≥1.30× 为标题候选,
     相邻标题行(跨中西文字号差被拆行)合并,≥1.55× → ## 其余 → ###。
  5. 逐页图像占比(v0.6.4): raw 页面对象枚举统计 FPDF_PAGEOBJ_IMAGE 面积占比,
     供上游 visionHints(页级局部 vision 路由)决策——零渲染成本。

行为开关(默认全开,供 A/B 与安全回退):
  --no-links / --no-headers / --no-headings / --margin <ratio>
保底路径: 行框/链接任一 API 异常时逐级降级到旧版 get_text_bounded 全文直提,绝不失败。

stdout 协议(单个 JSON,UTF-8):
  {"total": 9, "pages": [{"no": 1, "text": "...", "img_ratio": 0.12}, ...], "notes": {...}}
  打不开 PDF: {"ok": false, "error": "..."} 并退出码 1
"""
import argparse
import ctypes
import json
import re
import sys
from collections import Counter

import pypdfium2 as pdfium

try:
    import table_rebuild  # 同目录线框表格重建模块(v0.6.6)
except Exception:
    table_rebuild = None

try:
    import table_extract  # 同目录 PyMuPDF find_tables 提取(v0.7.2 W2-4)
except Exception:
    table_extract = None

try:
    import pypdfium2.raw as pdfium_c
except Exception:  # pragma: no cover - raw 模块缺失时链接/图像占比/表格降级
    pdfium_c = None

# 页眉/页脚边距带(占页高比例;pdfium 原点左下,y 向上)
MARGIN_RATIO = 0.12
# 同带内重复行判定的页数阈值:max(2, ceil(0.6 * 有效页数))
REPEAT_RATIO = 0.6
# 页眉/页脚区正则(仅边距带内生效,避免误杀正文)
ZONE_LINE_PAT = re.compile(
    r"^(?:版权所有©?.*|\d+(?:\s*/\s*\d+)?|第\s*\d+\s*页(?:.*共\s*\d+\s*页)?|Powered by .+)$"
)
# 孤儿列表符(仅符号、无正文)
BULLET_ONLY_PAT = re.compile(r"^[•·◦‣▪○●□■◆◇*+\-–—]+$")
# 孤儿序号(阿拉伯/括号序号,后随断行)
NUM_ONLY_PAT = re.compile(r"^(\d{1,2}[.、]|\(\d{1,2}\)[.、]?|\[\d{1,2}\][.、]?)$")
# 标题判定阈值(相对正文字号行高;真机校准:正文≈9.5,节标题≈1.45×,章标题≈2.48×)
HEADING_MIN_RATIO = 1.25
HEADING_H2_RATIO = 1.40
HEADING_MAX_LEN = 50
URI_ACTION_TYPE = 3  # pdfium action type: URI
# pdfium 页面对象类型:IMAGE 用 raw 常量(实证 =3;勿硬编码,TEXT=1/PATH=2/FORM=4)
PAGEOBJ_IMAGE = getattr(pdfium_c, "FPDF_PAGEOBJ_IMAGE", 3) if pdfium_c else 3

# 逐字符文字层重建的采纳基线比(v0.7.2 W1-1)
#   旧基线 = _page_lines 的逐 rect get_text_bounded 之和;逐字符页的 per-char rect 相互重叠,
#   同一字符会被多个 rect 重复取到 → 基线虚高约 10%,把正确的行重建判为"内容变少"而拒绝。
#   新基线 = 页面真实非空白字符数(逐字符遍历,不重复计数)。
#   真机校准(鹏瑞利 brief 11 页 / 2026-10-08,逐页探针):采纳页的 rebuilt/true 实测
#   1.042~1.112(全部 >1,最小值出现在 p1/p11 的 25/24);取 0.90 留 ~13% 余量,
#   真正劣化的重建(丢内容)会远低于此阈值。c2 34 页均不触发(avgbox 3.1~7.5),无误判。
CHAR_REBUILD_MIN_RATIO = 0.90
# 与 _char_rebuild_lines 同一字符数上限(保证比值口径一致)
CHAR_REBUILD_MAX_CHARS = 50000

# 同一 y 带内按字高拆分"桥接高字"的判据(v0.7.2 W1-6)
#   逐字符页的 y 聚类条件是"垂直重叠即同行",高大的装饰英文标题会与中文标题
#   被传递桥接成一行,再按 x 排序就逐字交错(实测 p2 'REIM招AGI标NING概POS述SIB：ILITIES')。
#   拆点取"唯一字高降序相邻比值的最大间隙",并要求高字一侧是少数 —— 只有这种
#   "少数高字桥接多数小字"的形态才是缺陷;正文行尾的小字号标点(实测 h=1.5 混 11.9)
#   因高字一侧是多数而不拆。
CHAR_ROW_SPLIT_RATIO = 1.5
CHAR_ROW_SPLIT_MAX_MINORITY = 0.4

# 逐字符定位文字层的第二判据(v0.7.2 W1-4): 真实字符数 / 行框数 <= 此值 = 每框≈1 字。
#   原判据只看 _page_avg_chars_per_box(lines) < 1.5, 而该值会被 rect 重叠放大 ——
#   实测 c1 p4 为 68 框/68 真实字符(=1.00 字/框, 确属逐字符定位)却因 avgbox=2.324 漏触发,
#   p9 同理(33/33=1.00, avgbox=3.364), 两页输出均长仅 2.3/3.4 字符。
#   真机校准(2026-10-08): c1 逐字符页为 1.00~1.04;c2 正常页为 3.13~5.81(最小 p32=3.13)
#   → 取 1.2, 距正常页有 2.6 倍余量。
CHAR_POSITION_MAX_CHARS_PER_RECT = 1.2


def _utf8_stdio():
    """Windows 管道默认 GBK,JSON 输出强制 UTF-8。"""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _norm(text):
    """归一化用于跨页重复比较(去全部空白差异)。"""
    return re.sub(r"\s+", "", text or "")


def _page_lines(tp):
    """行框提取: [(y_bottom, y_top, text)] 按字符序(阅读序);异常返回 None。"""
    try:
        n = tp.count_rects()
        lines = []
        for i in range(n):
            l, b, r, t = tp.get_rect(i)
            txt = (tp.get_text_bounded(left=l, bottom=b, right=r, top=t) or "").strip()
            if txt:
                lines.append((float(b), float(t), txt))
        return lines or None
    except Exception:
        return None


def _split_row_by_size(row):
    """把"少数高字桥接"的 y 带按字高拆成多个子行(v0.7.2 W1-6)。

    返回子行列表(高字在前);无桥接形态时原样返回 [row]。
    判据见 CHAR_ROW_SPLIT_RATIO / CHAR_ROW_SPLIT_MAX_MINORITY 注释。
    """
    if len(row) < 3:
        return [row]
    height_of = lambda c: round(c[6] - c[5], 1)  # noqa: E731
    heights = sorted({height_of(c) for c in row if c[6] > c[5]}, reverse=True)
    if len(heights) < 2:
        return [row]
    best_i, best_gap = -1, 0.0
    for i in range(len(heights) - 1):
        if heights[i + 1] <= 0:
            continue
        gap = heights[i] / heights[i + 1]
        if gap > best_gap:
            best_gap, best_i = gap, i
    if best_i < 0 or best_gap < CHAR_ROW_SPLIT_RATIO:
        return [row]
    cut = heights[best_i]
    tall = [c for c in row if height_of(c) >= cut]
    rest = [c for c in row if height_of(c) < cut]
    if not tall or not rest or len(tall) > CHAR_ROW_SPLIT_MAX_MINORITY * len(row):
        return [row]
    return [tall] + _split_row_by_size(rest)


def _char_rebuild_lines(tp):
    """逐字符文字层兜底(v0.6.13): 字符坐标重建阅读行;异常/无字符返回 None。

    背景(2026-10-06 五粮液采购文件实证): 部分 Word 导出 PDF 启用字符级定位,
    每字符一个独立行框(全册 1.1 字符/框,视觉渲染正常但直提逐字断裂不可读)。
    纯几何重建零 token,优于 vision 路由。竖排单列文字重建后恰为正确阅读序
    (每字符独立 y,从上到下);多列竖排不支持(诚实边界)。
    """
    try:
        n = tp.count_chars()
        text = tp.get_text_range(0, n)
    except Exception:
        return None
    chars = []
    for i in range(min(n, CHAR_REBUILD_MAX_CHARS)):
        ch = text[i] if i < len(text) else ""
        if not ch or ch.isspace():
            continue
        try:
            l, b, r, t = tp.get_charbox(i)
        except Exception:
            continue
        chars.append(((l + r) / 2.0, (b + t) / 2.0, ch, l, r, b, t))
    if not chars:
        return None
    # y 聚类成行(字形垂直重叠 = 同行;下划线等低基线字符不拆行)
    chars.sort(key=lambda c: (-c[6], c[3]))
    rows = []
    cur = [chars[0]]
    cur_hi, cur_lo = chars[0][6], chars[0][5]
    for c in chars[1:]:
        b, t = c[5], c[6]
        if b <= cur_hi + 1.0 and t >= cur_lo - 1.0:
            cur.append(c)
            cur_hi, cur_lo = max(cur_hi, t), min(cur_lo, b)
        else:
            rows.append(cur)
            cur = [c]
            cur_hi, cur_lo = t, b
    rows.append(cur)
    # 行内拼接(x 升序;间隙 > max(2.5pt, 0.45×前字宽) 还原词界)
    # v0.7.2 W1-6: 先按字高拆掉"少数高字桥接"(装饰英文标题与中文标题重叠于同一 y 带),
    # 否则两种文本流会被 x 排序逐字交错。
    out = []
    sized_rows = []
    for row in rows:
        sized_rows.extend(_split_row_by_size(row))
    for row in sized_rows:
        row.sort(key=lambda c: c[3])
        buf = ""
        prev_r = None
        prev_w = None
        for _cx, _cy, ch, cl, cr, _cb, _ct in row:
            if prev_r is not None and cl - prev_r > max(2.5, 0.45 * (prev_w or 0.0)):
                buf += " "
            buf += ch
            prev_r = cr
            prev_w = cr - cl
        txt = buf.strip()
        if txt:
            out.append((min(c[5] for c in row), max(c[6] for c in row), txt))
    return out or None


def _page_avg_chars_per_box(lines):
    """行框平均字符数(<1.5 = 字符级定位文字层的判据)。"""
    if not lines:
        return 99.0
    return sum(len(t) for _b, _t, t in lines) / len(lines)


def _page_true_chars(tp):
    """页面真实非空白字符数(v0.7.2 W1-1 的采纳基线)。

    与 _char_rebuild_lines 同口径:同一字符数上限、跳过空白。
    逐字符遍历 count_chars/get_text_range,不受 per-char rect 重叠导致的重复取值影响。
    异常返回 0(调用方按"无法判定"处理)。
    """
    try:
        n = min(tp.count_chars(), CHAR_REBUILD_MAX_CHARS)
        text = tp.get_text_range(0, n)
    except Exception:
        return 0
    return sum(1 for ch in text if ch and not ch.isspace())


def _page_img_ratio(page):
    """图像对象面积占**页面面积**比(raw 页面对象枚举,零渲染);异常返回 None。

    注: 多图层叠加的图像面积会重复计入(偏保守高估,对 visionHints 方向无害);
    分母取页面面积而非对象面积总和——文本对象框面积会稀释占比(v0.6.4 真机修正)。
    """
    if pdfium_c is None:
        return None
    try:
        img_area = 0.0
        w, h = page.get_size()
        page_area = float(w) * float(h)
        if page_area <= 0:
            return None
        count = pdfium_c.FPDFPage_CountObjects(page.raw)
        for i in range(min(count, 4096)):  # 单页对象数保险丝
            obj = pdfium_c.FPDFPage_GetObject(page.raw, i)
            if not obj:
                continue
            if pdfium_c.FPDFPageObj_GetType(obj) != PAGEOBJ_IMAGE:
                continue
            l, b, r, t = ctypes.c_float(), ctypes.c_float(), ctypes.c_float(), ctypes.c_float()
            if not pdfium_c.FPDFPageObj_GetBounds(obj, ctypes.byref(l), ctypes.byref(b), ctypes.byref(r), ctypes.byref(t)):
                continue
            img_area += max(0.0, (r.value - l.value)) * max(0.0, (t.value - b.value))
        return round(min(1.0, img_area / page_area), 3)
    except Exception:
        return None


def _page_links(doc_raw, page_raw):
    """URI 链接提取: [(anchor_text, url)];raw API 异常返回 None(调用方降级)。

    v0.6.3 决策: FPDFLink_CountRects/GetRect 在 pypdfium2 raw 绑定下对部分链接
    注解触发 access violation(真机实证),逐链接矩形锚文本路放弃;
    anchor 恒为空串,由 _apply_links 用「URL 尾段文件名回查正文」启发式内联。
    """
    if pdfium_c is None:
        return None
    out = []
    try:
        link_holder_t = pdfium_c.FPDFLink_Enumerate.argtypes[2]._type_
        link_holder = link_holder_t()
        start = ctypes.c_int(0)
        for _ in range(128):  # 单页链接数保险丝
            if not pdfium_c.FPDFLink_Enumerate(page_raw, ctypes.byref(start), ctypes.byref(link_holder)):
                break
            action = pdfium_c.FPDFLink_GetAction(link_holder)
            if not action:
                continue
            if pdfium_c.FPDFAction_GetType(action) != URI_ACTION_TYPE:
                continue
            need = pdfium_c.FPDFAction_GetURIPath(doc_raw, action, None, 0)
            if need <= 0:
                continue
            buf = ctypes.create_string_buffer(need)
            pdfium_c.FPDFAction_GetURIPath(doc_raw, action, buf, need)
            url = buf.raw.decode("utf-8", errors="replace").rstrip("\x00")
            if not url:
                continue
            # 协议白名单:仅保留真实外链;过滤 PDF 内部跳转锚点(如 "af://n29",
            # 实测极至地点推荐.pdf 单页 9 条引用角标链接全为此类纯噪音)
            if not url.lower().startswith(("http://", "https://", "mailto:")):
                continue
            out.append(("", url))
        return out
    except Exception:
        return None


def _detect_headers_footers(pages_meta, margin):
    """跨页页眉/页脚判定: 边距带内 跨页重复(≥max(2,60%页数)) 或 命中页码/版权正则。

    pages_meta: [{"no", "lines", "page_h"}];返回 set[归一化文本]。
    """
    strip = set()
    usable = [m for m in pages_meta if m["lines"] and m["page_h"] > 0]
    if not usable:
        return strip
    n_pages = len(usable)
    threshold = max(2, -(-n_pages * REPEAT_RATIO // 1))  # ceil(0.6N) 且 ≥2
    by_zone = {"top": Counter(), "bottom": Counter()}
    for m in usable:
        h = m["page_h"]
        for b, t, txt in m["lines"]:
            if t >= h * (1 - margin):
                by_zone["top"][_norm(txt)] += 1
            elif b <= h * margin:
                by_zone["bottom"][_norm(txt)] += 1
    for zone in by_zone:
        for key, cnt in by_zone[zone].items():
            if cnt >= threshold:
                strip.add(key)
    # 正则候选(边距带内出现≥1 次即剥:版权行/页码/第N页)
    for m in usable:
        h = m["page_h"]
        for b, t, txt in m["lines"]:
            if (t >= h * (1 - margin) or b <= h * margin) and ZONE_LINE_PAT.match(txt):
                strip.add(_norm(txt))
    return strip


def _merge_orphans(lines):
    """孤儿符号回挂: 与正文断行的列表符/序号回挂为 "- 正文" / "N. 正文"。

    连续符号行(布局幽灵,如页边距栏步骤号)互不回挂,直接丢弃——
    真实序号列表的序号与正文在同一文本对象内,不产生孤儿行。
    行元组 (b, t, txt) 贯穿:合并行沿用内容行的坐标。
    返回 (新行列表, 回挂数, 丢弃幽灵数)。
    """
    def is_marker(t):
        return bool(BULLET_ONLY_PAT.match(t) or NUM_ONLY_PAT.match(t))

    out = []
    merged = dropped = 0
    i = 0
    while i < len(lines):
        b, t, txt = lines[i]
        if is_marker(txt):
            if i + 1 < len(lines) and not is_marker(lines[i + 1][2]):
                nb, nt, ntxt = lines[i + 1]
                if BULLET_ONLY_PAT.match(txt):
                    out.append((nb, nt, "- " + ntxt))
                else:
                    marker = NUM_ONLY_PAT.match(txt).group(1)
                    marker = marker if marker.endswith((".", "、")) else marker + "."
                    out.append((nb, nt, marker + " " + ntxt))
                merged += 1
                i += 2
                continue
            dropped += 1  # 连续符号行(布局幽灵)或页尾孤儿 → 丢弃
            i += 1
            continue
        out.append(lines[i])
        i += 1
    return out, merged, dropped


def _apply_headings(lines, body_h):
    """标题层级重建(v0.6.4): 行高聚类 → ## / ###;紧邻续行合并。

    真机校准(火山方舟 PDF):正文 h≈9.5,节标题(能力介绍/常见问题)≈13.9-14.0
    (≈1.45×),章标题 ≈23.6(≈2.48×);中文标题与其西文 run 常被拆为两行且
    包围盒强重叠(gap≈-11~-14),故候选行后允许**紧邻续行**并入:
    gap ≤ 0.5×body_h 且行高 ≥0.9×body_h 且短行非句读结尾。
    ≥1.40×body_h → "## ",其余候选 → "### "(# 留给文档标题)。
    返回 (新行列表, 标题数)。
    """
    if body_h <= 0 or not lines:
        return lines, 0

    def is_candidate(txt, h):
        if h < body_h * HEADING_MIN_RATIO or len(txt) > HEADING_MAX_LEN:
            return False
        if len(txt) < 2 or re.search(r"[。；,;:]$", txt):
            return False
        return True

    def is_continuation(txt, h, gap):
        # 紧邻续行:与前一标题行包围盒重叠/极近(中文主标题+西文 run 拆行形态)
        if gap > body_h * 0.5 or h < body_h * 0.9 or len(txt) > HEADING_MAX_LEN:
            return False
        return not re.search(r"[。；,;:]$", txt)

    def level_of(h):
        return 2 if h >= body_h * HEADING_H2_RATIO else 3

    merged = []
    i = 0
    n = 0
    while i < len(lines):
        b, t, txt = lines[i]
        if not is_candidate(txt, t - b):
            merged.append(lines[i])
            i += 1
            continue
        # 收集候选行 + 紧邻续行(gap = 前行 y_bottom - 后行 y_top,重叠为负)
        group = [(b, t, txt)]
        best = t - b  # 组内最大候选行高,定级用
        j = i + 1
        while j < len(lines):
            pb, pt, ptxt = lines[j]
            gap = group[-1][0] - pt
            if is_candidate(ptxt, pt - pb):
                if gap > body_h * 2.2:
                    break
                group.append((pb, pt, ptxt))
                best = max(best, pt - pb)
            elif is_continuation(ptxt, pt - pb, gap):
                group.append((pb, pt, ptxt))
            else:
                break
            j += 1
        text_joined = " ".join(g[2] for g in group)
        lv = level_of(best)
        merged.append((group[-1][0], group[0][1], "#" * lv + " " + text_joined))
        n += 1
        i = j
    return merged, n


def _apply_links(text, links):
    """链接内联/脚注降级。返回 (新文本, 内联数, 脚注列表)。

    内联启发式(按序尝试,命中即止):
      ① 矩形锚文本(上游给定且能在正文找到时);
      ② URL 尾段文件名回查正文——下载链接(evolve-setup-*.zip)的可见标签
         即文件名,内联为 [evolve-setup-claude_code.zip](url)。
    均未命中 → 页尾脚注(不丢 URL)。
    """
    inlined = 0
    footnotes = []
    seen = set()
    for anchor, url in links:
        if url in seen:
            continue
        seen.add(url)
        done = False
        for cand in (anchor, _url_tail(url)):
            if cand and 3 < len(cand) <= 120 and cand in text:
                text = text.replace(cand, f"[{cand}]({url})", 1)
                inlined += 1
                done = True
                break
        if not done:
            footnotes.append(url)
    if footnotes:
        text = text.rstrip() + "\n\n本页链接:\n" + "\n".join(f"- {u}" for u in footnotes)
    return text, inlined, footnotes


def _url_tail(url):
    """URL 尾段(去 query/fragment 后的文件名),无尾段返回空。"""
    tail = re.split(r"[?#]", url, 1)[0].rstrip("/")
    tail = tail.rsplit("/", 1)[-1]
    return tail if tail and "." in tail else ""


def _body_height(pages_meta):
    """正文字号行高估计: 全部行高的众数(0.5pt 粒度聚类);无数据返回 0。"""
    counter = Counter()
    for m in pages_meta:
        for b, t, _txt in m["lines"]:
            h = round(t - b, 1)
            if h > 0:
                counter[round(h * 2) / 2] += 1
    if not counter:
        return 0.0
    return counter.most_common(1)[0][0]


def main():
    _utf8_stdio()
    ap = argparse.ArgumentParser(description="PDF 文字层直提(pypdfium2,零 OCR,v0.6.4 结构增强)")
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("--no-links", action="store_true", help="关闭链接提取")
    ap.add_argument("--no-headers", action="store_true", help="关闭页眉页脚剥离")
    ap.add_argument("--no-headings", action="store_true", help="关闭标题层级重建")
    ap.add_argument("--no-tables", action="store_true", help="关闭线框表格重建")
    ap.add_argument("--legacy-tables", action="store_true",
                    help="只用自研几何法建表(v0.7.2 W2-4 前的行为;A/B 与回退用)")
    ap.add_argument("--margin", type=float, default=MARGIN_RATIO, help="边距带比例(默认 0.12)")
    args = ap.parse_args()
    try:
        pdf = pdfium.PdfDocument(args.pdf)
    except Exception as e:
        msg = str(e)[:200]
        # v0.7.2 W4-5: 加密 PDF 给专属错误码与明确文案 —— 否则上层会继续走扫描件路由,
        # 白跑探针+渲染后才报误导性的 E_OCR_RUN("PDF 打开失败")。
        # 判据: pdfium 对"用户密码"加密抛 Incorrect password error;
        # 仅 owner 密码(权限加密)的文件**能正常打开**,不会误判。
        if "password" in msg.lower() or "encrypt" in msg.lower():
            print(json.dumps({"ok": False, "code": "E_ENCRYPTED",
                              "error": "PDF 已加密,需要密码(本插件暂不支持加密 PDF): %s" % msg},
                             ensure_ascii=False))
            return 1
        print(json.dumps({"ok": False, "error": "PDF 打开失败: %s" % msg}, ensure_ascii=False))
        return 1

    notes = {
        "links_inlined": 0, "links_footnote": 0, "stripped_lines": 0,
        "orphan_merged": 0, "orphan_dropped": 0, "headings": 0, "body_height": 0.0,
        "tables_rebuilt": 0, "char_rebuilt_pages": 0,
        "char_rebuild_rejected_pages": 0,
        "strip_protected_pages": 0,
        "tables_pymupdf": 0, "tables_legacy": 0, "table_pages_legacy_pref": 0,
        "cross_page_table_pairs": 0,   # v0.7.2 W2-5 观测:疑似被分页切断的表对数
    }
    # v0.7.2 W2-4: PyMuPDF find_tables 文档句柄(整册开一次;失败则全程退回自研几何法)
    mupdf_doc = None
    if table_extract is not None and not args.no_tables:
        mupdf_doc = table_extract.open_doc(args.pdf)
    pages_meta = []
    raw_pages = []  # [(no, page, tp, lines)]
    for i in range(len(pdf)):
        page = pdf[i]
        try:
            tp = page.get_textpage()
        except Exception:
            tp = None
        lines = _page_lines(tp) if tp is not None else None
        # v0.6.13 逐字符文字层兜底: 平均 <1.5 字符/行框(字符级定位) → 坐标重建阅读行
        # v0.7.2 W1-4: 触发判据补第二支——"真实字符数/行框数 <= 1.2"(每框≈1字)。
        #   原判据的 avgbox 会被 rect 重叠放大, 漏掉 c1 p4/p9 这类同样逐字符定位的页。
        if lines and tp is not None and (
            _page_avg_chars_per_box(lines) < 1.5
            or _page_true_chars(tp) <= CHAR_POSITION_MAX_CHARS_PER_RECT * len(lines)
        ):
            rebuilt = _char_rebuild_lines(tp)
            # v0.7.2 W1-1: 采纳基线改用"页面真实非空白字符数",替代
            # sum(len(t) for _,_,t in lines)——后者对逐字符页会因 rect 重叠而虚高约 10%,
            # 把正确的行重建误判为"内容变少"(实证 p3: orig=685 > 页面真实 625)从而拒绝;
            # 被拒页回退到同样重叠的 rect 路径,产出逐字符/交错乱码(如 `E圣`/`RE招IMAG标ININ概G`)。
            if rebuilt:
                true_chars = _page_true_chars(tp)
                rebuilt_chars = sum(len(t) for _, _, t in rebuilt)
                if true_chars <= 0 or rebuilt_chars >= CHAR_REBUILD_MIN_RATIO * true_chars:
                    lines = rebuilt
                    notes["char_rebuilt_pages"] = notes.get("char_rebuilt_pages", 0) + 1
                else:
                    notes["char_rebuild_rejected_pages"] = notes.get("char_rebuild_rejected_pages", 0) + 1
        page_h = 0.0
        try:
            page_h = float(page.get_size()[1])
        except Exception:
            page_h = 0.0
        if lines is None:
            # 保底:行框 API 异常 → 旧版全文直提
            try:
                txt = tp.get_text_bounded() if tp is not None else ""
            except Exception:
                txt = ""
            lines = [(0.0, 0.0, ln.strip()) for ln in (txt or "").splitlines() if ln.strip()]
        raw_pages.append((i + 1, page, tp, lines))
        pages_meta.append({"no": i + 1, "lines": lines, "page_h": page_h})

    strip_set = set() if args.no_headers else _detect_headers_footers(pages_meta, args.margin)
    body_h = 0.0 if args.no_headings else _body_height(pages_meta)
    notes["body_height"] = body_h

    pages = []
    tables_by_page = []   # v0.7.2 W2-5 观测:逐页表格(统计跨页切断候选)
    page_heights = []
    for no, page, tp, lines in raw_pages:
        # v0.6.6 表格重建:线框网格 → md 表格;区域内文本行由表格块替代
        # v0.7.2 W2-4: 默认改用 PyMuPDF `find_tables()`(实测单元格干净、无跨列串接),
        #   假表由行/列下限过滤(c1 逐字符页会被误判出 11 个 1 行假表);
        #   但若它的表含超长单元格(SUSPECT_CELL_LEN,"正文塞进单元格")且自研几何法
        #   在本页也检出表,则改用自研产物 —— golden 样本实证: 这类页上被验收断言认可的
        #   形态来自自研几何法(按长度直接拒收会把承载断言的真表一起误杀)。
        tables = []
        if not args.no_tables and tp is not None:
            ft, ft_max = [], 0
            if mupdf_doc is not None:
                try:
                    ex = table_extract.extract_tables(mupdf_doc, no - 1, page)
                    ft, ft_max = ex["tables"], ex["max_cell_len"]
                except Exception:
                    ft, ft_max = [], 0
            rb = []
            if table_rebuild is not None:
                try:
                    rb = table_rebuild.rebuild_tables(page, tp)
                except Exception:
                    rb = []
            if args.legacy_tables or not ft:
                tables = rb
            elif rb and ft_max > table_extract.SUSPECT_CELL_LEN:
                tables = rb
                notes["table_pages_legacy_pref"] = notes.get("table_pages_legacy_pref", 0) + 1
            else:
                tables = ft
            if tables is ft and ft:
                notes["tables_pymupdf"] = notes.get("tables_pymupdf", 0) + len(ft)
            elif tables is rb and rb:
                notes["tables_legacy"] = notes.get("tables_legacy", 0) + len(rb)
        notes["tables_rebuilt"] = notes.get("tables_rebuilt", 0) + len(tables)
        kept = []
        strip_dropped_here = 0
        for b, t, txt in lines:
            cy = (b + t) / 2.0
            if tables and any(t_top >= cy >= t_bot for (t_top, t_bot, _md) in tables):
                continue  # 表格区域内文本,由 md 表格块替代
            if _norm(txt) in strip_set:
                strip_dropped_here += 1
                continue
            kept.append((b, t, txt))
        # v0.7.2 W1-7: 页眉页脚剥离不得清空整页。
        # 实证(鹏瑞利 brief / 2026-10-08): 装饰英文标题在每页重复出现,被判为重复页眉而剥离;
        # 封面页 p1 的**唯一**内容就是该标题 → 整页被剥空(内容静默丢失)。
        # 不变量: 剥离后若本页既无留存行也无表格块,则撤销本页剥离,并计数以便观测。
        if not kept and not tables and strip_dropped_here:
            kept = list(lines)
            notes["strip_protected_pages"] = notes.get("strip_protected_pages", 0) + 1
        else:
            notes["stripped_lines"] += strip_dropped_here
        kept, merged, dropped = _merge_orphans(kept)
        notes["orphan_merged"] += merged
        notes["orphan_dropped"] += dropped
        kept, headings = _apply_headings(kept, body_h)
        notes["headings"] += headings
        # 组装:普通行(自上而下)与表格块按 y 位置交错(表格顶 > 当前行顶 → 表格在上方,先插)
        segs = []
        ti = 0
        for _b, t, txt in kept:
            while ti < len(tables) and tables[ti][0] > t:
                segs.append(tables[ti][2])
                ti += 1
            segs.append(txt)
        while ti < len(tables):
            segs.append(tables[ti][2])
            ti += 1
        text = "\n\n".join(segs)
        if not args.no_links and tp is not None:
            links = _page_links(pdf.raw, page.raw)
            if links:
                text, inlined, foot = _apply_links(text, links)
                notes["links_inlined"] += inlined
                notes["links_footnote"] += len(foot)
        img_ratio = _page_img_ratio(page)
        tables_by_page.append(tables)
        try:
            page_heights.append(float(page.get_size()[1]))
        except Exception:
            page_heights.append(0.0)
        pages.append({"no": no, "text": text, "img_ratio": img_ratio})

    # v0.7.2 W2-5: 跨页切断表候选计数(只观测不合并;实测真实样本 0 处,见 table_extract 注释)
    if table_extract is not None:
        notes["cross_page_table_pairs"] = table_extract.count_cross_page_pairs(tables_by_page, page_heights)

    print(json.dumps({"total": len(pages), "pages": pages, "notes": notes}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
