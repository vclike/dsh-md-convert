/**
 * W3-2 state 复用校验键 — 单测。
 * 关键安全属性:同文件同倍率稳定;倍率/mtime 变化必须换键(否则同名另存会命中旧 state)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateKeyFor } from "../lib/core/jobs.js";

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample3.pdf");

test("stateKeyFor: 稳定 + 含倍率 + 取不到指纹返回 null", () => {
	const a = stateKeyFor(SAMPLE, 2);
	assert.ok(a, "应有键");
	assert.match(a, /\|s2\|/, "键应含渲染倍率");
	assert.equal(a, stateKeyFor(SAMPLE, 2), "同文件同倍率必须稳定");
	assert.notEqual(a, stateKeyFor(SAMPLE, 3), "倍率变化必须换键");
	assert.equal(stateKeyFor(join(tmpdir(), "mdc-绝对不存在-9f2a.pdf"), 2), null, "取不到指纹返回 null");
});

test("stateKeyFor: mtime 变化必须换键(同名另存/内容更新不得命中旧 state)", () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-key-"));
	try {
		const f = join(dir, "same-name.pdf");
		copyFileSync(SAMPLE, f);
		const k1 = stateKeyFor(f, 2);
		assert.ok(k1);
		const t = new Date(Date.now() + 5000);
		utimesSync(f, t, t);
		assert.notEqual(k1, stateKeyFor(f, 2), "mtime 变化后键必须不同");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
