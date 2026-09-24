/**
 * dsh-md-convert — OCR 模块(模块化路由引擎)
 *
 * v0.5.x: 扫描件走「路由流水线」lib/py/routing_ocr.py 整份 PDF 一次调用(保留,
 *         供回退/对比: ocrPpstructure)。
 * v0.6.0: 新增页级并行链路 lib/py/parallel_ocr.py(NDJSON 流式 + 断点续跑 +
 *         复杂度探针,消费端 lib/core/jobs.js):
 *   - probeComplexity:       --probe 抽样 3 页版面分析(engine=auto 换轨决策输入)
 *   - ocrPpstructureParallel: 逐页流式消费,锚点 upsert 增量写 .md + .progress.json,
 *                             state.json 断点续跑(Python 侧独占写,Node 只读)
 *
 * 依赖检测/自动安装见 lib/core/deps.js(ensureOcrDeps)。
 */
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { runAsync } from "./spawn.js";
import { detectPython } from "./deps.js";
import { createOcrRun, runProbe } from "./jobs.js";
export { ensureOcrDeps, findMissingModules, installModules, PY_MODULES } from "./deps.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROUTING_SCRIPT = join(here, "..", "py", "routing_ocr.py");
/** v0.6.0 页级并行脚本(NDJSON 流式 + 断点续跑 + 探针) */
export const PARALLEL_SCRIPT = join(here, "..", "py", "parallel_ocr.py");

/** OCR 配置结构(v0.6.0 扩展:并行/探针/ETA 全部可配) */
const DEFAULT_OCR_CONFIG = {
	python: "",                // 留空自动探测 python / python3 / py
	scale: 2,                  // PDF 渲染倍率
	workers: 0,                // 并行 worker 数;0=脚本默认 min(CPU,8);1=进程内快速路径(沙箱/调试)
	probeTimeoutMs: 120_000,   // 复杂度探针超时(含版面模型冷加载)
	runTimeoutMs: 7_200_000,   // 前台 OCR 总超时(后台作业不限;超时 → E_OCR_TIMEOUT,可 resume)
	etaPerPageSec: 15,         // ETA 估算:单页均耗(bench.md 标定 ≈14.4s/页 @workers=1)
};

export function normalizeOcrConfig(cfg = {}) {
	// 显式兜底:undefined 不得覆盖默认值
	return {
		python: cfg.python ?? DEFAULT_OCR_CONFIG.python,
		scale: cfg.scale ?? DEFAULT_OCR_CONFIG.scale,
		workers: cfg.workers ?? DEFAULT_OCR_CONFIG.workers,
		probeTimeoutMs: cfg.probeTimeoutMs ?? DEFAULT_OCR_CONFIG.probeTimeoutMs,
		runTimeoutMs: cfg.runTimeoutMs ?? DEFAULT_OCR_CONFIG.runTimeoutMs,
		etaPerPageSec: cfg.etaPerPageSec ?? DEFAULT_OCR_CONFIG.etaPerPageSec,
	};
}

/**
 * 【v0.6.0】复杂度探针:仅版面模型抽样页分析,产出 engine=auto 换轨决策输入。
 * 调用方需先 ensureOcrDeps(探针加载 paddleocr LayoutDetection)。
 * @param {string} inputPath PDF 路径
 * @param {object} [cfg] { python, scale, pages:"1,33,65", probeTimeoutMs, signal }
 * @returns {Promise<{ok: boolean, pages?: object[], error?: string}>}
 */
export async function probeComplexity(inputPath, cfg = {}) {
	const c = normalizeOcrConfig(cfg);
	const python = c.python || detectPython();
	if (!python) {
		return { ok: false, error: "未找到 Python。请安装 Python 后重试" };
	}
	return runProbe({
		python,
		script: PARALLEL_SCRIPT,
		pdf: inputPath,
		scale: c.scale,
		pages: cfg.pages ?? "1",
		timeoutMs: c.probeTimeoutMs,
		signal: cfg.signal,
	});
}

/**
 * 【v0.6.0】页级并行 OCR(前台执行;后台作业亦复用同一函数)。
 * 与旧 ocrPpstructure 的差异:NDJSON 流式消费、页锚点 upsert 增量落盘、
 * state.json 断点续跑;长任务不再依赖单次同步调用存活。
 * @param {string} inputPath PDF 路径
 * @param {object} [cfg] {
 *   python, scale, workers, runTimeoutMs, signal, resume, onEvent,
 *   mdPath(必填,增量输出=最终输出), statePath(必填), progressPath(必填),
 *   title, metaComment, spawnStreamImpl(测试注入)
 * }
 * @returns {Promise<{ok: boolean, mdPath?, statePath?, progressPath?, progress?,
 *                     warnings?: string[], code?, error?, cancelled?, timedOut?}>}
 */
export async function ocrPpstructureParallel(inputPath, cfg = {}) {
	const c = normalizeOcrConfig(cfg);
	const python = c.python || detectPython();
	if (!python) {
		return { ok: false, code: "E_OCR_DEPS", error: "未找到 Python。请安装 Python 后重试" };
	}
	return createOcrRun({
		python,
		script: PARALLEL_SCRIPT,
		pdf: inputPath,
		mdPath: cfg.mdPath,
		statePath: cfg.statePath,
		progressPath: cfg.progressPath,
		title: cfg.title ?? `# ${basename(inputPath).replace(/\.[^.]+$/, "")}`,
		metaComment: cfg.metaComment ?? null,
		scale: c.scale,
		workers: cfg.workers ?? c.workers,
		resume: cfg.resume === true,
		timeoutMs: c.runTimeoutMs,
		signal: cfg.signal ?? null,
		onEvent: cfg.onEvent,
		spawnStreamImpl: cfg.spawnStreamImpl,
	});
}

/**
 * 对扫描件 PDF 执行路由 OCR(整份 PDF 一次调用)。
 * @param {string} inputPath PDF 路径
 * @param {object} [cfg] { python, scale }
 * @returns {Promise<{ ok: boolean, md?: string, warnings?: string[], error?: string }>}
 */
export async function ocrPpstructure(inputPath, cfg = {}) {
	const c = normalizeOcrConfig(cfg);
	const python = c.python || detectPython();
	if (!python) {
		return { ok: false, error: "未找到 Python。请安装 Python 后重试" };
	}
	const r = await runAsync(python, [ROUTING_SCRIPT, inputPath, "--scale", String(c.scale)], {
		timeout: 7_200_000, // 多页扫描件整 PDF 一次调用: 单页数秒~十几秒, 长文档给足 120 分钟
		maxBuffer: 512 * 1024 * 1024,
	});
	if (r.status !== 0) {
		if (r.error) return { ok: false, error: `路由 OCR 执行失败:${r.error}` };
		const tail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-6).join("\n");
		return { ok: false, error: `路由 OCR 执行失败:${tail || "(无输出)"}` };
	}
	try {
		const parsed = JSON.parse(r.stdout.trim());
		if (!parsed.ok) return { ok: false, error: parsed.error || "路由 OCR 返回失败" };
		return {
			ok: true,
			md: parsed.md ?? "",
			warnings: parsed.warnings ?? [],
		};
	} catch (e) {
		return { ok: false, error: `无法解析路由 OCR 输出:${e.message}` };
	}
}
