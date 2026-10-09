# -*- coding: utf-8 -*-
"""页眉/页脚剥离自测(纯逻辑,零 PDF 依赖,瞬间完成)。

为什么要这个测试:这段逻辑本轮**改了 3 次**才对 ——
  ① 第一版全局判据("任意页正文出现过就全不剥")→ 实测 29 处真页眉因 2 处正文同名被全放过;
  ② 改逐页判据后才发现 ③ 部署根本没生效(同名 tgz 致 pnpm 跳过重装)。
而它作用于**所有 pymupdf4llm 接管的产物**(绝大多数有文字层的 PDF),
此前只有 golden 的 ②类 chars 断言间接兜底 —— 能发现"剥多/剥少",发现不了"剥错哪一类"。
故把纯逻辑拆出 `detect_hf_from_zones` 直接断言四条判据。

判据(与自研链同源):
  ① 边距带内跨页重复 ≥ max(2, ceil(0.6N))
  ② 边距带内命中页码/版权正则(出现 1 次即剥)
  ③ 逐页收口:该页边距带有**且该页正文区没有**才剥(绝不误杀正文)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pymupdf4llm_extract as px  # noqa: E402


def main():
    D = px.detect_hf_from_zones
    S = px._strip_hf_from_md
    HDR = "专业数据集"  # 归一化后的页眉文本
    CPY = "版权所有©北京火山引擎科技有限公司"
    checks = [
        # ── 判据① 跨页重复(3 页都出现 → threshold=max(2,ceil(1.8))=2) ──
        ("3 页重复页眉 → 各页均剥",
         D({0: ({HDR}, set()), 1: ({HDR}, set()), 2: ({HDR}, set())}),
         {0: {HDR}, 1: {HDR}, 2: {HDR}}),
        # 只出现 1 次且非正则 → 不剥(阈值 ≥2)
        ("仅 1 页出现的普通文本 → 不剥", D({0: ({"某段落单文本"}, set())}), {}),
        # 5 页里出现 3 次:threshold=max(2,ceil(3))=3 → 恰好剥
        ("5 页出现 3 次 → 达阈值剥",
         D({0: ({HDR}, set()), 1: ({HDR}, set()), 2: ({HDR}, set()),
            3: ({"其它页眉"}, set()), 4: ({"别的"}, set())}),
         {0: {HDR}, 1: {HDR}, 2: {HDR}}),

        # ── 判据② 正则候选(出现 1 次即剥) ──
        ("页码 1/13 单次出现 → 剥", D({0: ({"1/13"}, set())}), {0: {"1/13"}}),
        ("纯数字页码单次出现 → 剥", D({0: ({"7"}, set())}), {0: {"7"}}),
        ("版权行单次出现 → 剥", D({0: ({CPY}, set())}), {0: {CPY}}),
        ("Powered by 单次出现 → 剥", D({0: ({"Powered by Foo"}, set())}), {0: {"Powered by Foo"}}),

        # ── 判据③ 逐页收口 / 正文保护(**最关键**) ──
        ("该页正文区同名 → 该页不剥(其余页照剥)",
         D({0: ({HDR}, {HDR}), 1: ({HDR}, set()), 2: ({HDR}, set())}),
         {1: {HDR}, 2: {HDR}}),
        ("正文区同名只影响该页,不牵连其它页",
         D({0: ({HDR}, set()), 1: ({HDR}, {HDR}), 2: ({HDR}, set())}),
         {0: {HDR}, 2: {HDR}}),
        ("页码在正文区也有 → 该页不剥(宁可漏剥)",
         D({0: ({"1/13"}, {"1/13"})}), {}),

        # ── 边界 ──
        ("空输入 → 空结果", D({}), {}),
        ("边距带全空 → 空结果", D({0: (set(), set()), 1: (set(), {"正文"})}), {}),

        # ── 剥离函数 ──
        # 用 "\n".join 明确表达行列表,别用字符串乘法 —— 优先级会坑人(本测试第一版就算错了)
        ("完全相等的行才删(含计数)",
         S("\n".join([HDR, "正文是一段很长的内容", "1/13"]), {HDR, "1/13"}),
         ("正文是一段很长的内容", 2)),
        ("正文行含同名**子串**不被删",
         S("专业数据集是面向 Agent 的专业搜索基础设施", {HDR}),
         ("专业数据集是面向 Agent 的专业搜索基础设施", 0)),
        ("空 strip_set → 原样返回", S("abc\ndef", set()), ("abc\ndef", 0)),
        # ["","",HDR,"",""] 删 HDR → ["","","",""] → join 得 3 个换行(不是 4 个)
        ("空白行不受影响", S("\n\n" + HDR + "\n\n", {HDR}), ("\n\n\n", 1)),
    ]

    # 归一化一致性:剥离函数按 _norm 比较,前后空格应等价
    checks.append(("前后空格仍能匹配(按 _norm 比较)", S("  专业数据集  ", {HDR}), ("", 1)))
    checks.append(("_norm 去全部空白", px._norm(" 专业 数据 集 "), "专业数据集"))

    ok = True
    for name, got, want in checks:
        good = got == want
        ok = ok and good
        print(("  [OK] " if good else "  [FAIL] ") + name + ("" if good else f"  (got={got!r} want={want!r})"))
    print("selftest_hf: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())