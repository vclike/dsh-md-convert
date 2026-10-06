/**
 * dsh-md-convert — cordis 插件入口(Node 半区,v0.6.0)
 *
 * 向 agent 注册 `md_convert` 工具:把 Office / PDF 文档转换为结构级排版的
 * Markdown 文件并返回路径(输出到工作区内,便于会话引用)。
 *
 * v0.6.0 扫描件三层引擎路由:
 *   文字层直提(markitdown) → 页级并行 PaddleOCR(lib/py/parallel_ocr.py,
 *   NDJSON 流式 + 锚点 upsert 增量写 + state.json 断点续跑) → 复杂版面
 *   (表格/公式占比超阈值)走 vision 任务书链路(lib/core/vision.js)。
 *
 * 后台作业化:OCR 类长任务经 ctx.jobs 后台执行,立即返回
 *   {ok, background:true, jobId, etaSec};组合未加载 @deepseek-ai/dsh-jobs +
 *   @deepseek-ai/dsh-tool-jobs 时**优雅降级**为前台执行(background:false +
 *   warning 注明),绝不因缺服务而失败。
 *
 * 插件配置(Schemastery,下方 Config;cordis.yml config 行覆盖,零硬编码):
 *   outDir / forceOcr / ocrScale / autoInstallDeps / background / engine /
 *   ocr{python,workers,probeTimeoutMs,runTimeoutMs,etaPerPageSec} /
 *   vision{pagesThreshold,complexityRatio} / legacy{backend}
 */
import { resolve } from "node:path";
import { basename } from "node:path";
import z from "@deepseek-ai/schemastery";
import { convertFile, convertPdfTextLayer, assembleAndWrite } from "./core/convert.js";
import { assemblePlan } from "./core/assemble.js";
import { estimateEtaSec, pdfPageCount, startBackgroundConvert } from "./core/jobs.js";
import { detectPython } from "./core/deps.js";
import { maybeAutoVisionBrief } from "./core/vision.js";
import { ERROR_CODES } from "./core/errors.js";

export const name = "dsh-md-convert";

/** 工具注入所需的 cordis 服务 */
export const inject = ["tools"];

/** 插件配置(Schemastery;cordis.yml config 行覆盖,缺省用 schema 默认值) */
export const Config = z.object({
	outDir: z.string().default(""),             // 输出目录;空则使用会话工作区
	forceOcr: z.boolean().default(false),       // 强制 PDF 走 OCR
	ocrScale: z.number().default(2),            // PDF 渲染倍率
	autoInstallDeps: z.boolean().default(true), // 缺 OCR 依赖时自动 pip 安装
	background: z.union(["auto", "true", "false"]).default("auto"), // OCR 类任务后台作业化
	engine: z.union(["auto", "local", "vision", "pymupdf4llm"]).default("auto"),   // 扫描件引擎路由;pymupdf4llm=强制段落合并直提(v0.6.15)
	ocr: z.object({
		python: z.string().default(""),                // Python 解释器(空则自动探测)
		workers: z.number().default(0),                // 并行 worker;0=资源感知默认 min(CPU,4,内存预算);1=进程内快速路径(沙箱/调试)
		foregroundMaxPages: z.number().default(30),    // 前台 OCR 页数闸门;0=不限制(超限拒绝并指引后台/vision/resume)
		probeTimeoutMs: z.number().default(120_000),   // 复杂度探针超时
		runTimeoutMs: z.number().default(7_200_000),   // 前台 OCR 超时(后台作业不限)
		etaPerPageSec: z.number().default(15),         // ETA 估算单页均耗(bench.md ≈14.4s/页 @workers=1)
	}),
	vision: z.object({
		pagesThreshold: z.number().default(0),   // 可选强制换轨闸;0=不限页数(纯复杂度换轨)
		complexityRatio: z.number().default(0.4),// 表格+公式区域占比换轨阈值
		batchSize: z.number().default(8),        // vision 每批页数(单批过大上下文过载,过小批次数膨胀)
		renderScale: z.number().default(2),      // vision PNG 渲染倍率(≈144dpi)
		promptTemplate: z.string().default(""),  // 自定义提示词模板路径(空=内置 lib/py/prompts/vision-ocr.md;相对路径基于会话工作区)
		autoBrief: z.boolean().default(true),    // v0.6.6:文字层发现截图页(visionHints)时自动生成 onlyPages 子集任务书
	}),
	legacy: z.object({
		backend: z.union(["auto", "wps", "office", "libreoffice"]).default("auto"),
	}),
});

