/**
 * W0-3 — golden 回归基线:对 test/golden/samples/ 跑完整插件链,记录指标并与基线比对。
 *
 * 用法
 *   node scripts/golden-baseline.mjs --write     生成/更新 test/golden/baseline.json
 *   node scripts/golden-baseline.mjs --check     比对(退化则退出 1)
 *   MDC_GOLDEN_SCAN=1 node scripts/golden-baseline.mjs --check    纳入扫描件类别(慢)
 *
 * 为什么要有它:本轮所有质量改动都只能靠**人工抽检**(肉眼看 md),既慢又不可回归。
 * 有了指标基线,改引擎/阈值后一条命令就能发现"少了几页锚点/表格变少/中文注入变多"。
 *
 * 容差设计(读作"缺陷指标只许变好"):
 *   - ok/code 必须一致;锚点数**必须完全一致**(页覆盖是硬不变量)
 *   - chars/bodyChars:不低于基线 3%
 *   - cjkPer1k(缺陷指标):不得比基线恶化 >20% 且 +1.0‰ 以上
 *   - tables/tableRows/headings:不得减少(结构性丢失)
 *   - quality.score:不低于基线 −2
 *   - ms:仅告警(>2× 提示性能退化,不判失败——机器负载会漂)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertFile } from "../lib/core/convert.js";
import { cjkSpaceStats } from "../lib/core/cjk.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SAMPLES = join(ROOT, "test", "golden", "samples");
export const BASELINE = process.env.MDC_GOLDEN_BASELINE || join(ROOT, "test", "golden", "baseline.json");
const OUT = join(ROOT, "test", "golden", ".out");

/** 样本类别(计划 §W0-2 + v0.7.12 的 Docling 扩充)。
 *  light=可进默认单测(实测 <1.2s);slow=需 MDC_GOLDEN_SCAN=1;其余走 test:golden。
 *  `dl-` 前缀 = 来自 Docling(MIT)开源测试集,仅本地使用,见 samples/SOURCES.md。 */
