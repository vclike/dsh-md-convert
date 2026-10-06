/**
 * v0.6.3 回归 — engine="vision" 对有文字层的 PDF(modern 分类)必须直达 vision 任务书。
 *
 * 修复背景:此前 convertFile 的 modern-PDF 分支无条件先试文字层,
 * engine=vision 被静默吞掉(2026-10-05 火山方舟 PDF 实测:E_VISION_PLAN 永不可达)。
 * renderPagesImpl 注入假实现,不触 Python;PDF 内容任意(分类只看扩展名,
 * 文字层检查在 vision 分支中被跳过)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFile } from "../lib/core/convert.js";

function fakePageDir(dir) {
	return { ok: true, pages: 1, dir: join(dir, "pages"), files: [join(dir, "pages", "p-01.png")] };
}

test("engine=vision 显式指定 → 有文字层 PDF 直达 vision 任务书(不被文字层抢先)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-vision-"));
	const pdf = join(dir, "doc.pdf");
	writeFileSync(pdf, "%PDF-1.4 fake text layer", "utf8");
	const calls = [];
	const r = await convertFile(pdf, {
		outDir: dir,
		engine: "vision",
		renderPagesImpl: async (p) => {
			calls.push(p.pdf);
			return fakePageDir(dir);
		},
	});
	assert.equal(r.ok, true, `转换应成功: ${r.error ?? ""}`);
	assert.equal(r.mode, "vision-brief");
	assert.equal(r.chain, "vision-brief");
	assert.equal(r.decision?.route, "vision");
	assert.ok(r.planPath && existsSync(r.planPath), "plan.json 应落盘");
	assert.equal(r.batches.length, 1);
	assert.deepEqual(calls, [pdf], "renderPagesImpl 应恰好被调用一次");
});

test("engine=vision 显式指定 → 渲染失败返回 E_VISION_PLAN(不静默降级为文字层)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-vision-fail-"));
	const pdf = join(dir, "doc.pdf");
	writeFileSync(pdf, "%PDF-1.4 fake", "utf8");
	const r = await convertFile(pdf, {
		outDir: dir,
		engine: "vision",
		renderPagesImpl: async () => ({ ok: false, error: "渲染失败(注入)" }),
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_VISION_PLAN");
	assert.ok(r.error.includes("渲染失败"), "失败原因应透出");
});
