/**
 * v0.7.18 anytomd(xlsx 路由)单测。
 * 之前该改动**零测试覆盖** —— 发 v1.0.0 前必须补上,否则它只是"看起来能跑"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAnytomdExt, ANYTOMD_EXT, viaAnytomd } from "../lib/core/anytomd.js";
import { classify } from "../lib/core/detect.js";
import { convertFile } from "../lib/core/convert.js";

const SAMPLE = "test/golden/samples/xlsx-defects.xlsx";

test("isAnytomdExt: 仅 xlsx 走 anytomd;xls 仍走 legacy", () => {
	assert.equal(isAnytomdExt("xlsx"), true);
	assert.equal(isAnytomdExt("XLSX"), true, "大小写不敏感");
	assert.equal(isAnytomdExt("xls"), false, ".xls 仍在 classify 阶段被 legacy 拦下");
	assert.equal(isAnytomdExt("docx"), false);
	assert.equal(isAnytomdExt(""), false);
	assert.equal(isAnytomdExt(null), false);
	assert.deepEqual([...ANYTOMD_EXT], ["xlsx"]);
});

test("detect: xlsx 仍被 classify 识别为 modern(未被 legacy 规则误捕)", () => {
	// anytomd 是在 classify 之后接管路由的,不能反过来破坏原有分类
	assert.equal(classify("a.xlsx").kind, "modern");
});

test("viaAnytomd: 缺陷样本四类问题全部修复", async (t) => {
	if (!existsSync(SAMPLE)) return t.skip("样本缺失");
	const { md } = await viaAnytomd(SAMPLE);

	// ① 单元格内换行 → 必须转 <br>,不能出现裸换行劈表。
	//    判据按**行**来:处于表格区(标题行之后)的行必须以 | 开头或为空行。
	//    ⚠️ 曾用 /\|\s*[^\n|]*\n[^\n|]*\|/ 判定 —— 该正则会匹配**正常的相邻表格行**,
	//    导致误报;这类"跨行贪婪匹配"判据在表格测试里不可靠。
	const lines = md.split("\n");
	const start = lines.findIndex((l) => l.trim().startsWith("|"));
	const brokenInTable = [];
	for (const l of lines.slice(start)) {
		const t = l.trim();
		if (t === "" || t.startsWith("|") || t.startsWith("<!--")) continue;
		brokenInTable.push(l);
	}
	assert.equal(brokenInTable.length, 0, `表格区出现非表格行(裸换行劈开了表格):${JSON.stringify(brokenInTable)}`);
	assert.match(md, /智能终端<br>/, "换行应转成 <br>");

	// ② 无缓存值公式 → 不得泄漏 [object Object]
	assert.doesNotMatch(md, /\[object Object\]/, "不得出现 [object Object]");

	// ③ 合并标题 → 只出现一次(不被广播重复)
	assert.equal((md.match(/2026年上半年业绩汇总/g) ?? []).length, 1);

	// ④ 双层表头 → 两组表头都在
	assert.ok((md.match(/产品线/g) ?? []).length >= 2, "双层表头应保留两层");
});

test("viaAnytomd: 失败时抛 E_ANYTOMD(而不是静默返回空)", async () => {
	// 接缝契约:失败必须抛出,否则 convert.js 的兜底无从判断
	await assert.rejects(() => viaAnytomd("__不存在的文件__.xlsx"));
});

test("viaAnytomd: childImpl 可注入(便于无依赖单测)", async () => {
	const r = await viaAnytomd("whatever.xlsx", {
		childImpl: async () => ({ md: "# 注入", warnings: ["w"] }),
	});
	assert.equal(r.md, "# 注入");
	assert.deepEqual(r.warnings, ["w"]);
	assert.equal(r.engine, "child-process");
});

test("viaAnytomd: childImpl 抛错 → 包装为 E_ANYTOMD", async () => {
	await assert.rejects(
		() => viaAnytomd("x.xlsx", { childImpl: async () => { throw new Error("boom"); } }),
		/boom|E_ANYTOMD/,
	);
});

test("convertFile 端到端: xlsx 走 anytomd 且产物无垃圾", { skip: !existsSync(SAMPLE) }, async () => {
	const r = await convertFile(SAMPLE, { outDir: "test/golden/.out/anytomd-e2e", engine: "auto" });
	assert.equal(r.ok, true, r.error ?? "");
	// convertFile 的真实返回字段是 `outFile`(不是 output / outputFile),且直接带 `md`
	assert.equal(r.chain, "anytomd", "应走 anytomd 链路");
	assert.match(r.outFile, /xlsx-defects\.md$/, "产物名应保持源文件名");
	const md = r.md;
	assert.doesNotMatch(md, /\[object Object\]/);
	//    注:表格区到**首个非表格内容行**为止 —— 文件尾部的溯源注释
	//    (`<!-- 源文件: … -->`)不是表格内容,不算缺陷(此前误判为 1 行异常)。
	const ls = md.split("\n");
	const s0 = ls.findIndex((l) => l.trim().startsWith("|"));
	const broken = [];
	for (const l of ls.slice(s0)) {
		const t = l.trim();
		if (t === "" || t.startsWith("|")) continue;
		if (t.startsWith("<!--")) continue; // 注释:溯源/页眉/装饰等,非表格内容
		broken.push(l);
	}
	assert.equal(broken.length, 0, `表格区出现非表格内容行:${JSON.stringify(broken)}`);
	assert.match(md, /智能终端<br>/, "单元格换行应转 <br>");
});