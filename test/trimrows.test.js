/** v1.0.5 表格噪声行清理 —— 修复 Excel 空行填充导致产物膨胀。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimNoiseTableRows, isNoiseTableRow } from "../lib/core/trimrows.js";

test("trim: 全空行被剔除", () => {
	assert.equal(isNoiseTableRow("|  |  |  |  |"), true);
	assert.equal(isNoiseTableRow("|   |   |"), true);
});

test("trim: 全零行被剔除(实测样本形态)", () => {
	// 这是真实产物里出现 28349 次的形态(充值/消费/剩余三列公式恒为 0)
	assert.equal(isNoiseTableRow("|  |  |  |  |  | 0 | 0 | 0 |  |"), true);
	assert.equal(isNoiseTableRow("| 0 | 0.0 | 0.00 | +0 | -0 |"), true);
});

test("trim: 有任一非零非空单元 → 保留", () => {
	assert.equal(isNoiseTableRow("| 1 | 2021-08-16 | 10101 | 稻壳1 | 1100 | 600 | 500 |  |"), false);
	// 只有一列有值也要保留(可能就是有效数据的稀疏行)
	assert.equal(isNoiseTableRow("|  |  |  | 稻壳5 |  |"), false);
	// 有 0 也有真值 → 保留
	assert.equal(isNoiseTableRow("| 1 | 0 |  |"), false);
});

test("trim: 分隔行与表头行绝不被删", () => {
	assert.equal(isNoiseTableRow("|---|---|---|"), false);
	assert.equal(isNoiseTableRow("| --- | :--: | --: |"), false);
	assert.equal(isNoiseTableRow("| 序号 | 姓名 | 金额 |"), false);
});

test("trim: 非表格行不处理", () => {
	for (const l of ["", "正文一段话", "# 标题", "  | 漏掉尾竖线", "| 只有首竖线"]) {
		assert.equal(isNoiseTableRow(l), false, JSON.stringify(l));
	}
});

test("trim: 整表清理(分隔行/表头/数据保留,噪声删净)", () => {
	const src = [
		"# 表",
		"| 序号 | 姓名 | 金额 |",
		"|---|---|---|",
		"| 1 | 稻壳1 | 1100 |",
		"|  |  |  |",
		"|  |  | 0 |",
		"| 2 | 稻壳2 | 900 |",
		"|  |  |  |",
		"",
		"正文保留",
	].join("\n");
	const r = trimNoiseTableRows(src);
	assert.equal(r.removed, 3);
	assert.equal(
		r.md,
		["# 表", "| 序号 | 姓名 | 金额 |", "|---|---|---|", "| 1 | 稻壳1 | 1100 |", "| 2 | 稻壳2 | 900 |", "", "正文保留"].join("\n"),
	);
});

test("trim: 幂等(二次运行零变化)", () => {
	const src = "| 序号 | 名 |\n|---|---|\n| 1 | a |\n|  |  |\n";
	const once = trimNoiseTableRows(src);
	const twice = trimNoiseTableRows(once.md);
	assert.equal(twice.md, once.md);
	assert.equal(twice.removed, 0);
});

test("trim: 无表格/空输入原样返回", () => {
	assert.deepEqual(trimNoiseTableRows(""), { md: "", removed: 0 });
	assert.deepEqual(trimNoiseTableRows("纯文本无表格"), { md: "纯文本无表格", removed: 0 });
	assert.deepEqual(trimNoiseTableRows(null), { md: "", removed: 0 });
});

test("trim: 全表皆噪声时不抛错(整表被清也是一致行为)", () => {
	const r = trimNoiseTableRows("|  |  |\n|  |  |");
	assert.equal(r.removed, 2);
	assert.equal(r.md, "");
});