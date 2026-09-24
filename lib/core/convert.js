/**
 * dsh-md-convert — 核心转换流水线(v0.6.0)
 *
 * 单文件链路:
 *   modern  : markitdown 原生转换(docx/xlsx/pptx/pdf 文字层、html/csv/json/...)
 *   legacy  : WPS/Office COM 另存为现代格式 → markitdown
 *   scanned : v0.6.0 三层路由 ——
 *     ① 复杂度探针(engine=auto):parallel_ocr.py --probe 抽样 3 页版面分析
 *     ② 表格/公式占比 > vision.complexityRatio(默认 0.4) → vision 任务书链路
 *        (或可选 vision.pagesThreshold 强制换轨闸;0=不限页数)
 *     ③ 否则 → 页级并行本地 OCR(NDJSON 流式 + 锚点 upsert 增量写 .md +
 *        .progress.json + state.json 断点续跑,任意页数不依赖单次同步调用存活)
 *
 * 「后台作业化」在工具层(lib/index.js)用 ctx.jobs 实现;convertFile 始终以
 * 前台语义执行(被后台作业 run() 复用同一实现),通过 opts.signal(任务自有
 * AbortController / exec.signal)支持取消,opts.onEvent 透传协议事件。
 *
 * 所有中间文件(另存结果等)放入 TempScope 临时目录,转换结束后统一清理;
 * 并行 OCR 的页 PNG 由 Python 侧临时目录自管理(运行结束自动清理)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { classify } from "./detect.js";
import { convertLegacy } from "./legacy.js";
import { ensureOcrDeps, ocrPpstructureParallel, probeComplexity } from "./ocr.js";
import { ocrModelCacheStatus } from "./deps.js";
import { pdfPageCount } from "./jobs.js";
import { TempScope, sweepStale } from "./cleanup.js";
import { err, codeOf, ERROR_CODES } from "./errors.js";

/** PDF 文字层判定:markitdown 结果低于该字符数视为扫描件 */
const PDF_MIN_TEXT = 20;

/** 默认配置 */
const DEFAULT_OPTS = {
	outDir: null,             // 输出目录(必填)
	forceOcr: false,          // 强制 PDF 走 OCR
	ocrScale: 2,              // PDF 渲染倍率
	ocr: {},                  // OCR 配置(python)
	autoInstallDeps: true,    // 缺 OCR 依赖时自动 pip 安装
	legacy: { backend: "auto" },
	title: true,              // md 开头加源文件名标题
	meta: true,               // 末尾加转换溯源注释
	overwrite: true,          // 覆盖同名输出
	keepTemp: false,          // 调试:保留临时文件
	onLog: null,              // (msg: string) => void 进度回调(依赖安装等)
	// ---- v0.6.0 扫描件三层路由 ----
	engine: "auto",           // auto | local | vision
	resume: false,            // 断点续跑(false=全新运行,清旧状态)
	workers: 0,               // 并行 worker 数;0=脚本默认;1=进程内快速路径(沙箱/调试)
	signal: null,             // AbortSignal(前台=exec.signal;后台作业=任务自有 controller)
	onEvent: null,            // (ev) => void 协议事件透传(start/page/done)
	probeTimeoutMs: 120_000,  // 探针超时(含版面模型冷加载)
	runTimeoutMs: 7_200_000,  // 前台 OCR 总超时;后台作业传 0(不限,由 job_kill 管)
	vision: { pagesThreshold: 0, complexityRatio: 0.4 }, // 换轨闸与阈值(0=不限页数)
};

function normalizeOpts(opts = {}) {
	const o = { ...DEFAULT_OPTS, ...opts };
	o.legacy = { ...DEFAULT_OPTS.legacy, ...(opts.legacy ?? {}) };
	o.vision = { ...DEFAULT_OPTS.vision, ...(opts.vision ?? {}) };
	if (!o.outDir) throw new Error("outDir is required");
	return o;
}

function log(o, msg) {
	if (typeof o.onLog === "function") o.onLog(msg);
}

/** 目标输出路径:同目录或指定 outDir,同名 .md */
function outputPathFor(input, opts) {
	const base = basename(input).replace(/\.[^.]+$/, "") + ".md";
	return join(opts.outDir, base);
}

function metaComment(input, chain) {
	const when = new Date().toISOString();
	return `\n\n<!-- 源文件: ${basename(input)} | 链路: ${chain} | dsh-md-convert | ${when} -->\n`;
}

