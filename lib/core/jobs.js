/**
 * dsh-md-convert — 后台作业与流式 OCR 消费端(v0.6.0)
 *
 * 解决「整 PDF 同步单调用被宿主中断」的 Node 半区:
 *   - spawnStream:        无 shell 子进程 + 逐行 NDJSON 消费 + 进程树终止
 *   - createOcrRun:       消费 lib/py/parallel_ocr.py 协议(start/page/done),
 *                         按 <!--PAGE:NN--> 锚点 upsert 增量写 .md + .progress.json
 *   - startBackgroundConvert: ctx.jobs 后台作业适配(cancel/done/readOutput)
 *   - runProbe/pdfPageCount/estimateEtaSec: 路由决策与 ETA 辅助
 *
 * 协议契约(与 parallel_ocr.py 对齐,勿单方面改动):
 *   {"event":"start","total":N}
 *   {"event":"page","no":3,"md":"<!--PAGE:03-->...<!--/PAGE:03-->","stats":{...}}
 *   {"event":"done","warnings":[...]}            (exit 1 时 warnings 末尾含「致命错误」)
 *   --probe 模式仅输出 {"event":"probe","pages":[{no,tables,formulas,textRegions,stamps}]}
 *   - page 事件乱序到达、失败页也发(锚点内占位注释) → 消费端必须按锚点 upsert
 *   - 断点状态 <name>.state.json 由 Python 侧原子落盘并**独占写**(pdf/scale/total 校验、
 *     resume 跳过 done/重试 failed);Node 侧只读,进度镜像另写 <name>.progress.json
 *
 * 错误纪律: createOcrRun **永不 reject**,一切失败收敛为 {ok:false,code,...} 结果对象;
 * 基础设施异常(参数缺失等)才 throw。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { runAsync } from "./spawn.js";
import { ERROR_CODES } from "./errors.js";

/** 单流 stderr 保留尾字节数(诊断用,防长日志爆内存) */
const STDERR_TAIL_BYTES = 16 * 1024;

/* ------------------------------------------------------------------ 锚点 */

/** 页锚点: <!--PAGE:NN--> ... <!--/PAGE:NN-->(两位补零,>99 自然扩展) */
export const ANCHOR_RE = /<!--PAGE:(\d{2,})-->([\s\S]*?)<!--\/PAGE:\1-->/g;

/**
 * 从既有 md 文本解析锚点页(断点续跑预播种用)。
 * @returns {Map<number, string>} 页号 → 含锚点的完整页块
 */
export function parseAnchoredPages(mdText) {
	const map = new Map();
	if (typeof mdText !== "string" || !mdText) return map;
	ANCHOR_RE.lastIndex = 0;
	let m;
	while ((m = ANCHOR_RE.exec(mdText)) !== null) {
		map.set(parseInt(m[1], 10), m[0]);
	}
	return map;
}

/**
 * 组装完整 markdown: 标题 + 页块按页号升序拼接。
 * @param {Map<number, string>} pageMap
 * @param {string} title 标题行(可空)
 */
export function assembleMd(pageMap, title = "") {
	const pages = [...pageMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
	const head = title ? `${title}\n\n` : "";
	return `${head}${pages.join("\n\n")}${pages.length ? "\n" : ""}`;
}

/* ------------------------------------------------------------------ NDJSON */

/** 安全解析一行 NDJSON;非 JSON/空行返回 null(协议行只会是 JSON 对象) */
export function parseNdjsonLine(line) {
	const s = String(line ?? "").trim();
	if (!s.startsWith("{")) return null;
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ 进程流 */

/**
 * 无 shell 子进程 + 逐行 stdout 消费 + 进程树终止。
 * - Windows: taskkill /pid <pid> /T /F(杀整棵进程树,Pool worker 一并回收);
 * - POSIX: SIGTERM → 3s 后 SIGKILL。
 * - stdout 协议行经 onLine(已按 \n 切分,UTF-8);stderr 有界收集尾部。
 * - signal 中止 / timeoutMs 超时 → killTree,promise 以 {timedOut,killed} 结案。
 *
 * @returns {{ promise: Promise<{status, signal, stderrTail, error?, timedOut?, killed?}>, killTree: (why?: string) => void }}
 */
export function spawnStream(cmd, args, opts = {}) {
	const { onLine, signal = null, timeoutMs = 0 } = opts;
	let child;
	try {
		child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		return {
			killTree: () => {},
			promise: Promise.resolve({ status: null, signal: null, stderrTail: "", error: e?.message ?? String(e) }),
		};
	}
	let stderrTail = "";
	let killed = false;
	let timedOut = false;
	let settled = false;
	let timer = null;
	let escrowTimer = null;

	const killTree = () => {
		if (killed || child.pid === undefined) return;
		killed = true;
		if (process.platform === "win32") {
			try {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			} catch { /* 兜底: close 兜底结案 */ }
		} else {
			try { child.kill("SIGTERM"); } catch { /* 忽略 */ }
			escrowTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 忽略 */ } }, 3000);
			if (escrowTimer.unref) escrowTimer.unref();
		}
	};

	const promise = new Promise((resolve) => {
		const finish = (r) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (escrowTimer) clearTimeout(escrowTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ timedOut, killed, ...r });
		};
		const onAbort = () => killTree();
		if (signal) {
			if (signal.aborted) killTree();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
			if (timer.unref) timer.unref();
		}
		child.stdout?.setEncoding("utf8");
		const rl = readline.createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			if (typeof onLine === "function") {
				try { onLine(line); } catch { /* 消费端回调异常不中断进程消费 */ }
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (d) => {
			stderrTail = (stderrTail + d).slice(-STDERR_TAIL_BYTES);
		});
		child.on("error", (e) => finish({ status: null, signal: null, stderrTail, error: e?.message ?? String(e) }));
		child.on("close", (code, sig) => finish({ status: code, signal: sig, stderrTail }));
	});

	return { promise, killTree };
}

