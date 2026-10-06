/**
 * dsh-md-convert — markitdown 双引擎桥(v0.6.5)
 *
 * ① 进程内:require("markitdown-node")——独立 node 环境最快路径;
 * ② 子进程桥:ELECTRON_RUN_AS_NODE=1 原生 Node 语义,绕开宿主进程内
 *    createRequire 解析链缺陷(2026-10-06 真机实证:DSH/Electron 宿主内
 *    docx/PDF 进程内加载均抛「createRequire.resolve.paths is not a function
 *    or its return value is not iterable」,独立环境子进程全绿)。
 *
 * 两次尝试均记录于 attempts 并随失败消息透出;双引擎都失败 →
 * err(E_MARKITDOWN)。进程内失败但子进程成功时附降级 warning。
 *
 * 接缝契约:
 *   viaMarkItDownDual(inputPath, opts?) →
 *     { ok 始终隐含, md, engine:"in-process"|"child-process", attempts, warning? }
 *   失败 → throw err(E_MARKITDOWN, 含 attempts 摘要)
 *   opts.inProcessImpl / opts.childImpl 供测试注入。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAsync } from "./spawn.js";
import { err, ERROR_CODES } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, "..", "worker", "markitdown-worker.cjs");
const TRUNC = 160;
/** 子进程桥超时(markitdown 转换毫秒~秒级;大文档余量) */
const CHILD_TIMEOUT_MS = 180_000;

/** 进程内转换(独立 node 环境下可用;Electron 宿主内加载即抛) */
async function viaInProcess(inputPath) {
	const { createRequire } = await import("node:module");
	const req = createRequire(import.meta.url);
	const { MarkItDown } = req("markitdown-node");
	const converter = new MarkItDown({
		defaultOptions: { ocrLanguages: "chi_sim+eng", extractTables: true, extractImages: false },
	});
	const result = await converter.convert(inputPath);
	if (!result || result.status !== "success") {
		const errs = Array.isArray(result?.errors) ? result.errors.join("; ") : "未知原因";
		throw new Error(`markitdown 转换失败:${errs.slice(0, TRUNC)}`);
	}
	return String(result.markdown_content ?? "");
}

/** 子进程桥转换(ELECTRON_RUN_AS_NODE=1 原生语义,宿主内可用) */
async function viaChildProcess(inputPath) {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	const r = await runAsync(process.execPath, [WORKER, inputPath], { timeout: CHILD_TIMEOUT_MS, env });
	if (r.error === "timeout") {
		throw new Error(`子进程桥超时(${Math.round(CHILD_TIMEOUT_MS / 1000)}s)`);
	}
	let parsed = null;
	try {
		parsed = JSON.parse(String(r.stdout ?? "").trim());
	} catch {
		// stdout 非协议 JSON → 按失败处理,细节取 stderr 尾部
	}
	if (!parsed || parsed.ok !== true) {
		const detail = parsed?.error
			?? (String(r.stderr ?? "").trim().split("\n").slice(-2).join(" ") || `(exit ${r.status})`);
		throw new Error(`markitdown 子进程桥失败:${slice2(detail)}`);
	}
	return String(parsed.md ?? "");
}

function slice2(s) {
	return String(s ?? "").slice(0, TRUNC);
}

/**
 * markitdown 双引擎转换主入口。
 * @param {string} inputPath 绝对路径
 * @param {object} [opts] { inProcessImpl?, childImpl? }(测试注入)
 * @returns {Promise<{md: string, engine: "in-process"|"child-process",
 *                     attempts: object[], warning?: string}>}
 */
export async function viaMarkItDownDual(inputPath, opts = {}) {
	const attempts = [];
	try {
		const inProc = opts.inProcessImpl ?? viaInProcess;
		const md = await inProc(inputPath);
		return { md, engine: "in-process", attempts };
	} catch (e) {
		attempts.push({ engine: "in-process", ok: false, error: String(e?.message ?? e).slice(0, TRUNC) });
	}
	try {
		const child = opts.childImpl ?? viaChildProcess;
		const md = await child(inputPath);
		return {
			md,
			engine: "child-process",
			attempts,
			warning: `进程内 markitdown 不可用(${attempts[0].error}),已用子进程桥完成(ELECTRON_RUN_AS_NODE 原生语义)`,
		};
	} catch (e) {
		attempts.push({ engine: "child-process", ok: false, error: String(e?.message ?? e).slice(0, TRUNC) });
	}
	throw err(
		ERROR_CODES.E_MARKITDOWN,
		`markitdown 双引擎均失败:${attempts.map((a) => `${a.engine}: ${a.error}`).join("; ")}`,
	);
}
