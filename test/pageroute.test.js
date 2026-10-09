/**
 * v0.6.4 单测 — 页级局部 vision 路由(P1-1 骨架):
 *   normalizeOnlyPages / computeBatchesForPages(子集切批)
 *   visionHintsFromPages / visionHintMessage(convert.js)
 *   makeVisionBrief onlyPages(子集渲染参数 + plan.source.pageList + 子集 finalOutput)
 *   assemblePlan 子集计划(coverage 只考察 pageList)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBatchesForPages, normalizeOnlyPages, makeVisionBrief, buildFigureList, renderTemplate } from "../lib/core/vision.js";
import { visionHintsFromPages, visionHintMessage, injectImages } from "../lib/core/convert.js";
import { assemblePlan } from "../lib/core/assemble.js";

/* ---------------- normalizeOnlyPages ---------------- */

test("normalizeOnlyPages: 数组/逗号串/单数字归一化为升序去重", () => {
	assert.deepEqual(normalizeOnlyPages([7, 5, 5, 12]), [5, 7, 12]);
	assert.deepEqual(normalizeOnlyPages("9,3,7"), [3, 7, 9]);
	assert.deepEqual(normalizeOnlyPages(5), [5]);
	assert.deepEqual(normalizeOnlyPages(" 8 , 2 "), [2, 8]);
});

test("normalizeOnlyPages: 无效输入收敛为 null", () => {
	assert.equal(normalizeOnlyPages(null), null);
	assert.equal(normalizeOnlyPages(""), null);
	assert.equal(normalizeOnlyPages([]), null);
	assert.equal(normalizeOnlyPages(["abc", -1]), null);
	assert.equal(normalizeOnlyPages(0), null);
});

/* ---------------- computeBatchesForPages ---------------- */

test("computeBatchesForPages: 子集升序去重 + batchSize 切段", () => {
	const batches = computeBatchesForPages([9, 5, 5, 7], 2);
	assert.deepEqual(batches.map((b) => b.id), ["batch-01", "batch-02"]);
	assert.deepEqual(batches[0].pages, [5, 7]);
	assert.deepEqual(batches[1].pages, [9]);
	assert.equal(batches[0].from, 5);
	assert.equal(batches[1].to, 9);
});

test("computeBatchesForPages: 空输入 → 空数组(不抛错)", () => {
	assert.deepEqual(computeBatchesForPages([]), []);
	assert.deepEqual(computeBatchesForPages(null), []);
});

/* ---------------- buildFigureList(v0.7.16) ---------------- */

test("buildFigureList: 只收本批页号的候选,且用 images/ 相对前缀", () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-fig-"));
	writeFileSync(join(dir, "p001_01.png"), "x");
	writeFileSync(join(dir, "p001_02.png"), "x");
	writeFileSync(join(dir, "p002_01.png"), "x"); // 不在本批 → 必须被过滤
	writeFileSync(join(dir, "readme.txt"), "x"); // 非 png → 必须被过滤
	const out = buildFigureList([1], dir, true);
	assert.match(out, /images\/p001_01\.png/);
	assert.match(out, /images\/p001_02\.png/);
	assert.doesNotMatch(out, /p002_01/, "别批次的图不得出现(会导致臆造/错引用)");
	assert.doesNotMatch(out, /readme/);
});

test("buildFigureList: 未启用抽图 / 无候选 → 明确提示而非留空", () => {
	// 留空会让模型自行编造图片路径;必须给出显式说明。
	assert.match(buildFigureList([1], "/nonexistent", false), /未抽取/);
	assert.match(buildFigureList([1], "/nonexistent", true), /无已抽取的插图候选/);
});

test("renderTemplate: 内置模板严格模式缺变量抛错;自定义模板保持宽松", () => {
	// strict(内置模板):变量漏传必须炸出来,否则转写 agent 收到残缺提示词却不知情。
	assert.throws(() => renderTemplate("a {{FIGURE_FILES}} b", {}, { strict: true }), /未提供的变量/);
	// 宽松(用户自定义模板):既有契约 —— 缺失变量替换为空串,不炸。
	assert.equal(renderTemplate("a {{CUSTOM}} b", {}), "a  b");
	assert.equal(renderTemplate("A={{BATCH_ID}} C={{MISSING}}", { BATCH_ID: "b" }), "A=b C=");
});

/* ---------------- injectImages(v0.7.16) ---------------- */

test("injectImages: 图片插进对应页锚点块内,且不破坏锚点", () => {
	const md = ["<!--PAGE:01-->", "正文一", "<!--/PAGE:01-->", "", "<!--PAGE:02-->", "正文二", "<!--/PAGE:02-->"].join("\n");
	const out = injectImages(md, [{ no: 2, images: [{ file: "images/p002_01.png", page: 2 }] }]);
	assert.match(out, /正文二\s*!\[第 2 页插图\]\(images\/p002_01\.png\)/);
	// 关键:锚点闭合标签必须仍在图片之后(否则块结构被破坏 → 装配会错位)
	assert.match(out, /images\/p002_01\.png\)[\s\S]*<!--\/PAGE:02-->/);
	// 未指定的页不得被污染
	assert.doesNotMatch(out.slice(0, out.indexOf("PAGE:02")), /images\//);
});

test("injectImages: 幂等(重复调用不叠加)+ 无图/无锚点安全", () => {
	const md = "<!--PAGE:01-->\n正文\n<!--/PAGE:01-->";
	const pages = [{ no: 1, images: [{ file: "images/p001_01.png", page: 1 }] }];
	const once = injectImages(md, pages);
	assert.equal(injectImages(once, pages), once, "第二次注入应无变化");
	assert.equal(injectImages(md, []), md);
	assert.equal(injectImages(md, [{ no: 9, images: [{ file: "images/x.png", page: 9 }] }]), md, "锚点不存在时应安全跳过");
});

