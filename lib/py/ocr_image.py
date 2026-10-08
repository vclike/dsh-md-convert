# -*- coding: utf-8 -*-
"""dsh-md-convert — 单张图片的本地 OCR(v0.7.2 W4-2)

为什么新增(2026-10-08 审计):
  图片此前只走 markitdown 的 ImageBackend → tesseract.js:
    - 语言硬编码 chi_sim+eng,无法配置;
    - **首次使用要从 jsdelivr CDN 下载 traineddata**,且默认写进**当前工作目录**(污染用户工作区);
    - 失败后没有任何离线回退(直接 E_MARKITDOWN)。
  而本插件扫描件链路早就在用 PaddleOCR/RapidOCR,且 **rapidocr 的 ONNX 模型随包内置**
  (`site-packages/rapidocr/models/*.onnx`)→ 完全离线、零 CDN、零 CWD 写入,中文质量通常更好。
  图片本质上就是"一页扫描件",与扫描件链路用同一引擎更一致。

用法: python ocr_image.py <图片路径>
输出(单行 JSON, stdout):
  {"ok": true, "engine": "rapidocr", "lines": ["..."], "md": "..."}
  {"ok": false, "error": "..."}(模块缺失等;调用方回退 markitdown)
"""
import json
import sys


def _utf8_stdio():
    """Windows 管道默认 GBK,JSON 输出强制 UTF-8。

    必须显式 reconfigure:否则本脚本在**未设 PYTHONIOENCODING 的环境**(如插件宿主
    直接 spawn Node 子进程)里会以 GBK 写出中文,Node 按 UTF-8 解码即得乱码。
    与本插件其余 python 入口(extract_text / parallel_ocr / render_pages)一致。
    """
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _line_texts(res):
    """把 RapidOCR 结果整理成按阅读顺序(上→下,左→右)的文本行。"""
    txts = getattr(res, "txts", None)
    boxes = getattr(res, "boxes", None)
    if txts is None:
        txts = []
    if boxes is None:
        boxes = []
    items = []
    for i, t in enumerate(txts):
        s = str(t).strip() if t is not None else ""
        if not s:
            continue
        y = x = 0.0
        if i < len(boxes):
            pts = boxes[i]
            try:
                ys = [float(p[1]) for p in pts]
                xs = [float(p[0]) for p in pts]
                y, x = sum(ys) / len(ys), sum(xs) / len(xs)
            except Exception:
                y = x = float(i)  # 拿不到坐标就保持原序
        else:
            y = float(i)
        items.append((y, x, s))
    items.sort(key=lambda it: (round(it[0] / 8.0), it[1]))  # 8px 行聚类容差,抗轻微基线抖动
    return [s for _y, _x, s in items]


def main():
    _utf8_stdio()
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: ocr_image.py <图片路径>"}, ensure_ascii=False))
        return 2
    path = sys.argv[1]
    try:
        import numpy as np
        from PIL import Image
        from rapidocr import RapidOCR
    except Exception as e:
        print(json.dumps({"ok": False, "error": "OCR 依赖不可用: %s" % str(e)[:200]}, ensure_ascii=False))
        return 1
    try:
        img = Image.open(path).convert("RGB")
    except Exception as e:
        print(json.dumps({"ok": False, "error": "图片打开失败: %s" % str(e)[:200]}, ensure_ascii=False))
        return 1
    try:
        engine = RapidOCR()
        res = engine(np.array(img))
    except Exception as e:
        print(json.dumps({"ok": False, "error": "OCR 执行失败: %s" % str(e)[:200]}, ensure_ascii=False))
        return 1
    lines = _line_texts(res)
    print(json.dumps({"ok": True, "engine": "rapidocr", "lines": lines, "md": "\n".join(lines)},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
