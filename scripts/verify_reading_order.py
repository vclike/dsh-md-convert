# -*- coding: utf-8 -*-
"""W2-8 验收:列序穿插是否归零 + 内容是否守恒(只许改顺序,不许改内容)。"""
import sys
import json

sys.path.insert(0, "lib/py")
import numpy as np
from PIL import Image
import pymupdf
import routing_ocr as RO


def main():
    pdf = pymupdf.open(r"test/golden/samples/zh-omnidocbench-12p.pdf")
    eng = RO.RoutingOCR()
    rows = []
    for pno in range(len(pdf)):
        page = pdf[pno]
        pix = page.get_pixmap(dpi=144)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        boxes = RO.dedup_regions(eng.layout.predict(np.array(img))[0]["boxes"])
        if not boxes:
            rows.append({"page": pno + 1, "blocks": 0, "cols": 0, "violations": 0})
            continue

        def viol(order):
            cols, _ = RO.column_ids(order, img.width)
            return sum(1 for i in range(1, len(cols)) if cols[i] < cols[i - 1])

        def cols_of(order):
            cols, _ = RO.column_ids(order, img.width)
            return (max(cols) + 1) if cols else 0

        old = sorted(boxes, key=lambda x: (x["coordinate"][1], x["coordinate"][0]))
        new = RO.order_boxes_by_columns(boxes, img.width)
        # 内容守恒:排序只换次序,块的**集合**必须一致
        same_set = sorted(id(b) for b in old) == sorted(id(b) for b in new)
        rows.append({
            "page": pno + 1,
            "blocks": len(boxes),
            "cols": cols_of(new),
            "viol_old": viol(old),
            "viol_new": viol(new),
            "same_set": same_set,
        })
    print("__JSON__" + json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main()