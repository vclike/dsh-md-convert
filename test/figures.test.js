/** v0.7.16 P6:成品图片引用校验(纯函数,零依赖)。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFigureRefs } from "../lib/core/figures.js";

const have = (...names) => {
	const set = new Set(names);
	return (p) => set.has(p);
};

test("validateFigureRefs: 文件存在 → 原样保留,不报 finding", () => {
	const md = "![图1](images/p001_01.png)\n正文";
	const r = validateFigureRefs(md, { resolveFile: have("images/p001_01.png") });
	assert.equal(r.md, md, "存在时不得改动内容");
	assert.equal(r.broken, 0);
	assert.equal(r.findings.length, 0);
	assert.equal(r.checked, 1);
});

test("validateFigureRefs: 文件缺失 → 降级为注释,且**不留断链**", () => {
	const md = "![第3页图表](images/p003_01.png)";
	const r = validateFigureRefs(md, { resolveFile: have() });
	assert.doesNotMatch(r.md, /!\[/, "绝不能留下坏图片引用(渲染是空框,比没有图更糟)");
	assert.match(r.md, /图片\(缺失,需人工补图\)/);
	assert.match(r.md, /第3页图表/, "替代文字要保留,否则丢信息");
	assert.equal(r.broken, 1);
	assert.equal(r.findings[0].code, "E_FIGURE_MISSING");
});

test("validateFigureRefs: 同一缺失文件只报一次 finding(不刷屏)", () => {
	const md = "![a](images/x.png)\n![b](images/x.png)\n![c](images/y.png)";
	const r = validateFigureRefs(md, { resolveFile: have() });
	assert.equal(r.broken, 3);
	assert.equal(r.findings.length, 2, "去重后应只报 2 条");
});

test("validateFigureRefs: 外链与 data URI 不参与校验", () => {
	const md = "![远](https://x.com/a.png) ![内](data:image/png;base64,AAA)";
	const r = validateFigureRefs(md, { resolveFile: have() });
	assert.equal(r.md, md);
	assert.equal(r.checked, 0);
});

test("validateFigureRefs: 无图 / 空输入 / resolveFile 抛异常都安全", () => {
	assert.equal(validateFigureRefs("纯文字", { resolveFile: have() }).md, "纯文字");
	assert.equal(validateFigureRefs(null, {}).md, "");
	assert.equal(validateFigureRefs("", {}).md, "");
	// resolveFile 抛异常 → 视为缺失(宁可降级不可崩)
	const r = validateFigureRefs("![a](images/a.png)", {
		resolveFile: () => {
			throw new Error("boom");
		},
	});
	assert.equal(r.broken, 1);
});

test("validateFigureRefs: 保留图片 title 参数(有文件时)", () => {
	const md = '![t](images/a.png "说明")';
	const r = validateFigureRefs(md, { resolveFile: have("images/a.png") });
	assert.equal(r.md, md);
});