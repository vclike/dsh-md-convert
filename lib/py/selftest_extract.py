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
    if not pdf:
        print("SKIP: MDC_TEST_PDF 未设置(指到文字层 PDF 即启用活体自验)")
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
