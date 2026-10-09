/** v1.0.1 跨页表格安全合并单测(纯函数,零依赖)。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCrossPageTables, tryMergeCrossPage } from "../lib/core/crosspage.js";
import { FIXTURE } from "./golden/crosspage-fixture.js";

// 夹具**逐字取自真实产物**(scripts/gen-crosspage-fixture.mjs 生成),不手写任何表格行。
// 手写夹具反复与真实形态对不上(末列空不空、列数几格),导致长时间无效排查。
const mkPage = (no, body) =>
	`<!--PAGE:${String(no).padStart(2, "0")}-->\n${body}\n<!--/PAGE:${String(no).padStart(2, "0")}-->`;

const p1body = [FIXTURE.head, FIXTURE.sep, ...FIXTURE.p1rows].join("\n");
const p2body = [FIXTURE.p2head, FIXTURE.p2sep, ...FIXTURE.p2rows].join("\n");

const cellsOf = (row) => String(row).trim().slice(1, -1).split("|").map((s) => s.trim());

test("夹具前置:真实形态是满列 + 一端留空", () => {
	const a = cellsOf(FIXTURE.p1rows.at(-1));
	const b = cellsOf(FIXTURE.p2rows[0]);
	assert.equal(a.length, 4, "p1 末行是满列(不是缺格)");
	assert.equal(b.length, 4, "p2 首行是满列");
	assert.equal(a[3], "", "p1 末行末列为空");
	assert.equal(b[0], "", "p2 首行首列为空");
});

test("tryMergeCrossPage: 逐列拼接 + 每列内容守恒", () => {
	const r = tryMergeCrossPage(p1body.split("\n"), p2body.split("\n"));
	assert.ok(r, "应判定为可合并");
	assert.equal(r.cols, 4);
	const c = cellsOf(r.mergedRow);
	assert.equal(c.length, 4, "合并后仍是满列 4 格");

	// ⚠️ 这组断言是被**独立 vision 评审**逼出来的:第一版只合并"次末列",
	// 把 b[1](法诉讼、行政处罚等…)整格丢弃,产物里检索不到"法���讼" → 静默丢字。
	const A = cellsOf(FIXTURE.p1rows.at(-1));
	const B = cellsOf(FIXTURE.p2rows[0]);
	const plain = (s) => s.split("<br>").join("");
	for (let i = 0; i < 4; i++) {
		// 守恒只看**原文内容**:拼接时我们主动插的 <br> 不算丢字,原文自带的要算
		assert.equal(plain(c[i]), plain(A[i]) + plain(B[i]), `第 ${i} 列原文内容必须守恒`);
	}
	// 被切断的那一列:上下两半都要在,且用 <br> 连接
	assert.ok(c[1].includes(A[1]) && c[1].includes(B[1]), "能力说明列上下两半都要在");
	assert.ok(c[1].includes("<br>"), "两半之间用 <br> 连接");
});

test("tryMergeCrossPage: 末行完整(末列非空) → 拒绝", () => {
	const full = [FIXTURE.head, FIXTURE.sep, ...FIXTURE.p1rows.slice(0, -1),
		"|某某某某|甲|乙|丙|丁|"].join("\n");
	assert.equal(tryMergeCrossPage(full.split("\n"), p2body.split("\n")), null);
});

test("tryMergeCrossPage: 表头不一致 → 拒绝(两张不同的表)", () => {
	const other = ["|姓名|年龄|城市|电话|", "|---|---|---|---|",
		"| |续|内容|内容|", "|x|y|z|w|"].join("\n");
	assert.equal(tryMergeCrossPage(p1body.split("\n"), other.split("\n")), null);
});

test("tryMergeCrossPage: 续行首列非空 → 拒绝(不是续表首行)", () => {
	const noGap = [FIXTURE.head, FIXTURE.sep,
		"|新行行|内容A|内容B|内容C|", "|某某某某|甲|乙|丙|"].join("\n");
	assert.equal(tryMergeCrossPage(p1body.split("\n"), noGap.split("\n")), null);
});

test("tryMergeCrossPage: 末行是全空占位行 → 拒绝(无内容可接)", () => {
	const blank = [FIXTURE.head, FIXTURE.sep, "|a|b|c|d|", "| | | | |"].join("\n");
	assert.equal(tryMergeCrossPage(blank.split("\n"), p2body.split("\n")), null);
});

test("mergeCrossPageTables: 分隔行减少、锚点保留、被切断内容不丢", () => {
	const md = [mkPage(1, p1body), mkPage(2, p2body), mkPage(3, "第三页普通内容")].join("\n\n");
	const before = (md.match(/^\|\s*:?-{2,}/gm) ?? []).length;
	const r = mergeCrossPageTables(md);
	assert.equal(r.merged, 1);
	assert.equal((r.md.match(/^\|\s*:?-{2,}/gm) ?? []).length, before - 1, "两表应合一");
	assert.ok(r.md.includes("<!--PAGE:01-->") && r.md.includes("<!--PAGE:03-->"), "锚点必须保留");
	const A = cellsOf(FIXTURE.p1rows.at(-1));
	const B = cellsOf(FIXTURE.p2rows[0]);
	for (const t of [...A, ...B]) {
		if (t) assert.ok(r.md.includes(t), `内容不得丢失:${t.slice(0, 14)}`);
	}
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