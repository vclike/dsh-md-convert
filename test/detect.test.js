/**
 * W4-1 格式白名单与引擎能力对齐 — 单测。
 *
 * 不变量(防漂移): 白名单**不得**包含引擎没有 backend 的扩展名 —— 否则用户会收到
 * "Unable to detect document format" 这种误导错误(以为文件坏了)。
 * 期望集镜像自 markitdown-node/dist/index.cjs:2032-2057 的 extensionToFormat。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classify,
	ENGINE_NO_BACKEND_EXT,
	ENGINE_UNSUPPORTED_EXT,
	MARKITDOWN_EXT,
	LEGACY_MAP,
	NO_BACKEND_HINT,
	isModernExt,
} from "../lib/core/detect.js";

/** 引擎真实支持的扩展名(与 dist 的 extensionToFormat 逐一对应;改动此文即改契约) */
const ENGINE_MAPPING = [
	"pdf", "docx", "pptx", "xlsx", "html", "htm", "vtt", "srt",
	"png", "jpg", "jpeg", "tiff", "tif", "csv", "json", "txt", "xml", "rss", "atom",
	"zip", "ipynb",
];

test("W4-1: 白名单与引擎 mapping 一致(不含无 backend 的扩展名)", () => {
	for (const ext of MARKITDOWN_EXT) {
		assert.ok(ENGINE_MAPPING.includes(ext), `白名单里的 ${ext} 在引擎 mapping 中不存在(会误导用户)`);
	}
	for (const ext of ENGINE_MAPPING) {
		assert.ok(MARKITDOWN_EXT.has(ext), `引擎支持的 ${ext} 应放行(白名单漏支持)`);
	}
});

test("W4-1: gif/bmp/webp 不再假支持 —— 明确报不支持而非误导错误", () => {
	for (const ext of ["gif", "bmp", "webp"]) {
		assert.ok(ENGINE_UNSUPPORTED_EXT.has(ext), `${ext} 应标记为引擎无后端`);
		assert.equal(isModernExt(ext), false, `${ext} 不得留在白名单`);
		assert.equal(classify(`x.${ext}`).kind, "unsupported");
	}
	// 黑白名单不得交叉
	for (const ext of ENGINE_UNSUPPORTED_EXT) {
		assert.ok(!MARKITDOWN_EXT.has(ext), `${ext} 不得同时出现在两侧`);
	}
});

test("W4-1: zip 放行(引擎有 ZIPBackend);md/markdown 仍走插件自身纯文本链", () => {
	assert.equal(classify("a.zip").kind, "modern");
	assert.ok(isModernExt("zip"));
	assert.equal(classify("a.md").kind, "modern");
	assert.equal(classify("a.markdown").kind, "modern");
	assert.equal(classify("a.txt").kind, "modern");
});

/* ── P4 / W4-8 + W4-10: 宏格式与 EPUB ────────────────────────────────────
 * 计划原写"W4-8 补宏格式白名单",**实测后判定为错误**:
 * 引擎 extensionToFormat 实测不含 docm/xlsm/pptm/epub。
 * 若放行 → 用户看到 "Unable to detect document format"(以为文件坏了)。
 * 正确做法:列入"引擎无后端",并给**针对该格式**的补救建议。
 * ────────────────────────────────────────────────────────────────────── */

test("W4-8/W4-10: 宏格式与 epub 引擎无后端 —— 不得进白名单", () => {
	for (const ext of ["docm", "xlsm", "pptm", "epub"]) {
		assert.ok(!MARKITDOWN_EXT.has(ext), `${ext} 绝不能进白名单(引擎无 backend)`);
		assert.equal(isModernExt(ext), false, `${ext} 不得被当作现代格式`);
		assert.equal(classify(`a.${ext}`).kind, "unsupported", `${ext} 应分类为 unsupported`);
		assert.ok(ENGINE_NO_BACKEND_EXT.has(ext), `${ext} 应标记为引擎无后端`);
	}
});

test("W4-8/W4-10: 每个无后端格式都有针对性补救建议", () => {
	for (const [ext, hint] of Object.entries(NO_BACKEND_HINT)) {
		assert.ok(hint && hint.length > 6, `${ext} 必须有可操作建议`);
	}
	// 关键:宏格式**不能**复用图片那句"转为 png/jpg"(对宏文档是荒谬建议)
	assert.ok(/docx/.test(NO_BACKEND_HINT.docm), "docm 应建议另存为 docx");
	assert.ok(/xlsx/.test(NO_BACKEND_HINT.xlsm), "xlsm 应建议另存为 xlsx");
	assert.ok(/pptx/.test(NO_BACKEND_HINT.pptm), "pptm 应建议另存为 pptx");
	assert.ok(/pdf|html/.test(NO_BACKEND_HINT.epub), "epub 应建议转为 pdf/html");
	for (const ext of Object.keys(NO_BACKEND_HINT)) {
		assert.ok(!/png\/jpg/.test(NO_BACKEND_HINT[ext]), `${ext} 不该被建议转为图片`);
	}
});

test("W4-8/W4-10: 白名单与无后端集合不得交叉", () => {
	for (const ext of ENGINE_NO_BACKEND_EXT) {
		assert.ok(!MARKITDOWN_EXT.has(ext), `${ext} 同时出现在白名单与无后端集合`);
	}
	// 旧集合仍应是无后端集合的子集(保持既有引用可用)
	for (const ext of ENGINE_UNSUPPORTED_EXT) {
		assert.ok(ENGINE_NO_BACKEND_EXT.has(ext), `${ext} 应包含在无后端总集中`);
	}
});

test("classify: legacy / 未知扩展名 / 无扩展名", () => {
	assert.deepEqual(classify("a.doc"), { kind: "legacy", ext: "doc", targetExt: LEGACY_MAP.doc });
	assert.deepEqual(classify("a.XLS"), { kind: "legacy", ext: "xls", targetExt: LEGACY_MAP.xls });
	assert.equal(classify("a.epub").kind, "unsupported");
	assert.equal(classify("a.rtf").kind, "unsupported");
	assert.equal(classify("noext").kind, "unsupported");
	assert.equal(classify("noext").ext, "");
});

test("classify: PDF 无文字层信息 → scanned 分支", () => {
	assert.deepEqual(classify("a.pdf", { hasTextLayer: false }), { kind: "scanned", ext: "pdf" });
	assert.deepEqual(classify("a.pdf"), { kind: "modern", ext: "pdf" });
});
