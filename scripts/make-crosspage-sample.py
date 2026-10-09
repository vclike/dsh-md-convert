# -*- coding: utf-8 -*-
"""抽取跨页表格页并压体积 —— **保留文字层**(缺陷只在文字层链路出现)。

上一版把页转成位图(200dpi)导致丢掉文字层,走 OCR 链路后表格反而被正确连成一张表,
**没复现原缺陷** —— 说明缺陷是**文字层链路特有**的。

本版:抽页 + 裁掉字体子集(体积大头)以保留文字层。
若字体子集裁剪导致文字层损坏,则回退为"整份入库"(4.7MB 可接受)。
"""
import os
import sys

import pymupdf

SRC = r"D:/Downloads/火山方舟_专业数据集_1787541642.pdf"
DST = sys.argv[1] if len(sys.argv) > 1 else r"test/golden/samples/pdf-crosspage-table.pdf"
PAGES = [4, 5, 6]

src = pymupdf.open(SRC)
out = pymupdf.open()
for pno in PAGES:
    out.insert_pdf(src, from_page=pno - 1, to_page=pno - 1)

# subset_fonts:只保留实际用到的字体子集(体积大头)
out.subset_fonts(verbose=False)
os.makedirs(os.path.dirname(DST), exist_ok=True)
out.save(DST, deflate=True, garbage=4, clean=True)
out.close()

print("-> %s (%.2f MB)" % (DST, os.path.getsize(DST) / 1e6))
d = pymupdf.open(DST)
ok = True
for i in range(d.page_count):
    n = len(d[i].get_text().strip())
    print("  p%d: 文字层 %d 字符" % (i + 1, n))
    if n < 100:
        ok = False
print("文字层完好:", "OK" if ok else "!! 损坏(字体裁剪过度)")