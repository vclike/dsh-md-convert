/**
 * dsh-md-convert — vision 任务书生成引擎(v0.6.0 三层路由第三层)
 *
 * 复杂版面(表格/公式占比超阈值)本地 OCR 质量不佳时,不改用在线 API,
 * 而是把工作「任务书化」:渲染 PNG → 切批 → 生成高保真 OCR 提示词 →
 * 写 plan.json,由 agent 编排(多个子代理并行读图转写)后经
 * md_convert_assemble(T4)校验装配回最终 md。
 *
 * 一次 makeVisionBrief 的产物(全部落在 <outDir>/<名>.vision/ 工作目录,**持久保留**:
 * 子代理转写与复查期间都需要读图;装配后如需清理由调用方决定):
 *   <名>.vision/
 *     plan.json            # 任务书清单(批次/文件契约/装配入口)
 *     pages/p-NN.png       # render_pages.py 渲染的整册页面
 *     prompts/batch-NN.md  # 每批实例化后的提示词
 *     outputs/batch-NN.md  # 各批转写 output 约定落点(空占位)
 *
 * 接缝契约(与 lib/core/convert.js viaVision 对齐):
 *   makeVisionBrief(inputPath, opts) →
 *     { ok:true, mode:"vision-brief", chain:"vision-brief",
 *       planPath, batches:[{id,pages:[from,to],promptFile,outputFile}], workDir, warnings }
 *   失败 → { ok:false, code:E_VISION_PLAN, error }(不抛错;基础设施异常才抛)
 *
 * 提示词模板:默认 lib/py/prompts/vision-ocr.md;配置 vision.promptTemplate
 * 指向自定义文件即整体覆盖(相对路径基于会话工作区 opts.cwd)。
 * 模板变量:{{BATCH_ID}} {{PAGE_RANGE}} {{OUTPUT_FILE}} {{TOTAL_PAGES}}
 *           {{IMAGE_FILES}} {{PAGES_LIST}}
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPython } from "./deps.js";
import { parseNdjsonLine, spawnStream } from "./jobs.js";
import { ERROR_CODES } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
/** 内置高保真 OCR 提示词模板(cordis.yml vision.promptTemplate 可整体覆盖) */
export const PROMPT_TEMPLATE = join(here, "..", "py", "prompts", "vision-ocr.md");

const DEFAULTS = Object.freeze({
	batchSize: 8,     // 每批页数:单批过大 → 单次转写上下文过载;过小 → 批次数膨胀
	renderScale: 2,   // 渲染倍率(≈144dpi,与本地 OCR 同口径)
});

/* ------------------------------------------------------------------ 纯函数 */

/**
 * v0.7.16:列出本批页面可引用的插图候选(纯函数,便于单测)。
 * 只收 `pNNN_XX.png` 命名、且页号落在本批内的文件 —— 这与 extract_text.py
 * 的抽图命名 (`p%03d_%02d.png`) 严格对应,避免注入不存在的文件名。
 * @returns {string} Markdown 列表行;无候选返回提示行(明确告诉模型"没有图",而非留空)
 */
export function buildFigureList(pages, imgDir, enabled) {
	if (!enabled) return "   (本次未抽取文中插图;若页面上有明显图表/截图,仍需按规则 8 处理)";
	const names = [];
	for (const p of pages) {
		const stem = `p${String(p).padStart(3, "0")}_`;
		try {
			for (const f of readdirSync(imgDir).sort()) {
				if (f.startsWith(stem) && f.toLowerCase().endsWith(".png")) names.push(f);
			}
		} catch {
			/* 目录不可读 → 当作无候选 */
		}
	}
	if (!names.length) return "   (本批次无已抽取的插图候选)";
	return names.map((n) => `   - images/${n}`).join("\n");
}

/**
 * 纯函数:把 1..totalPages 切成连续批次。
 * @param {number} totalPages
 * @param {number} batchSize 每批页数(≥1)
 * @returns {Array<{id: string, from: number, to: number, pages: number[]}>}
 */
export function computeBatches(totalPages, batchSize = DEFAULTS.batchSize) {
	const size = Math.max(1, Math.floor(batchSize || DEFAULTS.batchSize));
	const batches = [];
	for (let from = 1; from <= totalPages; from += size) {
		const to = Math.min(totalPages, from + size - 1);
		const seq = batches.length + 1;
		const id = `batch-${String(seq).padStart(2, "0")}`;
		const pages = [];
		for (let p = from; p <= to; p++) pages.push(p);
		batches.push({ id, from, to, pages });
	}
	return batches;
}

