/** v1.0.2 `<br>` 降级为空格 —— 修复实词被物理换行切断导致的检索失效。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseCjkSpaces } from "../lib/core/cjk.js";

const md = (s) => collapseCjkSpaces(s).md;

test("br: CJK↔CJK 被切断的词 → 还原", () => {
	// 实测样例(火山方舟专业数据集):这些都是词被从中间切开
	assert.equal(md("涵盖全球股票、期<br>货，国内期权"), "涵盖全球股票、期货，国内期权");
	assert.equal(md("司法诉<br>讼/行政处罚"), "司法诉讼/行政处罚");
	assert.equal(md("企业异常与风险相关<br>信息数据"), "企业异常与风险相关信息数据");
});

test("br: Query 中<br>包含 → 空格被 R1 收口", () => {
	assert.equal(md("Query 中<br>包含股票代码"), "Query 中包含股票代码");
});

test("br: CJK↔数字边界保留空格(R2 不动)", () => {
	// `3 只` 本就该有空格,不能粘成 `3只`
	assert.equal(md("单次查询最多可查 3<br>只股票"), "单次查询最多可查 3 只股票");
});

test("br: 整个单元格被复原(实测单元格逐字比对)", () => {
	const src =
		"|金融数据库|涵盖全球股票、期<br>货，国内期权、债<br>券、基金等各类上市<br>品种基本资料、财务<br>数据、日频行情信<br>息、盈利预测、技术<br>形态等各类分析指标<br>等数据。|";
	const out = md(src);
	assert.equal(
		out,
		"|金融数据库|涵盖全球股票、期货，国内期权、债券、基金等各类上市品种基本资料、财务数据、日频行情信息、盈利预测、技术形态等各类分析指标等数据。|",
	);
});

test("br: 计数可观测", () => {
	const r = collapseCjkSpaces("期<br>货 与 债<br>券");
	assert.equal(r.brTags, 2, "应报告转换的 <br> 个数");
});

test("br: 幂等(二次运行零变化)", () => {
	const once = collapseCjkSpaces("涵盖全球股票、期<br>货，国内期权").md;
	const twice = collapseCjkSpaces(once);
	assert.equal(twice.md, once);
	assert.equal(twice.brTags, 0);
});

test("br: 代码块内的 <br> 不动(R0 保护)", () => {
	const src = "```html\nfoo<br>bar\n```";
	assert.equal(md(src), src, "fenced code 必须原样保留");
	const inline = "用 `a<br>b` 表示换行";
	assert.equal(md(inline), inline, "行内 code 必须原样保留");
});

test("br: 自闭合与带空格写法都识别", () => {
	assert.equal(md("期<br/>货"), "期货");
	assert.equal(md("期<br />货"), "期货");
	assert.equal(md("期<BR>货"), "期货");
});

test("br: 不误伤真实换行(R5 仍成立)", () => {
	const src = "第一行\n第二行";
	assert.equal(md(src), src, "真换行绝不能被合并");
});

test("br: 无 <br> 时行为与旧版完全一致(回归保护)", () => {
	// 旧契约:只删 CJK 之间的单个半角空格
	assert.equal(md("视觉 表现力"), "视觉表现力");
	assert.equal(md("洽谈 记录"), "洽谈记录");
	assert.equal(md("视觉 Transformer"), "视觉 Transformer", "CJK↔拉丁不动");
	assert.equal(md("：http"), "：http", "CJK标点↔拉丁不动");
});