/** 通过 markitdown-node 转换(CJS 入口;其 ESM 入口内部 require 在纯 ESM 下不可用) */
async function viaMarkItDown(inputPath) {
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const { MarkItDown } = require("markitdown-node");
	const converter = new MarkItDown({
		defaultOptions: { ocrLanguages: "chi_sim+eng", extractTables: true, extractImages: false },
	});
	const result = await converter.convert(inputPath);
	if (result?.status !== "success") {
		throw err(ERROR_CODES.E_MARKITDOWN, `markitdown 转换失败:${(result?.errors ?? []).join("; ") || "未知原因"}`);
	}
	return result.markdown_content ?? "";
}

/** 文本类文件直接读取 */
function viaPlainText(inputPath) {
	return readFileSync(inputPath, "utf8");
}

const PLAIN_EXT = new Set(["md", "markdown", "txt"]);

/* ------------------------------------------------------------------ *
 * v0.6.0 扫描件三层路由(auto 复杂度探针决策)
 * ------------------------------------------------------------------ */

/**
 * 纯函数:探针抽样页规格。首页 + 1/3 处 + 2/3 处(去重升序,钳制到 [1,total])。
 * @param {number} total 总页数
 * @returns {string} 如 "1,32,64"(parallel_ocr.py --probe 参数)
 */
export function probePageSpec(total) {
	if (!Number.isInteger(total) || total <= 0) return "1";
	if (total <= 3) return Array.from({ length: total }, (_, i) => String(i + 1)).join(",");
	const third = Math.max(2, Math.floor(total / 3));
	const twoThird = Math.min(total, Math.max(third + 1, Math.floor((2 * total) / 3)));
	return [...new Set([1, third, twoThird])].sort((a, b) => a - b).join(",");
}

/**
 * 纯函数:探针结果 → 表格+公式区域占比。
 * 带 error 的抽样页剔除;全部无效时 valid:false(调用方保守回退本地)。
 * @param {Array<{tables?:number, formulas?:number, textRegions?:number, error?:string}>} probePages
 * @returns {{valid: boolean, tables: number, formulas: number, textRegions: number, ratio: number}}
 */
export function complexityRatio(probePages) {
	let t = 0, f = 0, tr = 0, valid = 0;
	for (const p of Array.isArray(probePages) ? probePages : []) {
		if (!p || typeof p !== "object" || p.error) continue;
		valid++;
		t += p.tables || 0;
		f += p.formulas || 0;
		tr += p.textRegions || 0;
	}
	const denom = t + f + tr;
	return { valid: valid > 0, tables: t, formulas: f, textRegions: tr, ratio: denom > 0 ? (t + f) / denom : 0 };
}

/**
 * 纯函数:引擎路由决策(engine=auto 按复杂度换轨,不按页数)。
 *   - engine 显式指定 → 直接尊重;
 *   - 探针不可用 → 保守走本地并行 OCR(后台作业无宿主中断风险);
 *   - vision.pagesThreshold > 0 且超页数 → 强制换轨闸;
 *   - 复杂度 > vision.complexityRatio → vision(表格/公式密集版面本地识别弱);
 *   - 其余 → 本地并行 OCR;复杂度接近阈值(≥0.7×)时附 hint 提示可对比 vision。
 * @returns {{route:"local"|"vision", reason: string, ratio?: number,
 *            hint?: string, probeFailed?: boolean}}
 */
export function decideRoute({ probePages = null, total = 0, engine = "auto", vision = {} } = {}) {
	const v = { pagesThreshold: 0, complexityRatio: 0.4, ...vision };
	if (engine === "vision") return { route: "vision", reason: 'engine="vision" 显式指定' };
	if (engine === "local") return { route: "local", reason: 'engine="local" 显式指定' };
	const cr = complexityRatio(probePages ?? []);
	if (!cr.valid) {
		return { route: "local", reason: "复杂度探针不可用,保守走本地并行 OCR(后台作业无中断风险)", probeFailed: true };
	}
	const pct = (x) => `${(x * 100).toFixed(1)}%`;
	if (v.pagesThreshold > 0 && total > v.pagesThreshold) {
		return { route: "vision", ratio: cr.ratio, reason: `页数 ${total} > vision.pagesThreshold=${v.pagesThreshold},强制换轨` };
	}
	if (cr.ratio > v.complexityRatio) {
		return {
			route: "vision",
			ratio: cr.ratio,
			reason: `复杂度 ${pct(cr.ratio)} > 阈值 ${pct(v.complexityRatio)}(表格/公式密集版面,vision 质量优先)`,
		};
	}
	const out = { route: "local", ratio: cr.ratio, reason: `复杂度 ${pct(cr.ratio)} ≤ 阈值 ${pct(v.complexityRatio)},本地并行 OCR` };
	if (cr.ratio >= v.complexityRatio * 0.7) {
		out.hint = `探针复杂度 ${pct(cr.ratio)} 接近换轨阈值,如本地表格/公式质量不佳可尝试 engine:"vision" 对比`;
	}
	return out;
}

