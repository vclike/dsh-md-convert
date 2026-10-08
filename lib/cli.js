#!/usr/bin/env node
/**
 * dsh-md-convert — 命令行入口
 *
 * 用法:
 *   dsh-md-convert <文件...> -o <输出目录> [选项]
 *   dsh-md-convert check                # 检查 OCR 依赖状态
 *   dsh-md-convert deps                 # 检查并自动安装缺失的 OCR 依赖
 *
 * 示例:
 *   dsh-md-convert a.docx b.pdf -o ./md
 *   dsh-md-convert old.doc -o ./md --legacy-backend wps
 *   dsh-md-convert scan.pdf -o ./md --force-ocr        # 扫描件固定走路由 OCR
 *
 * 退出码:
 *   0 全部成功   1 存在失败(含失败文件的错误码与路径)   2 参数错误
 */
import { createRequire } from "node:module";
import { convertMany } from "./core/convert.js";
import { expandInputs } from "./core/scan.js";
import { assemblePlan } from "./core/assemble.js";
import { formatError, ERROR_CODES } from "./core/errors.js";
import { installSignalCleanup } from "./core/cleanup.js";
import { ensureOcrDeps, detectPython, findMissingModules, PY_MODULES, ocrModelCacheStatus, ensureOcrModels } from "./core/deps.js";

const require = createRequire(import.meta.url);

function printHelp() {
	console.log(`dsh-md-convert — 将 Office / PDF 文档转换为结构级排版的 Markdown

用法:
  dsh-md-convert <文件...|目录...> -o <输出目录> [选项]
  dsh-md-convert convert <文件...|目录...> -o <输出目录> [选项]   # 同上(convert 子命令显式形式)
  dsh-md-convert assemble <plan.json> [--review]          # vision 链路装配:批次 output → 最终 md + 完整性校验
  dsh-md-convert check                    检查 OCR 依赖与模型缓存(不安装)
  dsh-md-convert deps                     安装缺失依赖并预下载 OCR 模型到本地(需联网一次,之后离线可用)

必选:
  -o, --out-dir <dir>          输出目录(生成的 .md 文件;assemble 子命令不需要)
  -r, --recursive              目录输入时递归子目录(默认只处理顶层)

选项:
      --force-ocr              强制 PDF 走 OCR(扫描件自动识别,文字层空时自动回退)
      --engine <mode>          扫描件引擎: auto | local | vision
                               (auto=复杂度探针抽样 3 页,表格/公式占比超阈值走 vision 任务书,
                                否则页级并行本地 OCR 任意页数;默认 auto)
      --background <mode>      auto | true | false(默认 auto:CLI 无后台控制器,in-process
                               后台模式=立即打印 jobId + stderr 逐页进度 + state/progress 文件可轮询;
                               agent 工具内 auto/true 走 ctx.jobs 真后台作业)
      --resume                 断点续跑:接续同名 .state.json 已完成页,仅重试失败页
      --review                 (仅 assemble)对可疑页生成复查任务书 <名>-review.md 并更新 plan.json
      --workers <n>            并行 worker 数(默认 0=资源感知 min(CPU,4,内存预算);
                                1=进程内快速路径,兼容禁用命名管道的沙箱/容器;
                                多 worker 需系统支持命名管道)
      --ocr-scale <n>          PDF 渲染倍率(默认 2,约 144dpi)
      --pages <spec>           只转换指定页(v0.7.3):如 "1-20" / "1-20,25,30-32"(1 起页号,
                               锚点保留原始页号)。文字层 PDF 支持任意页集合;vision 路由支持完整集合;
                               扫描件 OCR 只支持"从第 1 页起的连续 N 页"(其它形态会明确告警)。
                               越界报错而不会静默丢弃
      --ocr-python <path>      指定 Python 解释器(运行 OCR 流水线;留空自动探测 python/python3/py)
      --no-auto-install-deps   缺 OCR 依赖时不自动 pip 安装,直接报错(默认自动安装)
      --legacy-backend <b>     老格式转换后端: auto | wps | office | libreoffice(auto:Windows 用 wps/office COM,Linux/macOS 用 LibreOffice)
      --no-title               不在 md 开头加源文件名标题
      --no-meta                不追加转换溯源注释
      --no-overwrite           不覆盖已存在的 .md
      --keep-temp              保留临时文件(调试)
  -h, --help                   显示帮助
  -v, --version                显示版本

扫描件三层路由(v0.6.0):
  文字层直提(markitdown) → 复杂度探针(--probe 抽样 3 页,表格/公式占比 > 40% 转 vision
  任务书,阈值可配) → 页级并行本地 OCR(NDJSON 流式 + <!--PAGE:NN--> 锚点 upsert 增量写
  .md + .progress.json 进度镜像 + .state.json 断点续跑)。
  模型缓存: 运行 \`dsh-md-convert deps\` 预下载(首次约数百 MB),之后完全离线。

退出码: 0 全部成功 / 1 存在失败(每行带 [错误码] 源文件 原因) / 2 参数错误`);
}

