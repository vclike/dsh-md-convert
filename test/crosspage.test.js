/** v1.0.1 跨页表格安全合并单测(纯函数,零依赖)。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCrossPageTables, tryMergeCrossPage } from "../lib/core/crosspage.js";
import { FIXTURE } from "./golden/crosspage-fixture.js";

// 夹具**逐字取自真实产物**(scripts/gen-crosspage-fixture.mjs 生成),不手写任何表格行。
// 手写夹具反复与真实形态对不上(末列空不空、列数几格、表头在分隔行上方还是下方),
// 一度导致"三条判据手工全 true、函数却返回 null"的长时间排查 —— 夹具必须来自真实数据。
const mkPage = (no, body) =>
	`<!--PAGE:${String(no).padStart(2, "0")}-->\n${body}\n<!--/PAGE:${String(no).padStart(2, "0")}-->`;

const p1body = [FIXTURE.head, FIXTURE.sep, ...FIXTURE.p1rows].join("\n");
const p2body = [FIXTURE.p2head, FIXTURE.p2sep, ...FIXTURE.p2rows].join("\n");

const cellsOf = (row) => String(row).trim().slice(1, -1).split("|").map((s) => s.trim());

test("夹具前置:真实形态确实是'满列 + 一端留空'", () => {
	const a = cellsOf(FIXTURE.p1rows.at(-1));
	const b = cellsOf(FIXTURE.p2rows[0]);
	assert.equal(a.length, 4, "p1 末行是满列(不是缺格)");
	assert.equal(b.length, 4, "p2 首行是满列");
	assert.equal(a[3], "", "p1 末行末列为空");
	assert.equal(b[0], "", "p2 首行首列为空");
});

test("tryMergeCrossPage: 满列错位 + 同表头 → 合并", () => {
	const r = tryMergeCrossPage(p1body.split("\n"), p2body.split("\n"));
	assert.ok(r, "应判定为可合并");
	assert.equal(r.cols, 4);
	const c = cellsOf(r.mergedRow);
	assert.equal(c.length, 4, "合并后仍是满列 4 格");
	// 内容整体右移一格 → 只有"次末列"是同一格被切断:上半来自 a,下半来自 b
	assert.equal(c[0], cellsOf(FIXTURE.p1rows.at(-1))[0], "首格取上页");
	assert.equal(c[3], cellsOf(FIXTURE.p2rows[0])[3], "末列取续页的值");
	const cutA = cellsOf(FIXTURE.p1rows.at(-1))[2];
	const cutB = cellsOf(FIXTURE.p2rows[0])[2];
	assert.ok(c[2].startsWith(cutA), "次末列应以上半句开头");
	assert.ok(c[2].endsWith(cutB), "次末列应以下半句结尾");
	assert.ok(c[2].includes("<br>"), "上下两半之间用 <br> 连接");
});

test("tryMergeCrossPage: 末行完整(末列非空) → 拒绝(防误合正常表格)", () => {
	const full = [FIXTURE.head, FIXTURE.sep, ...FIXTURE.p1rows.slice(0, -1),
		"|某某|甲|乙|丙|丁|"].join("\n");
	assert.equal(tryMergeCrossPage(full.split("\n"), p2body.split("\n")), null);
});

test("tryMergeCrossPage: 表头不一致 → 拒绝(两张不同的表)", () => {
	const other = ["|姓名|年龄|城市|电话|", "|---|---|---|---|",
		"| |续|内容|内容|", "|x|y|z|w|"].join("\n");
	assert.equal(tryMergeCrossPage(p1body.split("\n"), other.split("\n")), null);
});

test("tryMergeCrossPage: 续行首列非空 → 拒绝(不是续表首行)", () => {
	const noGap = [FIXTURE.head, FIXTURE.sep,
		"|新行|内容A|内容B|内容C|", "|科研|甲|乙|丙|"].join("\n");
	assert.equal(tryMergeCrossPage(p1body.split("\n"), noGap.split("\n")), null);
});

test("tryMergeCrossPage: 末行是全空占位行 → 拒绝(无内容可接)", () => {
	const blank = [FIXTURE.head, FIXTURE.sep, "|a|b|c|d|", "| | | | |"].join("\n");
	assert.equal(tryMergeCrossPage(blank.split("\n"), p2body.split("\n")), null);
});

test("mergeCrossPageTables: 合并后分隔行减少、锚点保留、内容不丢", () => {
	const md = [mkPage(1, p1body), mkPage(2, p2body), mkPage(3, "第三页普通内容")].join("\n\n");
	const before = (md.match(/^\|\s*:?-{2,}/gm) ?? []).length;
	const r = mergeCrossPageTables(md);
	assert.equal(r.merged, 1);
	assert.equal((r.md.match(/^\|\s*:?-{2,}/gm) ?? []).length, before - 1, "分隔行应减少一个(两表合一)");
	assert.ok(r.md.includes("<!--PAGE:01-->") && r.md.includes("<!--PAGE:03-->"), "锚点必须保留");
	// 被切断的两半必须都还在(内容不丢)
	const cutA = cellsOf(FIXTURE.p1rows.at(-1))[2];
	const cutB = cellsOf(FIXTURE.p2rows[0])[2];
	assert.ok(r.md.includes(cutA), "上半句保留");
	assert.ok(r.md.includes(cutB), "下半句保留");
});

test("mergeCrossPageTables: 页号不连续 → 不合并(子集计划会跳跃)", () => {
	const md = [mkPage(1, p1body), mkPage(5, p2body)].join("\n\n");
	assert.equal(mergeCrossPageTables(md).merged, 0);
});

test("mergeCrossPageTables: 无锚点/空输入安全", () => {
	assert.equal(mergeCrossPageTables("纯文字").merged, 0);
	assert.equal(mergeCrossPageTables("").merged, 0);
	assert.equal(mergeCrossPageTables(null).merged, 0);
});