# -*- coding: utf-8 -*-
"""
dsh-md-convert — PyMuPDF4LLM 文字层提取桥(v0.6.14)

用法: python pymupdf4llm_extract.py <pdf> [--page-chunks 1]
输出(JSON, stdout): {"ok": true, "md": "...", "notes": {...}} / {"ok": false, "error": "..."}

定位: extract_text.py(自研结构增强链)的质量信号二次提取引擎——当直提产物
表格碎片化/逐字符碎裂(assessMdQuality score<70)时,用 pymupdf4llm 的成熟
段落合并/表格检测重提一次,两版对比取优。纯本地无 ML 模型,零 token。
"""
import io
import json
import math
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ─── v1.0.2 页眉/页脚剥离 ────────────────────────────────────────────────
# 为什么需要:pymupdf4llm 链路**没有**页眉页脚处理,实测 golden 18 类中有 4 类
# 把页眉混进正文(textlayer-multi-img 的 "Agent 进化"×8、pdf-crosspage-table 的
# "专业数据集"×3、char-layer 的 "鹏瑞利广场"×3、dl-pdf-4p 的 "이슈와 논점"×3),
# 另有页码行残留。自研链早有这套逻辑(extract_text.py 的 _detect_headers_footers),
# 但它是**基于 pdfium 坐标**的,而这里只有 md 文本 —— 故本模块用 pymupdf 坐标
# 独立复算一次,判据与自研链**同源**(同一 MARGIN_RATIO / REPEAT_RATIO / 正则),
# 保证"自研链会剥的,这里也会剥"。
#
# 有意重复常量而不从 extract_text.py import:后者的注释已说明本脚本的定位是
# "只装 pymupdf4llm 也能用"的可选引擎,模块级 import pypdfium2 会破坏这个前提。
MARGIN_RATIO = 0.12  # 页眉/页脚边距带占页高比例
REPEAT_RATIO = 0.6  # 同带内跨页重复阈值:max(2, ceil(0.6 × 有效页数))
ZONE_LINE_PAT = re.compile(
    r"^(?:版权所有©?.*|\d+(?:\s*/\s*\d+)?|第\s*\d+\s*页(?:.*共\s*\d+\s*页)?|Powered by .+)$"
)


def _norm(text):
    """归一化用于跨页重复比较(去全部空白差异)——与自研链同一实现。"""
    return re.sub(r"\s+", "", text or "")


def _zone_texts(doc, page_idx):
    """取某页的 (边距带文本集合, 正文区文本集合),均为归一化文本。

    pymupdf 坐标**原点左上、y 向下**(与 pdfium 相反),故:
      顶部带 = y0 <= h*MARGIN_RATIO;底部带 = y1 >= h*(1-MARGIN_RATIO)
    """
    page = doc[page_idx]
    h = float(page.rect.height)
    zone, body = set(), set()
    try:
        d = page.get_text("dict")
    except Exception:
        return zone, body
    for blk in d.get("blocks", []):
        if blk.get("type") != 0:  # 0=文本块,1=图像块
            continue
        for ln in blk.get("lines", []):
            bbox = ln.get("bbox")
            if not bbox:
                continue
            txt = "".join(sp.get("text", "") for sp in ln.get("spans", [])).strip()
            if not txt:
                continue
            key = _norm(txt)
            y0, y1 = float(bbox[1]), float(bbox[3])
            if y0 <= h * MARGIN_RATIO or y1 >= h * (1.0 - MARGIN_RATIO):
                zone.add(key)
            else:
                body.add(key)
    return zone, body