const BACKGROUND_WARNING =
	"后台作业控制器未安装(需在组合中加载 @deepseek-ai/dsh-jobs 与 @deepseek-ai/dsh-tool-jobs),已回退前台执行";

const OWNER_DETACHED_WARNING =
	"后台作业已无主启动(宿主拒绝 owner 关联):完成后不会自动注入本会话,请用 job_output(jobId) 主动轮询结果";

/** 规范 output.schema(与 execute 返回字段一一对应) */
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: true,
	properties: {
		ok: { type: "boolean", description: "转换是否成功(后台作业启动成功亦为 true)" },
		background: { type: "boolean", description: "是否已转为后台作业执行" },
		output: { type: "string", description: "成功时输出的 Markdown 路径" },
		chain: { type: "string", description: "成功时使用的转换链路(如 markitdown(pdf 文字层) / parallel-ocr / vision-brief)" },
		mode: { type: "string", description: "扫描件链路模式: local-ocr | vision-brief" },
		jobId: { type: "string", description: "后台作业 id(background=true 时返回;用 job_output 轮询)" },
		etaSec: { type: "number", description: "后台作业预计完成秒数(bench.md 标定估算;页数探查失败时省略)" },
		statePath: { type: "string", description: "断点续跑状态文件(Python 独占写,resume 用)" },
		progressPath: { type: "string", description: "进度镜像文件(逐页更新,可观测)" },
		progress: { type: "object", description: "完成时的进度快照 {total,done,failed,pages,...}" },
		decision: { type: "object", description: "引擎路由决策(route/reason/ratio/samplePages 等)" },
		probe: { type: "array", description: "复杂度探针原始数据(逐页区域计数)" },
		hint: { type: "string", description: "对比建议(如复杂度接近阈值时提示可尝试 engine=vision)" },
		planPath: { type: "string", description: "vision 任务书 plan.json 路径(mode=vision-brief)" },
		batches: { type: "array", description: "vision 批次任务书列表(mode=vision-brief)" },
		warnings: { type: "array", items: { type: "string" }, description: "警告列表(含降级说明)" },
		visionHints: { type: "object", description: "页级局部 vision 路由建议(v0.6.4):{threshold,pages,detail};pages 为图像占比高的页号,其内嵌截图文字不在文字层,建议 engine:\"vision\"+onlyPages 子集重转" },
		autoBrief: { type: "object", description: "自动生成的子集任务书(v0.6.6):{planPath,pages,batches};视觉转写各批 output 后 md_convert_assemble 装配,按锚点块替换合并回文字层版;autoBrief.error 为生成失败原因" },
		quality: { type: "object", description: "文字层产物质量信号(v0.6.12):{score,signals,issues,suggestVision};score<70 时 suggestVision=true 并在 warnings 给出 vision 重转建议(表格碎片化等确定性指标)" },
		elapsedMs: { type: "number", description: "总耗时毫秒(v0.6.8 可观测性:含探针/引擎/装配全链路;后台作业返回时为启动耗时)" },
		code: { type: "string", description: "失败时的稳定错误码" },
		file: { type: "string", description: "失败时涉及的源文件" },
		error: { type: "string", description: "失败时的错误信息" },
	},
	required: ["ok"],
};

