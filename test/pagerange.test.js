import test from "node:test";
import assert from "node:assert/strict";
import { pageSpecToArg, parsePageSpec, prefixPageCount } from "../lib/core/pagerange.js";

test("页范围①: 空/未给 → 全部页(pages=null)", () => {
	for (const v of ["", "   ", null, undefined]) {
		const r = parsePageSpec(v, 30);
		assert.equal(r.ok, true, String(v));
		assert.equal(r.pages, null);
	}
});

test("页范围②: 单页/范围/混合 → 1 起、升序、去重", () => {
	assert.deepEqual(parsePageSpec("5", 30).pages, [5]);
	assert.deepEqual(parsePageSpec("1-3", 30).pages, [1, 2, 3]);
	assert.deepEqual(parsePageSpec("5,1-3,3", 30).pages, [1, 2, 3, 5]);
	assert.deepEqual(parsePageSpec(" 2 - 4 , 9 ", 30).pages, [2, 3, 4, 9]);
});

test("页范围③: 越界**报错**而非静默丢弃", () => {
	const r = parsePageSpec("1-5,200", 30);
	assert.equal(r.ok, false);
	assert.match(r.error, /超出文档页数/);
	assert.match(r.error, /200/);
	// 未知总页数(total=0)时不校验上界
	assert.equal(parsePageSpec("1-99", 0).ok, true);
});

test("页范围④: 非法片段给出可用报错(冗余逗号按宽容处理)", () => {
	for (const [spec, re] of [["0", /从 1 开始/], ["5-3", /颠倒/], ["abc", /无法识别/], ["0-2", /从 1 开始/]]) {
		const r = parsePageSpec(spec, 30);
		assert.equal(r.ok, false, spec);
		assert.match(r.error, re, spec);
	}
	// 冗余逗号("1,,3")是可解析的 → 宽容处理,不报错(与"越界必须报错"是两件事)
	assert.deepEqual(parsePageSpec("1,,3", 30).pages, [1, 3]);
	assert.deepEqual(parsePageSpec(",", 30).ok, false, "只有逗号=空范围");
});

test("页范围⑤: prefixPageCount 只认『从第 1 页起连续』形态(OCR 链路用)", () => {
	assert.equal(prefixPageCount([1, 2, 3]), 3);
	assert.equal(prefixPageCount([1]), 1);
	assert.equal(prefixPageCount([2, 3]), 0);
	assert.equal(prefixPageCount([1, 3]), 0);
	assert.equal(prefixPageCount(null), 0);
	assert.equal(prefixPageCount([]), 0);
});

test("页范围⑥: pageSpecToArg 规范化成 python 侧参数", () => {
	assert.equal(pageSpecToArg([1, 2, 3]), "1,2,3");
	assert.equal(pageSpecToArg(null), "");
	assert.equal(pageSpecToArg([]), "");
});
