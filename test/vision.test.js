/**
 * T3 单测 — vision 任务书生成:切批/模板实例化/plan.json 契约/失败路径
 * 渲染步经 renderPagesImpl 测试替身注入,不启动真实 Python。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBatches, makeVisionBrief, renderTemplate } from "../lib/core/vision.js";
import { ERROR_CODES } from "../lib/core/errors.js";

function tmpWorkspace(tag) {
	return mkdtempSync(join(tmpdir(), `mdc-t3-${tag}-`));
}

/** 假渲染:返回 pages 页的清单(files 与 pages 严格对齐) */
function fakeRender(pages) {
	return async ({ outDir }) => ({
		ok: true,
		pages,
		dir: outDir,
		files: Array.from({ length: pages }, (_, i) => join(outDir, `p-${String(i + 1).padStart(2, "0")}.png`)),
	});
}

/* ---------------- computeBatches ---------------- */

test("computeBatches: 97 页/批 8 → 13 批,末批 1 页", () => {
	const batches = computeBatches(97, 8);
	assert.equal(batches.length, 13);
	assert.deepEqual(batches[0].pages, [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.deepEqual(batches.at(-1).pages, [97]);
	assert.equal(batches.at(-1).id, "batch-13");
	assert.equal(batches[0].id, "batch-01");
});

test("computeBatches: 整除/单页/默认批大小/非法批大小", () => {
	assert.deepEqual(computeBatches(16, 8).map((b) => [b.from, b.to]), [[1, 8], [9, 16]]);
	assert.deepEqual(computeBatches(1, 8).map((b) => [b.from, b.to]), [[1, 1]]);
	assert.deepEqual(computeBatches(3, 0).length, 1, "非法批大小回退默认 8 → 单批");
	assert.deepEqual(computeBatches(9, 4).map((b) => [b.from, b.to]), [[1, 4], [5, 8], [9, 9]]);
	// 连续性与无重无漏
	for (const total of [1, 7, 8, 9, 23, 97]) {
		const all = computeBatches(total, 8).flatMap((b) => b.pages);
		assert.equal(all.length, total);
		assert.deepEqual(all, Array.from({ length: total }, (_, i) => i + 1), `total=${total} 覆盖不连续`);
	}
});

/* ---------------- renderTemplate ---------------- */

test("renderTemplate: 变量全量替换;缺失变量不留残影", () => {
	const out = renderTemplate("A={{BATCH_ID}} B={{TOTAL_PAGES}} C={{MISSING}}", {
		BATCH_ID: "batch-02",
		TOTAL_PAGES: 97,
	});
	assert.equal(out, "A=batch-02 B=97 C=");
});

/* ---------------- makeVisionBrief ---------------- */

test("makeVisionBrief: 渲染→切批→提示词→plan.json 全链路(3 页单批)", async () => {
	const ws = tmpWorkspace("brief");
	const outDir = join(ws, "md");
	const r = await makeVisionBrief(join(ws, "采购文件.pdf"), {
		outDir,
		ocrScale: 2,
		vision: { batchSize: 8, renderScale: 2 },
		renderPagesImpl: fakeRender(3),
	});
	assert.equal(r.ok, true);
	assert.equal(r.mode, "vision-brief");
	assert.equal(r.chain, "vision-brief");
	assert.ok(r.planPath.endsWith(join("采购文件.vision", "plan.json")));
	assert.equal(r.batches.length, 1);
	const b = r.batches[0];
	// v0.6.4 语义:pages 为完整页列表([1,2,3]),旧二元组 [1,3] 已弃用
	assert.deepEqual(b.pages, [1, 2, 3]);
	assert.deepEqual([b.from, b.to], [1, 3]);
	assert.ok(b.promptFile.includes(join("prompts", "batch-01.md")));
	assert.ok(b.outputFile.includes(join("outputs", "batch-01.md")));

	// 提示词实例化:变量全部落地
	const prompt = readFileSync(b.promptFile, "utf8");
	assert.ok(prompt.includes("batch-01"));
	assert.ok(prompt.includes("第 1-3 页(共 3 页)"));
	assert.ok(prompt.includes(b.outputFile));
	assert.ok(prompt.includes("(第 2 页)"));
	assert.ok(prompt.includes("<!--PAGE:02-->"));
	assert.ok(!prompt.includes("{{"), "模板变量不得残留");

	// output 占位存在
	assert.equal(existsSync(b.outputFile), true);

	// plan.json 契约
	const plan = JSON.parse(readFileSync(r.planPath, "utf8"));
	assert.equal(plan.kind, "md-convert-vision-brief");
	assert.equal(plan.source.totalPages, 3);
	assert.equal(plan.batches.length, 1);
	assert.equal(plan.batches[0].status, "pending");
	assert.equal(plan.batches[0].imageFiles.length, 3);
	assert.ok(plan.outputContract.anchorRegex.includes("<!--PAGE:"));
	assert.equal(plan.assemble.tool, "md_convert_assemble");
	// v0.6.11:全页 vision 产物加 -vision 后缀(与直提版并存,防覆盖)
	assert.ok(plan.assemble.finalOutput.endsWith(join(outDir, "采购文件-vision.md")));
	assert.ok(existsSync(join(outDir, "采购文件.vision", "pages")));
});

test("makeVisionBrief: 10 页批 4 → 3 批,各批 imageFiles 与页段对齐", async () => {
	const ws = tmpWorkspace("slice");
	const r = await makeVisionBrief(join(ws, "doc.pdf"), {
		outDir: ws,
		vision: { batchSize: 4 },
		renderPagesImpl: fakeRender(10),
	});
	assert.equal(r.batches.length, 3);
	const plan = JSON.parse(readFileSync(r.planPath, "utf8"));
	// v0.6.4 语义:pages 为完整页列表(旧版为 [from,to] 二元组,子集计划会抹掉中间页)
	assert.deepEqual(plan.batches.map((b) => b.pages), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
	assert.deepEqual(plan.batches.map((b) => [b.from, b.to]), [[1, 4], [5, 8], [9, 10]]);
	assert.deepEqual(plan.batches.map((b) => b.pageList), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
	assert.deepEqual(plan.source.pageList, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.equal(plan.source.subset, false);
	assert.deepEqual(plan.batches[2].imageFiles.length, 2);
	// 第 2 批首图 = 第 5 页
	assert.ok(plan.batches[1].imageFiles[0].endsWith("p-05.png"));
});

test("makeVisionBrief: 自定义模板整体覆盖(相对路径基于 cwd)", async () => {
	const ws = tmpWorkspace("tpl");
	writeFileSync(join(ws, "my-template.md"), "自定义 {{BATCH_ID}} / {{PAGE_RANGE}} / {{IMAGE_FILES}}", "utf8");
	const r = await makeVisionBrief(join(ws, "doc.pdf"), {
		outDir: ws,
		vision: { batchSize: 8, promptTemplate: "my-template.md" },
		cwd: ws,
		renderPagesImpl: fakeRender(2),
	});
	assert.equal(r.ok, true);
	const prompt = readFileSync(r.batches[0].promptFile, "utf8");
	assert.ok(prompt.startsWith("自定义 batch-01"));
	assert.ok(prompt.includes("第 1-2 页(共 2 页)"));
	const plan = JSON.parse(readFileSync(r.planPath, "utf8"));
	assert.equal(plan.promptTemplate.overridden, true);
});

test("makeVisionBrief: 渲染失败 → E_VISION_PLAN(不抛错)", async () => {
	const ws = tmpWorkspace("rfail");
	const r = await makeVisionBrief(join(ws, "doc.pdf"), {
		outDir: ws,
		renderPagesImpl: async () => ({ ok: false, error: "PDF 打开失败" }),
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_VISION_PLAN);
	assert.ok(r.error.includes("页面渲染失败"));
});

test("makeVisionBrief: 渲染清单页数与文件数不一致 → E_VISION_PLAN", async () => {
	const ws = tmpWorkspace("mismatch");
	const r = await makeVisionBrief(join(ws, "doc.pdf"), {
		outDir: ws,
		renderPagesImpl: async () => ({ ok: true, pages: 5, dir: ws, files: [] }),
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_VISION_PLAN);
	assert.ok(r.error.includes("清单异常"));
});

test("makeVisionBrief: 模板不可读 → E_VISION_PLAN", async () => {
	const ws = tmpWorkspace("nofpl");
	const r = await makeVisionBrief(join(ws, "doc.pdf"), {
		outDir: ws,
		vision: { promptTemplate: "不存在的模板.md" },
		cwd: ws,
		renderPagesImpl: fakeRender(1),
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_VISION_PLAN);
	assert.ok(r.error.includes("提示词模板不可读"));
});

test("makeVisionBrief: 缺 outDir → 收敛为 E_VISION_PLAN(永不抛错)", async () => {
	const r = await makeVisionBrief("doc.pdf", { renderPagesImpl: fakeRender(1) });
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_VISION_PLAN);
});

test("makeVisionBrief: 内置模板存在且含全部协议变量", async () => {
	const tpl = readFileSync(new URL("../lib/py/prompts/vision-ocr.md", import.meta.url), "utf8");
	for (const v of ["{{BATCH_ID}}", "{{PAGE_RANGE}}", "{{OUTPUT_FILE}}", "{{TOTAL_PAGES}}", "{{IMAGE_FILES}}", "{{PAGES_LIST}}"]) {
		assert.ok(tpl.includes(v), `内置模板缺变量 ${v}`);
	}
	assert.ok(tpl.includes("<!--PAGE:"), "内置模板必须约束页锚点格式");
});
