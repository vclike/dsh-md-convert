/**
 * W2-1 中文行间空格归并 — 规则 R0-R7 单测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseCjkSpaces, cjkSpaceStats, joinWrappedCjkLines } from "../lib/core/cjk.js";

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

/* ── v0.7.6 段内硬换行合并 ──────────────────────────────────────────────
 * 证据:97 页真实扫描件实测 415 处 / 55 页 / 占正文行 39.6%。
 * 陷阱:415 处候选中 113 处紧邻表格/标题/列表行 → 必须结构保护。
 * ────────────────────────────────────────────────────────────────────── */

test("v0.7.6: OCR 栏宽硬换行把中文词切开 → 合并", () => {
	// 真实样本(97 页扫描件 p02/p03)
	const md = ["服务要求:对2026年窖主节活动策划、执行与搭", "建,服务内容包含:活动策划。", "3.3不得参加同一标", "段或者未划分标段的同一采购项目。"].join("\n");
	const r = joinWrappedCjkLines(md);
	assert.equal(r.joined, 2, `应合并 2 处,实得 ${r.joined}`);
	assert.ok(r.md.includes("执行与搭建,服务内容包含"), "词不应被切开");
	assert.ok(r.md.includes("同一标段或者未划分"), "词不应被切开");
	assert.equal(r.md.split("\n").length, 2, "非空行应从 4 降到 2");
});

test("v0.7.6 R0: 表格行/标题/列表/分隔线 受保护,绝不参与合并", () => {
	const md = [
		"| 姓名 | 性别 |",          // 表格行
		"| --- | --- |",
		"## 四、法定代表人",         // 标题
		"1.1 项目概况",            // 列表/编号段首
		"- 采购编号:",             // 列表项
		"---",                     // 分隔线
	].join("\n");
	const r = joinWrappedCjkLines(md);
	assert.equal(r.joined, 0, "结构行之间不得合并");
	assert.equal(r.md, md, "结构行内容必须原样保留");
});

test("v0.7.6 R0: 表格行紧邻正文时表格仍完好(实测 113 处此类候选)", () => {
	// 要求不是"禁止合并",而是**表格行不得被吸进正文行**。
	// 表格行本身是结构行 → 受保护;其后的两个正文行相邻,合并是正确的。
	const md = ["| 职务 | 职称 |", "本文档规定了采购", "流程与相关要求。"].join("\n");
	const r = joinWrappedCjkLines(md);
	assert.ok(r.md.includes("| 职务 | 职称 |"), "表格行必须原样保留,不得被吸进正文");
	assert.ok(!r.md.includes("| 职称 | 本文档"), "表格行后不得直接接正文内容");
	assert.ok(r.md.includes("本文档规定了采购流程与相关要求。"), "两个正文行相邻 → 合并是对的");
});

test("v0.7.6 R2: 前一行以句末标点收尾 → 是真段首,不合并", () => {
	const md = ["上一句已经说完。", "这是新的一段。"].join("\n");
	const r = joinWrappedCjkLines(md);
	assert.equal(r.joined, 0, "句末标点后不得合并");
	assert.equal(r.md, md);
});

test("v0.7.6: 绝不跨 <!--PAGE:NN--> 锚点合并(否则破坏页覆盖语义)", () => {
	const md = ["<!--PAGE:03-->", "第一页末尾未完", "<!--/PAGE:03-->", "<!--PAGE:04-->", "接上文继续", "<!--/PAGE:04-->"].join("\n");
	const r = joinWrappedCjkLines(md);
	assert.equal(r.joined, 0, "锚点两侧不得合并");
	assert.ok(r.md.includes("<!--PAGE:03-->") && r.md.includes("<!--/PAGE:03-->"), "锚点必须保留");
});

test("v0.7.6 R4: 幂等 —— 二次运行零变化", () => {
	const md = ["执行与搭", "建,服务内容", "3.3不得参加同一标", "段或者未划分标段。"].join("\n");
	const once = joinWrappedCjkLines(md);
	const twice = joinWrappedCjkLines(once.md);
	assert.equal(twice.joined, 0, "已合并的不应再合");
	assert.equal(twice.md, once.md, "二次运行必须零变化");
});

test("v0.7.6: 空行与 CRLF 不被破坏;拉丁/数字行不参与合并", () => {
	const crlf = ["行尾是中文", "接下一行", "", "English line", "another line"].join("\r\n");
	const r = joinWrappedCjkLines(crlf);
	assert.equal(r.joined, 1, "只应合并中文那一处");
	assert.ok(r.md.includes("行尾是中文接下一行"), "中文行应合并");
	assert.ok(r.md.includes("English line\r\nanother line"), "拉丁行原样保留");
	assert.ok(r.md.includes("\r\n"), "CRLF 不得被改成 LF");
});

test("v0.7.6: 与 collapseCjkSpaces 串起来用(先断行合并后行内归并)", () => {
	// 模拟真实链路:OCR 断行 + 行内残留空格。
	// joinWrappedCjkLines 会 trim 两侧再拼接,所以断点处的空格在**合并时**就被去掉,
	// 归并阶段通常无事可做 —— 这里断言的是**最终产物正确**。
	const md = ["活动策划、执行与搭", " 建，服务内容包含"];
	const j = joinWrappedCjkLines(md.join("\n"));
	assert.equal(j.joined, 1);
	const m = collapseCjkSpaces(j.md);
	assert.equal(m.md, "活动策划、执行与搭建，服务内容包含");
	assert.equal(cjkSpaceStats(m.md).injected, 0, "合并后不得残留注入");
});
