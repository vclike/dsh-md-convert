/**
 * T2 单测 — engine 路由决策(复杂度探针驱动,不按页数)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { complexityRatio, decideRoute, probePageSpec } from "../lib/core/convert.js";

/* ---------------- probePageSpec ---------------- */

test("probePageSpec: 小文档全抽样", () => {
	assert.equal(probePageSpec(1), "1");
	assert.equal(probePageSpec(2), "1,2");
	assert.equal(probePageSpec(3), "1,2,3");
});

test("probePageSpec: 97 页抽样 首页+1/3+2/3", () => {
	assert.equal(probePageSpec(97), "1,32,64");
});

test("probePageSpec: 去重与钳制", () => {
	for (const total of [4, 5, 6, 10, 30, 31, 200]) {
		const pages = probePageSpec(total).split(",").map(Number);
		assert.ok(pages.every((n) => n >= 1 && n <= total), `total=${total} 页号越界`);
		assert.equal(new Set(pages).size, pages.length, `total=${total} 有重复`);
		assert.deepEqual(pages, [...pages].sort((a, b) => a - b), `total=${total} 未升序`);
		assert.ok(pages[0] === 1, `total=${total} 首页必抽`);
	}
	assert.equal(probePageSpec(0), "1");
	assert.equal(probePageSpec(-1), "1");
});

/* ---------------- complexityRatio ---------------- */

test("complexityRatio: 表格+公式 / 全部内容区域", () => {
	const r = complexityRatio([{ tables: 2, formulas: 1, textRegions: 7 }]);
	assert.equal(r.valid, true);
	assert.equal(r.tables, 2);
	assert.equal(r.formulas, 1);
	approx(r.ratio, 0.3);
});

// node:test 无 assert.approx,自写浮点比较
function approx(actual, expected, label = "ratio") {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}

test("complexityRatio: error 页剔除;全无效 valid=false", () => {
	const r = complexityRatio([
		{ tables: 1, formulas: 0, textRegions: 3 },
		{ tables: 9, formulas: 9, textRegions: 0, error: "渲染失败" },
	]);
	approx(r.ratio, 0.25);
	const bad = complexityRatio([{ error: "x" }, null, undefined]);
	assert.equal(bad.valid, false);
	assert.equal(bad.ratio, 0);
});

test("complexityRatio: 空输入与空白页", () => {
	assert.equal(complexityRatio(null).valid, false);
	assert.equal(complexityRatio(undefined).valid, false);
	const blank = complexityRatio([{ tables: 0, formulas: 0, textRegions: 0 }]);
	assert.equal(blank.valid, true);
	assert.equal(blank.ratio, 0);
});

/* ---------------- decideRoute ---------------- */

test("decideRoute: engine 显式指定直接生效", () => {
	assert.equal(decideRoute({ engine: "vision" }).route, "vision");
	assert.equal(decideRoute({ engine: "local" }).route, "local");
});

test("decideRoute: 复杂度超阈值 → vision", () => {
	const d = decideRoute({
		probePages: [{ tables: 5, formulas: 1, textRegions: 4 }], // 6/10 = 0.6
		total: 97,
		engine: "auto",
		vision: { complexityRatio: 0.4 },
	});
	assert.equal(d.route, "vision");
	assert.ok(d.reason.includes("复杂度"));
	approx(d.ratio, 0.6);
});

test("decideRoute: 低复杂度 → local 且无 hint", () => {
	const d = decideRoute({
		probePages: [{ tables: 0, formulas: 1, textRegions: 19 }], // 1/20 = 0.05
		total: 50,
		engine: "auto",
		vision: { complexityRatio: 0.4 },
	});
	assert.equal(d.route, "local");
	assert.equal(d.hint, undefined);
});

test("decideRoute: 复杂度接近阈值(≥0.7×)→ local + hint", () => {
	const d = decideRoute({
		probePages: [{ tables: 3, formulas: 0, textRegions: 7 }], // 0.3 = 0.75×0.4
		total: 50,
		engine: "auto",
		vision: { complexityRatio: 0.4 },
	});
	assert.equal(d.route, "local");
	assert.ok(d.hint.includes("engine"));
});

test("decideRoute: 探针不可用 → 保守 local + probeFailed", () => {
	const d = decideRoute({ probePages: [{ error: "模型加载失败" }], total: 10, engine: "auto" });
	assert.equal(d.route, "local");
	assert.equal(d.probeFailed, true);
	const d2 = decideRoute({ probePages: null, total: 10, engine: "auto" });
	assert.equal(d2.route, "local");
	assert.equal(d2.probeFailed, true);
});

test("decideRoute: pagesThreshold 可选强制换轨闸(>0 才启用)", () => {
	const gate = decideRoute({
		probePages: [{ tables: 0, formulas: 0, textRegions: 10 }],
		total: 31,
		engine: "auto",
		vision: { pagesThreshold: 30, complexityRatio: 0.4 },
	});
	assert.equal(gate.route, "vision");
	assert.ok(gate.reason.includes("pagesThreshold"));
	const off = decideRoute({
		probePages: [{ tables: 0, formulas: 0, textRegions: 10 }],
		total: 9999,
		engine: "auto",
		vision: { pagesThreshold: 0, complexityRatio: 0.4 }, // 0=不限页数,纯复杂度换轨
	});
	assert.equal(off.route, "local");
});

test("decideRoute: engine 显式 vision 优先于阈值闸", () => {
	const d = decideRoute({ probePages: [], total: 5, engine: "vision", vision: { pagesThreshold: 30 } });
	assert.equal(d.route, "vision");
});