/* ---------------- visionHints ---------------- */

test("visionHintsFromPages: 阈值命中页提取,无命中/无数据 → null", () => {
	const hints = visionHintsFromPages([
		{ no: 4, imgRatio: 0.0 },
		{ no: 5, imgRatio: 0.224 },
		{ no: 6, imgRatio: 0.001 },
		{ no: 9 },
	]);
	assert.equal(hints.threshold, 0.15);
	assert.deepEqual(hints.pages, [5]);
	assert.deepEqual(hints.detail, [{ page: 5, imgRatio: 0.224 }]);
	assert.equal(visionHintsFromPages([{ no: 1, imgRatio: 0.01 }]), null);
	assert.equal(visionHintsFromPages(undefined), null);
});

test("visionHintMessage: 含页号/占比/后续动作指引", () => {
	const msg = visionHintMessage(visionHintsFromPages([{ no: 5, imgRatio: 0.224 }]));
	assert.ok(msg.includes("第 5 页 22.4%"), msg);
	assert.ok(msg.includes('onlyPages:"5"'), msg);
	assert.ok(msg.includes("锚点块"), msg);
	assert.equal(visionHintMessage(null), "");
});

/* ---------------- makeVisionBrief onlyPages 集成 ---------------- */

test("makeVisionBrief: onlyPages → 子集渲染参数 + pageList 计划 + 子集 finalOutput", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-onlypages-"));
	const pdf = join(dir, "doc.pdf");
	writeFileSync(pdf, "%PDF-1.4 fake", "utf8");
	const seen = [];
	const r = await makeVisionBrief(pdf, {
		outDir: dir,
		vision: { onlyPages: "7,5" },
		renderPagesImpl: async (p) => {
			seen.push({ pages: p.pages });
			return {
				ok: true,
				pages: 2,
				pageList: [5, 7],
				dir: join(dir, "doc.vision", "pages"),
				files: [join(dir, "doc.vision", "pages", "p-05.png"), join(dir, "doc.vision", "pages", "p-07.png")],
			};
		},
	});
	assert.equal(r.ok, true, `应成功: ${r.error ?? ""}`);
	assert.deepEqual(seen, [{ pages: [5, 7] }], "渲染应收到归一化后的页子集");
	assert.equal(r.planPath && existsSync(r.planPath), true);
	assert.equal(r.batches.length, 1);
	assert.deepEqual(r.batches[0].pages, [5, 7]);
	const plan = JSON.parse(await import("node:fs").then((m) => m.readFileSync(r.planPath, "utf8")));
	assert.equal(plan.source.subset, true);
	assert.deepEqual(plan.source.pageList, [5, 7]);
	assert.ok(plan.assemble.finalOutput.includes("p5-p7"), `子集产物名: ${plan.assemble.finalOutput}`);
	assert.equal(plan.assemble.merge?.kind, "anchor-replace");
});

test("makeVisionBrief: 无 onlyPages → 全页计划,无 merge 段(向后兼容)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-full-"));
	const pdf = join(dir, "doc.pdf");
	writeFileSync(pdf, "%PDF-1.4 fake", "utf8");
	const r = await makeVisionBrief(pdf, {
		outDir: dir,
		renderPagesImpl: async () => ({
			ok: true,
			pages: 2,
			pageList: [1, 2],
			dir: join(dir, "pages"),
			files: [join(dir, "pages", "p-01.png"), join(dir, "pages", "p-02.png")],
		}),
	});
	assert.equal(r.ok, true);
	const plan = JSON.parse(await import("node:fs").then((m) => m.readFileSync(r.planPath, "utf8")));
	assert.equal(plan.source.subset, false);
	assert.deepEqual(plan.source.pageList, [1, 2]);
	assert.equal(plan.assemble.merge, undefined);
	// v0.6.11:全页 vision 产物加 -vision 后缀(与直提版并存,防覆盖)
	assert.ok(plan.assemble.finalOutput.endsWith("doc-vision.md"));
});

/* ---------------- assemblePlan 子集计划 ---------------- */

test("assemblePlan: 子集计划 coverage 只考察 pageList,不要求全页", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-assemble-sub-"));
	const batchOut = join(dir, "batch-01.md");
	writeFileSync(
		batchOut,
		"<!--PAGE:05-->\n\n第5页视觉转写内容,足够长以通过极短页检查的一行文字。\n\n<!--/PAGE:05-->",
		"utf8",
	);
	const planPath = join(dir, "plan.json");
	writeFileSync(
		planPath,
		JSON.stringify({
			planVersion: 1,
			kind: "md-convert-vision-brief",
			source: { pdf: "doc.pdf", base: "doc", totalPages: 9, pageList: [5], subset: true },
			render: { scale: 2 },
			batches: [{ id: "batch-01", pages: [5, 5], pageList: [5], outputFile: batchOut, status: "pending" }],
			assemble: { tool: "md_convert_assemble", planPath, finalOutput: join(dir, "doc-p5-p5.md") },
		}),
		"utf8",
	);
	const r = await assemblePlan({ planPath });
	assert.equal(r.ok, true, `装配应成功: ${r.error ?? ""}`);
	assert.deepEqual(r.coverage, { found: 1, total: 1 }, "覆盖率只考察子集");
	assert.equal(existsSync(r.output), true);
	const out = await import("node:fs").then((m) => m.readFileSync(r.output, "utf8"));
	assert.ok(out.includes("第5页视觉转写内容"), out);
	assert.ok(!out.includes("<!--PAGE:01-->"), "子集计划不得产出未覆盖页占位");
});