/* ------------------------------------------------------------------ 辅助探查 */

/** pypdfium2 页数探查(快速,失败返回 -1;不抛错) */
export async function pdfPageCount(python, pdf, timeoutMs = 30_000) {
	const snippet = "import pypdfium2 as pdfium, sys; print(len(pdfium.PdfDocument(sys.argv[1])))";
	const r = await runAsync(python, ["-c", snippet, String(pdf)], { timeout: timeoutMs });
	if (r.status !== 0) return -1;
	const n = parseInt(`${r.stdout ?? ""}`.trim(), 10);
	return Number.isInteger(n) && n > 0 ? n : -1;
}

/* 每 worker 内存预算字节:PP-DocLayout + SLANet + RapidOCR 三模型栈实测 ~2.45GB 起(docs/bench.md) */
const WORKER_MEM_BUDGET_BYTES = 2.5 * 1024 ** 3;
/* worker 数上限:bench.md 只标定到 workers=4;2026-10-05 97 页采购文件实测 8 路并发
   (旧默认 min(CPU,8),22 核机即 8)导致内存饱和、整机卡顿、单页 33s(基准 14.4s)。 */
const WORKERS_HARD_CAP = 4;

/**
 * 资源感知默认 worker 数(v0.6.1):min(CPU, 4, 内存预算)。
 * 旧口径 min(CPU,8) 只看核数不看内存,内存饱和后并行反比串行更慢,且拖垮整机。
 * @param {object} [p] 注入测试:{cpu, totalMem, cap}
 * @returns {number} ≥1
 */
export function defaultWorkers({ cpu = os.cpus?.()?.length || 4, totalMem = os.totalmem?.() ?? 0, cap = WORKERS_HARD_CAP } = {}) {
	const byMem = totalMem > 0 ? Math.max(1, Math.floor(totalMem / WORKER_MEM_BUDGET_BYTES)) : cap;
	return Math.max(1, Math.min(cpu, cap, byMem));
}

/**
 * ETA 估算(bench.md 标定):
 *   - workers=1: 97 页全量 23.3min ≈ 14.4s/页 → 97×15=1455s(偏差 +4%,可接受);
 *   - workers=4: 线性 364s + 多 worker 模型加载/渲染固定开销 ≈ 40s → 404s,
 *     落在 captain 标定区间 400-420s(文字密页 16.1s 反而慢于表格页 11.3s,
 *     故按页数均耗启发式,不按区域密度精调);
 *   - workers=0(默认): 按资源感知默认口径 defaultWorkers() 估算(F5,v0.6.1 起为
 *     min(CPU,4,内存预算)——旧 min(CPU,8) 口径与实际执行的 worker 数脱节)。
 */
export function estimateEtaSec(totalPages, workers = 1, perPageSec = 15) {
	if (!Number.isInteger(totalPages) || totalPages <= 0) return null;
	const effective = (workers | 0) > 0 ? (workers | 0) : defaultWorkers();
	const w = Math.max(1, effective);
	const linear = Math.ceil((totalPages * perPageSec) / w);
	// 多 worker 固定开销:每个 worker 首次加载模型 ~5s + 主进程渲染阶段(bench ≈16s)
	return linear + (w > 1 ? 40 : 0);
}