export function apply(ctx, config = {}) {
	ctx.tools.register({
		name: "md_convert",
		description:
			"将 Office 文档(.doc/.docx/.xls/.xlsx/.ppt/.pptx)或 PDF(含扫描件)转换为保留结构级排版" +
			"(标题/列表/表格/段落)的 Markdown 文件,返回输出路径。" +
			"PDF 文字层:pypdfium2 结构增强直提(表格重建/标题层级/链接保留/页眉页脚剥离/PAGE 锚点/逐页图像占比," +
			"失败原因随 warnings 透出),markitdown 子进程桥兜底;Office 文档走 markitdown 子进程桥(表格原生支持);" +
			"截图页自动生成 onlyPages 子集任务书(autoBrief);页级并行本地 OCR(NDJSON 流式+断点续跑," +
			"OCR 类长任务自动转后台作业并立即返回 {jobId,etaSec})→ 表格/公式密集扫描件走 vision 任务书。" +
			"参数:background=auto|true|false(OCR 类一律后台;启动失败逐级降级:无主后台→前台,绝不报错失败)," +
			"engine=auto|local|vision(auto 按复杂度探针换轨),resume=true 断点续跑," +
			"onlyPages=\"5,7-9\" 页子集(配合 engine:\"vision\",产物仅含子集页,按锚点块替换合并)。" +
			"前台本地 OCR 有页数闸门(ocr.foregroundMaxPages,默认 30):超限拒绝(E_FOREGROUND_LIMIT)" +
			"并建议转后台/vision/resume,防止长任务占满 CPU/内存拖垮整机。" +
			"失败时返回稳定错误码: E_FILE_NOT_FOUND / E_UNSUPPORTED_FORMAT / E_MARKITDOWN / " +
			"E_LEGACY_CONVERT / E_OCR_DEPS / E_OCR_RUN / E_OCR_TIMEOUT / E_OCR_EMPTY / " +
			"E_VISION_PLAN / E_FOREGROUND_LIMIT / E_OUTPUT。",
		parameters: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "要转换的源文件路径(绝对路径或相对工作区路径)",
				},
				outDir: {
					type: "string",
					description: "输出目录(可选;默认插件配置或工作区)",
				},
				forceOcr: {
					type: "boolean",
					description: "强制 PDF 走 OCR(默认自动:文字层为空时转 OCR 路由)",
				},
				background: {
					type: "string",
					enum: ["auto", "true", "false"],
					description:
						"后台作业化(默认 auto):OCR 类长任务经后台作业执行并立即返回 {jobId,etaSec}," +
						"用 job_output(jobId) 轮询;文本层直提等快链路始终同步。" +
						"缺后台控制器时自动降级前台并附 warning。false=强制同步等待完成。",
				},
				engine: {
					type: "string",
					enum: ["auto", "local", "vision", "pymupdf4llm"],
					description:
						"扫描件引擎(默认 auto):auto=复杂度探针抽样 3 页,表格/公式占比超阈值走 vision," +
						"否则本地并行 OCR(任意页数);local=强制本地;vision=强制 vision 任务书。",
				},
				resume: {
					type: "boolean",
					description: "断点续跑(默认 false):true 时接续同名 .state.json 已完成页,仅重试失败页",
				},
				onlyPages: {
					description:
						"页子集(v0.6.4,配合 engine:\"vision\"):数组或逗号串,如 \"5,7-9\"。只渲染/转写这些页," +
						"装配产物仅含子集页;把产物中的 <!--PAGE:NN--> 块替换进文字层版 md 同名锚点块即完成局部增强合并。",
				},
			},
			required: ["file"],
		},
		output: { schema: OUTPUT_SCHEMA, render: renderOutput },
		async execute(args, exec) {
			return executeConvert(args, exec, ctx, config);
		},
	});

	// ---- md_convert_assemble:vision 链路装配与完整性校验(T4) ----
	ctx.tools.register({
		name: "md_convert_assemble",
		description:
			"装配 md_convert vision 链路(三层路由第三层)的批次产出为最终 Markdown,并做确定性完整性校验:" +
			"各批 output 文件存在且非空、PAGE 锚点覆盖 1..总页数(无缺页/无重复/无越批)、UTF-8 合法、" +
			"GBK 双重编码乱码特征检测、极短页统计。" +
			"全部通过 → 按页序合并写最终 md;有问题 → 仍装配(缺页占位)并返回 findings(每项 {page,severity,problem,evidence});" +
			"review:true 时对可疑页生成复查任务书(<名>-review.md,指向原 PNG + 逐字校正提示词)," +
			"并把受影响批次 outputFile 更新为复查输出路径(outputs/review-batch-NN.md,整批重写)," +
			"复查完成后重新调用本工具即可再次校验装配。" +
			"失败时返回稳定错误码: E_FILE_NOT_FOUND(plan.json 不存在) / E_ASSEMBLE(plan 损坏/结构无效/非合法 UTF-8) / E_OUTPUT。",
		parameters: {
			type: "object",
			properties: {
				planPath: {
					type: "string",
					description: "vision 任务书 plan.json 路径(md_convert engine=vision 产物,如 <outDir>/<名>.vision/plan.json)",
				},
				review: {
					type: "boolean",
					description: "生成复查任务书(默认 false):对可疑页(缺页/重复/越批/乱码/极短页)生成 <名>-review.md 并更新 plan.json 各批 output 为复查路径",
				},
			},
			required: ["planPath"],
		},
		output: { schema: ASSEMBLE_SCHEMA, render: renderAssembleOutput },
		async execute(args, exec) {
			return executeAssemble(args, exec, config);
		},
	});
}