def _detect_hf(doc, page_idxs):
    """跨页页眉/页脚判定 → {页号: 该页待剥离的归一化文本集合}。

    判据(与自研链一致):
      ① 边距带内**跨页重复** ≥ max(2, ceil(0.6N));或
      ② 边距带内命中页码/版权正则(出现 ≥1 次即剥)。
    保守条件:只在该页边距带有该文本、**且该页正文区无同名行**时才剥该页 ——
    绝不误杀正文(自研链在坐标层直接删行,这里只能在文本层按行匹配,必须更保守)。

    ⚠️ **v1.1 起改为逐页判定**(此前是全局判定,过度保守):
    全局版的条件是"该文本在**任意页**的正文区出现过就全不剥"。实测火山方舟 16 页文档:
    「专业数据集」在边距带 **29 次**、正文区仅 **2 次**(p1 封面标题、p3 目录项),
    于是 **29 处真页眉因 2 处正文同名而被全部放过** —— 这就是"一处风险否决全部收益"。
    改为**逐页**:某页边距带有该文本**且该页正文区没有** → 只剥该页。
    效果:p1 本就无页眉不剥、p3 因正文同名跳过(保留 1 处噪音)、其余 **28 处照剥**。
    仍然保守(绝不误杀),只是不再让个别页的正文牵连其它页的页眉。
    """
    zones = {}
    for i in page_idxs:
        zones[i] = _zone_texts(doc, i)
    return detect_hf_from_zones(zones)


def detect_hf_from_zones(zones):
    """**纯函数**(可单测):{页号: (边距带集合, 正文区集合)} → {页号: 待剥集合}。

    拆出来的原因:原实现与 `doc` 对象耦合,无法单测 —— 而这段逻辑本轮**改了 3 次**
    (全局判据→发现 29 处页眉没剥→改逐页),只靠 golden 的 chars 断言间接兜底。
    纯函数让"阈值/正则/逐页收口/正文保护"四条判据都能被直接断言。
    """
    from collections import Counter

    usable = [(i, z, b) for i, (z, b) in zones.items() if z]
    if not usable:
        return {}
    n_pages = len(usable)
    # ① 跨页重复:≥ max(2, ceil(0.6N))
    threshold = max(2, int(math.ceil(n_pages * REPEAT_RATIO)))

    freq = Counter()
    for _i, z, _b in usable:
        for k in z:
            freq[k] += 1
    candidates = {k for k, c in freq.items() if c >= threshold}
    # ② 正则候选(边距带内命中即剥):页码/版权/第N页/Powered by
    for _i, z, _b in usable:
        for k in z:
            if ZONE_LINE_PAT.match(k):
                candidates.add(k)

    # ③ 逐页收口:该页边距带有、**该页正文区没有** → 只剥该页(绝不误杀正文)
    per_page = {}
    for i, z, b in usable:
        s = {k for k in candidates if k in z and k not in b}
        if s:
            per_page[i] = s
    return per_page


def _strip_hf_from_md(page_text, strip_set):
    """从**单页** md 里删掉归一化后完全等于页眉/页脚的行。返回 (新文本, 剥离数)。"""
    if not strip_set:
        return page_text, 0
    kept, removed = [], 0
    for ln in page_text.split("\n"):
        s = ln.strip()
        if s and _norm(s) in strip_set:
            removed += 1
            continue
        kept.append(ln)
    return "\n".join(kept), removed


def _expand_pages(spec, total):
    """页范围 → 1 起页号集合(None=全部);越界抛 ValueError。

    与 lib/core/pagerange.js / extract_text.py 同一语法(`1-20,25`)。
    此处**有意重复**这 20 行而不是 import extract_text:后者在模块级 import pypdfium2,
    而本脚本的定位是"只装 pymupdf4llm 也能用"的可选引擎。
    """
    raw = str(spec or "").strip()
    if not raw:
        return None
    sel = set()
    for seg in raw.split(","):
        s = seg.strip()
        if not s:
            continue
        m = re.match(r"^(\d+)\s*-\s*(\d+)$", s)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a < 1 or b < 1 or a > b:
                raise ValueError("页范围片段非法:%s(应形如 3-5)" % s)
            sel.update(range(a, b + 1))
            continue
        if s.isdigit():
            if int(s) < 1:
                raise ValueError("页码必须从 1 开始:%s" % s)
            sel.add(int(s))
            continue
        raise ValueError("无法识别的页范围片段:%s(示例 1-20,25)" % s)
    if not sel:
        raise ValueError("页范围为空:%s" % raw)
    bad = sorted(n for n in sel if n > total)
    if bad:
        raise ValueError("请求的页码超出文档页数(共 %d 页):%s" % (total, "、".join(str(b) for b in bad[:8])))
    return sel


