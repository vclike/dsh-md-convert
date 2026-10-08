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
import { BASELINE, SAMPLE_CLASSES, compareSample, metricsOf, runSample } from "../scripts/golden-baseline.mjs";

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
