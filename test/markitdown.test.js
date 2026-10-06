/**
 * v0.6.5 单测 — markitdown 双引擎桥:
 *   ① 进程内(独立 node 最快路径)  ② 子进程桥(ELECTRON_RUN_AS_NODE,宿主兼容)
 *   双引擎都失败 → E_MARKITDOWN(attempts 摘要透出)
 *   worker 活体协议测试(真 spawn,txt 样本全格式兼容)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viaMarkItDownDual } from "../lib/core/markitdown.js";
import { convertFile } from "../lib/core/convert.js";
import { runAsync } from "../lib/core/spawn.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, "..", "lib", "worker", "markitdown-worker.cjs");

function txtFixture(dir, name = "sample.txt", body = "# markitdown 双引擎桥验证\n\n这是一段用于转换的正文文本。") {
	const p = join(dir, name);
	writeFileSync(p, body, "utf8");
	return p;
}

test("双引擎①: 独立环境进程内成功,engine=in-process", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-mk-"));
	const r = await viaMarkItDownDual(txtFixture(dir));
	assert.ok(r.md.includes("双引擎桥验证"), r.md.slice(0, 80));
	assert.equal(r.engine, "in-process");
	assert.equal(r.warning, undefined);
});

test("双引擎②: 进程内失败 → 子进程桥接手,附降级 warning", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-mk-fb-"));
	const r = await viaMarkItDownDual(txtFixture(dir), {
		inProcessImpl: async () => {
			throw new Error("createRequire.resolve.paths is not a function(注入复现宿主形态)");
		},
	});
	assert.equal(r.engine, "child-process");
	assert.ok(r.md.includes("双引擎桥验证"), r.md.slice(0, 80));
	assert.ok(r.warning.includes("子进程桥"), r.warning);
	assert.ok(r.warning.includes("resolve.paths"), "降级原因应透出宿主错误形态");
	assert.equal(r.attempts[0].ok, false);
});

test("双引擎③: 两级都失败 → E_MARKITDOWN + attempts 摘要", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-mk-dead-"));
	await assert.rejects(
		viaMarkItDownDual(txtFixture(dir), {
			inProcessImpl: async () => { throw new Error("in-process 死因"); },
			childImpl: async () => { throw new Error("child 死因"); },
		}),
		(e) => {
			assert.equal(e.code, "E_MARKITDOWN");
			assert.ok(e.message.includes("双引擎均失败"), e.message);
			assert.ok(e.message.includes("in-process 死因"), e.message);
			assert.ok(e.message.includes("child 死因"), e.message);
			return true;
		},
	);
});

test("worker 活体协议: ELECTRON_RUN_AS_NODE 子进程转换 txt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-mk-worker-"));
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	const r = await runAsync(process.execPath, [WORKER, txtFixture(dir)], { timeout: 120_000, env });
	assert.equal(r.status, 0, `stderr: ${r.stderr.slice(0, 200)}`);
	const parsed = JSON.parse(r.stdout.trim());
	assert.equal(parsed.ok, true, parsed.error ?? "");
	assert.ok(parsed.md.includes("双引擎桥验证"));
});

test("端到端: convertFile html → chain=markitdown(双引擎桥内联)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-mk-e2e-"));
	const p = join(dir, "e2e.html");
	writeFileSync(p, "<h1>markitdown 双引擎桥验证</h1><p>正文段落。</p>", "utf8");
	const r = await convertFile(p, { outDir: dir });
	assert.equal(r.ok, true, r.error ?? "");
	assert.equal(r.chain, "markitdown");
});