def main():
    real_stdout = sys.stdout
    # pymupdf4llm 会往 stdout 打进度信息,污染 JSON 协议——转换期重定向到 stderr
    sys.stdout = sys.stderr
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 pdf 参数"}))
        return 1
    pdf = sys.argv[1]
    pages_spec = ""
    if "--pages" in sys.argv:
        _i = sys.argv.index("--pages")
        if _i + 1 < len(sys.argv):
            pages_spec = sys.argv[_i + 1]
    try:
        import pymupdf4llm
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"pymupdf4llm 未安装: {str(e)[:200]}"}))
        return 1
    try:
        import pymupdf

        doc = pymupdf.open(pdf)
        total = len(doc)
        # v0.7.3 W4-4: 页范围 —— pymupdf4llm 的 pages 是 **0 起** 页号列表
        try:
            sel = _expand_pages(pages_spec, total)
        except ValueError as e:
            sys.stdout = real_stdout
            doc.close()
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
            return 1
        pages_arg = None if sel is None else sorted(n - 1 for n in sel)
        # v1.0.2: 页眉/页脚检测必须在 **doc.close() 之前**(需要坐标)
        # MDC_NO_HF_STRIP=1 可关闭剥离(逃生开关 + A/B 对照验证用)
        page_idxs = pages_arg if pages_arg is not None else list(range(total))
        hf_strip = {} if os.environ.get("MDC_NO_HF_STRIP") else _detect_hf(doc, page_idxs)
        doc.close()
        # page_chunks=True: 逐页 chunk → 自行包 <!--PAGE:NN--> 锚点(与自研链协议一致)
        chunks = pymupdf4llm.to_markdown(pdf, page_chunks=True, pages=pages_arg)
        # 锚点必须用**原始页号**:子集提取时 enumerate 会把第 5 页错编成 01
        nos = pages_arg if pages_arg is not None else list(range(total))
        if pages_arg is not None and len(chunks) != len(nos):
            sys.stdout = real_stdout
            print(json.dumps({"ok": False, "error": "页范围提取的返回块数与请求页数不一致(%d vs %d),已拒绝以免锚点错位"
                                               % (len(nos), len(chunks))}, ensure_ascii=False))
            return 1
        parts = []
        hf_removed = 0
        hf_patterns_seen = set()
        for idx, c in enumerate(chunks):
            real = (nos[idx] + 1) if idx < len(nos) else (idx + 1)
            text = (c.get("text") or "").strip()
            # v1.0.2: 逐页剥离页眉/页脚(必须在包锚点**之前**,只动本页内容)
            # 逐页取对应页的待剥集合(检测已按页收口)
            page_no = nos[idx] if idx < len(nos) else idx
            this_strip = hf_strip.get(page_no, set())
            hf_patterns_seen |= this_strip
            text, rm = _strip_hf_from_md(text, this_strip)
            hf_removed += rm
            parts.append(f"<!--PAGE:{real:02d}-->\n\n{text}\n\n<!--/PAGE:{real:02d}-->")
        md = "\n\n".join(parts)
        if not md.strip():
            print(json.dumps({"ok": False, "error": "文字层为空"}))
            return 1
        notes = {
            "engine": "pymupdf4llm",
            "pages": len(chunks),
            "total_pages": total,
            "chars": len(md),
            "hf_stripped": hf_removed,
            "hf_pages": len(hf_strip),
            "hf_patterns": sorted(hf_patterns_seen)[:12],
        }
        sys.stdout = real_stdout
        print(json.dumps({"ok": True, "md": md, "notes": notes}, ensure_ascii=False))
        return 0
    except Exception as e:
        sys.stdout = real_stdout
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