/**
 * 纯函数:onlyPages 输入归一化(数组/逗号串/单数字 → 升序去重页号数组;无效 → null)。
 * @param {unknown} input
 * @returns {number[]|null}
 */
export function normalizeOnlyPages(input) {
	let list = null;
	if (Array.isArray(input)) list = input;
	else if (typeof input === "string" && input.trim()) list = input.split(",");
	else if (typeof input === "number" && Number.isInteger(input) && input >= 1) list = [input];
	if (!list) return null;
	const pages = list
		.map((v) => (typeof v === "string" ? Number(String(v).trim()) : v))
		.filter((v) => Number.isInteger(v) && v >= 1);
	const unique = [...new Set(pages)].sort((a, b) => a - b);
	return unique.length ? unique : null;
}

/**
 * 纯函数:对任意页号列表(v0.6.4 onlyPages 子集)做连续切批。
 * 子集页升序去重后按 batchSize 切成连续段;段内页号允许跳跃(如 [5,7])。
 * @param {number[]} pageList 页号列表
 * @param {number} [batchSize]
 * @returns {Array<{id: string, from: number, to: number, pages: number[]}>}
 */
export function computeBatchesForPages(pageList, batchSize = DEFAULTS.batchSize) {
	const size = Math.max(1, Math.floor(batchSize || DEFAULTS.batchSize));
	const unique = (Array.isArray(pageList) ? pageList : [])
		.filter((p) => Number.isInteger(p) && p >= 1)
		.sort((a, b) => a - b);
	const deduped = [...new Set(unique)];
	const batches = [];
	for (let i = 0; i < deduped.length; i += size) {
		const chunk = deduped.slice(i, i + size);
		batches.push({
			id: `batch-${String(batches.length + 1).padStart(2, "0")}`,
			from: chunk[0],
			to: chunk[chunk.length - 1],
			pages: chunk,
		});
	}
	return batches;
}

/**
 * v0.6.6:visionHints 命中页 → 自动生成 onlyPages 子集任务书(P1-B 自动闭环)。
 * 渲染失败不阻塞主流程(返回 {error}),调用方降级为仅提示 visionHints。
 * opts.vision.autoBrief === false 时跳过(默认开)。
 * @returns {Promise<{planPath, pages, batches}|{error: string}|null>}
 */
export async function maybeAutoVisionBrief(pdfPath, visionHints, opts = {}) {
	if (!visionHints || !Array.isArray(visionHints.pages) || !visionHints.pages.length) return null;
	if (opts.vision?.autoBrief === false) return null;
	const r = await makeVisionBrief(pdfPath, {
		...opts,
		vision: { ...(opts.vision ?? {}), onlyPages: visionHints.pages },
	});
	if (!r.ok) return { error: r.error ?? "vision 任务书生成失败" };
	return { planPath: r.planPath, pages: [...visionHints.pages], batches: r.batches.length };
}

/**
 * 纯函数:模板变量替换({{KEY}} 全量替换;未提供的变量替换为空串,不留残影)。
 * @param {string} template
 * @param {Record<string, string>} vars
 */
export function renderTemplate(template, vars, { strict = false } = {}) {
	// v0.7.16:内置模板走 strict —— 出现未提供的变量即**抛错**,不静默替换成空串。
	// 静默替换的后果:转写 agent 收到一段缺了"插图候选清单"的残缺提示词却毫无察觉,
	// 进而臆造图片路径或漏转内容,属于静默的质量退化。
	// 宽松模式是**刻意保留**的既有契约:自定义模板(vision.promptTemplate)可能带自己的
	// 变量,不该因插件新增变量而炸掉用户的模板。
	const missing = new Set();
	const out = String(template ?? "").replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
		if (!Object.prototype.hasOwnProperty.call(vars, key)) {
			if (strict) missing.add(key);
			return "";
		}
		return String(vars[key]);
	});
	if (missing.size) {
		throw new Error(`提示词模板存在未提供的变量:${[...missing].join(", ")}(内置模板与传参不一致,请检查代码)`);
	}
	return out;
}

/** 页号 → 补零锚点页码(与 parallel_ocr.py page_anchor_md 同口径) */
function anchorNo(no) {
	return String(no).padStart(2, "0");
}

/* ------------------------------------------------------------------ 渲染 */

/**
 * 默认渲染实现:解析 Python(失败即失败形状,不抛错)→ 调 render_pages.py。
 * python 解析放在本实现内:注入测试替身时,makeVisionBrief 完全不触 Python 探测。
 */
