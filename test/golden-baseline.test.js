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
import { existsSync, readFileSync } from "node:fs";
import { BASELINE, SAMPLE_CLASSES, compareSample, runSample } from "../scripts/golden-baseline.mjs";

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