const ASSEMBLE_SCHEMA = {
	type: "object",
	additionalProperties: true,
	properties: {
		ok: { type: "boolean", description: "装配是否完成(致命失败为 false;有 findings 但已装配仍为 true)" },
		output: { type: "string", description: "最终 Markdown 路径" },
		coverage: {
			type: "object",
			description: "锚点覆盖统计 {found,total}",
			properties: {
				found: { type: "number", description: "实际找到的页数" },
				total: { type: "number", description: "总页数(plan.source.totalPages)" },
			},
		},
		findings: {
			type: "array",
			description: "完整性发现列表(每项 {page,severity:blocker|high|medium|low,problem,evidence};空数组=全部通过)",
		},
		review: {
			type: "object",
			description: "复查任务书信息(review:true 且有可疑页时):{briefPath,pages,batches}",
		},
		planPath: { type: "string", description: "消费的 plan.json 路径" },
		code: { type: "string", description: "致命失败时的稳定错误码" },
		error: { type: "string", description: "致命失败时的错误信息" },
	},
	required: ["ok"],
};

function renderAssembleOutput(_args, value) {
	if (!value.ok) {
		return [{ type: "text", text: `md_convert_assemble 失败 [${value.code}]: ${value.error ?? ""}` }];
	}
	const cov = value.coverage ? ` (coverage ${value.coverage.found}/${value.coverage.total})` : "";
	if (Array.isArray(value.findings) && value.findings.length > 0) {
		const review = value.review?.briefPath ? `;复查任务书 ${value.review.briefPath}` : "(可 review:true 生成复查任务书)";
		return [{
			type: "text",
			text: `md_convert_assemble 装配完成但有 ${value.findings.length} 项发现${cov}: ${value.output};${review}`,
		}];
	}
	return [{ type: "text", text: `md_convert_assemble 完成${cov}: ${value.output}` }];
}

/** md_convert_assemble 执行主流程(独立导出便于测试) */
export async function executeAssemble(args, exec, _config = {}) {
	if (exec?.signal?.aborted) {
		const e = new Error("tool call aborted");
		e.name = "AbortError";
		throw e;
	}
	const planPath = args?.planPath;
	if (typeof planPath !== "string" || !planPath.trim()) {
		return { ok: false, code: "E_ASSEMBLE", planPath: String(planPath ?? ""), error: "缺少有效的 planPath 参数(需为 plan.json 路径)" };
	}
	const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
	return assemblePlan({
		planPath: resolve(cwd, planPath),
		review: args.review === true,
	});
}