/** OCR 依赖与模型缓存就绪(本地链路/探针前置;vision 链路不需要 paddle) */
async function ensureOcrReady(o) {
	const dep = await ensureOcrDeps({
		...o.ocr,
		autoInstall: o.autoInstallDeps !== false,
		onLog: (m) => log(o, m),
	});
	if (!dep.ok) {
		return { ok: false, code: ERROR_CODES.E_OCR_DEPS, error: dep.error };
	}
	const models = ocrModelCacheStatus(dep.python);
	if (!models.ok) {
		return {
			ok: false,
			code: ERROR_CODES.E_OCR_DEPS,
			error:
				`OCR 模型未缓存(缺 ${models.missing.length} 个)。` +
				`请先联网执行一次 \`dsh-md-convert deps\` 预下载模型到本地,之后即可完全离线运行。`,
		};
	}
	return { ok: true, python: dep.python };
}

/**
 * vision 任务书接缝(t3 交付 lib/core/vision.js 后即插即用)。
 * makeVisionBrief 契约: (inputPath, opts) => {ok, mode:"vision-brief",
 *   planPath, batches:[{id,pages,promptFile,outputFile}], warnings?}
 */
async function viaVision(inputPath, o) {
	const mod = await import("./vision.js").catch(() => null);
	if (!mod || typeof mod.makeVisionBrief !== "function") {
		return {
			ok: false,
			code: ERROR_CODES.E_VISION_PLAN,
			error: "vision 引擎模块未就绪(v0.6.0 vision 任务书生成尚未安装)",
		};
	}
	return mod.makeVisionBrief(inputPath, o);
}

/** 本地页级并行 OCR(增量写 .md/.progress.json;state.json 断点续跑) */
async function viaLocalOcr(inputPath, o, python) {
	const outFile = outputPathFor(inputPath, o);
	const stem = basename(outFile).replace(/\.md$/, "");
	const r = await ocrPpstructureParallel(inputPath, {
		python,
		scale: o.ocrScale,
		workers: o.workers,
		mdPath: outFile,
		statePath: join(o.outDir, `${stem}.state.json`),
		progressPath: join(o.outDir, `${stem}.progress.json`),
		title: o.title ? `# ${stem}` : "",
		metaComment: o.meta ? metaComment(inputPath, "parallel-ocr") : null,
		resume: o.resume === true,
		signal: o.signal ?? null,
		onEvent: o.onEvent ?? null,
		runTimeoutMs: o.runTimeoutMs,
	});
	if (!r.ok) {
		return {
			ok: false,
			code: r.code ?? ERROR_CODES.E_OCR_RUN,
			error: r.error,
			statePath: r.statePath,
			progressPath: r.progressPath,
			cancelled: r.cancelled,
			timedOut: r.timedOut,
		};
	}
	const progress = r.progress ?? null;
	if (progress && progress.total > 0 && progress.done === 0) {
		return { ok: false, code: ERROR_CODES.E_OCR_EMPTY, error: "未识别出任何内容(扫描页可能过暗/方向异常)", statePath: r.statePath, progressPath: r.progressPath };
	}
	return {
		ok: true,
		chain: "parallel-ocr",
		mode: "local-ocr",
		warnings: r.warnings ?? [],
		outFile: r.mdPath,
		statePath: r.statePath,
		progressPath: r.progressPath,
		progress,
	};
}

/**
 * 扫描件路由总入口:engine 三态 + auto 探针决策 + vision 失败回退(engine=auto 时)。
 * @returns 结果附 decision(路由决策)、probe(探针原始数据)、hint 并入 warnings
 */