/* ------------------------------------------------------------------ 探针 */

/**
 * 复杂度探针: parallel_ocr.py --probe(仅版面模型,目标 ≤8s + 模型加载)。
 * @returns {Promise<{ok: boolean, pages?: object[], error?: string}>}
 */
export async function runProbe({ python, script, pdf, scale = 2, pages = "1", timeoutMs = 120_000, signal = null }) {
	let probeEvent = null;
	const { promise, killTree } = spawnStream(python, [script, String(pdf), "--scale", String(scale), "--probe", String(pages)], {
		signal,
		timeoutMs,
		onLine: (line) => {
			const ev = parseNdjsonLine(line);
			if (ev?.event === "probe") probeEvent = ev;
		},
	});
	const r = await promise;
	if (probeEvent) {
		if (probeEvent.error) return { ok: false, pages: probeEvent.pages ?? [], error: probeEvent.error };
		return { ok: true, pages: probeEvent.pages ?? [] };
	}
	const tail = r.error ? r.error : (r.stderrTail || "").trim().split("\n").slice(-4).join("\n");
	return {
		ok: false,
		error: r.timedOut
			? `复杂度探针超时(${Math.round(timeoutMs / 1000)}s)已终止:${tail || "(无输出)"}`
			: `复杂度探针执行失败:${tail || `(exit ${r.status})`}`,
	};
}

/* ------------------------------------------------------------------ 增量写入 */

/** 原子写文本: 临时文件 + rename(与 Python 侧 _save_state 同口径) */
function atomicWriteText(path, text) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text, "utf8");
	try {
		renameSync(tmp, path); // Windows 允许覆盖已存在目标
	} catch {
		// 极端场景(杀软锁文件)退化为非原子覆盖
		writeFileSync(path, text, "utf8");
		try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
	}
}

/** 读取 Python 侧断点状态(只读;损坏/缺失返回 null) */
function readPythonState(statePath) {
	try {
		if (!statePath || !existsSync(statePath)) return null;
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		return st && typeof st.pages === "object" && st.pages ? st : null;
	} catch {
		return null;
	}
}

/**
 * 消费 parallel_ocr.py 的一次完整 OCR 运行(前台/后台作业共用)。
 *
 * - 每页 page 事件 → 锚点 upsert → 重写 .md(免疫乱序与 resume 重发) + 写 .progress.json;
 * - statePath 始终传给 Python --resume:首跑自动建状态,后续同参数自动接续(增量断点默认开启);
 *   resume=false 时先删旧状态/进度文件(全新语义;旧 md 仅作预播种源,最终被完整覆盖);
 * - 成功结束时按需追加溯源注释(metaComment)。
 *
 * @param {object} opts
 * @param {string} opts.python Python 解释器
 * @param {string} opts.script parallel_ocr.py 绝对路径
 * @param {string} opts.pdf 源 PDF 绝对路径
 * @param {string} opts.mdPath 增量输出 md(= 最终输出路径)
 * @param {string} opts.statePath 断点状态文件(Python 独占写)
 * @param {string} opts.progressPath 进度镜像文件(Node 写)
 * @param {string} [opts.title] md 标题行(如 "# 采购文件")
 * @param {string} [opts.metaComment] 成功结束时追加的溯源注释(可空)
 * @param {number} [opts.scale=2] 渲染倍率
 * @param {number} [opts.workers=0] 0=脚本默认 min(CPU,8);1=进程内快速路径(沙箱/调试)
 * @param {boolean} [opts.resume=false] true=接续既有断点;false=全新运行
 * @param {number} [opts.timeoutMs=0] 前台超时(0=不限;超时 → E_OCR_TIMEOUT,状态已落盘可续跑)
 * @param {AbortSignal|null} [opts.signal] 取消信号(中止 → 进程树终止,cancelled:true)
 * @param {(ev: object) => void} [opts.onEvent] 协议事件回调(start/page/done)
 * @param {Function} [opts.spawnStreamImpl] 注入测试替身
 * @returns {Promise<{ok: boolean, code?: string, error?: string, warnings?: string[],
 *                     mdPath?: string, statePath?: string, progressPath?: string,
 *                     progress?: object, cancelled?: boolean, timedOut?: boolean}>}
 */