function renderOutput(_args, value) {
	// v0.6.3:成功路径同样透出 warnings(降级/兜底原因)——此前只进 JSON 不进渲染,
	// 调用方看不到(markitdown 兜底原因一度只能翻输出文件 footer 获知)。
	const warn = (v) => {
		const arr = Array.isArray(v.warnings) ? v.warnings.filter(Boolean) : [];
		return arr.length ? `\n⚠ ${arr.join("\n⚠ ")}` : "";
	};
	if (value.ok && value.background) {
		const eta = Number.isFinite(value.etaSec) ? `,预计 ~${value.etaSec}s` : "";
		return [{
			type: "text",
			text: `md_convert 后台作业已启动: jobId=${value.jobId}${eta};进度 ${value.progressPath ?? "(见输出目录)"};完成后用 job_output 读取结果${warn(value)}`,
		}];
	}
	if (value.ok && value.mode === "vision-brief") {
		return [{
			type: "text",
			text: `md_convert vision 任务书已生成: ${value.planPath ?? value.output}(批次 ${Array.isArray(value.batches) ? value.batches.length : "?"});各批 output 完成后用 md_convert_assemble 装配${warn(value)}`,
		}];
	}
	if (value.ok) {
		const ab = value.autoBrief && value.autoBrief.planPath
			? `\n📄 截图页子集任务书已自动生成: ${value.autoBrief.planPath}(页 ${value.autoBrief.pages.join(",")},批次 ${value.autoBrief.batches});视觉转写后 md_convert_assemble 装配,按锚点块替换合并`
			: (value.autoBrief?.error ? `\n⚠ 截图页子集任务书生成失败: ${value.autoBrief.error}` : "");
		return [{
			type: "text",
			text: `md_convert 完成: ${value.output}${value.chain ? ` (${value.chain})` : ""}${warn(value)}${ab}`,
		}];
	}
	return [{
		type: "text",
		text: `md_convert 失败 [${value.code}]: ${value.error ?? ""}` +
			(Array.isArray(value.warnings) && value.warnings.length ? `\n⚠ ${value.warnings.join("\n⚠ ")}` : ""),
	}];
}