function parseArgs(argv) {
	const opts = { files: [], outDir: null, command: null, background: "auto", engine: "auto", workers: 0 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case "check": case "deps": case "convert": case "assemble": opts.command = a; break;
			case "-o": case "--out-dir": opts.outDir = next(); break;
			case "--force-ocr": opts.forceOcr = true; break;
			case "--engine": opts.engine = next(); break;
			case "--background": opts.background = next(); break;
			case "--resume": opts.resume = true; break;
			case "--review": opts.review = true; break;
			case "--workers": opts.workers = Number(next()); break;
			case "--ocr-scale": opts.ocrScale = Number(next()); break;
			case "--ocr-python": opts.ocrPython = next(); break;
			case "--no-auto-install-deps": opts.noAutoInstallDeps = true; break;
			case "-r": case "--recursive": opts.recursive = true; break;
			case "--no-cjk-merge": opts.noCjkMerge = true; break;
			case "--pages": opts.pages = next(); break;
			case "--legacy-backend": opts.legacyBackend = next(); break;
			case "--no-title": opts.noTitle = true; break;
			case "--no-meta": opts.noMeta = true; break;
			case "--no-overwrite": opts.noOverwrite = true; break;
			case "--keep-temp": opts.keepTemp = true; break;
			case "-h": case "--help": printHelp(); process.exit(0); break;
			case "-v": case "--version": console.log(require("../package.json").version); process.exit(0); break;
			default:
				if (a.startsWith("-")) { console.error(`未知选项: ${a}`); printHelp(); process.exit(2); }
				opts.files.push(a);
		}
	}
	return opts;
}

/** check / deps 子命令:OCR 依赖 + 模型缓存状态 */
async function depsCommand(mode) {
	const python = detectPython();
	if (!python) {
		console.error("✗ 未找到 Python(需要 Python ≥3.8)。请先安装:https://www.python.org/downloads/");
		process.exit(1);
	}
	console.log(`✓ Python: ${python}`);

	// 1. Python 依赖(pip 包)
	const { missing } = findMissingModules(python);
	if (missing.length > 0) {
		console.log(`⚠ 缺少 OCR 模块: ${missing.join(", ")}`);
		if (mode !== "deps") {
			console.log(`  安装命令: python -m pip install ${missing.map((m) => PY_MODULES[m]).join(" ")}`);
			process.exit(1);
		}
		console.log("→ 开始安装 OCR 依赖...");
		const r = await ensureOcrDeps({ python, autoInstall: true, onLog: (m) => console.log(`  ${m}`) });
		if (!r.ok) {
			console.error(`✗ 安装失败:${r.error}`);
			process.exit(1);
		}
		console.log(`✓ 已安装: ${r.installed.join(", ")}`);
	} else {
		console.log("✓ OCR 依赖齐全: paddlepaddle / paddleocr / paddlex[ocr] / pypdfium2 / rapidocr / onnxruntime");
	}

	// 2. 路由 OCR 模型缓存(本地离线运行的前提)
	const modelStatus = ocrModelCacheStatus(python);
	if (modelStatus.ok) {
		console.log(`✓ OCR 模型已缓存(${modelStatus.cacheDir}),运行完全离线、不检查网络`);
		process.exit(0);
	}
	console.log(`⚠ 缺少 OCR 模型(${modelStatus.missing.length} 个): ${modelStatus.missing.join(", ")}`);
	if (mode !== "deps") {
		console.log("  请联网执行一次 `dsh-md-convert deps` 预下载模型(首次约数百 MB),之后离线可用");
		process.exit(1);
	}
	const m = await ensureOcrModels(python, (msg) => console.log(`  ${msg}`));
	if (!m.ok) {
		console.error(`✗ 模型就绪失败:${m.error}`);
		process.exit(1);
	}
	console.log("✓ OCR 模型已就绪(本地缓存,之后离线可用)");
	process.exit(0);
}

