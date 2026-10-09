/**
 * dsh-md-convert — anytomd 子进程桥(v0.7.18)
 *
 * xlsx/xls 的结构化转换链路。anytomd(Apache-2.0,Rust+calamine)以 WASM 形态
 * 分发,**不需要 Python / .NET / 任何额外运行时**,绕开了 markitdown-node 依赖
 * createRequire 解析链的根本问题。
 *
 * 选型依据(2026-10-09 真机实测,样本含 21 处合并/135 条公式/双层表头):
 *   markitdown-node XLSXBackend 共 58 行,无 merges / formula 处理:
 *     - `isHeader: rowNumber === 1` → 双层表头被压平成数据行
 *     - 无换行转义 → 表格行被物理换行劈开,渲染器崩
 *     - formatCellValue 兜底 `String(cell)` → 无缓存值公式输出 [object Object]
 *     - 从不调用 mergeCells → 合并标题被广播重复 18 次
 *   anytomd 四项全部修复,且输出与独立 Node 逐字节一致(SHA256 验证)。
 *
 * 接缝契约(与 markitdown.js 同构):
 *   viaAnytomd(inputPath, opts?) → { md, warnings, engine:"child-process" }
 *   失败 → throw err(E_ANYTOMD, 含原因)
 *   opts.childImpl 供测试注入。
 *
 * ⚠️ Node 版本约束:anytomd 以 `import * as wasm from "./anytomd_bg.wasm"` 引入
 * WebAssembly 模块,该语法在较老 Node 上不被支持(本仓 `engines` 声明 >=18,
 * 但实测 24.21.0 / Electron 44 内置 24.18.1 均正常且**无需 --experimental-wasm-modules**)。
 * 老 Node 上本桥会失败 → convert.js 的兜底分支自动退回 markitdown,不会让功能不可用。
 * 是否把 engines 抬到 >=22 属于打包策略决定,本次不改,留待评估。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAsync } from "./spawn.js";
import { err, ERROR_CODES } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, "..", "worker", "anytomd-worker.cjs");
const TRUNC = 160;
/** 子进程桥超时(anytomd 冷启 ~28ms;大表余量给足) */
const CHILD_TIMEOUT_MS = 120_000;

/** anytomd 由 ESM import 引入 wasm,Node 会打 ExperimentalWarning 到 stderr。协议只解析 stdout,不影响;此处一并压掉以免日志噪音。 */
function childEnv() {
	return {
		...process.env,
		ELECTRON_RUN_AS_NODE: "1",
		NODE_NO_WARNINGS: "1",
	};
}

/** 子进程桥转换(ELECTRON_RUN_AS_NODE=1 原生语义,宿主内可用) */
async function viaChildProcess(inputPath) {
	const r = await runAsync(process.execPath, [WORKER, inputPath], { timeout: CHILD_TIMEOUT_MS, env: childEnv() });
	if (r.error === "timeout") {
		throw new Error(`anytomd 子进程桥超时(${Math.round(CHILD_TIMEOUT_MS / 1000)}s)`);
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
		throw new Error(`anytomd 子进程桥失败:${String(detail ?? "").slice(0, TRUNC)}`);
	}
	return { md: String(parsed.md ?? ""), warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [] };
}

/**
 * anytomd 转换主入口。
 * @param {string} inputPath 绝对路径
 * @param {object} [opts] { childImpl? }(测试注入)
 * @returns {Promise<{md: string, warnings: string[], engine: "child-process"}>}
 */
export async function viaAnytomd(inputPath, opts = {}) {
	const child = opts.childImpl ?? viaChildProcess;
	try {
		const r = await child(inputPath);
		return { md: r.md, warnings: r.warnings ?? [], engine: "child-process" };
	} catch (e) {
		throw err(ERROR_CODES.E_ANYTOMD, String(e?.message ?? e).slice(0, TRUNC));
	}
}

/**
 * 该扩展名是否走 anytomd 链路。
 *
 * 目前**仅 xlsx**。`.xls` 虽是 anytomd 的强项(calamine 原生支持,上游 sample.xls /
 * sample_unicode.xls 实测均与官方 golden 逐字节一致),但它现在被 `detect.js`
 * 的 `LEGACY_MAP` 拦在 `classify()` 之前走 WPS/Office COM 另存路径,
 * 且有既存测试 `assert.deepEqual(classify("a.XLS"), { kind: "legacy", ... })` 锁定该行为。
 * 迁移到 anytomd 可去掉对 WPS/Office COM 的外部依赖,是值得做的改进,
 * 但属于**独立的产品决策**(改变 .xls 的错误语义:失败时不再有 legacy 兜底,
 * 因为 markitdown-node 根本不支持 .xls),不混在本次接线里。
 */
export const ANYTOMD_EXT = new Set(["xlsx"]);

export function isAnytomdExt(ext) {
	return ANYTOMD_EXT.has(String(ext ?? "").toLowerCase());
}
