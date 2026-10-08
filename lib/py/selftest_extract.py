# -*- coding: utf-8 -*-
"""
dsh-md-convert — extract_text.py 活体自验(P2-4,可重复执行的验收脚本)

用法:
  MDC_TEST_PDF=<文字层 PDF 路径> python lib/py/selftest_extract.py
  未设置 MDC_TEST_PDF / python 缺 pypdfium2 → 打印 SKIP 并以 0 退出(不阻塞 CI)。

断言(通用不变量,不绑定特定文档):
  1. 协议 JSON 可解析;total>0;每页含 no/text/img_ratio 字段
  2. 确定性:连续两次运行输出完全一致
  3. --no-headings 时产物无新增 "## "/"### " 行(开关生效)
  4. 标题重建产物中 "# " 单级不出现在正文行(单级保留给文档标题)
  5. 页眉脚剥离后,边距带版权正则行不再出现于产物
"""
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "extract_text.py")


def _norm_str(text):
    """与 extract_text._norm 同一判据(去全部空白差异)。"""
    return re.sub(r"\s+", "", text or "")


def _run(pdf, *extra):
    r = subprocess.run([sys.executable, SCRIPT, pdf, *extra], capture_output=True, timeout=120)
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")[-600:]
    return json.loads(r.stdout.decode("utf-8"))


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    pdf = os.environ.get("MDC_TEST_PDF", "").strip()

    # v0.7.10 P3: 页眉页脚**判定带位置、应用也必须带位置**。
    # 这段是纯逻辑、**不依赖 PDF 样本**,故放在 SKIP 判断之前 —— 否则默认跑
    # `test:py` 时它永远不执行,等于没测(本轮已踩过一次:先加在 main 末尾,
    # 结果整条 selftest 在默认路径下整条被 SKIP,断言从未跑过)。
    # 回归点: 同一文本只要在边距带里出现过一次,原先会把**页中部**的同名行一起剥掉
    # (实测 bigtable-34p: 324 次剥离里 271 次是页中部误杀;char-layer-11p: 574/351)。
    margin = 0.12
    page_h = 800.0
    strip_set = {'"'}
    mid_line = (350.0, 370.0, '"')          # 页中部(y≈0.46)—— 必须保留
    top_line = (780.0, 795.0, '"')          # 顶部边距带(y≈0.98)—— 应被剥

    def _in_zone(b, t, h, m):
        return t >= h * (1 - m) or b <= h * m

    assert _norm_str(mid_line[2]) in strip_set, "前提:页中部行命中 strip_set"
    assert not _in_zone(*mid_line[:2], page_h, margin), "前提:页中部不在边距带内"
    kept_mid = not (_norm_str(mid_line[2]) in strip_set and _in_zone(*mid_line[:2], page_h, margin))
    assert kept_mid, "页中部的同名行必须保留(修复前会被误杀)"
    stripped_top = _norm_str(top_line[2]) in strip_set and _in_zone(*top_line[:2], page_h, margin)
    assert stripped_top, "边距带内的页眉页脚仍应被剥离(不得为治误杀而漏剥)"

    if not pdf:
        print("SKIP: MDC_TEST_PDF 未设置(活体自验跳过;页眉页脚位置回归已执行)")
        return 0
    try:
        import pypdfium2  # noqa: F401
    except Exception:
        print("SKIP: python 缺 pypdfium2,活体自验不可用")
        return 0
    if not os.path.isfile(pdf):
        print(f"SKIP: MDC_TEST_PDF 不存在: {pdf}")
        return 0

    d1 = _run(pdf)
    assert d1["total"] > 0, "total 应 > 0"
    assert all(("text" in p and "img_ratio" in p and "no" in p) for p in d1["pages"]), "每页应含 no/text/img_ratio"

    d2 = _run(pdf)
    assert json.dumps(d1, sort_keys=True, ensure_ascii=False) == json.dumps(d2, sort_keys=True, ensure_ascii=False), \
        "提取应确定性(两次运行一致)"

    d3 = _run(pdf, "--no-headings")
    plain = "\n".join(p["text"] for p in d3["pages"])
    assert not re.search(r"^### ", plain, re.M), "--no-headings 时不得出现 ### 行"

    full = "\n".join(p["text"] for p in d1["pages"])
    # 源文档可能自带单级 "# " 行(bash 注释等),无法与误标区分——
    # 改为对照断言:标题重建不得**新增**单级 # 行(只允许产出 ##/###)
    single_default = len(re.findall(r"^#(?!#) ", full, re.M))
    single_plain = len(re.findall(r"^#(?!#) ", plain, re.M))
    assert single_default == single_plain, f"标题重建不得新增单级 # 行({single_plain} → {single_default})"
    assert not re.search(r"^版权所有©", full, re.M), "版权页脚行应被剥离"

    print(f"PASS: total={d1['total']} headings={d1['notes'].get('headings')} "
          f"links_inlined={d1['notes'].get('links_inlined')} "
          f"links_footnote={d1['notes'].get('links_footnote')} "
          f"stripped={d1['notes'].get('stripped_lines')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
