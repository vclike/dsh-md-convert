# -*- coding: utf-8 -*-
"""多栏阅读顺序度量(改代码前先建尺子)。由 scripts/measure-reading-order.mjs 调用。"""
import sys
import json

sys.path.insert(0, "lib/py")
import numpy as np
from PIL import Image
import pymupdf
import routing_ocr as RO


def column_ids(boxes, page_w):
    """按 x 覆盖的空白带切列(XY-cut 简化版:只看竖直切分)。
    返回 (每个块的列号, 切分条数)。"""
    if not boxes:
        return [], 0
    spans = [(b["coordinate"][0], b["coordinate"][2]) for b in boxes]
    cov = [0] * 1000
    for x0, x1 in spans:
        a = max(0, min(999, int(x0 / page_w * 1000)))
        b = max(0, min(999, int(x1 / page_w * 1000)))
        for i in range(a, b + 1):
            cov[i] = 1
    gaps, run = [], None
    for i, v in enumerate(cov):
        if v == 0:
            run = i if run is None else run
        else:
            if run is not None:
                gaps.append((run, i - 1))
                run = None
    if run is not None:
        gaps.append((run, 999))
    cuts = [g for g in gaps if (g[1] - g[0]) / 1000.0 >= 0.03]
    bounds = [0.0] + [(g[0] + g[1]) / 2.0 / 1000.0 for g in cuts] + [1.0]
    out = []
    for x0, x1 in spans:
        cx = (x0 + x1) / 2.0 / page_w
        idx = 0
        for j in range(len(bounds) - 1):
            if bounds[j] <= cx < bounds[j + 1]:
                idx = j
                break
        out.append(idx)
    return out, len(cuts)


def main():
    pdf = pymupdf.open(r"test/golden/samples/zh-omnidocbench-12p.pdf")
    eng = RO.RoutingOCR()
    rows = []
    for pno in range(len(pdf)):
        page = pdf[pno]
        pix = page.get_pixmap(dpi=144)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        raw = eng.layout.predict(np.array(img))
        # 实测:返回 [{boxes:[...]}],且需过 dedup_regions —— 与 textbox_to_md 一致
        boxes = RO.dedup_regions(raw[0]["boxes"])
        if not boxes:
            rows.append({"page": pno + 1, "blocks": 0, "cuts": 0, "cols": 0, "violations": 0})
            continue
        # 当前实现使用的顺序
        order_now = sorted(boxes, key=lambda x: (x["coordinate"][1], x["coordinate"][0]))
        cols, ncuts = column_ids(order_now, img.width)
        viol = sum(1 for i in range(1, len(cols)) if cols[i] < cols[i - 1])
        rows.append({
            "page": pno + 1,
            "blocks": len(boxes),
            "cuts": ncuts,
            "cols": (max(cols) + 1) if cols else 0,
            "violations": viol,
        })
    print("__JSON__" + json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main()