/** 工具执行主流程(独立导出便于测试) */
export async function executeConvert(args, exec, ctx, config = {}) {
	// v0.6.8 可观测性:总耗时(含探针/引擎/装配全链路),所有返回路径统一附 elapsedMs
	const startedAt = Date.now();
	const withElapsed = (r) => (r && typeof r === "object" ? { ...r, elapsedMs: Date.now() - startedAt } : r);
	// raw 注册无入参校验,这里做基础类型防御。
	const file = args?.file;
	if (typeof file !== "string" || !file.trim()) {
		return withElapsed({ ok: false, code: "E_FILE_NOT_FOUND", file: String(file ?? ""), error: "缺少有效的 file 参数(需为字符串路径)" });
	}
	// 相对路径基准是「会话工作区」(exec.agent.session.header.cwd),而非宿主进程 cwd
	// (与官方 dsh-tool-fs 一致;带盘符绝对路径被 resolve 正确保留)。
	const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
	const src = resolve(cwd, file);
	const outArg = typeof args.outDir === "string" && args.outDir ? args.outDir : (config.outDir || cwd);
	const out = resolve(cwd, outArg);
	const background = pickEnum(args.background, config.background, ["auto", "true", "false"], "auto");
	const engine = pickEnum(args.engine, config.engine, ["auto", "local", "vision", "pymupdf4llm"], "auto");
	const resume = typeof args.resume === "boolean" ? args.resume : false;
	const warnings = [];

	const baseOpts = {
		outDir: out,
		forceOcr: typeof args.forceOcr === "boolean" ? args.forceOcr : config.forceOcr,
		ocrScale: config.ocrScale,
		ocr: config.ocr,
		autoInstallDeps: config.autoInstallDeps !== false,
		legacy: config.legacy,
		engine,
		resume,
		workers: config.ocr?.workers ?? 0,
		probeTimeoutMs: config.ocr?.probeTimeoutMs,
		runTimeoutMs: config.ocr?.runTimeoutMs,
		vision: { ...(config.vision ?? {}), ...(args.onlyPages != null ? { onlyPages: args.onlyPages } : {}) },
		cwd, // 会话工作区:vision 自定义模板相对路径的解析基准
	};

	const isPdf = /\.pdf$/i.test(src);

	// ---- PDF:先试文字层快路径(v0.6.2 双引擎:markitdown → pypdfium2 兜底;快链路不进后台) ----
	if (isPdf && !baseOpts.forceOcr && engine !== "vision") {
		// v0.6.15: engine="pymupdf4llm" 显式强制段落合并直提(跳过自研直提优先级)
		const textLayer = await convertPdfTextLayer(src, { python: config.ocr?.python ?? "", forcePymupdf4llm: engine === "pymupdf4llm" });
		if (textLayer.ok) {
			const tlWarn = Array.isArray(textLayer.warnings) ? textLayer.warnings : [];
			const assembled = assembleAndWrite(src, { md: textLayer.md, chain: textLayer.chain, warnings: [...warnings, ...tlWarn] }, baseOpts);
			if (!assembled.ok) return withElapsed(failResult(assembled));
			// v0.6.6 P1-B:截图页 visionHints → 自动生成 onlyPages 子集任务书(失败不阻塞)
			let autoBrief = null;
			if (textLayer.visionHints && baseOpts.vision?.autoBrief !== false) {
				try {
					autoBrief = await maybeAutoVisionBrief(src, textLayer.visionHints, baseOpts);
				} catch {
					autoBrief = null;
				}
			}
			return withElapsed({
				ok: true,
				background: false,
				output: assembled.outFile,
				chain: assembled.chain,
				decision: { route: "text-layer", via: textLayer.via },
				...(textLayer.visionHints ? { visionHints: textLayer.visionHints } : {}),
				...(autoBrief ? { autoBrief } : {}),
				...(textLayer.quality ? { quality: textLayer.quality } : {}),
				warnings: assembled.warnings,
			});
		}
		// 文字层不可用 → 落入 OCR 路由(失败原因透出,不再静默吞)
		warnings.push(`文字层直提不可用:${textLayer.error}`);
	}

	// ---- OCR 路由(PDF:扫描件/文字层为空/强制 OCR) ----
	if (isPdf) {
		const jobsAvailable = hasJobs(ctx);
		const wantBackground = (background === "true" || background === "auto") && engine !== "vision";
		// 页数探查(后台 ETA 与前台闸门共用;fast <1s;探查失败=null → 不承诺 ETA 且不设闸)
		const totalPages = engine === "vision" ? null : await safePageCount(src, config.ocr);
		if (wantBackground && jobsAvailable) {
			const etaSec = totalPages != null
				? estimateEtaSec(totalPages, baseOpts.workers ?? 0, config.ocr?.etaPerPageSec ?? 15)
				: null;
			const handle = startBackgroundConvert({
				ctx,
				exec,
				label: `OCR ${basename(src)}`,
				etaSec,
				runFn: (signal, onEvent) =>
					convertFile(src, {
						...baseOpts,
						forceOcr: true,       // 进入后台即确定走 OCR 路由(文字层快路径已前置排除)
						signal,               // 任务自有 controller(job_kill → 进程树终止)
						onEvent,
						runTimeoutMs: 0,      // 后台不限时,生命周期归 job_kill/owner
					}),
			});
			if (handle?.ok) {
				return withElapsed({
					ok: true,
					background: true,
					jobId: handle.jobId,
					...(etaSec != null ? { etaSec } : {}),
					statePath: statePathFor(src, out),
					progressPath: progressPathFor(src, out),
					...(handle.ownerDetached || warnings.length
						? { warnings: [...(handle.ownerDetached ? [OWNER_DETACHED_WARNING] : []), ...warnings] }
						: {}),
				});
			}
			// v0.6.1:jobs 服务消失(null)或宿主拒绝启动({ok:false,reason})均降级前台,绝不失败
			warnings.push(handle ? `后台作业启动失败,已回退前台:${handle.reason}` : BACKGROUND_WARNING);
		} else if (wantBackground && !jobsAvailable) {
			// captain 硬性要求:缺后台控制器优雅降级,绝不报错失败
			warnings.push(BACKGROUND_WARNING);
		}
		// v0.6.1 前台闸门:vision 任务书生成是秒级不受闸;本地 OCR 前台长跑会占满 CPU/内存
		// (2026-10-05 事故:97 页前台 8 workers 拖垮整机),超限拒绝并给出替代路线。
		if (engine !== "vision" && totalPages != null) {
			const maxPages = Number.isFinite(config.ocr?.foregroundMaxPages) ? config.ocr.foregroundMaxPages : 30;
			if (maxPages > 0 && totalPages > maxPages) {
				const eta = estimateEtaSec(totalPages, baseOpts.workers ?? 0, config.ocr?.etaPerPageSec ?? 15);
				return withElapsed({
					ok: false,
					background: false,
					code: ERROR_CODES.E_FOREGROUND_LIMIT,
					file: src,
					error:
						`前台 OCR 页数超限:${totalPages} 页 > 上限 ${maxPages} 页(前台长任务会占满 CPU/内存影响整机)。` +
						`建议:① background:"true" 转后台作业;② engine:"vision" 走多子代理视觉并行;` +
						`③ 已有断点进度时配合 resume:true;④ 确需前台:配置 ocr.foregroundMaxPages=0 解除限制(自担风险)。`,
					...(eta != null
						? { hint: `本地 OCR 预估 ~${Math.max(1, Math.round(eta / 60))} 分钟(资源感知 workers);vision 路线零本机负载` }
						: {}),
					statePath: statePathFor(src, out),
					progressPath: progressPathFor(src, out),
					...(warnings.length ? { warnings: [...warnings] } : {}),
				});
			}
		}
		// 前台执行(降级 / 显式 background=false / engine=vision 任务书)
		const result = await convertFile(src, { ...baseOpts, signal: exec?.signal ?? null });
		return withElapsed(toCanonical(result, { background: false, warnings: mergeWarnings(warnings, result.warnings) }));
	}

	// ---- 非 PDF:文本层/legacy/markitdown 快链路,同步执行 ----
	const result = await convertFile(src, { ...baseOpts, signal: exec?.signal ?? null });
	return withElapsed(toCanonical(result, { background: false, warnings: mergeWarnings(warnings, result.warnings) }));
}