export const SAMPLE_CLASSES = [
	{ id: "char-layer", file: "char-layer-11p.pdf", cls: "①逐字符文字层", light: false },
	{ id: "textlayer-multi-img", file: "textlayer-multi-img.pdf", cls: "②文字层+多图", light: false },
	{ id: "scan-4p", file: "scan-4p.pdf", cls: "③纯图扫描件", light: false, slow: true, opts: { engine: "local" } },
	{ id: "office-cn-table", file: "office-cn-table.docx", cls: "④Office", light: true },
	{ id: "bigtable-34p", file: "bigtable-34p.pdf", cls: "⑤大表格", light: false },
	{ id: "gbk-text", file: "gbk-text.txt", cls: "⑥GBK 文本", light: true },
	// ── v0.7.18 xlsx 结构缺陷(自造样本,许可自持)──
	// 覆盖五类 markitdown-node 已知缺陷:合并单元格广播/双层表头压平/
	// 单元格换行劈表/无缓存值公式 [object Object]/前导空列
	{ id: "xlsx-defects", file: "xlsx-defects.xlsx", cls: "⑦xlsx结构缺陷", light: true },
	// ── v1.0.1 跨页表格缺陷(自建样本:公开技术文档抽 3 页 + 字体子集压缩)──
	// 已知缺陷:文字层链路把跨页大表拆成"每页一张表"(3 个分隔行),
	// 且续页重复表头、列数漂移。作为 A1 安全合并的回归检测项。
	// 观测:同一份样本走扫描件 OCR 链路时三页会被正确连成一张表 → 缺陷是文字层特有。
	{ id: "pdf-crosspage-table", file: "pdf-crosspage-table.pdf", cls: "⑧跨页表格缺陷", light: true },

	// ── v0.7.12 Docling(MIT)补充:Office 细分结构 + 英文 PDF 版式 ──
	// 实测耗时:docx 29~1102ms(进默认单测);pdf 423~579ms(需 python 进程,走 test:golden)
	{ id: "dl-word-tables", file: "dl-word_tables.docx", cls: "⑦Docx表格", light: true },
	{ id: "dl-tablecell", file: "dl-tablecell.docx", cls: "⑧Docx表格单元格", light: true },
	{ id: "dl-lists", file: "dl-docx_lists.docx", cls: "⑨Docx列表", light: true },
	{ id: "dl-headers", file: "dl-unit_test_headers.docx", cls: "⑩Docx标题层级", light: true },
	{
		id: "dl-hdrftr-firstpage",
		file: "dl-docx_page_header_footer_first_page.docx",
		cls: "⑪Docx首页页眉页脚",
		light: true,
	},
	{ id: "dl-eastasian-num", file: "dl-docx_list_east_asian_num_fmt.docx", cls: "⑫Docx东亚编号", light: true },
	{ id: "dl-word-sample", file: "dl-word_sample.docx", cls: "⑬Docx通用", light: true },
	{ id: "dl-pdf-4p", file: "dl-normal_4pages.pdf", cls: "⑭英文4页PDF", light: false },
	{ id: "dl-pdf-multipage", file: "dl-multi_page.pdf", cls: "⑮英文多页PDF", light: false },
	{
		id: "dl-pdf-table-as-img",
		file: "dl-table_mislabeled_as_picture.pdf",
		cls: "⑯表被误判为图",
		light: false,
	},
	{ id: "dl-pdf-code-formula", file: "dl-code_and_formula.pdf", cls: "⑰代码与公式PDF", light: false },

	// ── v0.7.12 OmniDocBench 简体中文页(⚠️ 数据集"仅研究用途、禁止商用" -> **仅本地,不入库**)──
	// 由 12 张中文页图片封装成 PDF(数据集只提供图片,无 PDF),覆盖 5 种来源
	// (exam_paper/newspaper/book/magazine/colorful_textbook)与 5 种版式
	// (单栏/双栏/三栏/1andmore/other),其中 11 页含表格。
	// 实测约 10s/页 -> slow,需 MDC_GOLDEN_SCAN=1。
	{
		id: "zh-omnidocbench",
		file: "zh-omnidocbench-12p.pdf",
		cls: "⑱中文页(OmniDocBench)",
		light: false,
		slow: true,
		opts: { engine: "local" },
	},
];

/**
 * 归一化编辑距离(Edit_dist),零依赖实现。
 *
 * 用途:现有基线只有"字符数 ≥ 基线 97%"这种粗判据 —— 一次大规模**重排/丢段**
 * 完全可能在字符数不掉的情况下混过去。本指标把"产物与基线的差异"变成一个可比数值。
 *
 * 做法:先剥公共前后缀(绝大多数情况只差一小段),再对中间做 Levenshtein DP。
 * 长度上限保护:超过 MDC_EDIT_MAX 字符则退化为"行级集合 Jaccard",避免 O(n²) 卡死。
 */
