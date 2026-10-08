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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { classify, ENGINE_UNSUPPORTED_EXT } from "./detect.js";
import { convertLegacy } from "./legacy.js";
import { ensureOcrDeps, ocrPpstructureParallel, probeComplexity } from "./ocr.js";
import { detectPython, ocrModelCacheStatus } from "./deps.js";
import { pdfPageCount, stateKeyFor } from "./jobs.js";
import { installModules } from "./deps.js";
import { extractPdfTextPython, pymupdf4llmExtract } from "./textlayer.js";
import { viaMarkItDownDual } from "./markitdown.js";
import { maybeAutoVisionBrief } from "./vision.js";
import { assessMdQuality } from "./quality.js";
import { collapseCjkSpaces } from "./cjk.js";
import { TempScope, sweepStale } from "./cleanup.js";
import { err, codeOf, ERROR_CODES } from "./errors.js";

/** PDF 文字层判定:markitdown 结果低于该字符数视为扫描件 */
const PDF_MIN_TEXT = 20;

/** 图像占比 ≥ 该值的页列入 visionHints(页级局部 vision 路由建议;真机校准:截图页≈0.22,纯文字页≈0) */
const IMG_RATIO_THRESHOLD = 0.15;

/** 中文归并处数 ≥ 该值时在 warnings 透出(v0.7.2 W2-1;1~2 处不刷屏) */
const CJK_MERGE_WARN_MIN = 5;

/**
 * 纯函数:逐页 imgRatio(extract_text.py 透传)→ visionHints;无数据/无命中 → null。
 * @param {Array<{no:number, imgRatio?:number}>} pages
 * @returns {{threshold:number, pages:number[], detail:Array<{page:number,imgRatio:number}>}|null}
 */
export function visionHintsFromPages(pages) {
	const hits = (Array.isArray(pages) ? pages : [])
		.filter((p) => Number.isFinite(p?.imgRatio) && p.imgRatio >= IMG_RATIO_THRESHOLD)
		.map((p) => ({ page: p.no, imgRatio: p.imgRatio }));
	if (!hits.length) return null;
	return { threshold: IMG_RATIO_THRESHOLD, pages: hits.map((h) => h.page), detail: hits };
}

/** 纯函数:visionHints → 调用方提示语(空命中返回空串) */
export function visionHintMessage(visionHints) {
	if (!visionHints || !Array.isArray(visionHints.pages) || !visionHints.pages.length) return "";
	const pct = (r) => `${Math.round(r * 1000) / 10}%`;
	const detail = (visionHints.detail ?? []).map((h) => `第 ${h.page} 页 ${pct(h.imgRatio)}`).join("、");
	return (
		`${detail} 图像占比 ≥ ${pct(visionHints.threshold)},其内嵌截图文字不在文字层;` +
		`可调 md_convert(engine:"vision", onlyPages:"${visionHints.pages.join(",")}") 生成子集任务书,` +
		`md_convert_assemble 装配后按 <!--PAGE:NN--> 锚点块替换回文字层版`
	);
}

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
	cjkMerge: true,           // v0.7.2 W2-1:中文行间空格归并(纯规则/零依赖);false=关闭
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

/**
 * v0.7.2 W3-1: 路由探针结果缓存。
 *
 * 探针每次都要冷启 paddle 并加载版面模型(实测 10.6s:import 3.16s + 模型 4.4s),
 * 而它的输出只是"抽样页的区域计数"这种小 JSON → 同文档同参数重复转换时可直接复用。
 * 键 = state 复用同源指纹(插件版本+倍率+文档指纹) + 抽样页规格:
 * 改算法/改倍率/换文件/改抽样范围都不会命中,不会因缓存导致误路由。
 * 只缓存**成功**结论(错误不缓存);任何 I/O 失败都退回"未命中"。
 */
function readProbeCache(file, key) {
	try {
		const d = JSON.parse(readFileSync(file, "utf8"));
		if (d && d.key === key && d.result && d.result.ok && Array.isArray(d.result.pages)) return d.result;
	} catch { /* 未命中/文件不存在 */ }
	return null;
}

