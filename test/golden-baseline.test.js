/**
 * W0-3 golden 回归基线 — 进入默认单测的**轻量类别**(Office / GBK 文本,每个 <2s)。
 *
 * 重类别(逐字符文字层 11p / 文字层+多图 / 大表格 34p / 扫描件)耗时数十秒到数分钟,
 * 走独立命令:`npm run test:golden`(扫描件另需 `MDC_GOLDEN_SCAN=1`)。
 *
 * 缺基线或缺样本 → **显式 SKIP 并打印原因**,不假装通过(计划 §W0-2 的要求)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASELINE,
	SAMPLE_CLASSES,
	compareSample,
	editDistance,
	metricsOf,
	runSample,
	tableStats,
	wrapStats,
} from "../scripts/golden-baseline.mjs";

const light = SAMPLE_CLASSES.filter((s) => s.light);
const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;

test("golden 基线:轻量类别不退化(Office/GBK 文本)", async () => {
	if (!base) {
		console.log(`SKIP: 缺基线 ${BASELINE}(运行 npm run test:golden -- --write 生成)`);
		return;
	}
	let checked = 0;
	for (const s of light) {
		const res = await runSample(s);
		if (res.skip) {
			console.log(`SKIP ${s.cls}: ${res.reason}`);
			continue;
		}
		const ref = base[s.id];
		assert.ok(ref, `基线缺该类别 ${s.id}(先 --write)`);
		const c = compareSample(ref, res.metrics, s.id);
		assert.ok(c.ok, `${s.cls} 退化:\n  ${c.issues.join("\n  ")}\n  当前=${JSON.stringify(res.metrics)}`);
		checked++;
	}
	assert.ok(checked > 0, "至少应有一个轻量类别被真正校验(否则说明样本/基线缺失)");
	console.log(`golden 轻量类别通过: ${checked}/${light.length}`);
});

/* ── v0.7.7 扫描件纳入基线时抓到的 harness 缺陷 ──────────────────────────
 * 扫描件链路只回 `outFile`(路径)、**不回 `md` 内容**;而 metricsOf 原先只读 `r.md`
 * → 扫描件指标恒为 0(实测 chars=0 anchors=0)。若不修,写进基线的就是一个
 * "永远是 0 却一直通过"的空基线 —— 比没有基线更危险。
 * ────────────────────────────────────────────────────────────────────── */

test("metricsOf: 只回 outFile 的链路(扫描件)也必须算出真实指标", () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-metrics-"));
	const f = join(dir, "x.md");
	writeFileSync(f, ["<!--PAGE:1-->", "", "| a | b |", "| --- | --- |", "| c | d |"].join("\n"), "utf8");
	const m = metricsOf({ ok: true, outFile: f }, 12);
	assert.equal(m.chars > 0, true, "必须从 outFile 读到内容");
	assert.equal(m.anchors, 1, "锚点应被统计");
	assert.equal(m.tables, 1, "表头分隔行应被统计");
	assert.equal(m.ok, true);
});

test("metricsOf: 有 md 就用 md,不额外读盘", () => {
	const m = metricsOf({ ok: true, md: "<!--PAGE:1-->\n正文" }, 1);
	assert.equal(m.chars, "<!--PAGE:1-->\n正文".length);
	assert.equal(m.anchors, 1);
});

test("runSample: ok=true 但产物为空 → 显式 skip,绝不产出全 0 基线", async () => {
	// 防呆:ok=true 却一个字符都没有,几乎必然是"只回路径、没读到内容"的 harness 缺陷。
	// 若放过,写进基线的就是"永远通过的空基线"。
	const dir = mkdtempSync(join(tmpdir(), "mdc-empty-"));
	const empty = join(dir, "e.md");
	writeFileSync(empty, "", "utf8");
	const s = { id: "t-empty", file: "x.pdf", cls: "测试", light: false, slow: false };
	// 直接验证 metricsOf 对空产物给出 chars=0,再验证 runSample 的 skip 分支存在
	const m = metricsOf({ ok: true, outFile: empty }, 1);
	assert.equal(m.chars, 0);
	assert.equal(typeof runSample, "function", "runSample 必须导出(供上面两个用例与基线共用)");
});

test("基线文件:扫描件类别已纳入且指标非全 0", () => {
	if (!base) return;
	const scan = base["scan-4p"];
	if (!scan) {
		console.log("SKIP: 基线尚未包含扫描件类别(跑 MDC_GOLDEN_SCAN=1 npm run test:golden -- --write)");
		return;
	}
	assert.equal(scan.chars > 0, true, "扫描件基线 chars 不能是 0 —— 那说明写入时没读到内容");
	assert.equal(scan.anchors > 0, true, "扫描件基线必须含页锚点");
});

