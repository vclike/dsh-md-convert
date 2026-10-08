# -*- coding: utf-8 -*-
"""W2-4 表格提取自测(假表过滤 + md 生成),零 PDF 依赖,瞬间完成。

关键回归点: **不能按单元格长度拒收** —— golden 样本里承载验收断言的真表也含超长单元格,
按长度过滤会把它们误杀(已实证: golden 两条断言由 True 变 False)。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_extract as te  # noqa: E402


def main():
    checks = [
        # 假表(带竖线感的文本行被当表): 实测 c1 逐字符页出现 11 个 1 行假表
        ("1 行 → 判假表", te._is_fake([["202", "6", ".10.20", "；"]]), True),
        ("1 列 → 判假表", te._is_fake([["a"], ["b"]]), True),
        ("全空 → 判假表", te._is_fake([[None, None], [None, ""]]), True),
        # 真表
        ("正常 2x2 → 收", te._is_fake([["项目", "内容"], ["拦标价", "194,000 元（含税）"]]), False),
        # 关键: 含超长单元格的真表**仍被收**(不得按长度拒收,否则误杀 golden 断言表)
        ("含超长单元的真表仍被收", te._is_fake([["运行时", "Connector"], ["正" * 250, "x"]]), False),
        # md 生成
        ("表内 | 转义", "a\\|b" in te._table_md([["a|b", "c"], ["d", "f"]]), True),
        ("单元格换行 → 单空格", "d e" in te._table_md([["h1", "h2"], ["d\ne", "f"]]), True),
        ("单行不产表", te._table_md([["a", "b"]]) == "", True),
        ("表头 + 分隔行", te._table_md([["h1", "h2"], ["a", "b"]]).startswith("| h1 | h2 |\n| --- | --- |"), True),
        ("不等长行补齐列宽", "| a | b |  |" in te._table_md([["h1", "h2", "h3"], ["a", "b"]]), True),
    ]
    ok = True
    for name, got, want in checks:
        good = got == want
        ok = ok and good
        print(("  [OK] " if good else "  [FAIL] ") + name + ("" if good else f"  (got={got!r} want={want!r})"))
    print("selftest_tables: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
