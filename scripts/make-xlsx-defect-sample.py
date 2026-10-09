# -*- coding: utf-8 -*-
"""构造能暴露四类 xlsx 缺陷的样本(用于验证 anytomd 声称的修复)。

四类缺陷(来自 markitdown-node XLSXBackend 的已知问题):
  1) 单元格内换行符 → 表格行被物理换行劈开,渲染器崩
  2) 无缓存值的公式 → String(cell) 兜底输出 [object Object]
  3) 合并单元格 → ExcelJS 广播值,标题重复多次
  4) 双层表头 → 被压平成两张互不相干的表
另外造一个前导空列(第 5 类)。
"""
import os
import sys

from openpyxl import Workbook

out = sys.argv[1]
os.makedirs(os.path.dirname(out), exist_ok=True)

wb = Workbook()
ws = wb.active
ws.title = "缺陷样本"

# ① 双层表头(第 1 行分组,第 2 行子项)
ws["A1"] = "2026年上半年业绩汇总"
ws.merge_cells("A1:D1")  # ③ 合并标题 —— 若广播会重复多次
ws["A2"] = "产品线"
ws["B2"] = "销量"
ws["C2"] = "单价"
ws["D2"] = "金额"
# 再来一组双层表头
ws["A3"] = "产品线"
ws["B3"] = "销量"
ws["C3"] = "单价"
ws["D3"] = "金额"

# ④ 带换行的单元格(第一个缺陷:换行符)
ws["A4"] = "智能终端\n（含配件）"
ws["B4"] = 1200
ws["C4"] = 3500
ws["D4"] = 4200000

ws["A5"] = "网络设备"
ws["B5"] = 860
ws["C5"] = 2200
ws["D5"] = 1892000

# ② 无缓存值公式(第二个缺陷:String(cell) → [object Object])
ws["A6"] = "合计"
ws["B6"] = "=SUM(B4:B5)"
ws["C6"] = "=AVERAGE(C4:C5)"
ws["D6"] = "=SUM(D4:D5)"

ws["A7"] = "环比"
ws["B7"] = "=B6/B4-1"
ws["C7"] = "=C6/C4"
ws["D7"] = "=D6/D5"

wb.save(out)
print("已生成:", out)
print("  合并区域: A1:D1")
print("  双层表头: 第 2-3 行")
print("  含换行单元格: A4")
print("  公式单元格: B6,C6,D6,B7,C7,D7(无缓存值)")