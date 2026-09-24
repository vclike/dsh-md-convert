# -*- coding: utf-8 -*-
"""
dsh-md-convert — PDF → PNG 渲染导出(vision 路由复用, T3 任务书生成的渲染底座)

CLI:
  python render_pages.py <pdf> <outDir> [--scale 2]

行为:
  - 将 PDF 每页渲染为 PNG 写入 <outDir>/p-01.png ... p-NN.png
    (页码从 1 起,两位补零;超过 99 页自然扩展为三位,如 p-100.png)
  - 渲染口径与 lib/py/routing_ocr.py 一致: RGB、最长边限 MAX_SIDE=1600
  - stdout 输出**单行 JSON 清单**(消费端按行 JSON.parse):
      {"ok":true,"pages":97,"dir":"<abs outDir>","files":["<abs p-01.png>", ...]}
    失败时: {"ok":false,"error":"..."} 且退出码 1

协议纪律:
  - stdout 只输出协议 JSON(单行 + 立即 flush);一切诊断/进度走 stderr
  - stdout/stderr 强制 UTF-8(Windows 管道默认 GBK,中文路径与内容必须 reconfigure)

依赖: 仅 pypdfium2 + Pillow(不依赖 paddle,vision 链路零 OCR 依赖,可独立使用)
"""
import argparse
import json
import os
import sys
import time

import pypdfium2 as pdfium
from PIL import Image

# 与 lib/py/routing_ocr.py 同口径: PP-OCRv5/视觉模型在 ~72-144dpi 精度足够,
# 大图直接送入模型会拖慢推理一个量级。此处有意**本地复制**该常量与逻辑而非
# import routing_ocr, 使本脚本不依赖 paddle 系依赖即可独立运行(vision 路径
# 的机器可能未装 OCR 栈)。修改上限时须与 routing_ocr.py 的 MAX_SIDE 同步。
MAX_SIDE = 1600


def _cap_max_side(pil):
    w, h = pil.size
    longest = max(w, h)
    if longest <= MAX_SIDE:
        return pil
    ratio = MAX_SIDE / float(longest)
    return pil.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)


def _utf8_stdio():
    """Windows 管道默认编码跟随 ANSI 代码页(GBK),协议输出必须强制 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass  # 非 TextIOWrapper 场景(重定向到已配置编码的流)保持原样


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg):
    sys.stderr.write("[render-pages] %s\n" % msg)
    sys.stderr.flush()


def main():
    _utf8_stdio()
    ap = argparse.ArgumentParser(
        prog="render_pages.py",
        description="将 PDF 每页渲染为 p-NN.png 并输出 JSON 清单(vision 路由复用)")
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("out_dir", help="PNG 输出目录(不存在则创建)")
    ap.add_argument("--scale", type=float, default=2.0,
                    help="渲染倍率(1=72dpi,默认 2≈144dpi)")
    args = ap.parse_args()

    try:
        pdf = pdfium.PdfDocument(args.pdf)
    except Exception as e:
        _emit({"ok": False, "error": "PDF 打开失败: %s" % str(e)[:300]})
        return 1

    try:
        total = len(pdf)
    except Exception as e:
        _emit({"ok": False, "error": "读取页数失败: %s" % str(e)[:300]})
        return 1

    try:
        os.makedirs(args.out_dir, exist_ok=True)
    except Exception as e:
        _emit({"ok": False, "error": "创建输出目录失败: %s" % str(e)[:300]})
        return 1

    out_dir_abs = os.path.abspath(args.out_dir)
    files = []
    t0 = time.time()
    try:
        for i in range(total):
            img = _cap_max_side(pdf[i].render(scale=args.scale).to_pil().convert("RGB"))
            path = os.path.join(out_dir_abs, "p-%02d.png" % (i + 1))
            img.save(path, "PNG")
            files.append(path)
            if (i + 1) == 1 or (i + 1) % 20 == 0 or (i + 1) == total:
                _log("渲染 %d/%d 页 (%.1fs)" % (i + 1, total, time.time() - t0))
    except Exception as e:
        _emit({"ok": False,
               "error": "渲染失败(第 %d 页附近): %s" % (len(files) + 1, str(e)[:300])})
        return 1

    _log("完成: %d 页 → %s (%.1fs)" % (total, out_dir_abs, time.time() - t0))
    _emit({"ok": True, "pages": total, "dir": out_dir_abs, "files": files})
    return 0


if __name__ == "__main__":
    sys.exit(main())