export function editDistance(a, b, max = 40000) {
	const s = String(a ?? "");
	const t = String(b ?? "");
	if (s === t) return { dist: 0, norm: 0, mode: "exact" };
	if (!s.length || !t.length) return { dist: Math.max(s.length, t.length), norm: 1, mode: "exact" };
	// 公共前后缀
	let p = 0;
	const maxP = Math.min(s.length, t.length);
	while (p < maxP && s[p] === t[p]) p++;
	let e = 0;
	const maxE = Math.min(s.length - p, t.length - p);
	while (e < maxE && s[s.length - 1 - e] === t[t.length - 1 - e]) e++;
	const mid1 = s.slice(p, s.length - e);
	const mid2 = t.slice(p, t.length - e);
	if (!mid1.length || !mid2.length) {
		const d = mid1.length + mid2.length;
		return { dist: d, norm: Math.round((d / Math.max(s.length, t.length)) * 10000) / 10000, mode: "exact" };
	}
	if (mid1.length * mid2.length > max * max) {
		// 过大 → 行级 Jaccard 近似(足以发现"丢段/重排",不追求精确编辑距离)
		const setA = new Set(mid1.split("\n").map((x) => x.trim()).filter(Boolean));
		const setB = new Set(mid2.split("\n").map((x) => x.trim()).filter(Boolean));
		let inter = 0;
		for (const x of setA) if (setB.has(x)) inter++;
		const union = new Set([...setA, ...setB]).size;
		const sim = union ? inter / union : 1;
		return { dist: null, norm: Math.round((1 - sim) * 10000) / 10000, mode: "jaccard" };
	}
	// Levenshtein DP(滚动数组)
	const m = mid1.length;
	const n = mid2.length;
	let prev = new Array(n + 1);
	let cur = new Array(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		cur[0] = i;
		const c1 = mid1.charCodeAt(i - 1);
		for (let j = 1; j <= n; j++) {
			const cost = c1 === mid2.charCodeAt(j - 1) ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		const t2 = prev;
		prev = cur;
		cur = t2;
	}
	const d = prev[n];
	return { dist: d, norm: Math.round((d / Math.max(s.length, t.length)) * 10000) / 10000, mode: "exact" };
}

/**
 * 断行率(可观测指标):段内硬换行把中文词切开的处数 / 正文行数。
 * 这是 v0.7.6 修复的缺陷类型,必须有量化指标兜底,否则将来会静默回归。
 *
 * ⚠️ 已知局限(实测,不是猜测):本指标**只从 md 文本判断**,无法区分
 *   "OCR 按栏宽硬换行切开" 与 "源文件本来就是分行排版"。
 *   例:gbk-text 样本(纯文本,源文件本就分 4 行)实测 wraps=2,而它的转换输出**完全正确**。
 *   所以 wraps 只能在**同一份样本的多次运行之间**做回归对比(基线 vs 现状),
 *   **不能**跨文档比较、也不能当作"绝对质量分"。0.7.6 的修复效果正是在
 *   97 页真实扫描件上用同样的判据测得 415 → 0。
 */
export function wrapStats(md) {
	const text = String(md ?? "");
	const lines = text.split("\n");
	const cjkEnd = /[㐀-䶿一-鿿豈-﫿]$/;
	const cjkStart = /^[㐀-䶿一-鿿豈-﫿]/;
	const term = /[。！？；：、，,．.!?;:]$/;
	const struct = /^\s*(\||#{1,6}\s|>|<!-|[-*+]\s|[-=*_]{3,}\s*$)/;
	let wraps = 0;
	let body = 0;
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t || t.startsWith("<!--") || t.startsWith("|") || t.startsWith("#")) continue;
		body++;
		if (i === lines.length - 1) continue;
		const nx = lines[i + 1].trim();
		if (!nx || struct.test(lines[i]) || struct.test(lines[i + 1])) continue;
		if (cjkEnd.test(t) && cjkStart.test(nx) && !term.test(t)) wraps++;
	}
	return { wraps, bodyLines: body, per100: body ? Math.round((wraps * 10000) / body) / 100 : 0 };
}

/**
 * 表格结构一致性:统计"单元格数与表头不一致"的表格数据行。
 * 列序/列数错乱是扫描件链路的已知痛点(几何装配),这个指标能在退化时立刻报警。
 */
export function tableStats(md) {
	const lines = String(md ?? "").split("\n");
	let tables = 0;
	let rows = 0;
	let badRows = 0;
	let headerCols = null;
	const flush = () => {
		headerCols = null;
	};
	for (const raw of lines) {
		const l = raw.trim();
		if (!l.startsWith("|")) {
			flush();
			continue;
		}
		const cells = l.split("|").length - 2;
		if (/^\|[\s:-]+\|[\s:|-]*$/.test(l)) continue; // 分隔行
		if (headerCols === null) {
			tables++;
			headerCols = cells;
			continue;
		}
		rows++;
		if (cells !== headerCols) badRows++;
	}
	return { tables, rows, badRows };
}

