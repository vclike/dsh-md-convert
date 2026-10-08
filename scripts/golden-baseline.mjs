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

/** 6 类样本(计划 §W0-2);light=可进默认单测,slow=需 MDC_GOLDEN_SCAN=1 */
export const SAMPLE_CLASSES = [
	{ id: "char-layer", file: "char-layer-11p.pdf", cls: "①逐字符文字层", light: false },
	{ id: "textlayer-multi-img", file: "textlayer-multi-img.pdf", cls: "②文字层+多图", light: false },
	{ id: "scan-4p", file: "scan-4p.pdf", cls: "③纯图扫描件", light: false, slow: true, opts: { engine: "local" } },
	{ id: "office-cn-table", file: "office-cn-table.docx", cls: "④Office", light: true },
	{ id: "bigtable-34p", file: "bigtable-34p.pdf", cls: "⑤大表格", light: false },
	{ id: "gbk-text", file: "gbk-text.txt", cls: "⑥GBK 文本", light: true },
];

/** 单样本指标(纯函数,便于单测) */
export function metricsOf(r, ms) {
	const md = typeof r.md === "string" ? r.md : "";
	const lines = md.split("\n");
	const sep = lines.filter((l) => /^\|\s*---/.test(l.trim())).length;
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
	return { skip: false, metrics: metricsOf(r, Date.now() - t0) };
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
			console.log(`  ${s.cls.padEnd(14)} SKIP(慢类别,默认不跑)`);
			continue;
		}
		const res = await runSample(s);
		if (res.skip) {
			console.log(`  ${s.cls.padEnd(14)} SKIP(${res.reason})`);
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
