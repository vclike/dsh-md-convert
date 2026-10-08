/**
 * dsh-md-convert — 单张图片的本地 OCR 桥(v0.7.2 W4-2)
 *
 * 走 lib/py/ocr_image.py(RapidOCR;**模型随包内置 → 完全离线**)。
 * 图片此前只走 markitdown 的 tesseract.js:语言硬编码、首次要从 jsdelivr CDN 下
 * traineddata 且写进 CWD、失败无离线回退。详见 ocr_image.py 头注释。
 *
 * 协议: python 打印单行 JSON {ok, engine, lines, md} 或 {ok:false, error}。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPython } from "./deps.js";
import { runAsync } from "./spawn.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "py", "ocr_image.py");

/**
 * @param {string} imagePath
 * @param {{python?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, md?: string, lines?: string[], engine?: string, error?: string, unavailable?: boolean}>}
 */
export async function ocrImageLocal(imagePath, opts = {}) {
	const python = opts.python || detectPython("");
	if (!python) return { ok: false, unavailable: true, error: "python 不可用,跳过本地图片 OCR" };
	let r;
	try {
		r = await runAsync(python, [SCRIPT, String(imagePath)], { timeout: opts.timeoutMs ?? 180_000 });
	} catch (e) {
		return { ok: false, error: `本地图片 OCR 执行异常:${String(e?.message ?? e).slice(0, 160)}` };
	}
	let parsed = null;
	try {
		parsed = JSON.parse(String(r.stdout ?? "").trim());
	} catch { /* 非 JSON → 走 exit/stderr 摘要 */ }
	if (parsed && parsed.ok === true) {
		return { ok: true, md: String(parsed.md ?? ""), lines: Array.isArray(parsed.lines) ? parsed.lines : [], engine: parsed.engine ?? "rapidocr" };
	}
	const tail = String(r.stderr ?? "").trim().split("\n").slice(-3).join("\n");
	return {
		ok: false,
		unavailable: Boolean(parsed && /依赖不可用/.test(String(parsed.error ?? ""))),
		error: (parsed && parsed.error) || `本地图片 OCR 失败(exit ${r.status}):${tail || "(无输出)"}`,
	};
}