/** 单样本指标(纯函数,便于单测) */
export function metricsOf(r, ms) {
	// 注意:不同链路返回形状不同 —— 文字层/Office 直接回 `md` 内容,
	// **扫描件链路只回 `outFile`(路径),不回 md**(实测:否则扫描件指标恒为 0)。
	// 缺这一段会让扫描件基线"永远是 0 却一直通过",等于没有基线。
	let md = typeof r.md === "string" ? r.md : "";
	if (!md && typeof r.outFile === "string" && existsSync(r.outFile)) {
		md = readFileSync(r.outFile, "utf8");
	}
	const lines = md.split("\n");
	const sep = lines.filter((l) => /^\|\s*---/.test(l.trim())).length;
	// W0-4 零依赖指标(2026-10-09):断行率 + 表结构一致性
	const wrap = wrapStats(md);
	const tstat = tableStats(md);
	return {
		ok: r.ok === true,
		code: r.code ?? null,
		chain: r.chain ?? null,
		chars: md.length,
		bodyChars: md.replace(/\s+/g, "").length,
		cjkPer1k: Number((cjkSpaceStats(md).per1k ?? 0).toFixed(2)),
		tables: sep,
		tableRows: lines.filter((l) => l.trim().startsWith("|")).length,
		headings: lines.filter((l) => /^#{1,6} /.test(l)).length,
		anchors: (md.match(/<!--PAGE:\d+-->/g) ?? []).length,
		qualityScore: typeof r.quality?.score === "number" ? r.quality.score : null,
		// 缺陷指标:越低越好
		wraps: wrap.wraps,
		wrapPer100: wrap.per100,
		badTableRows: tstat.badRows,
		ms: Math.round(ms),
	};
}

/** 基线比对 → {ok, issues:[], warnings:[]} */
export function compareSample(base, cur, id) {
	const issues = [];
	const warnings = [];
	if (base.ok !== cur.ok) issues.push(`ok 变化:${base.ok} → ${cur.ok}${cur.code ? ` (${cur.code})` : ""}`);
	if (base.code !== cur.code) issues.push(`错误码变化:${base.code} → ${cur.code}`);
	if (base.anchors !== cur.anchors) issues.push(`锚点数变化:${base.anchors} → ${cur.anchors}(页覆盖硬不变量)`);
	for (const k of ["chars", "bodyChars"]) {
		const floor = Math.floor(base[k] * 0.97);
		if (cur[k] < floor) issues.push(`${k} 退化:${base[k]} → ${cur[k]}(< ${floor})`);
	}
	if (cur.cjkPer1k > base.cjkPer1k * 1.2 && cur.cjkPer1k > base.cjkPer1k + 1.0) {
		issues.push(`中文行间空格注入恶化:${base.cjkPer1k}‰ → ${cur.cjkPer1k}‰`);
	}
	for (const k of ["tables", "tableRows", "headings"]) {
		if (cur[k] < base[k]) issues.push(`${k} 减少:${base[k]} → ${cur[k]}(结构丢失)`);
	}
	if (base.qualityScore != null && cur.qualityScore != null && cur.qualityScore < base.qualityScore - 2) {
		issues.push(`质量分下降:${base.qualityScore} → ${cur.qualityScore}`);
	}
	if (base.ms > 0 && cur.ms > base.ms * 2) warnings.push(`耗时 ${base.ms}ms → ${cur.ms}ms(>2×,仅告警)`);
	// W0-4 零依赖指标(缺陷指标:只许不增)
	if (typeof base.wraps === "number" && typeof cur.wraps === "number" && cur.wraps > base.wraps) {
		issues.push(`段内硬换行增加:${base.wraps} → ${cur.wraps}(v0.7.6 的修复被回退)`);
	}
	if (
		typeof base.badTableRows === "number" &&
		typeof cur.badTableRows === "number" &&
		cur.badTableRows > base.badTableRows
	) {
		issues.push(`表格列数不一致的行增加:${base.badTableRows} → ${cur.badTableRows}(列序/列数错乱)`);
	}
	return { id, ok: issues.length === 0, issues, warnings };
}

/** 跑一个样本(样本不存在 → {skip:true}) */
export async function runSample(s, { workers } = {}) {
	const p = join(SAMPLES, s.file);
	if (!existsSync(p)) return { skip: true, reason: `缺样本 ${s.file}(见 samples/README.md)` };
	const od = join(OUT, s.id);
	if (existsSync(od)) rmSync(od, { recursive: true, force: true });
	mkdirSync(od, { recursive: true });
	const t0 = Date.now();
	const r = await convertFile(p, { outDir: od, background: false, ...(workers ? { workers } : {}), ...(s.opts ?? {}) });
	const metrics = metricsOf(r, Date.now() - t0);
	// 防呆:ok=true 但一个字都没有 —— 几乎必然是"链路只回路径、没读到内容"这类 harness 缺陷。
	// 绝不能把这种全 0 指标写进基线(它会永远通过,等于没有基线)。
	if (r.ok === true && metrics.chars === 0) {
		return {
			skip: true,
			reason: `产物为空但 ok=true(疑似未读到内容;返回键:${Object.keys(r).join(",")})`,
		};
	}
	return { skip: false, metrics };
}

function parseArgs(argv) {
	return { write: argv.includes("--write"), check: argv.includes("--check") };
}

async function main() {
	const { write, check } = parseArgs(process.argv.slice(2));
	if (!write && !check) {
		console.log("用法: node scripts/golden-baseline.mjs --write | --check");
		process.exit(2);
	}
	const withScan = process.env.MDC_GOLDEN_SCAN === "1";
	const targets = SAMPLE_CLASSES.filter((s) => withScan || !s.slow);
	const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
	const out = prev && !write ? { ...prev } : {};
	let failed = 0;
	console.log(`golden ${write ? "--write" : "--check"} | 样本目录 ${SAMPLES}${withScan ? " | 含扫描件" : " | 跳过扫描件(MDC_GOLDEN_SCAN=1 打开)"}`);
	for (const s of SAMPLE_CLASSES) {
		const inScope = targets.includes(s);
		if (!inScope) {
			// 慢类别被跳过时,**必须保留**它原有的基线项:
			// 不带 MDC_GOLDEN_SCAN=1 跑 --write 会把扫描件基线静默删掉(实测隐患)。
			if (write && prev?.[s.id]) {
				out[s.id] = prev[s.id];
				console.log(`  ${s.cls.padEnd(14)} 保留旧基线(slow,MDC_GOLDEN_SCAN=1 才能重测)`);
			} else {
				console.log(`  ${s.cls.padEnd(14)} SKIP(慢类别,默认不跑)`);
			}
			continue;
		}
		const res = await runSample(s);
		if (res.skip) {
			// 样本缺失同理:保留旧基线,否则补回样本后基线已被清空
			if (write && prev?.[s.id]) {
				out[s.id] = prev[s.id];
				console.log(`  ${s.cls.padEnd(14)} 保留旧基线(${res.reason})`);
			} else {
				console.log(`  ${s.cls.padEnd(14)} SKIP(${res.reason})`);
			}
			continue;
		}
		const m = res.metrics;
		if (write) {
			out[s.id] = m;
			console.log(`  ${s.cls.padEnd(14)} 写入 chars=${m.chars} anchors=${m.anchors} tables=${m.tables} cjk=${m.cjkPer1k}‰ ms=${m.ms}`);
			continue;
		}
		const base = prev?.[s.id];
		if (!base) {
			console.log(`  ${s.cls.padEnd(14)} 基线缺失(先跑 --write)`);
			continue;
		}
		const c = compareSample(base, m, s.id);
		if (!c.ok) failed++;
		console.log(`  ${s.cls.padEnd(14)} ${c.ok ? "OK  " : "FAIL"} chars=${m.chars} anchors=${m.anchors} tables=${m.tables} cjk=${m.cjkPer1k}‰ ms=${m.ms}`);
		for (const i of c.issues) console.log(`      ✗ ${i}`);
		for (const w of c.warnings) console.log(`      ! ${w}`);
	}
	if (write) {
		mkdirSync(dirname(BASELINE), { recursive: true });
		writeFileSync(BASELINE, JSON.stringify(out, null, "\t"), "utf8");
		console.log(`\n已写入 ${BASELINE}`);
		process.exit(0);
	}
	console.log(failed ? `\n${failed} 个类别退化` : "\n无退化");
	process.exit(failed ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("golden-baseline.mjs")) await main();
