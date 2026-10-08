# -*- coding: utf-8 -*-
"""表格几何装配自测(v0.7.2 W-表格列序),零模型依赖 —— 只测 cells_to_grid 纯函数。

关键回归点(全部来自真实采样):
  1. **同一视觉行 cell 的 y1 有 0.1~0.2px 差异** → 旧"按检测顺序每 ncols 切一段"会逐行错位;
     实测采购文件 p4 的 16 行里 11 行条款号跑到第 2/3 列。
  2. **行边界不得靠单元格高度估计容差** —— 高单元格(h=229)会把"0.5×中位高"放大到 ~50px,
     把相距 34px 的两行误并成一行(实测 1.4.2 / 1.4.3 被并)。
  3. 合并单元格/漏检使某行 cell 数偏少时,应**留空**而非顶替。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from routing_ocr import cells_to_grid  # noqa: E402


def C(x1, y1, x2, y2):
    return {"coordinate": [x1, y1, x2, y2]}


def main():
    checks = []

    # ① y1 打乱:检测顺序把"第 2 列"排在前面(真实采样形态,2 行 × 3 列)
    cells1 = [
        C(97.0, 6.0, 323.0, 41.0), C(5.0, 6.2, 97.0, 41.0), C(323.0, 7.0, 843.0, 42.0),
        C(97.0, 41.6, 323.0, 143.0), C(5.0, 41.7, 97.0, 143.0), C(323.0, 42.3, 843.0, 143.0),
    ]
    texts1 = ["条款名称", "条款号", "编列内容", "服务要求", "1.3.2", "服务期：自合同…"]
    g1 = cells_to_grid(cells1, texts1, 2, 3)
    checks.append(("① y1 打乱后仍按 x 排好列序(表头)", g1[0] if g1 else [], ["条款号", "条款名称", "编列内容"]))
    checks.append(("① y1 打乱后仍按 x 排好列序(数据行)", g1[1] if len(g1) > 1 else [], ["1.3.2", "服务要求", "服务期：自合同…"]))
    checks.append(("① 行数正确", len(g1), 2))

    # ② 高单元格不得把相邻两行并成一行(nrows 驱动的最大间隙切分,零容差)
    #    行 y 中心间距 34px(真实 1.4.2/1.4.3 的间距),另有 h=229 的高行拉大"中位高度"
    cells2 = [
        C(5.0, 0.0, 97.0, 229.0), C(97.0, 1.0, 323.0, 229.0), C(323.0, 2.0, 843.0, 229.0),      # 高行
        C(5.0, 263.0, 97.0, 298.0), C(97.0, 263.1, 323.0, 298.0), C(323.0, 263.2, 843.0, 298.4),  # cy≈280.6
        C(5.0, 297.6, 97.0, 332.6), C(97.0, 297.7, 323.0, 332.6), C(323.0, 297.8, 843.0, 333.1),  # cy≈315.15(间距 34.5)
        C(5.0, 332.6, 97.0, 367.6), C(97.0, 332.7, 323.0, 367.6), C(323.0, 332.8, 843.0, 368.2),
    ]
    texts2 = [f"t{i}" for i in range(12)]
    g2 = cells_to_grid(cells2, texts2, 4, 3)
    checks.append(("② 4 行不得被并为 3 行", len(g2), 4))
    checks.append(("② 每行 3 列", [len(r) for r in g2], [3, 3, 3, 3]))
    checks.append(("② 行序自上而下", [r[0] for r in g2], ["t0", "t3", "t6", "t9"]))

    # ③ 短行(合并/漏检)→ 按列槽留空,不顶替
    cells3 = [
        C(5.0, 0.0, 97.0, 30.0), C(97.0, 0.1, 323.0, 30.0), C(323.0, 0.2, 843.0, 30.0),
        C(5.0, 30.0, 97.0, 60.0), C(97.0, 30.1, 323.0, 60.0), C(323.0, 30.2, 843.0, 60.0),
        C(5.0, 60.0, 97.0, 90.0), C(323.0, 60.2, 843.0, 90.0),                       # 中间列缺失
        C(5.0, 90.0, 97.0, 120.0), C(97.0, 90.1, 323.0, 120.0), C(323.0, 90.2, 843.0, 120.0),
    ]
    texts3 = ["h1", "h2", "h3", "a1", "a2", "a3", "b1", "b3", "c1", "c2", "c3"]
    g3 = cells_to_grid(cells3, texts3, 4, 3)
    checks.append(("③ 缺中间列 → 行内留空且不顶替", g3[2] if len(g3) > 2 else [], ["b1", "", "b3"]))
    checks.append(("③ 满行不受影响", g3[3] if len(g3) > 3 else [], ["c1", "c2", "c3"]))

    # ④ 边界
    checks.append(("④ 空输入 → 空网格", cells_to_grid([], [], 2, 3), []))
    checks.append(("④ nrows 缺失(0) → 单行兜底", len(cells_to_grid([C(0, 0, 10, 10), C(20, 0, 30, 10)], ["a", "b"], 0, 2)), 1))
    checks.append(("④ 单列 → 每格一行", cells_to_grid([C(0, 0, 10, 10), C(0, 20, 10, 30)], ["a", "b"], 2, 1), [["a"], ["b"]]))

    ok = True
    for name, got, want in checks:
        good = got == want
        ok = ok and good
        print(("  [OK] " if good else "  [FAIL] ") + name + ("" if good else f"  (got={got!r} want={want!r})"))

    # v0.7.14: 公式模型**懒加载**的回归防护。
    # 缺陷:parallel_ocr 直接取 `engine.formula`,而该属性在 __init__ 里是 None(W3-5 懒加载),
    #       扫描件链路从未调用 formula_engine() -> 恒为 None -> 每个公式都抛
    #       'NoneType' object has no attribute 'predict'。
    # 这里不加载真模型(太重),只断言"取公式引擎的入口存在且初始为 None"。
    import routing_ocr as RO

    eng = RO.RoutingOCR.__new__(RO.RoutingOCR)   # 绕开 __init__(会加载 layout/ocr 模型)
    eng.formula = None
    calls = []

    def _fake_fr(**kw):
        # 用工厂函数而非"__init__ 返回对象"—— 后者违反 Python 语义(TypeError)
        calls.append(kw)
        return type("FakeEngine", (), {"predict": staticmethod(lambda img: [{"rec_formula": "x^2"}])})()

    eng.FormulaRecognition = _fake_fr
    # 注意:这一条必须在**首次调用 formula_engine() 之前**断言,
    # 否则属性已被赋值,断言 None 必然失败(写错过一次)。
    pre_lazy = eng.formula
    checks2 = [
        ("公式: 懒加载入口存在", callable(getattr(RO.RoutingOCR, "formula_engine", None)), True),
        ("公式: 未经 formula_engine() 时属性保持 None(未急加载)", pre_lazy, None),
    ]
    got = eng.formula_engine().predict(None)
    checks2.append(("公式: 经 formula_engine() 可拿到引擎(不再是 None)", got[0]["rec_formula"], "x^2"))
    checks2.append(("公式: 首次调用才构造模型(懒加载)", len(calls), 1))
    eng.formula_engine()
    checks2.append(("公式: 二次调用复用同一实例", len(calls), 1))
    diag = getattr(eng, "formula_diagnostics", None)
    checks2.append(("公式: 失败可观测接口存在", callable(diag), True))

    for name, got2, want2 in checks2:
        good = got2 == want2
        ok = ok and good
        print(("  [OK] " if good else "  [FAIL] ") + name + ("" if good else f"  (got={got2!r} want={want2!r})"))

    print("selftest_routing: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