/* ------------------------------------------------------------------ internals */

function pickEnum(argValue, configValue, allowed, dflt) {
	const a = typeof argValue === "string" && allowed.includes(argValue) ? argValue : undefined;
	const c = typeof configValue === "string" && allowed.includes(configValue) ? configValue : undefined;
	return a ?? c ?? dflt;
}

function hasJobs(ctx) {
	return Boolean(ctx?.get?.("jobs"));
}

/** 页数探查(fast <1s;任何失败返回 null,不阻塞 ETA 与前台闸门——探查不了即不设闸) */
async function safePageCount(src, ocrCfg) {
	try {
		const python = detectPython(ocrCfg?.python ?? "");
		if (!python) return null;
		const total = await pdfPageCount(python, src);
		return total > 0 ? total : null;
	} catch {
		return null;
	}
}

function statePathFor(src, outDir) {
	return resolve(outDir, `${basename(src).replace(/\.[^.]+$/, "")}.state.json`);
}

function progressPathFor(src, outDir) {
	return resolve(outDir, `${basename(src).replace(/\.[^.]+$/, "")}.progress.json`);
}

function mergeWarnings(pre, post) {
	return [...(pre ?? []), ...(post ?? [])];
}

/** convertFile 结果 → 工具规范 JSON(字段与 OUTPUT_SCHEMA 一一对应) */
function toCanonical(result, { background, warnings }) {
	if (!result.ok) return failResult({ ...result, warnings });
	return {
		ok: true,
		background,
		output: result.outFile,
		chain: result.chain,
		...(result.mode ? { mode: result.mode } : {}),
		...(result.statePath ? { statePath: result.statePath } : {}),
		...(result.progressPath ? { progressPath: result.progressPath } : {}),
		...(result.progress ? { progress: result.progress } : {}),
		...(result.decision ? { decision: result.decision } : {}),
		...(result.probe ? { probe: result.probe } : {}),
		...(result.planPath ? { planPath: result.planPath } : {}),
		...(Array.isArray(result.batches) ? { batches: result.batches } : {}),
		warnings: warnings ?? result.warnings ?? [],
	};
}

function failResult({ code, file, error, warnings }) {
	return {
		ok: false,
		background: false,
		code: code ?? "E_UNKNOWN",
		...(file ? { file } : {}),
		error: error ?? "未知错误",
		...(Array.isArray(warnings) && warnings.length ? { warnings } : {}),
	};
}
