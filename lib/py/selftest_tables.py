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
        # v0.7.2 W2-5: 跨页切断表观测。**注意坐标系**:pypdfium2 y 向上 ⇒
        # "贴底"= bottom≈0(如 (top=82, bot=4)),"贴顶"= top≈页高(如 (top=802, bot=724))。
        ("跨页: 贴底+贴顶+同列数 → 计 1 对",
         te.count_cross_page_pairs(
             [[(82.0, 4.0, "| a | b |\n| --- | --- |\n| 1 | 2 |")],
              [(802.0, 724.0, "| a | b |\n| --- | --- |\n| 3 | 4 |")]],
             [842.0, 842.0]), 1),
        ("跨页: 未贴底(表在中部) → 不计",
         te.count_cross_page_pairs(
             [[(542.0, 464.0, "| a | b |\n| --- | --- |\n| 1 | 2 |")],
              [(802.0, 724.0, "| a | b |\n| --- | --- |\n| 3 | 4 |")]],
             [842.0, 842.0]), 0),
        ("跨页: 列数不同 → 不计",
         te.count_cross_page_pairs(
             [[(82.0, 4.0, "| a | b |\n| --- | --- |")],
              [(802.0, 724.0, "| a | b | c |\n| --- | --- | --- |")]],
             [842.0, 842.0]), 0),
        ("跨页: 中间有整页无表 → 不计(prev 为空)",
         te.count_cross_page_pairs(
             [[(82.0, 4.0, "| a | b |\n| --- | --- |")],
              [],
              [(802.0, 724.0, "| a | b |\n| --- | --- |")]],
             [842.0, 842.0, 842.0]), 0),
    ]
    # v0.7.9 P3/W1-3: 表格重建的字符丢弃计数必须**可达**(否则就是永不触发的死传感器)。
    # 用假 _table_chars 构造"字符落在网格外"的场景:1 个 y 在 band 外、1 个 x 在列外。
    import table_rebuild as tr  # noqa: E402

    tr.reset_stats()
    _orig_chars = tr._table_chars
    try:
        tr._table_chars = lambda tp, rect: [
            (50, 500, "A", 0, 60, 0, 12),  # y 在 band 外 → 丢弃
            (50, 150, "B", 0, 60, 0, 12),  # 网格内 → 保留
            (500, 150, "C", 0, 60, 0, 12),  # x 在列外 → 丢弃
        ]
        md = tr.rebuild_table_md(None, {"rows": [100.0, 200.0], "cols": [0.0, 100.0],
                                       "rect": (0.0, 100.0, 100.0, 200.0)})
        st = tr.stats()
    finally:
        tr._table_chars = _orig_chars
        tr.reset_stats()
    checks += [
        ("表格重建: 网格外字符被计入 chars_dropped", st.get("chars_dropped"), 2),
        ("表格重建: 网格内字符仍正常输出", "| B |" in md, True),
        ("表格重建: reset_stats 能清零", (tr.reset_stats(), tr.stats()["chars_dropped"])[1], 0),
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