export async function createOcrRun(opts) {
	const {
		python, script, pdf, mdPath, statePath, progressPath,
		title = "", metaComment = null,
		scale = 2, workers = 0, resume = false,
		timeoutMs = 0, signal = null,
		onEvent = null,
		spawnStreamImpl = spawnStream,
	} = opts;
	try {
		if (!python) throw new Error("python is required");
		if (!pdf || !mdPath || !statePath || !progressPath) throw new Error("pdf/mdPath/statePath/progressPath are required");

		// 全新语义:清旧状态/进度(旧 md 保留为预播种源,成功后被完整覆盖)
		if (!resume) {
			for (const p of [statePath, progressPath]) {
				try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
			}
		}

		// 预播种:既有 md 锚点 + 既有进度(统计)——resume 接续时不丢已完成页
		const pageMap = parseAnchoredPages(existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "");
		let priorStats = {};
		let priorSeconds = {};
		try {
			if (resume && existsSync(progressPath)) {
				const prev = JSON.parse(readFileSync(progressPath, "utf8"));
				if (prev && typeof prev.pageStats === "object" && prev.pageStats) priorStats = prev.pageStats;
				if (prev && typeof prev.pageSeconds === "object" && prev.pageSeconds) priorSeconds = prev.pageSeconds;
			}
		} catch { /* 进度镜像是尽力而为的观测文件 */ }

		mkdirSync(dirname(mdPath), { recursive: true });

		let total = null;
		let doneWarnings = null;
		let sawDone = false;

		const emit = (ev) => {
			if (typeof onEvent === "function") {
				try { onEvent(ev); } catch { /* 回调异常不中断 */ }
			}
		};

		const writeMd = () => atomicWriteText(mdPath, assembleMd(pageMap, title));

		const writeProgress = (extra = {}) => {
			try {
				const st = readPythonState(statePath);
				const pages = st?.pages ?? {};
				let done = 0, failed = 0;
				for (const v of Object.values(pages)) {
					if (v === "done") done++;
					else if (v === "failed") failed++;
				}
				atomicWriteText(progressPath, JSON.stringify({
					pdf: String(pdf),
					source: basename(pdf),
					total: total ?? st?.total ?? null,
					done, failed,
					pages,
					pageStats: priorStats,
					pageSeconds: priorSeconds, // v0.6.8 可观测性:逐页 OCR 耗时(秒)
					warnings: doneWarnings ?? [],
					...extra,
					updatedAt: new Date().toISOString(),
				}, null, "\t"));
			} catch { /* 进度镜像失败不阻断主流程 */ }
		};

		// v0.6.1: workers<=0 → 资源感知默认(内存预算制),显式传给 Python,
		// 避免与 parallel_ocr.py 独立默认口径漂移(单一事实源在 Node 侧)。
		const workerCount = (workers | 0) > 0 ? (workers | 0) : defaultWorkers();
		const { promise, killTree } = spawnStreamImpl(python, [
			script, String(pdf),
			"--scale", String(scale),
			"--workers", String(workerCount),
			"--resume", statePath,
		], {
			signal,
			timeoutMs,
			onLine: (line) => {
				const ev = parseNdjsonLine(line);
				if (!ev) return;
				if (ev.event === "start") {
					total = typeof ev.total === "number" ? ev.total : null;
					writeProgress();
					emit(ev);
				} else if (ev.event === "page" && Number.isInteger(ev.no)) {
					// 锚点 upsert(同页覆盖)——乱序/重发天然幂等
					pageMap.set(ev.no, typeof ev.md === "string" ? ev.md : "");
					if (ev.stats && typeof ev.stats === "object") priorStats[String(ev.no)] = ev.stats;
					if (Number.isFinite(ev.duration)) priorSeconds[String(ev.no)] = ev.duration; // v0.6.8 逐页耗时
					writeMd();
					writeProgress();
					emit(ev);
				} else if (ev.event === "done") {
					sawDone = true;
					doneWarnings = Array.isArray(ev.warnings) ? ev.warnings : [];
					writeProgress();
					emit(ev);
				}
			},
		});

		const r = await promise;

		if (signal?.aborted) {
			writeProgress({ status: "cancelled" });
			return {
				ok: false, cancelled: true,
				code: ERROR_CODES.E_OCR_RUN,
				error: "OCR 已取消(进程树已终止);已完成的页保留在 state.json,可 resume 接续",
				mdPath, statePath, progressPath,
			};
		}
		if (r.timedOut) {
			writeProgress({ status: "timeout" });
			return {
				ok: false, timedOut: true,
				code: ERROR_CODES.E_OCR_TIMEOUT,
				error: `OCR 执行超时已终止:${(r.stderrTail || "").trim().split("\n").slice(-3).join("\n") || "(无输出)"}。已完成页已落盘,可用 resume 接续`,
				mdPath, statePath, progressPath,
			};
		}

		// F3 收尾对账:state 标记 done 但 md 无该页 = job_kill/超时窗口在途事件静默丢失。
		// Node 不写 state(captain 裁定,Python 独占),故以 warnings+progress 标注并给出恢复指引;
		// 若不检出,--resume 会跳过这些页 → 最终文档静默缺页,断点恢复路径不闭环。
		const reconcile = () => {
			const st = readPythonState(statePath);
			if (!st?.pages) return null;
			const lost = [];
			for (const [k, v] of Object.entries(st.pages)) {
				const no = Number(k);
				if (v === "done" && Number.isInteger(no) && !pageMap.has(no)) lost.push(no);
			}
			lost.sort((a, b) => a - b);
			return lost.length ? lost : null;
		};
		const lost = reconcile();

		if (r.status === 0 && sawDone) {
			const warnings = doneWarnings ?? [];
			if (lost) {
				warnings.push(`对账发现 ${lost.length} 页已在断点状态标记完成但未写入 md(第 ${lost.join("、")} 页):resume 会跳过这些页,请删除 ${basename(statePath)} 后全新重跑,或对该页单独补 OCR`);
			}
			// 成功收尾:重写一次(含标题)+ 追加溯源注释;原子写防截断窗口(F3)
			const finalText = assembleMd(pageMap, title) + (metaComment ? `${metaComment}\n` : "");
			atomicWriteText(mdPath, finalText);
			writeProgress({ status: "done", ...(lost ? { reconciliation: { missingInMd: lost } } : {}) });
			const progress = readProgressSnapshot(progressPath);
			return { ok: true, warnings, mdPath, statePath, progressPath, progress };
		}

		// 非 0 退出:done 已到 → Python 层致命错误(已完成页保留,resumable);否则进程级异常
		writeProgress({ status: "failed", ...(lost ? { reconciliation: { missingInMd: lost } } : {}) });
		if (sawDone) {
			const fatal = (doneWarnings ?? []).filter((w) => String(w).includes("致命错误"));
			const warnings = doneWarnings ?? [];
			if (lost) {
				warnings.push(`对账发现 ${lost.length} 页已在断点状态标记完成但未写入 md(第 ${lost.join("、")} 页):resume 会跳过这些页,请删除 ${basename(statePath)} 后全新重跑,或对该页单独补 OCR`);
			}
			return {
				ok: false,
				code: ERROR_CODES.E_OCR_RUN,
				error: `OCR 致命错误(已完成页可 resume 接续):${fatal.join("; ") || (r.stderrTail || "").trim().split("\n").slice(-3).join("\n") || `(exit ${r.status})`}`,
				warnings,
				mdPath, statePath, progressPath,
				progress: readProgressSnapshot(progressPath),
			};
		}
		return {
			ok: false,
			code: ERROR_CODES.E_OCR_RUN,
			error: `OCR 进程异常退出(exit ${r.status}):${(r.stderrTail || "").trim().split("\n").slice(-4).join("\n") || "(无输出)"}`,
			mdPath, statePath, progressPath,
		};
	} catch (e) {
		return { ok: false, code: ERROR_CODES.E_UNKNOWN, error: e?.message ?? String(e) };
	}
}