async function viaScannedRoute(inputPath, o) {
	// vision 链路不需要 paddle 依赖;本地/探针链路先就绪依赖
	let python = null;
	if (o.engine !== "vision") {
		const ready = await ensureOcrReady(o);
		if (!ready.ok) return ready;
		python = ready.python;
	}

	let decision;
	let probePages = null;
	if (o.engine === "vision") {
		decision = { route: "vision", reason: 'engine="vision" 显式指定' };
	} else if (o.engine === "local") {
		decision = { route: "local", reason: 'engine="local" 显式指定' };
	} else {
		const total = await pdfPageCount(python, inputPath);
		const spec = probePageSpec(total > 0 ? total : 1);
		const pr = await probeComplexity(inputPath, {
			python,
			scale: o.ocrScale,
			pages: spec,
			probeTimeoutMs: o.probeTimeoutMs,
			signal: o.signal ?? null,
		});
		if (pr.ok) probePages = pr.pages;
		decision = decideRoute({ probePages, total: total > 0 ? total : 0, engine: "auto", vision: o.vision });
		decision.samplePages = spec;
		if (total > 0) decision.totalPages = total;
		if (!pr.ok) decision.probeError = pr.error;
		log(o, `路由决策: ${decision.route} (${decision.reason})`);
	}

	if (decision.route === "vision") {
		const r = await viaVision(inputPath, o);
		if (r.ok) {
			return { ...r, chain: r.chain ?? "vision-brief", mode: "vision-brief", decision, probe: probePages };
		}
		if (o.engine === "vision") {
			// 显式指定 vision:失败原样返回,不静默降级
			return { ...r, decision };
		}
		// auto 误判 vision(探针偏差/模块缺失):回退本地并行 OCR,附警告
		log(o, `vision 链路失败,回退本地并行 OCR:${r.error ?? ""}`);
		const local = await viaLocalOcr(inputPath, o, python);
		if (local.ok) {
			local.warnings = [...(local.warnings ?? []), `vision 链路失败已回退本地:${r.error ?? ""}`];
			local.decision = { ...decision, fallback: "local" };
		} else {
			local.decision = decision;
		}
		return local;
	}
	const local = await viaLocalOcr(inputPath, o, python);
	if (local.ok && decision.hint) {
		local.warnings = [...(local.warnings ?? []), decision.hint];
	}
	local.decision = decision;
	local.probe = probePages;
	return local;
}

/* ------------------------------------------------------------------ *
 * 组装与入口
 * ------------------------------------------------------------------ */

/**
 * 组装最终 Markdown 并写盘(供 convertFile 与工具层文字层快路径复用)。
 * @returns {{ok, file?, outFile?, md?, chain?, warnings?, code?, error?}}
 */
export function assembleAndWrite(inputPath, { md, chain, warnings = [] }, opts = {}) {
	const o = normalizeOpts(opts);
	const title = o.title ? `# ${basename(inputPath).replace(/\.[^.]+$/, "")}\n\n` : "";
	const meta = o.meta ? metaComment(inputPath, chain) : "";
	const finalMd = `${title}${String(md).trim()}\n${meta}`;
	const outFile = outputPathFor(inputPath, o);
	try {
		if (o.overwrite || !fileExists(outFile)) {
			mkdirSync(o.outDir, { recursive: true });
			writeFileSync(outFile, finalMd, "utf8");
		}
	} catch (e) {
		return { ok: false, file: inputPath, code: ERROR_CODES.E_OUTPUT, error: `无法写入输出文件 ${outFile}:${e.message}` };
	}
	return { ok: true, file: inputPath, outFile, chain, warnings, md: finalMd };
}

/**
 * PDF 文字层快路径(工具层 background=auto 决策用):仅尝试 markitdown 文字层,
 * 不回退 OCR。文字层丰富 → {ok:true, md};否则 {ok:false}(调用方转 OCR 路由)。
 */
export async function convertPdfTextLayer(inputPath) {
	try {
		const md = await viaMarkItDown(inputPath);
		if (md && md.trim().length >= PDF_MIN_TEXT) return { ok: true, md };
		return { ok: false, error: "文字层为空或过短" };
	} catch (e) {
		return { ok: false, error: e?.message ?? String(e) };
	}
}

/** 提取扫描件路由结果附带的元数据字段 */
function pickRouteMeta(r) {
	const out = {};
	for (const k of ["mode", "decision", "probe", "statePath", "progressPath", "progress", "outFile", "planPath", "batches"]) {
		if (r[k] !== undefined) out[k] = r[k];
	}
	return out;
}

