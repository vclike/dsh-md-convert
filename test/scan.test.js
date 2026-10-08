/**
 * W4-6 目录展开 — 单测。
 *
 * 不变量:**不静默丢文件** —— 跳过的每个文件都要有原因;显式单文件不受目录规则影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expandInputs, isConvertibleExt } from "../lib/core/scan.js";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "mdc-scan-"));
	writeFileSync(join(dir, "b.pdf"), "x");
	writeFileSync(join(dir, "a.docx"), "x");
	writeFileSync(join(dir, "c.md"), "x"); // 疑似本工具产物 → 目录模式跳过
	writeFileSync(join(dir, "d.zip"), "x"); // v0.7.2 W4-1 起受支持
	writeFileSync(join(dir, "e.unknown"), "x");
	writeFileSync(join(dir, "f.state.json"), "x"); // 本工具产物
	writeFileSync(join(dir, ".hidden.docx"), "x"); // 隐藏项
	writeFileSync(join(dir, "noext"), "x");
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "g.txt"), "x");
	return dir;
}

test("W4-6: 目录展开 —— 只收受支持文件,跳过项逐条说明原因", () => {
	const dir = fixture();
	const r1 = expandInputs([dir]);
	assert.deepEqual(
		r1.files.map((p) => basename(p)),
		["a.docx", "b.pdf", "d.zip"],
		`顶层受支持文件且按名排序,实际: ${r1.files.map((p) => basename(p))}`,
	);
	assert.ok(!r1.files.some((p) => p.includes("sub")), "默认不递归子目录");
	const reasons = Object.fromEntries(r1.skipped.map((s) => [basename(s.path), s.reason]));
	assert.match(reasons["c.md"] ?? "", /Markdown/);
	assert.match(reasons["e.unknown"] ?? "", /不支持/);
	assert.match(reasons["f.state.json"] ?? "", /产物/);
	assert.match(reasons["noext"] ?? "", /无扩展名/);
	assert.equal(reasons[".hidden.docx"], undefined, "隐藏项直接忽略,不作为跳过项噪声");

	const r2 = expandInputs([dir], { recursive: true });
	assert.ok(r2.files.some((p) => p.endsWith("g.txt")), "递归应收子目录文件");
});

test("W4-6: 显式单文件不受目录规则影响(md 仍可转);不存在的路径交给下层报 E_FILE_NOT_FOUND", () => {
	const r = expandInputs(["x.md", "missing.docx"]);
	assert.deepEqual(r.files, ["x.md", "missing.docx"]);
	assert.equal(r.skipped.length, 0);
});

test("W4-6: isConvertibleExt 覆盖现代/老格式/插件纯文本", () => {
	for (const e of ["pdf", "docx", "xlsx", "pptx", "zip", "txt", "md", "png", "jpg", "doc", "xls", "ppt"]) {
		assert.ok(isConvertibleExt(e), `${e} 应可转换`);
	}
	for (const e of ["gif", "bmp", "webp", "epub", "rtf", "exe", ""]) {
		assert.equal(isConvertibleExt(e), false, `${e} 不应可转换`);
	}
});
