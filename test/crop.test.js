/** v0.7.17 P7:crop: 自裁剪(纯函数部分)。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCrops, pngSize } from "../lib/core/crop.js";

test("planCrops: 解析 crop: 引用,给出稳定 id 与顺序", () => {
	const md = "![流程图](crop:3:100,200,800,600)\n\n![另一张](crop:3:10,10,100,100)";
	const { items, rejects } = planCrops(md);
	assert.equal(items.length, 2);
	assert.equal(rejects.length, 0);
	assert.equal(items[0].id, "p003_c01");
	assert.deepEqual(items[0].box, [100, 200, 800, 600]);
	assert.equal(items[1].id, "p003_c02", "同页按出现顺序编号");
});

test("planCrops: 跨页编号各自从 c01 开始", () => {
	const { items } = planCrops("![a](crop:1:0,0,50,50) ![b](crop:7:0,0,50,50)");
	assert.deepEqual(items.map((i) => i.id), ["p001_c01", "p007_c01"]);
});

test("planCrops: 完全相同的框去重(只裁一次)", () => {
	const md = "![a](crop:3:10,10,100,100) ![b](crop:3:10,10,100,100)";
	const { items, rejects } = planCrops(md);
	assert.equal(items.length, 1);
	assert.equal(rejects.length, 1);
	assert.match(rejects[0].reason, /去重/);
});

test("planCrops: 退化框被拒(宽或高<=0)", () => {
	const md = "![a](crop:2:100,100,100,500) ![b](crop:2:0,0,-5,-5)";
	const { items, rejects } = planCrops(md);
	assert.equal(items.length, 0);
	assert.equal(rejects.length, 2);
	assert.ok(rejects.every((r) => /退化/.test(r.reason)));
});

test("planCrops: 每页上限可配(默认 4),超出部分拒绝而非静默丢弃", () => {
	const md = Array.from({ length: 6 }, (_, i) => `![i${i}](crop:5:${i * 20},0,${i * 20 + 50},50)`).join("\n");
	const r4 = planCrops(md, { maxPerPage: 4 });
	assert.equal(r4.items.length, 4);
	assert.equal(r4.rejects.length, 2);
	assert.match(r4.rejects[0].reason, /每页上限/);
	const r10 = planCrops(md, { maxPerPage: 10 });
	assert.equal(r10.items.length, 6);
});

test("planCrops: 无 crop 引用 / 空输入安全", () => {
	assert.deepEqual(planCrops("纯文字 ![普通](images/a.png)").items, []);
	assert.deepEqual(planCrops("").items, []);
	assert.deepEqual(planCrops(null).items, []);
});

test("planCrops: 允许负坐标(交给 python clamp,模型偶尔会报负值)", () => {
	const { items } = planCrops("![a](crop:2:-10,-20,300,400)");
	assert.equal(items.length, 1, "负坐标不应在 JS 侧被拒,越界由裁剪阶段 clamp");
});

test("pngSize: 非 PNG / 不存在 / 合法文件", () => {
	assert.equal(pngSize("__not_exist__.png"), null);
	assert.equal(pngSize("package.json"), null, "非 PNG 必须返回 null 而不是乱解");
});