/**
 * 转换单个文件为 Markdown。
 * @param {string} inputPath
 * @param {object} [opts] 见 DEFAULT_OPTS;扫描件链路结果额外携带
 *   mode("local-ocr"|"vision-brief")/decision/probe/statePath/progressPath/progress
 * @returns {Promise<{
 *   ok: boolean,
 *   file?: string,
 *   code?: string,           // 错误码(仅失败时),见 lib/core/errors.js
 *   md?: string, outFile?: string, chain?: string, warnings?: string[],
 *   mode?: string, decision?: object, probe?: object[],
 *   statePath?: string, progressPath?: string, progress?: object,
 *   error?: string
 * }>}
 */
export async function convertFile(inputPath, opts = {}) {
	sweepStale(); // 顺带清理历史崩溃残留
	inputPath = resolve(inputPath); // COM 后端等需要绝对路径
	const o = normalizeOpts(opts);
	const scope = new TempScope();
	try {
		if (!existsSync(inputPath)) {
			return { ok: false, file: inputPath, code: ERROR_CODES.E_FILE_NOT_FOUND, error: `文件不存在:${inputPath}` };
		}
		const info = { hasTextLayer: null };
		const cls = classify(inputPath, info);
		let md = "";
		let chain = "";
		let warnings = [];
		let routeMeta = {};

		if (cls.kind === "unsupported") {
			return { ok: false, file: inputPath, code: ERROR_CODES.E_UNSUPPORTED_FORMAT, error: `不支持的格式:${cls.ext || "(无扩展名)"}` };
		}

		if (cls.kind === "legacy") {
			// 老格式:先另存为现代格式
			const tmpDir = scope.dir("legacy");
			const conv = convertLegacy(inputPath, tmpDir, { backend: o.legacy.backend });
			if (!conv.ok) {
				return { ok: false, file: inputPath, code: ERROR_CODES.E_LEGACY_CONVERT, error: conv.error };
			}
			const converted = conv.out;
			md = await viaMarkItDown(converted);
			chain = `legacy(${conv.backend}) → markitdown`;
			// converted 在临时目录,scope.dispose() 时清理
		} else if (cls.kind === "scanned" || (cls.ext === "pdf" && o.forceOcr)) {
			const r = await viaScannedRoute(inputPath, o);
			if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error, ...pickRouteMeta(r) };
			routeMeta = pickRouteMeta(r);
			warnings = r.warnings ?? [];
			chain = r.chain;
		} else if (PLAIN_EXT.has(cls.ext)) {
			md = viaPlainText(inputPath);
			chain = "text";
		} else {
			// modern(markitdown 原生)
			if (cls.ext === "pdf") {
				// 先尝试文字层;空结果回退三层路由(探针 → vision / 并行本地 OCR)
				try {
					md = await viaMarkItDown(inputPath);
				} catch (e) {
					md = "";
				}
				if (!md || md.trim().length < PDF_MIN_TEXT) {
					const r = await viaScannedRoute(inputPath, o);
					if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error, ...pickRouteMeta(r) };
					routeMeta = pickRouteMeta(r);
					warnings = ["markitdown 文字层为空,已转扫描件路由", ...(r.warnings ?? [])];
					chain = `markitdown(空) → ${r.chain}`;
				} else {
					chain = "markitdown(pdf 文字层)";
				}
			} else {
				md = await viaMarkItDown(inputPath);
				chain = "markitdown";
			}
		}

		// 组装最终 Markdown(两条扫描件链路都已自带落盘产物,不进通用组装:
		// local-ocr=增量 md 已写;vision-brief=产物是 plan.json+批次文件,无最终 md)
		if (routeMeta.mode === "local-ocr" || routeMeta.mode === "vision-brief") {
			return { ok: true, file: inputPath, chain, warnings, ...routeMeta };
		}

		const assembled = assembleAndWrite(inputPath, { md, chain, warnings }, o);
		if (!assembled.ok) return assembled;
		return { ...assembled, ...routeMeta };
	} catch (e) {
		return { ok: false, file: inputPath, code: codeOf(e), error: e?.message ?? String(e) };
	} finally {
		if (!o.keepTemp) scope.dispose();
	}
}

function fileExists(p) {
	try { return existsSync(p); } catch { return false; }
}

/**
 * 批量转换。
 * @param {string[]} inputs
 * @param {object} [opts]
 * @returns {Promise<Array>} 与 convertFile 同构的结果数组
 */
export async function convertMany(inputs, opts = {}) {
	const results = [];
	for (const f of inputs) {
		results.push(await convertFile(f, opts));
	}
	return results;
}