/** 读取进度镜像快照(损坏返回 null) */
function readProgressSnapshot(progressPath) {
	try {
		return JSON.parse(readFileSync(progressPath, "utf8"));
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ 后台作业 */

/**
 * 把一次 convertFile 型长任务挂到 ctx.jobs 后台作业。
 *
 * 契约(与 dsh-tool-bash/dsh-tool-subagent 一致):
 *   - ctx.get("jobs") 不可用 → 返回 null(调用方走前台降级,不得报错);
 *   - exec.signal 已中止 → throw AbortError(预中止调用判失败);
 *   - v0.6.1 降级链:带 owner 启动 → 宿主拒绝时改无 owner(unowned bucket)启动 →
 *     仍拒绝则返回 {ok:false,reason}(调用方前台降级)。jobs.start 裸调用会让宿主侧
 *     拒绝(如 `session "[object Object]" has no live agent`)打穿整个工具调用——
 *     违反「绝不因缺服务而失败」承诺(2026-10-05 事故;dsh-tabbit installer 同位有此保护)。
 *   - run() 内用任务自有 AbortController(发布 id 后外层取消不再杀作业);
 *   - done 永不 reject(convertFile 自身收敛为结果对象)。
 *
 * @param {object} p
 * @param {object} p.ctx cordis ctx(读 jobs 服务)
 * @param {object} [p.exec] 工具 execute 的 exec(owner/signal)
 * @param {string} p.label 作业标签
 * @param {number|null} [p.etaSec] 预估秒数(仅透传给调用方展示)
 * @param {(signal: AbortSignal, onEvent?: (ev: object) => void) => Promise<object>} p.runFn
 *        真正的长任务(convertFile 等);onEvent 用于 readOutput 进度行
 * @returns {{ ok: true, jobId: string, etaSec?: number, ownerDetached?: true }
 *           | { ok: false, reason: string }
 *           | null}  null 仅表示 jobs 服务不可用(调用方按缺控制器口径降级)
 */
export function startBackgroundConvert({ ctx, exec, label, etaSec = null, runFn }) {
	const jobs = ctx?.get?.("jobs");
	if (!jobs) return null;
	if (exec?.signal?.aborted) {
		const e = new Error("tool call aborted");
		e.name = "AbortError";
		throw e;
	}
	const run = () => {
		const ctrl = new AbortController();
		let progressLine = "started";
		const onEvent = (ev) => {
			if (ev?.event === "start") progressLine = `total ${ev.total} 页处理中`;
			else if (ev?.event === "page") progressLine = `第 ${ev.no} 页完成`;
			else if (ev?.event === "done") progressLine = "done";
		};
		const p = (async () => {
			try {
				return await runFn(ctrl.signal, onEvent);
			} catch (e) {
				// runFn 异常也收敛为结果对象,保证 done 永不 reject
				return { ok: false, code: ERROR_CODES.E_UNKNOWN, error: e?.message ?? String(e) };
			}
		})();
		return {
			cancel: (reason) => ctrl.abort(reason ?? "job killed"),
			// 官方 JobOutcome 契约(dsh-jobs types.d.ts):{status:'completed'|'killed'|'failed', detail?, output?}
			// 必填 status——注册表 settle()/isTerminal 只认三值,缺省=永非终态(F1)。
			// 映射口径:cancelled→killed;成功→completed(富字段并入 detail);其余→failed。
			done: p.then((r) => {
				if (r?.cancelled) {
					return { status: "killed", detail: r.error ?? "job killed" };
				}
				if (r?.ok === true) {
					const target = r.outFile ?? r.mdPath ?? r.output ?? "";
					const extras = [];
					if (r.chain) extras.push(r.chain);
					if (r.mode) extras.push(r.mode);
					if (Array.isArray(r.warnings) && r.warnings.length) extras.push(`${r.warnings.length} 条警告`);
					return {
						status: "completed",
						detail: `${target}${extras.length ? ` (${extras.join(", ")})` : ""}`,
						output: target,
					};
				}
				return { status: "failed", detail: `${r?.code ? `[${r.code}] ` : ""}${r?.error ?? "未知错误"}` };
			}),
			// 官方 JobHooks.readOutput?(): string(F2)——必须返回字符串,否则 job_output 渲染 [object Object]
			readOutput: () => `md_convert 后台作业 ${progressLine}`,
		};
	};
	// v0.6.1 降级链:①带 owner(完成可注入唤醒) → 宿主拒绝则 ②无 owner(unowned bucket,
	// 完成不自动唤醒,调用方须以 warning 注明轮询 job_output) → 仍拒绝则 ③{ok:false}
	// 交调用方前台降级。jobs.start 每次失败的异常只记录,绝不外抛。
	const hasAgent = Boolean(exec?.agent);
	const attempts = [
		...(hasAgent ? [{ owner: exec.agent, degraded: false }] : []),
		{ degraded: hasAgent },
	];
	let lastError = null;
	for (const attempt of attempts) {
		const params = { kind: "md-convert", label: String(label ?? "md_convert"), run };
		if (!attempt.degraded && hasAgent) params.owner = attempt.owner;
		try {
			const jobId = jobs.start(params);
			return {
				ok: true,
				jobId,
				...(etaSec != null ? { etaSec } : {}),
				...(attempt.degraded ? { ownerDetached: true } : {}),
			};
		} catch (e) {
			lastError = e;
		}
	}
	return { ok: false, reason: lastError?.message ?? String(lastError ?? "未知错误") };
}
