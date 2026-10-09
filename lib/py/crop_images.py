# -*- coding: utf-8 -*-
"""按图块坐标从**已渲染的页面 PNG** 裁剪出插图。

v0.7.17(P7)。为什么在装配阶段裁、而不是让 vision 转写时就裁:
  - 页面 PNG **已经渲染好了**,裁剪只是像素搬运(毫秒级),不需要重渲染;
  - 一次调用批量处理所有裁剪(单子进程),避免"每图一次子进程"的开销。

输入 JSON(spec 文件路径):
  {"items":[{"id":"p003_c01","page":3,"src":"<页面PNG绝对路径>",
             "box":[x0,y0,x1,y1],"out":"<输出PNG绝对路径>"}]}
输出 JSON: {"ok":true,"done":[{"id","out","w","h","clamped":bool}],
            "failed":[{"id","reason"}]}

坐标语义:与提示词约定一致 —— **渲染后页面 PNG 的像素坐标系,左上角为原点**。
越界一律 clamp 到图像范围(可恢复);退化(宽或高 < minSize)判为失败,由上层降级。
"""
import json
import os
import sys

MIN_SIZE = 24  # 小于这个尺寸基本是线条/噪声碎片,不裁


def main():
    spec_path = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "spec 读取失败:%s" % str(e)[:160]}, ensure_ascii=False))
        return 1

    try:
        from PIL import Image
    except Exception as e:
        print(json.dumps({"ok": False, "error": "PIL 不可用:%s" % str(e)[:160]}, ensure_ascii=False))
        return 1

    done, failed = [], []
    for it in spec.get("items", []):
        src, out, box = it.get("src"), it.get("out"), it.get("box") or []
        if not src or not out or len(box) != 4:
            failed.append({"id": it.get("id"), "reason": "参数不完整"})
            continue
        if not os.path.exists(src):
            failed.append({"id": it.get("id"), "reason": "页面图不存在"})
            continue
        try:
            with Image.open(src) as im:
                im = im.convert("RGB")
                W, H = im.size
                x0, y0, x1, y1 = [int(round(v)) for v in box]
                # clamp:模型给的框常有偏差,越界可恢复,不该直接判失败
                cx0, cy0 = max(0, min(W - 1, x0)), max(0, min(H - 1, y0))
                cx1, cy1 = max(0, min(W, x1)), max(0, min(H, y1))
                if cx1 - cx0 < MIN_SIZE or cy1 - cy0 < MIN_SIZE:
                    failed.append({"id": it.get("id"),
                                   "reason": "裁剪区退化(宽或高<%d)" % MIN_SIZE})
                    continue
                clamped = (cx0, cy0, cx1, cy1) != (x0, y0, x1, y1)
                os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
                im.crop((cx0, cy0, cx1, cy1)).save(out)
                done.append({"id": it.get("id"), "out": out,
                             "w": cx1 - cx0, "h": cy1 - cy0, "clamped": clamped})
        except Exception as e:
            failed.append({"id": it.get("id"), "reason": str(e)[:120]})

    print(json.dumps({"ok": True, "done": done, "failed": failed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())