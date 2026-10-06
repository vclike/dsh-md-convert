/**
 * v0.6.7 单测 — PDF 文字层引擎调序后的双引擎决策:
 *   ① pypdfium2 结构增强直提(主引擎):成功即用,不触 markitdown
 *   ② python 失败/空返回 → markitdown 兜底(子进程桥),chain=markitdown(文字层兜底)
 *   ③ 双双失败 → ok:false + attempts 两条(顺序:pypdfium2 在前)
 *   ④ pypdfium2 成功且含图像页 → visionHints 随结果透出
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPdfTextLayer } from "../lib/core/convert.js";

const goodMd = "# 标题\n\n" + "x".repeat(50);

test("文字层①: pypdfium2 成功 → via=pypdfium2,不触 markitdown(主引擎)", async () => {
	let markitdownCalled = 0;
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => { markitdownCalled++; return goodMd; },
			pythonText: async () => ({ ok: true, md: "y".repeat(50), pages: [{ no: 1, imgRatio: 0 }] }),
		},
	});
	assert.equal(r.ok, true);
	assert.equal(r.via, "pypdfium2");
	assert.equal(r.chain, "pypdfium2(结构增强直提)");
	assert.equal(markitdownCalled, 0, "pypdfium2 成功不得触发 markitdown 兜底");
	assert.equal(r.attempts.length, 1);
});

test("文字层②: python 失败 → markitdown 兜底成功,失败原因进 attempts", async () => {
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => goodMd,
			pythonText: async () => ({ ok: false, error: "extract_text 执行失败(exit 1)" }),
		},
	});
	assert.equal(r.ok, true);
	assert.equal(r.via, "markitdown");
	assert.equal(r.chain, "markitdown(文字层兜底)");
	assert.equal(r.attempts[0].via, "pypdfium2");
	assert.equal(r.attempts[0].ok, false);
	assert.ok(r.attempts[0].error.includes("exit 1"));
});

test("文字层③: python 空返回(过短) → markitdown 兜底", async () => {
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => goodMd,
			pythonText: async () => ({ ok: true, md: "短", pages: [] }),
		},
	});
	assert.equal(r.ok, true);
	assert.equal(r.via, "markitdown");
	assert.ok(r.attempts[0].error.includes("文字层为空或过短"));
});

test("文字层④: 双双失败 → ok:false + attempts 两条(pypdfium2 在前)", async () => {
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => { throw new Error("host quirk"); },
			pythonText: async () => ({ ok: false, error: "extract_text 执行失败(exit 1)" }),
		},
	});
	assert.equal(r.ok, false);
	assert.ok(r.error.includes("文字层不可用"));
	assert.ok(r.error.includes("host quirk"));
	assert.equal(r.attempts.length, 2);
	assert.equal(r.attempts[0].via, "pypdfium2");
	assert.equal(r.attempts[1].via, "markitdown");
});

test("文字层⑤: pypdfium2 成功且含图像页 → visionHints 随结果透出", async () => {
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => goodMd,
			pythonText: async () => ({ ok: true, md: "y".repeat(50), pages: [{ no: 5, imgRatio: 0.224 }] }),
		},
	});
	assert.equal(r.via, "pypdfium2");
	assert.deepEqual(r.visionHints.pages, [5]);
	assert.ok(r.warnings[0].includes("图像占比"), r.warnings);
});

test("文字层⑥: 质量信号触发 → pymupdf4llm 二次提取接管(更好的产物胜出)", async () => {
	// 直提产物:表格碎片化(真机特征:11 列大量空单元格)
	const fragMd = [
		"| 公司 |  |  | 2025年Ca |  | pEx |  | 2026年C | apEx指引 |  |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		"| Alphabet |  |  | ~910-930 |  | 亿美元 |  | 1,750-1, | 850亿美元 |  |",
		"| Microsoft |  |  | 单季超400 |  | 亿美元 |  | FY2026 | 全年~1,900亿 | 元 |",
		"| Amazon |  |  | ~1,250亿 |  | 美元 |  | 持续显著增长 |  |  |",
	].join("\n");
	// pymupdf4llm 二次提取:干净三列表
	const cleanMd = ["| 公司 | 2025年CapEx | 2026年CapEx指引 |", "| --- | --- | --- |", "| Alphabet | ~910-930亿美元 | 1,750-1,850亿美元 |", "| Microsoft | 单季超400亿美元 | FY2026全年~1,900亿美元 |"].join("\n");
	let pmCalled = 0;
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => goodMd,
			pythonText: async () => ({ ok: true, md: fragMd, pages: [] }),
			pymupdf4llm: async () => { pmCalled++; return { ok: true, md: cleanMd, notes: {} }; },
		},
	});
	assert.equal(pmCalled, 1, "质量信号触发时应调用 pymupdf4llm");
	assert.equal(r.via, "pymupdf4llm");
	assert.equal(r.chain, "pymupdf4llm(段落合并直提)");
	assert.equal(r.quality.score, 100);
	assert.ok(r.warnings.some((w) => w.includes("[质量修复]")), r.warnings);
});

test("文字层⑦: pymupdf4llm 未安装 → 优雅跳过,直提产物保留 + 质量建议透出", async () => {
	const fragMd = ["| A |  |  |  |  |", "| --- | --- | --- | --- | --- |", "| 1 |  |  |  |  |", "| 2 |  |  |  |  |", "| 3 |  |  |  |  |", "| 4 |  |  |  |  |"].join("\n");
	const r = await convertPdfTextLayer("a.pdf", {
		impls: {
			markitdown: async () => goodMd,
			pythonText: async () => ({ ok: true, md: fragMd, pages: [] }),
			pymupdf4llm: async () => ({ ok: false, unavailable: true, error: "pymupdf4llm 未安装" }),
		},
	});
	assert.equal(r.via, "pypdfium2", "依赖缺失应保留直提产物");
	assert.ok(r.warnings.some((w) => w.includes("[质量信号]")), r.warnings);
});