function writeProbeCache(file, key, result) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify({ key, result, at: new Date().toISOString() }, null, "\t"), "utf8");
		renameSync(tmp, file);
	} catch { /* 缓存失败不影响主流程 */ }
}

/**
 * markitdown 双引擎桥(v0.6.5):进程内 → 子进程(ELECTRON_RUN_AS_NODE)。
 * 修复:DSH/Electron 宿主进程内 createRequire 解析链抛
 * 「createRequire.resolve.paths is not a function」,markitdown-node 全格式
 * 不可用(docx 硬失败;PDF 曾因此整链降级)。详见 lib/core/markitdown.js。
 * @returns {Promise<{md: string, warning: string|null}>}
 */
async function viaMarkItDown(inputPath) {
	const r = await viaMarkItDownDual(inputPath);
	return { md: r.md, warning: r.warning ?? null };
}

/**
 * 文本解码(v0.7.2 W4-3)。
 *
 * 根因:此前 `readFileSync(path, "utf8")` **硬读** —— GBK/GB18030 编码的中文 txt/md 会
 * 变成乱码,却仍返回 ok:true 且无任何告警(静默内容损坏)。中文 Windows 旧文件常见 GBK。
 * 策略: BOM 优先 → 严格 UTF-8(失败即回落) → GB18030 → 最后才用替换符兜底。
 */
function decodeText(buf) {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8(BOM)" };
	}
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
		return { text: new TextDecoder("utf-16le").decode(buf), encoding: "utf-16le" };
	}
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
		return { text: new TextDecoder("utf-16be").decode(buf), encoding: "utf-16be" };
	}
	try {
		// fatal:true = 非法 UTF-8 立即抛错,不产生 U+FFFD 替换符(避免"半个乱码也算 UTF-8")
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
	} catch { /* 非 UTF-8 → 回落中文常见编码 */ }
	try {
		return { text: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" };
	} catch {
		return { text: buf.toString("utf8"), encoding: "utf-8(含替换符)" };
	}
}

