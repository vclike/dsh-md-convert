/**
 * v0.6.12 单测 — 文字层质量信号检测器(assessMdQuality):
 *   ① 表格碎片化触发(真机特征:工业富联 CapEx 表 82% 含空单元格行)
 *   ② 完整表格不触发(火山特征)
 *   ③ 阈值边界(<50% 不触发)
 *   ④ 短行仅观测不触发(真机校准无区分度,极至/火山分布几乎一致)
 *   ⑤ 高碎片样例 suggestVision=true + warnings 建议由调用方拼接(此处只测返回形状)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessMdQuality } from "../lib/core/quality.js";

// 真机特征样例:工业富联 CapEx 表(11 列、大量空单元格)
const fragmented = [
	"# 工业富联投资价值与策略分析",
	"",
	"| 公司 |  |  | 2025年Ca |  | pEx |  | 2026年C | apEx指引 |  |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	"| Alphabet (Google) |  |  | ~91 0-930 |  | 亿美元 |  | 1,750-1, | 850亿美元 |  |",
	"| Microsoft |  |  | 单季超400 |  | 亿美元 |  | FY2026 | 全年~1,900亿美 | 元 |",
	"| Amazon (AWS) |  |  | ~1,250亿 |  | 美元 |  | 持续显著增长 |  |  |",
	"| Meta |  |  | ~700-720 |  | 亿美元 |  | 持续显著增长 |  |  |",
].join("\n");

// 真机特征样例:火山 P4 完整表(3 列无空单元格)
const clean = [
	"# 火山方舟 Agent 进化",
	"",
	"| 运行时 | Connector | 可优化的指令文件 |",
	"| --- | --- | --- |",
	"| Claude Code | claude_code | 项目级 CLAUDE.md、CLAUDE.local.md |",
	"| OpenClaw | openclaw | AGENTS.md、SOUL.md 等 |",
	"| TraeCode | trae | 项目级 AGENTS.md |",
].join("\n");

test("质量①: 碎片化表格(真机特征) → suggestVision=true + issues", () => {
	const r = assessMdQuality(fragmented);
	assert.equal(r.suggestVision, true, JSON.stringify(r.signals));
	assert.ok(r.score < 70, `score=${r.score}`);
	assert.ok(r.issues.some((i) => i.includes("表格碎片化")), r.issues);
	assert.ok(r.signals.tableFragRatio >= 0.5);
	assert.ok(r.reason.includes("vision"), r.reason);
});

test("质量②: 完整表格(真机特征) → 不触发, score=100", () => {
	const r = assessMdQuality(clean);
	assert.equal(r.suggestVision, false);
	assert.equal(r.score, 100);
	assert.equal(r.signals.tableFragRatio, 0);
});

test("质量③: 阈值边界 — 空单元格行 <50% 不触发", () => {
	// 5 行表格中 2 行含空单元格(40%)
	const rows = [
		"| A | B |",
		"| --- | --- |",
		"| 1 | 2 |",
		"| 3 |  |",
		"| 4 | 5 |",
		"| 6 |  |",
		"| 7 | 8 |",
	].join("\n");
	const r = assessMdQuality(rows);
	assert.equal(r.suggestVision, false, JSON.stringify(r.signals));
});

test("质量③b: 逐字符/竖排文字层(真机特征:五粮液采购文件) → 极端档触发", () => {
	// 真机形态:Word 导出逐字符定位,每行 ≤2 字符(shortLineRatio≈1.0)
	const md = Array.from({ length: 60 }, (_, i) => ["四", "川", "五", "粮", "液", "70", "米"][i % 7]).join("\n");
	const r = assessMdQuality(md);
	assert.equal(r.signals.charFragmentation, true, JSON.stringify(r.signals));
	assert.equal(r.suggestVision, true);
	assert.ok(r.score <= 30, `score=${r.score}`);
	assert.ok(r.reason.includes("逐字符"), r.reason);
	assert.ok(r.issues.some((i) => i.includes("逐字符")), r.issues);
});

test("质量④: 短行仅观测 — 大量短行不触发 suggestVision", () => {
	const md = Array.from({ length: 20 }, (_, i) => (i % 2 ? "70" : "海水能见度超")).join("\n");
	const r = assessMdQuality(md);
	assert.equal(r.suggestVision, false);
	assert.ok(r.signals.shortLineRatio > 0.3, JSON.stringify(r.signals));
});

test("质量⑤: 无表格纯长文 → score=100", () => {
	const md = Array.from({ length: 10 }, (_, i) => `这是第 ${i} 段比较长的正文内容,用于填充行。`).join("\n");
	const r = assessMdQuality(md);
	assert.equal(r.score, 100);
	assert.equal(r.suggestVision, false);
	assert.equal(r.signals.tableRows, 0);
});

test("质量⑥(W2-2): 中文行间空格注入只观测 —— 计入 signals 但不改 score/闸门", () => {
	// 注入形态(pymupdf4llm span 拼接产物):中文行间被插单个半角空格
	const injected = Array.from({ length: 10 }, (_, i) => `这是第 ${i} 段落 入 中文 空格 的正文内容,用于填充行。`).join("\n");
	const ri = assessMdQuality(injected);
	assert.ok(ri.signals.cjkSpaceInjection > 0, JSON.stringify(ri.signals));
	assert.ok(ri.signals.cjkSpacePer1k > 0, JSON.stringify(ri.signals));
	// 同一文本去掉注入空格 → 信号归零,而 score 不变(证明只观测、不参与评分)
	const clean = injected.replace(/(?<=[\u4e00-\u9fff]) (?=[\u4e00-\u9fff])/g, "");
	const rc = assessMdQuality(clean);
	assert.equal(rc.signals.cjkSpaceInjection, 0);
	assert.equal(ri.score, rc.score, "注入空格不得改变 score(仅观测字段)");
	assert.equal(ri.suggestVision, rc.suggestVision, "注入空格不得改变闸门");
	// 数字被单空格打散 → 观测计数(R4 只观测不修改)
	assert.ok(assessMdQuality("拦标价 1 9 4 , 0 0 0元").signals.tornDigitRuns >= 1);
});
