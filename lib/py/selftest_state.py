# -*- coding: utf-8 -*-
"""state 复用校验键自测(v0.7.2 W3-2)。

覆盖四个方向:
  1. 正确键 → 接受
  2. 错误键 → 拒绝
  3. 无键(CLI 直调/旧调用方) → 退回 pdf/scale/total 旧校验并接受
  4. 旧 state 没有 stateKey + 本次给了键 → 必须拒绝(绝不能拿旧结果)

零模型、零 PDF 依赖,瞬间完成。
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parallel_ocr as po  # noqa: E402


def main():
    fake_pdf = os.path.abspath("mdc-selftest-fake.pdf")
    checks = []
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "s.json")
        st = {"pdf": fake_pdf, "total": 4, "scale": 2.0, "stateKey": "K1",
              "pages": {"1": "done"}, "pageWarnings": {}}
        po._save_state(p, st)
        checks.append(("正确键 → 接受",
                       po._load_state(p, fake_pdf, 4, 2.0, "K1") is not None, True))
        checks.append(("错误键 → 拒绝",
                       po._load_state(p, fake_pdf, 4, 2.0, "K2") is None, True))
        checks.append(("无键(旧调用方) → 退回旧校验并接受",
                       po._load_state(p, fake_pdf, 4, 2.0, None) is not None, True))
        # 旧 state(无 stateKey) + 本次给了键 → 拒绝
        old = dict(st)
        old.pop("stateKey")
        po._save_state(p, old)
        checks.append(("旧 state 无键 + 给键 → 拒绝",
                       po._load_state(p, fake_pdf, 4, 2.0, "K1") is None, True))
        # 键正确但页数/倍率不符 → 仍拒绝(纵深防御)
        po._save_state(p, st)
        checks.append(("键正确但 total 不符 → 拒绝",
                       po._load_state(p, fake_pdf, 5, 2.0, "K1") is None, True))

    ok = True
    for name, got, want in checks:
        good = got == want
        ok = ok and good
        print(("  [OK] " if good else "  [FAIL] ") + name)
    print("selftest_state: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