function buildConvertOpts(cli, handlers = {}) {
	return {
		outDir: cli.outDir,
		forceOcr: cli.forceOcr,
		ocrScale: cli.ocrScale,
		ocr: { python: cli.ocrPython },
		autoInstallDeps: !cli.noAutoInstallDeps,
		cjkMerge: !cli.noCjkMerge,
		pages: cli.pages || "",
		legacy: { backend: cli.legacyBackend },
		title: !cli.noTitle,
		meta: !cli.noMeta,
		overwrite: !cli.noOverwrite,
		keepTemp: cli.keepTemp,
		onLog: (m) => console.log(`  ${m}`),
		// ---- v0.6.0 三层路由 ----
		engine: cli.engine ?? "auto",
		resume: cli.resume === true,
		workers: Number.isFinite(cli.workers) ? cli.workers : 0,
		signal: handlers.signal ?? null,
		onEvent: handlers.onEvent ?? null,
	};
}

/** 合法后端值(校验 --legacy-backend) */
const LEGACY_BACKEND_VALUES = new Set(["auto", "wps", "office", "libreoffice"]);
const ENGINE_VALUES = new Set(["auto", "local", "vision"]);
const BACKGROUND_VALUES = new Set(["auto", "true", "false"]);

async function main() {
	const cli = parseArgs(process.argv.slice(2));

	if (cli.command === "check" || cli.command === "deps") {
		installSignalCleanup();
		await depsCommand(cli.command);
		return;
	}

	// ---- assemble 子命令:vision 批次产出 → 最终 md + 完整性校验 ----
	if (cli.command === "assemble") {
		const planPath = cli.files[0];
		if (!planPath) {
			console.error("错误: assemble 需要传入 plan.json 路径。\n");
			printHelp();
			process.exit(2);
		}
		if (cli.review) console.log("review 模式:可疑页将生成复查任务书并更新 plan.json");
		const r = await assemblePlan({ planPath, review: cli.review === true });
		if (!r.ok) {
			console.error(`✗ [${r.code}] ${r.error}`);
			for (const f of r.findings ?? []) console.error(`  ⚠ [${f.severity}] 第${f.page ?? "-"}页 ${f.problem}: ${f.evidence}`);
			process.exit(1);
		}
		console.log(`✓ 装配完成 (coverage ${r.coverage.found}/${r.coverage.total}) → ${r.output}`);
		for (const f of r.findings ?? []) console.warn(`  ⚠ [${f.severity}] 第${f.page ?? "-"}页 ${f.problem}: ${f.evidence}`);
		if (r.review) {
			console.log(`  复查任务书: ${r.review.briefPath}`);
			console.log(`  受影响批次: ${r.review.batches.join(", ")}(可疑页 ${r.review.pages.length} 个)`);
		}
		// 有 findings 即退出 1(脚本可感知"装配了但有问题");全绿退出 0
		process.exit((r.findings ?? []).length ? 1 : 0);
	}

	if (cli.files.length === 0) {
		console.error("错误: 未指定输入文件。\n");
		printHelp();
		process.exit(2);
	}
	if (!cli.outDir) {
		console.error("错误: 缺少 -o/--out-dir。\n");
		printHelp();
		process.exit(2);
	}
	if (cli.legacyBackend && !LEGACY_BACKEND_VALUES.has(cli.legacyBackend)) {
		console.error(`错误: 无效的 --legacy-backend: ${cli.legacyBackend}(可选: auto | wps | office | libreoffice)\n`);
		printHelp();
		process.exit(2);
	}
	if (!ENGINE_VALUES.has(cli.engine)) {
		console.error(`错误: 无效的 --engine: ${cli.engine}(可选: auto | local | vision)\n`);
		printHelp();
		process.exit(2);
	}
	if (!BACKGROUND_VALUES.has(cli.background)) {
		console.error(`错误: 无效的 --background: ${cli.background}(可选: auto | true | false)\n`);
		printHelp();
		process.exit(2);
	}

	// CLI 无 ctx.jobs 控制器:--background true/auto 为 in-process 后台模式 ——
	// 立即打印 jobId,stderr 逐页进度,md/progress/state 文件随跑随写可外部轮询。
	const backgroundMode = cli.background === "true" || cli.background === "auto";
	const cliJobId = `cli-${process.pid}-${Date.now()}`;
	const handlers = {};
	if (backgroundMode) {
		// 立即输出作业标识(冒烟/轮询依据),随后流式进度
		console.log(`jobId: ${cliJobId}`);
		let lastTotal = null;
		handlers.onEvent = (ev) => {
			if (ev?.event === "start") {
				lastTotal = ev.total;
				console.error(`[progress] start: 共 ${ev.total} 页`);
			} else if (ev?.event === "page") {
				console.error(`[progress] page ${ev.no}${lastTotal ? `/${lastTotal}` : ""} 完成 (tables=${ev.stats?.tables ?? "?"} formulas=${ev.stats?.formulas ?? "?"} textChars=${ev.stats?.textChars ?? "?"})`);
			} else if (ev?.event === "done") {
				console.error("[progress] done");
			}
		};
	}

	// Ctrl+C → 中止信号:进程树终止 Python,已落盘页可 --resume 接续
	const controller = new AbortController();
	const onSigint = () => controller.abort(new Error("SIGINT"));
	process.once("SIGINT", onSigint);
	installSignalCleanup();

	// v0.7.2 W4-6: 目录展开 —— 目录参数按其内受支持文件批量转换;跳过的条目逐条说明原因
	const { files: inputs, skipped } = expandInputs(cli.files, { recursive: cli.recursive === true });
	for (const s of skipped) console.warn(`  ⚠ 跳过 ${s.path}(${s.reason})`);
	if (!inputs.length) {
		console.error(`✗ 没有可转换的文件(${cli.files.length ? "给定目录内没有受支持的文件" : "未指定输入文件"})`);
		process.exit(2);
	}
	if (inputs.length > 1) console.error(`共 ${inputs.length} 个文件待转换(串行处理)`);

	const results = await convertMany(inputs, buildConvertOpts(cli, handlers));
	let failed = 0;
	for (const r of results) {
		if (r.ok) {
			const route = r.decision?.route ? ` [route=${r.decision.route}${r.decision.ratio != null ? ` ratio=${(r.decision.ratio * 100).toFixed(1)}%` : ""}]` : "";
			// v0.7.3: vision-brief 模式没有 outFile(产物是 plan.json + 批次文件),
			// 此前会打印 "→ undefined";改为按产物类型给出可用路径与后续动作。
			const target = r.outFile ?? r.planPath ?? "(本次无单文件产物)";
			console.log(`✓ ${r.chain}${route}  → ${target}`);
			if (r.mode === "vision-brief") {
				console.log(`   vision 任务书: ${r.planPath}(批次 ${Array.isArray(r.batches) ? r.batches.length : "?"})`
					+ `;按任务书逐批转写后执行 md_convert_assemble 装配`);
			}
			for (const w of r.warnings ?? []) console.warn(`  ⚠ ${w}`);
		} else {
			failed++;
			// 统一输出格式:✗ [错误码] 源文件: 原因
			console.error(`✗ ${formatError({ code: r.code, message: r.error })}  ${r.file}`);
			if (r.statePath) console.error(`  已完成页保留于 ${r.statePath}(可用 --resume 接续)`);
		}
	}
	console.error(failed ? `\n${failed} 个文件转换失败(详见上方 [错误码] 行)` : "");
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error(`✗ ${formatError(e)}`);
	process.exit(1);
});