/** 文本类文件直接读取(带编码探测;非 UTF-8 时返回告警,不再静默乱码) */
function viaPlainText(inputPath) {
	const { text, encoding } = decodeText(readFileSync(inputPath));
	return {
		md: text,
		warning: encoding === "utf-8" ? null : `[编码] 非 UTF-8 文本已按 ${encoding} 解码(原文件编码与 UTF-8 不符)`,
	};
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
	// v0.6.8 可观测性:分段计时(依赖就绪/探针/引擎),随 decision.timings 透出
	const t0 = Date.now();
	// vision 链路不需要 paddle 依赖;本地/探针链路先就绪依赖
	let python = null;
	if (o.engine !== "vision") {
		const ready = await ensureOcrReady(o);
		if (!ready.ok) return ready;
		python = ready.python;
	}
	const depsMs = Date.now() - t0;

	let decision;
	let probePages = null;
	let probeMs = null;
	if (o.engine === "vision") {
		decision = { route: "vision", reason: 'engine="vision" 显式指定' };
	} else if (o.engine === "local") {
		decision = { route: "local", reason: 'engine="local" 显式指定' };
	} else {
		const probeT0 = Date.now();
		// v0.7.2 W3-6: 上游(工具层闸门/ETA)已探查过页数时直接复用,省一次 python 冷启(~250ms);
		// 非正数/缺失则照旧自行探查(CLI 直调等无提示场景)。
		const total = Number.isInteger(o.pageCountHint) && o.pageCountHint > 0
			? o.pageCountHint
			: await pdfPageCount(python, inputPath);
		const spec = probePageSpec(total > 0 ? total : 1);
		// v0.7.2 W3-1: 探针结果缓存(键与 state 复用同源) —— 命中则完全跳过 paddle 冷启
		const probeCachePath = join(o.outDir ?? dirname(inputPath), `${basename(inputPath).replace(/\.[^.]+$/, "")}.probe.json`);
		const probeKey = `${stateKeyFor(inputPath, o.ocrScale) ?? "nokey"}|p${spec}`;
		let pr = readProbeCache(probeCachePath, probeKey);
		if (pr) {
			probeMs = Date.now() - probeT0;
			log(o, `路由探针: 命中缓存(${spec} 页抽样结论),跳过 paddle 冷启`);
		} else {
			pr = await probeComplexity(inputPath, {
				python,
				scale: o.ocrScale,
				pages: spec,
				probeTimeoutMs: o.probeTimeoutMs,
				signal: o.signal ?? null,
			});
			probeMs = Date.now() - probeT0;
			if (pr.ok) writeProbeCache(probeCachePath, probeKey, pr);
		}
		if (pr.ok) probePages = pr.pages;
		decision = decideRoute({ probePages, total: total > 0 ? total : 0, engine: "auto", vision: o.vision });
		decision.samplePages = spec;
		if (total > 0) decision.totalPages = total;
		if (!pr.ok) decision.probeError = pr.error;
		log(o, `路由决策: ${decision.route} (${decision.reason})`);
	}
	decision.timings = { depsMs, ...(probeMs != null ? { probeMs } : {}) };

	const engineT0 = Date.now();
	if (decision.route === "vision") {
		const r = await viaVision(inputPath, o);
		const engineMs = Date.now() - engineT0;
		decision.timings.engineMs = engineMs;
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
			local.decision = { ...decision, fallback: "local", timings: { ...decision.timings, fallbackMs: Date.now() - engineT0 } };
		} else {
			local.decision = decision;
		}
		return local;
	}
	const local = await viaLocalOcr(inputPath, o, python);
	decision.timings.engineMs = Date.now() - engineT0;
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
 * PDF 文字层直提(v0.6.7 引擎调序):① pypdfium2 结构增强直提(主引擎)
 * ② markitdown 兜底(子进程桥;其 PDF 产物无表格重建/无锚点/无结构增强)。
 *
 * 调序依据(2026-10-06 双链路对照实证):独立环境下两引擎正文内容一致,而
 * pypdfium2 链独占结构增强(表格重建/标题层级/链接保留/页眉脚剥离/PAGE 锚点/
 * visionHints),markitdown 对 PDF 表格与标题均拍平——结构能力碾压,且秒级不慢。
 * 宿主内 markitdown 依赖子进程桥,调序后主路径还省一次桥接往返。
 * 两层都试,失败原因逐层记入 attempts 并随 warnings 透出,不静默吞错。
 * @param {string} inputPath
 * @param {object} [opts] { python?: string, timeoutMs?: number,
 *                          impls?: {markitdown?: Function, pythonText?: Function} } (impls 供测试注入)
 * @returns {Promise<{ok: true, md: string, via: "markitdown"|"pypdfium2", chain: string,
 *                     attempts: object[], warnings?: string[]}
 *                   |{ok: false, error: string, attempts: object[]}>}
 */
