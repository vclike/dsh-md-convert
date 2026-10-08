/**
 * W4-2 图片本地 OCR — 单测。
 *
 * 图片此前只走 markitdown/tesseract:语言硬编码、首次要从 jsdelivr CDN 下 traineddata
 * 且写进 CWD、失败无离线回退。现在优先本地 RapidOCR(模型随包内置,完全离线)。
 * 本用例在 rapidocr 不可用时不会假绿:改断言"优雅回落 + 有告警"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFile } from "../lib/core/convert.js";

/** 用 pymupdf 内置 CJK 字体造一张含中文的 PNG;环境不可用则返回 null(跳过) */
function makeCjkPng(dir) {
	const out = join(dir, "cjk.png");
	const script = [
		"import pymupdf, sys",
		"d = pymupdf.open()",
		"p = d.new_page(width=600, height=200)",
		"p.insert_text((36, 60), '鹏瑞利青羊广场 圣诞美陈方案', fontname='china-s', fontsize=20)",
		"p.insert_text((36, 110), '回标截止 2026-10-20', fontname='china-s', fontsize=16)",
		"p.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(sys.argv[1])",
		"d.close()",
	].join("\n");
	try {
		execFileSync("python", ["-c", script, out], { timeout: 60_000, stdio: "ignore" });
	} catch {
		return null;
	}
	return existsSync(out) ? out : null;
}

test("W4-2: 图片优先本地离线 OCR(image-ocr),产物含识别文本", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-img-"));
	const png = makeCjkPng(dir);
	if (!png) {
		console.log("SKIP: 本机 python/pymupdf 不可用,无法构造图片夹具");
		return;
	}
	const r = await convertFile(png, { outDir: dir });
	assert.equal(r.ok, true, r.error ?? "");
	const md = readFileSync(r.outFile, "utf8");
	if (/^image-ocr/.test(String(r.chain))) {
		// 主路径: 本地 RapidOCR
		assert.ok(md.includes("圣诞美陈") || md.includes("鹏瑞利"), `应识别出中文: ${md.slice(0, 200)}`);
		assert.ok((r.warnings ?? []).some((w) => w.includes("[图片OCR]")), `应有本地识别告警: ${JSON.stringify(r.warnings)}`);
	} else {
		// rapidocr 缺失时的优雅回落(不得假绿):必须明确告知已回落 markitdown/tesseract
		assert.ok(
			(r.warnings ?? []).some((w) => w.includes("本地图片 OCR 不可用")),
			`回落路径必须透出原因: chain=${r.chain} warnings=${JSON.stringify(r.warnings)}`,
		);
		assert.ok(md.trim().length > 0, "回落产物不得为空(否则应报错而不是 ok)");
	}
});
