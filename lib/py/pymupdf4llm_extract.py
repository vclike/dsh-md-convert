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
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


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
        doc.close()
        # v0.7.3 W4-4: 页范围 —— pymupdf4llm 的 pages 是 **0 起** 页号列表
        try:
            sel = _expand_pages(pages_spec, total)
        except ValueError as e:
            sys.stdout = real_stdout
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
            return 1
        pages_arg = None if sel is None else sorted(n - 1 for n in sel)
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
        for idx, c in enumerate(chunks):
            real = (nos[idx] + 1) if idx < len(nos) else (idx + 1)
            text = (c.get("text") or "").strip()
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
