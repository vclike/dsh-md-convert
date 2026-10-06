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
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def main():
    real_stdout = sys.stdout
    # pymupdf4llm 会往 stdout 打进度信息,污染 JSON 协议——转换期重定向到 stderr
    sys.stdout = sys.stderr
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少 pdf 参数"}))
        return 1
    pdf = sys.argv[1]
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
        # page_chunks=True: 逐页 chunk → 自行包 <!--PAGE:NN--> 锚点(与自研链协议一致)
        chunks = pymupdf4llm.to_markdown(pdf, page_chunks=True)
        parts = []
        for i, c in enumerate(chunks, 1):
            text = (c.get("text") or "").strip()
            parts.append(f"<!--PAGE:{i:02d}-->\n\n{text}\n\n<!--/PAGE:{i:02d}-->")
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