async function renderPagesDefault({ pythonHint, script, pdf, outDir, scale, pages, signal, onLog }) {
	const python = detectPython(pythonHint ?? "");
	if (!python) {
		return { ok: false, error: "未找到 Python。请安装 Python 后重试" };
	}
	let manifest = null;
	const args = [script, String(pdf), String(outDir), "--scale", String(scale)];
	if (Array.isArray(pages) && pages.length) args.push("--pages", pages.join(","));
	const { promise } = spawnStream(python, args, {
		signal: signal ?? null,
		onLine: (line) => {
			const ev = parseNdjsonLine(line);
			if (ev && typeof ev.ok === "boolean") manifest = ev;
		},
	});
	const r = await promise;
	if (manifest) {
		if (!manifest.ok) return { ok: false, error: manifest.error || "渲染失败" };
		return manifest;
	}
	const tail = r.error ? r.error : (r.stderrTail || "").trim().split("\n").slice(-3).join("\n");
	return { ok: false, error: `页面渲染执行失败:${tail || `(exit ${r.status})`}` };
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 生成 vision 批次任务书(渲染 → 切批 → 提示词实例化 → plan.json)。
 * @param {string} inputPath 源 PDF 绝对路径
 * @param {object} [opts] convert.js normalizeOpts 形态:
 *   outDir(必填), ocrScale, vision:{batchSize, renderScale, promptTemplate},
 *   cwd(相对模板路径基准), signal, onLog, renderPagesImpl(测试注入)
 * @returns {Promise<object>} 接缝契约见文件头
 */
export async function makeVisionBrief(inputPath, opts = {}) {
	try {
		const o = {
			outDir: opts.outDir,
			ocrScale: opts.ocrScale,
			vision: { ...DEFAULTS, ...(opts.vision ?? {}) },
			onlyPages: normalizeOnlyPages(opts.vision?.onlyPages), // v0.6.4:页子集(null=全页)
			cwd: opts.cwd ?? process.cwd(),
			signal: opts.signal ?? null,
			onLog: typeof opts.onLog === "function" ? opts.onLog : () => {},
			renderPagesImpl: opts.renderPagesImpl ?? renderPagesDefault,
			pythonHint: opts.ocr?.python ?? "",
		};
		if (!o.outDir) throw new Error("outDir is required");
		const base = basename(inputPath).replace(/\.[^.]+$/, "");
		const stem = base;
		const workDir = join(o.outDir, `${stem}.vision`);
		const pagesDir = join(workDir, "pages");
		const promptsDir = join(workDir, "prompts");
		const outputsDir = join(workDir, "outputs");
		const planPath = join(workDir, "plan.json");
		mkdirSync(pagesDir, { recursive: true });
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(outputsDir, { recursive: true });

		// 1. 渲染整册 PNG(仅 pypdfium2+Pillow,零 paddle 依赖)
		const { renderPagesImpl } = o;
		const manifest = await renderPagesImpl({
			pythonHint: o.pythonHint,
			script: join(here, "..", "py", "render_pages.py"),
			pdf: inputPath,
			outDir: pagesDir,
			scale: o.vision.renderScale ?? o.ocrScale ?? DEFAULTS.renderScale,
			pages: o.onlyPages, // v0.6.4 子集渲染;null/undefined=全页
			signal: o.signal,
			onLog: o.onLog,
		});
		if (!manifest.ok) {
			return fail(`页面渲染失败:${manifest.error ?? "未知原因"}`);
		}
		// 页清单:新 manifest 带 pageList(子集渲染时 files 与之按序对应);
		// onlyPages 与渲染回执取交集,容忍渲染侧越界钳制
		const manifestList = Array.isArray(manifest.pageList) && manifest.pageList.length
			? manifest.pageList
			: Array.from({ length: manifest.pages ?? 0 }, (_, k) => k + 1);
		const pageList = o.onlyPages
			? o.onlyPages.filter((p) => manifestList.includes(p))
			: manifestList;
		const totalPages = pageList.length;
		const files = Array.isArray(manifest.files) ? manifest.files : [];
		const expectedCount = Array.isArray(manifest.pageList) ? manifest.pageList.length : totalPages;
		if (totalPages <= 0 || files.length !== expectedCount) {
			return fail(`渲染清单异常:pages=${manifest.pages ?? 0},files=${files.length}`);
		}
		const pageFile = (p) => {
			const idx = Array.isArray(manifest.pageList) ? manifest.pageList.indexOf(p) : p - 1;
			return idx >= 0 ? files[idx] : files[p - 1];
		};
		// v0.7.16:已抽出的文中插图候选(extract_text.py --extract-images 产物)。
		// 注入提示词,让转写 agent 只能引用真实存在的文件名,杜绝臆造路径。
		const imgDir = join(workDir, "images");
		const hasImages = existsSync(imgDir);
		if (hasImages) o.onLog(`vision: 发现文中插图候选目录 ${imgDir}`);
		o.onLog(`vision: 已渲染 ${totalPages} 页${o.onlyPages ? `(子集 ${pageList[0]}-${pageList[pageList.length - 1]})` : ""} → ${manifest.dir}`);

		// 2. 模板加载(默认内置;vision.promptTemplate 整体覆盖)
		const tplPath = o.vision.promptTemplate
			? resolve(o.cwd, o.vision.promptTemplate)
			: PROMPT_TEMPLATE;
		let template;
		try {
			template = readFileSync(tplPath, "utf8");
		} catch (e) {
			return fail(`提示词模板不可读(${tplPath}):${e?.message ?? e}`);
		}

		// 3. 切批 + 模板实例化 + output 占位(v0.6.4:子集/全页统一走 computeBatchesForPages)
		const batches = computeBatchesForPages(pageList, o.vision.batchSize);
		const batchRecords = [];
		for (const b of batches) {
			const promptFile = join(promptsDir, `${b.id}.md`);
			const outputFile = join(outputsDir, `${b.id}.md`);
			const imageFiles = b.pages.map((p) => `- ${pageFile(p)}  (第 ${p} 页)`).join("\n");
			const pagesList = b.pages.map((p) => `   <!--PAGE:${anchorNo(p)}--> … <!--/PAGE:${anchorNo(p)}-->`).join("\n");
			const pageRange = b.from === b.to
				? `第 ${b.from} 页(共 1 页)`
				: `第 ${b.from}-${b.to} 页(共 ${b.pages.length} 页)`;
			// 内置模板 strict(变量漏传要炸出来);用户自定义模板保持宽松(既有契约)
		const isBuiltin = tplPath === PROMPT_TEMPLATE;
		let prompt;
		try {
			prompt = renderTemplate(
				template,
				{
					BATCH_ID: b.id,
					PAGE_RANGE: pageRange,
					OUTPUT_FILE: outputFile,
					TOTAL_PAGES: String(totalPages),
					IMAGE_FILES: imageFiles,
					PAGES_LIST: pagesList,
					// v0.7.16:本批可引用的插图候选清单(空=本次无插图,按纯文字转写)
					FIGURE_FILES: buildFigureList(b.pages, imgDir, hasImages),
				},
				{ strict: isBuiltin },
			);
		} catch (e) {
			return fail(`提示词渲染失败:${e?.message ?? e}`);
		}
			writeFileSync(promptFile, prompt, "utf8");
			// output 占位:装配工具(t4)可据此区分「未产出」与「空产出」
			if (!existsSync(outputFile)) {
				writeFileSync(outputFile, "", "utf8");
			}
			batchRecords.push({
				id: b.id,
				// v0.6.4:pages 用完整页列表(子集计划允许跳跃,如 [5,7,9]);
				// 旧版 [from,to] 二元组会抹掉中间页,已弃用(from/to 仍保留做范围展示)
				from: b.from,
				to: b.to,
				pages: b.pages,
				pageList: b.pages,
				imageFiles: b.pages.map((p) => pageFile(p)),
				promptFile,
				outputFile,
				status: "pending",
			});
		}

		// 4. plan.json 任务书清单(装配工具 md_convert_assemble 的唯一输入)
		const plan = {
			planVersion: 1,
			kind: "md-convert-vision-brief",
			createdAt: new Date().toISOString(),
			source: {
				pdf: resolve(inputPath),
				base,
				totalPages: pageList[pageList.length - 1], // 最大锚点页号(锚点语义仍为全文档页号)
				pageList,
				subset: Boolean(o.onlyPages),
			},
			render: { scale: o.vision.renderScale ?? o.ocrScale ?? DEFAULTS.renderScale, pagesDir: manifest.dir ?? pagesDir },
			promptTemplate: { path: tplPath, overridden: Boolean(o.vision.promptTemplate) },
			batches: batchRecords,
			outputContract: {
				anchorFormat: "<!--PAGE:NN--> … <!--/PAGE:NN-->(NN 两位补零,>99 页自然扩展)",
				anchorRegex: "<!--PAGE:(\\d{2,})-->([\\s\\S]*?)<!--/PAGE:\\1-->",
				rules: [
					"每页一对锚点、页号与 plan.pageList 一致、不得缺页/重页",
					"逐字保真:不改写/不翻译/不补全;无法辨认处用 <!-- 第N页…无法辨认 --> 占位",
					"只输出 Markdown 正文,不用代码围栏包裹全文",
				],
			},
			assemble: {
				tool: "md_convert_assemble",
				planPath,
				// v0.6.11:全页 vision 产物也加 -vision 后缀——实测视觉装配曾覆盖同名
				// 直提产物(工业富联对照实验,2026-10-06);两版必须并存供对比/合并
				finalOutput: o.onlyPages
					? join(workDir, `${base}-p${pageList[0]}-p${pageList[pageList.length - 1]}.md`)
					: join(o.outDir, `${base}-vision.md`),
				...(o.onlyPages
					? {
							merge: {
								kind: "anchor-replace",
								pages: pageList,
								note: "子集计划:本产物仅含 source.pageList 各页;将产物中的 <!--PAGE:NN--> 块逐一替换文字层版 md 的同名锚点块即完成合并",
							},
						}
					: {}),
			},
		};
		// 5. v0.7.16 多 agent 并发编排指令
		// 插件**无法自行派生子 agent**(无 spawn/delegate 能力),因此并发由宿主 agent 执行 ——
		// 与 Deep Research / agent team 同一机制:宿主管模型与并发,插件管批次切分与质量契约。
		// 这里把"用哪个模型、开几路并发、按什么顺序派发"写进 plan,宿主 agent 照做即可。
		const model = String(o.vision.model ?? "").trim();
		const rawConc = Number(o.vision.maxConcurrency);
		const maxConcurrency = Number.isFinite(rawConc) && rawConc > 0 ? Math.floor(rawConc) : 0;
		plan.orchestration = {
			executor: "host-agent",
			note: "本插件不派生子 agent;并发转写须由宿主 agent 执行(参考 agent team / deep research 的子 agent 机制)",
			model: model || "(跟随宿主当前模型)",
			modelExplicit: Boolean(model),
			batchCount: batchRecords.length,
			maxConcurrency: maxConcurrency || batchRecords.length,
			how: [
				`1) 用 **subagent/agent team/workflow** 一次性并发派发全部 ${batchRecords.length} 个批次任务书`,
				`2) 每个子 agent 读对应 promptFile,把转写结果**写入该批 outputFile**(路径见 batches[].outputFile)`,
				`3) 子 agent 必须使用**视觉模型**(能读图的模型);${model ? `指定模型 = ${model}` : "未指定,跟随宿主当前模型"}`,
				`4) 建议并发 ${maxConcurrency || batchRecords.length} 路(可在 vision.maxConcurrency 调整);不要串行跑满 ${batchRecords.length} 批`,
				"5) 全部批次完成后调用 md_convert_assemble(planPath) 装配",
			],
			qualityGuard: [
				"每批**独立**转写:不得跨批补写、不得加「接上页/续」等衔接语",
				"锚点是唯一合并依据:每页一对 <!--PAGE:NN--> … <!--/PAGE:NN-->,页号必须与该批 pages 一致",
				"提示词已内置图片规则(有信息量的图用 images/ 相对路径、截图里的表格必须转成 Markdown 表格)",
			],
		};
		try {
			writeFileSync(planPath, JSON.stringify(plan, null, "\t"), "utf8");
		} catch (e) {
			return fail(`plan.json 写入失败:${e?.message ?? e}`);
		}
		o.onLog(`vision: 任务书已生成 ${planPath}(批次 ${batchRecords.length},共 ${totalPages} 页)`);

		return {
			ok: true,
			mode: "vision-brief",
			chain: "vision-brief",
			planPath,
			workDir,
			batches: batchRecords.map((b) => ({ id: b.id, pages: b.pages, from: b.from, to: b.to, promptFile: b.promptFile, outputFile: b.outputFile })),
			// v0.7.16:编排指令直接回给宿主 agent,让并发真正发生(而不是只写在 plan 里等人读)
			orchestration: plan.orchestration,
			warnings: [],
		};
	} catch (e) {
		return { ok: false, code: ERROR_CODES.E_VISION_PLAN, error: e?.message ?? String(e) };
	}
}

function fail(error) {
	return { ok: false, code: ERROR_CODES.E_VISION_PLAN, error };
}
