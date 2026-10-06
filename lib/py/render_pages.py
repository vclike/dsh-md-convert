# -*- coding: utf-8 -*-
"""
dsh-md-convert — PDF → PNG 渲染导出(vision 路由复用, T3 任务书生成的渲染底座)

CLI:
  python render_pages.py <pdf> <outDir> [--scale 2] [--pages 5,7-9]

行为:
  - 将 PDF 指定页(缺省全部页)渲染为 PNG 写入 <outDir>/p-01.png ... p-NN.png
    (页码从 1 起,两位补零;超过 99 页自然扩展为三位,如 p-100.png)
  - 渲染口径与 lib/py/routing_ocr.py 一致: RGB、最长边限 MAX_SIDE=1600
  - stdout 输出**单行 JSON 清单**(消费端按行 JSON.parse):
      {"ok":true,"pages":2,"pageList":[5,7],"dir":"<abs outDir>","files":["<abs p-05.png>","<abs p-07.png>"]}
    files 与 pageList 按序一一对应;缺省全页时 pageList=[1..N](v0.6.4 起始终携带)
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


def _parse_pages(spec):
    """解析 "5,7-9" 形态的页选择为升序去重列表;无效输入返回 None(全页)。"""
    if not spec:
        return None
    pages = set()
    try:
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                lo, hi = part.split("-", 1)
                lo_i, hi_i = int(lo), int(hi)
                if lo_i < 1 or hi_i < lo_i:
                    return None
                pages.update(range(lo_i, hi_i + 1))
            else:
                v = int(part)
                if v < 1:
                    return None
                pages.add(v)
    except ValueError:
        return None
    return sorted(pages) or None


def main():
    _utf8_stdio()
    ap = argparse.ArgumentParser(
        prog="render_pages.py",
        description="将 PDF 指定页渲染为 p-NN.png 并输出 JSON 清单(vision 路由复用)")
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("out_dir", help="PNG 输出目录(不存在则创建)")
    ap.add_argument("--scale", type=float, default=2.0,
                    help="渲染倍率(1=72dpi,默认 2≈144dpi)")
    ap.add_argument("--pages", default="",
                    help="页选择,如 \"5,7-9\"(缺省渲染全部页)")
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

    # 页选择(v0.6.4 onlyPages 子集渲染):无效/越界回退全页
    page_list = _parse_pages(args.pages) or list(range(1, total + 1))
    page_list = [p for p in page_list if p <= total]
    if not page_list:
        _emit({"ok": False, "error": "页选择为空(共 %d 页)" % total})
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
        for done_no, pno in enumerate(page_list, 1):
            img = _cap_max_side(pdf[pno - 1].render(scale=args.scale).to_pil().convert("RGB"))
            path = os.path.join(out_dir_abs, "p-%02d.png" % pno)
            img.save(path, "PNG")
            files.append(path)
            if done_no == 1 or done_no % 20 == 0 or done_no == len(page_list):
                _log("渲染 %d/%d 页 (%.1fs)" % (done_no, len(page_list), time.time() - t0))
    except Exception as e:
        _emit({"ok": False,
               "error": "渲染失败(第 %d 页附近): %s" % (page_list[len(files)] if len(files) < len(page_list) else -1, str(e)[:300])})
        return 1

    _log("完成: %d 页 → %s (%.1fs)" % (len(page_list), out_dir_abs, time.time() - t0))
    _emit({"ok": True, "pages": len(page_list), "pageList": page_list, "dir": out_dir_abs, "files": files})
    return 0


if __name__ == "__main__":
    sys.exit(main())
