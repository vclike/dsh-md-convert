/**
 * dsh-md-convert — PDF 文字层 python 兜底桥接(v0.6.2)
 *
 * markitdown-node 在宿主运行时(Electron 内置 Node)内对部分文字层 PDF 失败时,
 * 用本来就依赖的 pypdfium2(lib/py/extract_text.py)直提文字层——秒级、零新增依赖。
 * 纯文字提取无版面结构,产出按 <!--PAGE:NN--> 锚点保序,便于与 PDF 逐页对照。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAsync } from "./spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
export const EXTRACT_TEXT_SCRIPT = join(here, "..", "py", "extract_text.py");
export const PYMUPDF4LLM_SCRIPT = join(here, "..", "py", "pymupdf4llm_extract.py");

/**
 * PyMuPDF4LLM 二次提取(v0.6.14 质量信号触发引擎)。
 * 场景: 直提产物碎片化(assessMdQuality score<70)时,用 pymupdf4llm 成熟的
 * 段落合并/表格检测重提;纯本地无 ML 模型,零 token。依赖可选(未安装优雅跳过)。
 * @returns {Promise<{ok: boolean, md?: string, notes?: object, error?: string, unavailable?: boolean}>}
 */
export async function pymupdf4llmExtract({ python, pdf, timeoutMs = 120_000, pages = "" }) {
	if (!python) return { ok: false, unavailable: true, error: "python 不可用,跳过 pymupdf4llm" };
	const args = [PYMUPDF4LLM_SCRIPT, String(pdf)];
	if (String(pages ?? "").trim()) args.push("--pages", String(pages).trim()); // v0.7.3 W4-4
	let r;
	try {
		r = await runAsync(python, args, { timeout: timeoutMs });
	} catch (e) {
		return { ok: false, error: `pymupdf4llm 执行异常:${String(e?.message ?? e).slice(0, 160)}` };
	}
	if (r.status !== 0) {
		return { ok: false, error: `pymupdf4llm 执行失败(exit ${r.status})` };
	}
	let parsed;
	try {
		parsed = JSON.parse(String(r.stdout ?? "").trim());
	} catch (e) {
		return { ok: false, error: `pymupdf4llm 输出解析失败:${String(e?.message ?? e).slice(0, 160)}` };
	}
	if (parsed && parsed.ok === false) {
		const msg = String(parsed.error ?? "");
		// 依赖缺失=可选引擎不可用,不进 attempts 报错链
		return { ok: false, unavailable: msg.includes("未安装"), error: msg };
	}
	return { ok: true, md: String(parsed?.md ?? ""), notes: parsed?.notes ?? null };
}

/**
 * 提取 PDF 文字层(python pypdfium2;零 OCR)。
 * @param {object} p
 * @param {string} p.python Python 解释器路径
 * @param {string} p.pdf PDF 绝对路径
 * @param {number} [p.timeoutMs=30000] 超时(纯文字提取毫秒级)
 * @returns {Promise<{ok: boolean, md?: string, total?: number, error?: string}>}
 *          md 为 <!--PAGE:NN--> 锚点页块拼接(空页跳过,不含标题——由 assembleAndWrite 统一加)
 */
export async function extractPdfTextPython({ python, pdf, timeoutMs = 30_000, pages = "", imageDir = "", imageMinArea, imageMaxArea }) {
	if (!python) return { ok: false, error: "python 不可用,文字层兜底跳过" };
	const args = [EXTRACT_TEXT_SCRIPT, String(pdf)];
	if (String(pages ?? "").trim()) args.push("--pages", String(pages).trim()); // v0.7.3 W4-4
	// v0.7.16:文中插图抽取。imageDir 为空 → 完全不传该开关(默认不抽,行为与旧版一致)。
	if (String(imageDir ?? "").trim()) {
		args.push("--extract-images", String(imageDir).trim());
		if (Number.isFinite(imageMinArea)) args.push("--image-min-area", String(imageMinArea));
		if (Number.isFinite(imageMaxArea)) args.push("--image-max-area", String(imageMaxArea));
	}
	let r;
	try {
		r = await runAsync(python, args, { timeout: timeoutMs });
	} catch (e) {
		return { ok: false, error: `extract_text 执行异常:${String(e?.message ?? e).slice(0, 160)}` };
	}
	if (r.status !== 0) {
		// v0.7.2 W4-5: 非 0 退出也可能是**结构化错误**(python 打印 JSON 后 return 1,如
		// E_ENCRYPTED)—— 优先取它,否则会把错误码吞掉、上层只能看到 stderr 摘要而无法短路。
		let structured = null;
		try {
			const p = JSON.parse(String(r.stdout ?? "").trim());
			if (p && p.ok === false) structured = p;
		} catch { /* stdout 非 JSON(stderr 摘要路径) */ }
		if (structured) return { ok: false, code: structured.code, error: structured.error ?? "extract_text 返回失败" };
		const tail = String(r.stderr ?? r.error ?? "").trim().split("\n").slice(-3).join("\n");
		return { ok: false, error: `extract_text 执行失败(exit ${r.status}):${tail || "(无输出)"}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(String(r.stdout ?? "").trim());
	} catch (e) {
		return { ok: false, error: `extract_text 输出解析失败:${String(e?.message ?? e).slice(0, 160)}` };
	}
	if (parsed && parsed.ok === false) {
		// v0.7.2 W4-5: 透传 python 侧错误码(如 E_ENCRYPTED),供上层短路
		return { ok: false, code: parsed.code, error: parsed.error ?? "extract_text 返回失败" };
	}
	const pageList = Array.isArray(parsed?.pages) ? parsed.pages : [];
	const block = (no, text) => {
		const a = String(no).padStart(2, "0");
		return `<!--PAGE:${a}-->\n\n${String(text).trim()}\n\n<!--/PAGE:${a}-->`;
	};
	const md = pageList
		.filter((p) => p && Number.isInteger(p.no) && String(p.text ?? "").trim())
		.map((p) => block(p.no, p.text))
		.join("\n\n");
	// v0.6.4:pages 原样透传(含逐页 img_ratio),供上游 visionHints 页级局部路由决策
	// v0.7.16:同时透传 images(已抽出的插图)。此前这里**重建**了 pages 对象、只留 {no,imgRatio},
	// 导致下游拿不到任何插图信息 —— 表现为"抽图成功但 md 里没有图",排查绕了半天才定位到。
	return {
		ok: true,
		md,
		total: typeof parsed?.total === "number" ? parsed.total : pageList.length,
		pages: pageList
			.filter((p) => p && Number.isInteger(p.no))
			.map((p) => ({
				no: p.no,
				...(Number.isFinite(p.img_ratio) ? { imgRatio: p.img_ratio } : {}),
				...(Array.isArray(p.images) && p.images.length ? { images: p.images } : {}),
				...(Array.isArray(p.img_blocks) && p.img_blocks.length ? { imgBlocks: p.img_blocks } : {}),
			})),
		notes: parsed?.notes ?? null,
	};
}
