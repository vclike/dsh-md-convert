# -*- coding: utf-8 -*-
"""生成 3 页纯图 PDF 测试 fixture(冒烟/单测共用)。

Pillow 纯本地方案:文字画到白底图片 → 多页保存为 PDF(整份即纯图 PDF,
文字层为空,命中扫描件路由)。输出与脚本同目录 sample3.pdf。
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sample3.pdf")

W, H = 1240, 1754  # A4 @150dpi 比例
MARGIN = 96


def page(no, title, lines):
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    y = MARGIN
    d.text((MARGIN, y), title, fill="black")
    y += 72
    body = [
        f"第 {no} 页:本页用于 dsh-md-convert v0.6.0 并行 OCR 冒烟测试。",
        "采购文件识别样例:项目名称、编号与预算金额均为占位文本。",
        "The quick brown fox jumps over the lazy dog. 0123456789。",
    ]
    rows = body + [lines[i % len(lines)] for i in range(12)]
    for text in rows:
        d.text((MARGIN, y), text, fill="black")
        y += 56
    d.text((MARGIN, H - MARGIN), f"- {no} -", fill="black")
    return img


def main():
    filler = ["系统要求与投标须知续文,测试行 %d。" % i for i in range(5)]
    pages = [
        page(1, "采购文件(测试样本)", filler),
        page(2, "第二章 投标人须知(测试样本)", filler),
        page(3, "第三章 评标办法(测试样本)", filler),
    ]
    pages[0].save(OUT, "PDF", save_all=True, append_images=pages[1:], resolution=150)
    print("written:", OUT)


if __name__ == "__main__":
    main()