export async function convertPdfTextLayer(inputPath, opts = {}) {
	const impls = opts.impls ?? {};
	// v0.6.5:桥接降级 warning(进程内失败→子进程桥)经闭包带出——宿主缺陷的持续取证
	let markitdownBridgeWarning = null;
	const markitdownFn = impls.markitdown ?? ((p) => viaMarkItDown(p).then((r) => {
		markitdownBridgeWarning = r.warning;
		return r.md;
	}));
	const pythonFn = impls.pythonText
		?? ((p) => extractPdfTextPython({ python: opts.python || detectPython(""), pdf: p, timeoutMs: opts.timeoutMs ?? 30_000 }));
	const attempts = [];
	// ① pypdfium2 结构增强直提(表格重建/标题层级/链接保留/页眉脚剥离/PAGE 锚点/visionHints)
	try {
		let py = await pythonFn(inputPath);
		let pyUsable = Boolean(py?.ok && py.md && py.md.trim().length >= PDF_MIN_TEXT);
		// v0.7.1 依赖缺失自动安装+重试: 文字层主链(pypdfium2/pymupdf4llm)缺失时
		// 按依赖自动安装机制补装并重试一次;仍失败则最终 warnings 给出精确 pip 命令
		let depRetryNote;
		if (!pyUsable) {
			const firstErr = String(py?.error ?? "");
			const depMods = [...firstErr.matchAll(/No module named ['"]?([\w.]+)['"]?/g)]
				.map((m) => m[1])
				.filter((m) => m === "pypdfium2" || m === "pymupdf4llm");
			if (depMods.length && opts.depsAutoInstall !== false) {
				try {
					const pyBin = opts.python || detectPython("");
					if (pyBin) {
						await installModules(pyBin, [...new Set(depMods)]);
						py = await pythonFn(inputPath);
						pyUsable = Boolean(py?.ok && py.md && py.md.trim().length >= PDF_MIN_TEXT);
						if (pyUsable) depRetryNote = `依赖自动安装后重试成功(${[...new Set(depMods)].join(",")})`;
					}
				} catch {
					// 自动安装失败: 落入下方依赖提示
				}
			}
		}
		attempts.push({
			via: "pypdfium2",
			ok: pyUsable,
			error: pyUsable ? undefined : (py?.error ?? (py?.ok ? `文字层为空或过短(<${PDF_MIN_TEXT} 字符)` : "extract_text 失败")),
			...(depRetryNote ? { note: depRetryNote } : {}),
		});
	if (pyUsable) {
			const visionHints = visionHintsFromPages(py.pages);
			const hintMsg = visionHintMessage(visionHints);
			// v0.6.14 P1: 质量信号触发的 pymupdf4llm 二次提取——直提碎片化(score<70)时,
			// 用 pymupdf4llm 成熟段落合并/表格检测重提,对比取优;依赖可选,未装优雅跳过
			// v0.6.15: char_rebuilt_pages>0(逐字符重建来源)同样触发——字符重建只恢复
			// "行",段落边界未恢复(实证:五粮液一段话碎成三段,用户 2026-10-06 指出);
			// 此场景 pymupdf4llm ok 即采纳(段落合并是确定收益,score 测不出段落质量)
			// v0.7.2 W2-1/W2-3: 两个候选**都先做中文行间空格归并**再评分比较 ——
			// 否则评分看不见 CJK 退化(pymupdf4llm 的 span 无条件拼接与自研链的标题续行/
			// 表格拼接都会往中文行间插空格),会出现"结构好但中文被插空格"的候选胜出。
			const mergeCand = (s) => (opts.cjkMerge === false ? { md: s, removed: 0 } : collapseCjkSpaces(s));
			const chainCand = mergeCand(py.md);
			const quality = assessMdQuality(chainCand.md);
			let cjkRemoved = chainCand.removed;
			const charRebuilt = Number(py.notes?.char_rebuilt_pages ?? 0) > 0;
			let via = "pypdfium2";
			let chain = "pypdfium2(结构增强直提)";
			let finalMd = chainCand.md;
			let finalQuality = quality;
			const warnings = [...(hintMsg ? [hintMsg] : [])];
			const needPm = quality.suggestVision || charRebuilt || opts.forcePymupdf4llm === true;
			if (needPm) {
				const pmFn = impls.pymupdf4llm ?? ((p) => pymupdf4llmExtract({ python: opts.python || detectPython(""), pdf: p, timeoutMs: opts.pymupdf4llmTimeoutMs ?? 120_000 }));
				const pm = await pmFn(inputPath);
				attempts.push({ via: "pymupdf4llm", ok: Boolean(pm?.ok), error: pm?.ok ? undefined : String(pm?.error ?? "失败").slice(0, 160), ...(pm?.unavailable ? { unavailable: true } : {}) });
				if (pm?.ok && pm.md) {
					const pmCand = mergeCand(pm.md);
					const q2 = assessMdQuality(pmCand.md);
					const adopt = charRebuilt || opts.forcePymupdf4llm === true ? q2.score >= quality.score - 10 : q2.score > quality.score;
					if (adopt) {
						via = "pymupdf4llm";
						chain = "pymupdf4llm(段落合并直提)";
						finalMd = pmCand.md;
						finalQuality = q2;
						cjkRemoved = pmCand.removed;
						warnings.push(`[质量修复] 直提产物${charRebuilt ? "段落结构未恢复(逐字符重建来源)" : `碎片化(score ${quality.score})`}已由 pymupdf4llm 二次提取修复(score ${q2.score})`);
					}
				}
			}
			return {
				ok: true, md: finalMd, via, chain, attempts,
				...(visionHints ? { visionHints } : {}),
				quality: finalQuality,
				...(cjkRemoved ? { cjkMerge: { removed: cjkRemoved } } : {}),
				warnings: [
					...warnings,
					...(cjkRemoved >= CJK_MERGE_WARN_MIN
						? [`[中文归并] 归并中文行间空格 ${cjkRemoved} 处(来源:span 拼接/标题续行/表格词界注入)`]
						: []),
					// 未接管成功(依赖缺失/分数未更高)→ 质量信号建议照常透出
					...(via === "pypdfium2" && quality.suggestVision
						? [`[质量信号] ${quality.issues.join("; ")}——${quality.reason}`]
						: []),
				],
			};
		}
	} catch (e) {
		attempts.push({ via: "pypdfium2", ok: false, error: String(e?.message ?? e).slice(0, 160) });
	}
	// v0.7.1: 文字层主链依赖缺失 → 精确 pip 修复命令随最终失败透出
	const depHint = String(attempts.find((a) => a.via === "pypdfium2" && !a.ok)?.error ?? "").match(/No module named ['"]?(pypdfium2|pymupdf4llm)['"]?/);
	const depWarning = depHint
		? `[依赖缺失] Python 缺少 ${depHint[1]}——PDF 文字层主链不可用已降级。修复: pip install ${depHint[1] === "pymupdf4llm" ? "pymupdf4llm" : "pypdfium2 pymupdf4llm"}`
		: null;
	// ② markitdown 兜底(结构弱但正文可达;宿主内经子进程桥)
	let md = "";
	let markitdownError = null;
	try {
		md = await markitdownFn(inputPath);
	} catch (e) {
		md = "";
		markitdownError = String(e?.message ?? e).slice(0, 160);
	}
	if (md && md.trim().length >= PDF_MIN_TEXT) {
		// v0.7.2 W2-1: 兜底产物同样归并(自研链/P4L 都不可用时,中文行间空格不应漏网)
		const mkCand = opts.cjkMerge === false ? { md, removed: 0 } : collapseCjkSpaces(md);
		return {
			ok: true, md: mkCand.md, via: "markitdown", chain: "markitdown(文字层兜底)", attempts,
			...(mkCand.removed ? { cjkMerge: { removed: mkCand.removed } } : {}),
			...(markitdownBridgeWarning || depWarning || mkCand.removed >= CJK_MERGE_WARN_MIN
				? {
					warnings: [
						...(mkCand.removed >= CJK_MERGE_WARN_MIN
							? [`[中文归并] 归并中文行间空格 ${mkCand.removed} 处(来源:span 拼接/标题续行/表格词界注入)`]
							: []),
						...(markitdownBridgeWarning ? [markitdownBridgeWarning] : []),
						...(depWarning ? [depWarning] : []),
					],
				}
				: {}),
		};
	}
	attempts.push({ via: "markitdown", ok: false, error: markitdownError ?? `文字层为空或过短(<${PDF_MIN_TEXT} 字符)` });
	const fail = attempts.map((a) => `${a.via}: ${a.error ?? "空"}`).join("; ");
	return {
		ok: false,
		error: `文字层不可用(${fail})`,
		attempts,
		...(depWarning ? { warnings: [depWarning] } : {}),
	};
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
			// v0.7.2 W4-1: 引擎无后端者给可操作提示(此前它们被误列白名单,报的是
			// "Unable to detect document format" —— 用户会以为文件损坏)
			const noBackend = ENGINE_UNSUPPORTED_EXT.has(cls.ext);
			return {
				ok: false,
				file: inputPath,
				code: ERROR_CODES.E_UNSUPPORTED_FORMAT,
				error: noBackend
					? `不支持的格式:${cls.ext}(解析引擎无该格式后端;请先转为 png/jpg 等受支持格式)`
					: `不支持的格式:${cls.ext || "(无扩展名)"}`,
			};
		}

		if (cls.kind === "legacy") {
			// 老格式:先另存为现代格式
			const tmpDir = scope.dir("legacy");
			const conv = convertLegacy(inputPath, tmpDir, { backend: o.legacy.backend });
			if (!conv.ok) {
				return { ok: false, file: inputPath, code: ERROR_CODES.E_LEGACY_CONVERT, error: conv.error };
			}
			const converted = conv.out;
			const mdRes = await viaMarkItDown(converted);
			md = mdRes.md;
			if (mdRes.warning) warnings.push(mdRes.warning);
			chain = `legacy(${conv.backend}) → markitdown`;
			// converted 在临时目录,scope.dispose() 时清理
		} else if (cls.kind === "scanned" || (cls.ext === "pdf" && o.forceOcr)) {
			const r = await viaScannedRoute(inputPath, o);
			if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error, ...pickRouteMeta(r) };
			routeMeta = pickRouteMeta(r);
			warnings = r.warnings ?? [];
			chain = r.chain;
		} else if (PLAIN_EXT.has(cls.ext)) {
			const pt = viaPlainText(inputPath);
			md = pt.md;
			if (pt.warning) warnings.push(pt.warning); // v0.7.2 W4-3: 非 UTF-8 解码透明化
			chain = "text";
		} else {
			// modern(markitdown 原生)
			if (cls.ext === "pdf") {
				// v0.6.3:engine="vision" 显式指定 → 直接走扫描件路由。
				// 修复:此前有文字层的 PDF 在本分支无条件先试文字层,engine=vision
				// 被静默吞掉(2026-10-05 火山方舟 PDF 实测:E_VISION_PLAN 永不可达)。
				if (o.engine === "vision") {
					const r = await viaScannedRoute(inputPath, o);
					if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error, ...pickRouteMeta(r) };
					routeMeta = pickRouteMeta(r);
					warnings = r.warnings ?? [];
					chain = r.chain;
				} else {
					// 文字层双引擎(v0.6.2):markitdown → pypdfium2 兜底;都不可用才回退三层路由
					const tl = await convertPdfTextLayer(inputPath, { python: o.ocr?.python ?? "", cjkMerge: o.cjkMerge !== false });
				if (tl.ok) {
					const tlWarn = Array.isArray(tl.warnings) ? tl.warnings : [];
					const assembled = assembleAndWrite(inputPath, { md: tl.md, chain: tl.chain, warnings: [...tlWarn] }, o);
					if (!assembled.ok) return assembled;
					// v0.6.6 P1-B:截图页 visionHints → 自动生成 onlyPages 子集任务书(失败不阻塞)
					let autoBrief = null;
					if (tl.visionHints && o.vision?.autoBrief !== false) {
						try {
							autoBrief = await maybeAutoVisionBrief(inputPath, tl.visionHints, o);
						} catch {
							autoBrief = null;
						}
					}
					return {
						...assembled,
						decision: { route: "text-layer", via: tl.via },
						...(tl.visionHints ? { visionHints: tl.visionHints } : {}),
						...(autoBrief ? { autoBrief } : {}),
						...(tl.quality ? { quality: tl.quality } : {}),
					};
				}
				// 文字层不可用 → 扫描件路由(失败原因透出,不再静默)
				const r = await viaScannedRoute(inputPath, o);
				if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error, ...pickRouteMeta(r) };
				routeMeta = pickRouteMeta(r);
					warnings = [`文字层不可用(${tl.error}),已转扫描件路由`, ...(r.warnings ?? [])];
					chain = `文字层(空) → ${r.chain}`;
				}
			} else {
				const mdRes = await viaMarkItDown(inputPath);
				md = mdRes.md;
				if (mdRes.warning) warnings.push(mdRes.warning);
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
