/**
 * W2-1 中文行间空格归并 — 规则 R0-R7 单测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseCjkSpaces, cjkSpaceStats } from "../lib/core/cjk.js";

test("R1: CJK↔CJK 单个半角空格删除;连续多空格/制表符保留", () => {
	assert.equal(collapseCjkSpaces("视觉 表现力").md, "视觉表现力");
	assert.equal(collapseCjkSpaces("招标现场沟通洽 谈记录").md, "招标现场沟通洽谈记录");
	assert.equal(collapseCjkSpaces("视觉  表现力").md, "视觉  表现力"); // 2 空格 = 真空白
	assert.equal(collapseCjkSpaces("视觉\t表现力").md, "视觉\t表现力");
});

test("R2/R3: CJK↔拉丁、CJK↔数字、标点↔拉丁 均不动", () => {
	assert.equal(collapseCjkSpaces("视觉 Transformer 模型").md, "视觉 Transformer 模型");
	assert.equal(collapseCjkSpaces("拦标价 194,000 元（含税）").md, "拦标价 194,000 元（含税）");
	assert.equal(collapseCjkSpaces("官网：http://a.com/x 见").md, "官网：http://a.com/x 见");
});

test("R1 扩展: CJK 标点↔CJK 之间同样归并", () => {
	assert.equal(collapseCjkSpaces("； 详细说明").md, "；详细说明");
	assert.equal(collapseCjkSpaces("， 采用多点位").md, "，采用多点位");
});

test("R0: fenced code 与行内 code 受保护", () => {
	const fenced = "前 面\n\n```\n视觉 表现力\n```\n\n后 面";
	assert.equal(collapseCjkSpaces(fenced).md, "前面\n\n```\n视觉 表现力\n```\n\n后面");
	const inline = "这是 `视觉 表现力` 示例 与 说 明";
	assert.equal(collapseCjkSpaces(inline).md, "这是 `视觉 表现力` 示例与说明");
});

test("R0 偏离(有意): 表格行照常处理 —— 实测 c2 的 145 处注入有 141 处在单元格内", () => {
	assert.equal(collapseCjkSpaces("| 这 怎 图， 拿 输 谈 图 |").md, "| 这怎图，拿输谈图 |");
	assert.equal(collapseCjkSpaces("| --- | --- |").md, "| --- | --- |");
	// 单元格内边距(空格紧邻 | )天然不受影响
	assert.equal(collapseCjkSpaces("| 内容 | 说明 |").md, "| 内容 | 说明 |");
});

test("R5: 绝不删换行、不跨行合并", () => {
	const t = "视觉\n表现力\n\n新段落 内容";
	assert.equal(collapseCjkSpaces(t).md, "视觉\n表现力\n\n新段落内容");
});

test("R7: 幂等(二次运行零变化) + 计数可观测", () => {
	const src = "视觉 表现力； 洽 谈 记录 视觉 Transformer 1 9 4";
	const once = collapseCjkSpaces(src);
	const twice = collapseCjkSpaces(once.md);
	assert.equal(twice.md, once.md);
	assert.equal(twice.removed, 0);
	assert.ok(once.removed >= 3);
	assert.ok(once.tornDigitRuns >= 1, "应观测到被空格打散的数字串(R4 只观测)");
});

test("cjkSpaceStats: 与归并同判据的观测信号", () => {
	const s = cjkSpaceStats("视觉 表现力。洽 谈记录 194,000 元");
	assert.ok(s.cjkChars > 0);
	assert.equal(s.injected, 2);
	assert.ok(s.per1k > 0);
});