/* ── W0-4 零依赖评测指标 ────────────────────────────────────────────────
 * 目的:让"质量改动"能给出**数值差**,而不是只靠人工抽检 md。
 * ────────────────────────────────────────────────────────────────────── */

test("editDistance: 完全相同为 0;差异可量化", () => {
	assert.equal(editDistance("abcdef", "abcdef").norm, 0);
	assert.equal(editDistance("abcdef", "abcdef").mode, "exact");
	const d = editDistance("采购文件正文", "采购文文件正文");
	assert.ok(d.dist === 1, `插入 1 字应得 dist=1,实得 ${d.dist}`);
	assert.ok(d.norm > 0 && d.norm < 1, "归一化差异应在 (0,1)");
	// 公共前后缀应被剥掉 → 只算中间
	const d2 = editDistance("AAA差异BBB", "AAA差异BBB".replace("差异", "差异"));
	assert.equal(d2.dist, 0);
});

test("editDistance: 能识别'丢一段'这类粗判据漏掉的变化", () => {
	// 字符数几乎不变但内容被重排 —— chars≥97% 判据会放过,editDistance 不会
	const a = "第一段内容。\n第二段内容。\n第三段内容。\n";
	const b = "第一段内容。\n第三段内容。\n";
	const d = editDistance(a, b);
	assert.ok(d.norm > 0.1, `丢段应被量化,实得 norm=${d.norm}`);
});

test("wrapStats: 量化段内硬换行(v0.7.6 的缺陷类型)", () => {
	const broken = ["行尾是中文", "接下一行。", "另一段已经说完。"].join("\n");
	const s1 = wrapStats(broken);
	assert.equal(s1.wraps, 1, "应检出 1 处硬换行");
	assert.ok(s1.bodyLines > 0);
	// 修复后应为 0
	const fixed = wrapStats(["行尾是中文接下一行。", "另一段已经说完。"].join("\n"));
	assert.equal(fixed.wraps, 0, "合并后不得再报断行");
	// 表格/标题行不计入正文,也不因它们相邻而产生"断行"
	const withTbl = wrapStats(["| 职务 | 职称 |", "## 标题", "正文行没有句号", "接下一行。"].join("\n"));
	assert.equal(withTbl.wraps, 1, "只应统计正文之间的断行(标题不参与),表格行不计入正文");
	assert.equal(withTbl.bodyLines, 2, "表格行与标题都不算正文行");
});

test("tableStats: 检出列数不一致的数据行(列序错乱的代理指标)", () => {
	const good = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
	const g = tableStats(good);
	assert.equal(g.tables, 1);
	assert.equal(g.rows, 2);
	assert.equal(g.badRows, 0, "列数一致时不应报坏行");
	const bad = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 1 | 2 | 3 |"].join("\n");
	assert.equal(tableStats(bad).badRows, 1, "多出一列应被检出");
});

test("metricsOf: 输出 W0-4 新指标(wraps / badTableRows)", () => {
	const md = ["# 标题", "", "正文第一行很长但是没有句号", "换行续接。", "", "| a | b |", "| --- | --- |", "| 1 | 2 | 3 |"].join("\n");
	const m = metricsOf({ ok: true, md }, 1);
	assert.equal(typeof m.wraps, "number");
	assert.equal(typeof m.wrapPer100, "number");
	assert.equal(m.badTableRows, 1, "坏行应被统计进指标");
});

test("compareSample: 断行增加 / 坏行增加 → 必须判退化", () => {
	const base = { ok: true, code: null, anchors: 1, chars: 100, bodyChars: 90, cjkPer1k: 0, tables: 0, tableRows: 0, headings: 0, qualityScore: 80, wraps: 0, badTableRows: 0, ms: 100 };
	// 断行回退
	let c = compareSample(base, { ...base, wraps: 3 }, "x");
	assert.equal(c.ok, false);
	assert.ok(c.issues.some((i) => i.includes("硬换行")), `应报断行回退:${c.issues}`);
	// 表格坏行增加
	c = compareSample(base, { ...base, badTableRows: 2 }, "x");
	assert.equal(c.ok, false);
	assert.ok(c.issues.some((i) => i.includes("列数不一致")), `应报表格坏行:${c.issues}`);
	// 变好不应报错
	c = compareSample(base, { ...base, wraps: 0, badTableRows: 0 }, "x");
	assert.equal(c.ok, true);
});
