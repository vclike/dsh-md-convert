/**
 * T2 单测 — 工具层契约(executeConvert):后台启动返回结构 / 缺 jobs 优雅降级 / vision 接缝
 * 注:executeConvert 不触真实 OCR——用不存在的 PDF 快速失败,断言的是路由/降级/错误码语义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeConvert } from "../lib/index.js";

function makeCtx(jobs) {
	return { get: (k) => (k === "jobs" ? jobs : undefined) };
}
function stubJobs() {
	const started = [];
	return { started, start: (p) => { started.push(p); return `job-${started.length}`; } };
}
function makeExec(cwd) {
	return { agent: { session: { header: { cwd } } } };
}
function tmpWorkspace(tag) {
	return mkdtempSync(join(tmpdir(), `mdc-t2-tool-${tag}-`));
}

test("executeConvert: 缺 file 参数 → E_FILE_NOT_FOUND", async () => {
	const r = await executeConvert({}, makeExec(tmpWorkspace("a")), makeCtx(null), {});
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_FILE_NOT_FOUND");
});

test("executeConvert: 文本文件同步直读,background:false", async () => {
	const ws = tmpWorkspace("text");
	const md = join(ws, "note.md");
	writeFileSync(md, "# hello\n\n内容", "utf8");
	const r = await executeConvert({ file: "note.md" }, makeExec(ws), makeCtx(null), {});
	assert.equal(r.ok, true);
	assert.equal(r.background, false);
	assert.equal(r.chain, "text");
	assert.ok(r.output.endsWith("note.md"));
	assert.equal(r.jobId, undefined, "快链路不得进后台");
});

test("executeConvert: background=true 但 jobs 缺失 → 优雅降级前台 + warning(硬性要求)", async () => {
	const ws = tmpWorkspace("degrade");
	const r = await executeConvert(
		{ file: "missing.pdf", background: "true", forceOcr: true },
		makeExec(ws), makeCtx(null), { ocr: {}, vision: {} },
	);
	assert.equal(r.ok, false, "文件不存在仍按领域失败返回(不是缺服务失败)");
	assert.equal(r.background, false);
	assert.equal(r.code, "E_FILE_NOT_FOUND");
	assert.ok(
		(r.warnings ?? []).some((w) => w.includes("后台作业控制器未安装") && w.includes("回退前台")),
		"必须注明降级原因",
	);
});

test("executeConvert: background=auto + jobs 在 → 后台启动 {ok,background:true,jobId}", async () => {
	const ws = tmpWorkspace("bg");
	const jobs = stubJobs();
	const r = await executeConvert(
		{ file: "missing.pdf", background: "auto", forceOcr: true },
		makeExec(ws), makeCtx(jobs), { ocr: {}, vision: {} },
	);
	assert.equal(r.ok, true);
	assert.equal(r.background, true);
	assert.equal(r.jobId, "job-1");
	assert.equal(r.etaSec, undefined, "页数探查失败(文件不存在)不承诺 etaSec");
	assert.ok(r.statePath.endsWith("missing.state.json"));
	assert.ok(r.progressPath.endsWith("missing.progress.json"));
	const p = jobs.started[0];
	assert.equal(p.kind, "md-convert");
	assert.ok(p.label.includes("missing.pdf"));
	// 作业体:runFn 里 convertFile 对缺失文件 → done 结算为 failed JobOutcome(永不 reject)
	const view = p.run();
	const outcome = await view.done;
	assert.equal(outcome.status, "failed");
	assert.ok(outcome.detail.includes("E_FILE_NOT_FOUND"));
});

test("executeConvert: engine=vision 显式指定 → vision 链路确定性失败(E_VISION_PLAN,环境无关)", async () => {
	const ws = tmpWorkspace("vision");
	// F6:用「存在但非合法 PDF」保证渲染在任何环境必败——此前依赖沙箱缺 python 才通过,
	// 在完整依赖机器上会真实渲染成功导致断言失败。存在性门先于引擎路由,故文件必须真实存在。
	const badPdf = join(ws, "bad.pdf");
	writeFileSync(badPdf, "这不是 PDF 内容,render_pages.py 会确定性打开失败。", "utf8");
	const r = await executeConvert(
		{ file: badPdf, engine: "vision", forceOcr: true, background: "false" },
		makeExec(ws), makeCtx(null), { ocr: {}, vision: {} },
	);
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_VISION_PLAN");
	assert.equal(r.background, false);
	assert.equal(r.jobId, undefined, "vision 任务书为前台快链路,不进后台");
});

test("executeConvert: background=false 强制同步,无降级 warning", async () => {
	const ws = tmpWorkspace("sync");
	const r = await executeConvert(
		{ file: "missing.pdf", background: "false", forceOcr: true },
		makeExec(ws), makeCtx(null), { ocr: {}, vision: {} },
	);
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_FILE_NOT_FOUND");
	assert.equal(r.warnings, undefined, "显式 false 是用户选择,不注降级警告");
});

test("executeConvert: 非法 background/engine 参数回退默认(auto)", async () => {
	const ws = tmpWorkspace("enum");
	const jobs = stubJobs();
	// 非法 background → auto;auto + jobs → 后台启动
	const r = await executeConvert(
		{ file: "missing.pdf", background: "yes", forceOcr: true },
		makeExec(ws), makeCtx(jobs), { ocr: {}, vision: {} },
	);
	assert.equal(r.background, true, "非法值回退 auto,auto+jobs 走后台");
	// 非法 engine → auto(不阻断)
	const r2 = await executeConvert(
		{ file: "missing.pdf", engine: "quantum", background: "false", forceOcr: true },
		makeExec(ws), makeCtx(null), { ocr: {}, vision: {} },
	);
	assert.equal(r2.ok, false); // auto 探针链路对缺失文件在 deps/页数阶段失败,但不因 engine 值抛参数错
	assert.notEqual(r2.code, undefined);
});

/* ---------------- v0.6.1 前台闸门与后台启动降级 ---------------- */

test("executeConvert: 前台页数超限 → E_FOREGROUND_LIMIT 策略拒绝(附替代路线与 ETA)", async () => {
	const ws = tmpWorkspace("gate");
	// 真实 3 页样张:页数探查成功才设闸,闸门在 convertFile 之前拦截(不触发任何 OCR)
	const sample3 = fileURLToPath(new URL("./fixtures/sample3.pdf", import.meta.url));
	const r = await executeConvert(
		{ file: sample3, background: "false", forceOcr: true },
		makeExec(ws), makeCtx(null), { ocr: { foregroundMaxPages: 2 }, vision: {} },
	);
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_FOREGROUND_LIMIT");
	assert.ok(r.error.includes("3 页 > 上限 2 页"), r.error);
	assert.ok(r.error.includes('background:"true"'), "必须给出后台替代路线");
	assert.ok(r.error.includes('engine:"vision"'), "必须给出 vision 替代路线");
	assert.ok(String(r.hint ?? "").includes("预估"), "应附本地 ETA 提示");
	assert.ok(r.statePath.endsWith("sample3.state.json"));
});

test("executeConvert: ocr.foregroundMaxPages=0 → 不设闸(显式解除)", async () => {
	const ws = tmpWorkspace("nogate");
	// 用「存在但非合法 PDF」:探查失败页数 null 也不设闸,convertFile 快速领域失败,不跑真 OCR
	const badPdf = join(ws, "bad.pdf");
	writeFileSync(badPdf, "这不是 PDF 内容。", "utf8");
	const r = await executeConvert(
		{ file: badPdf, background: "false", forceOcr: true },
		makeExec(ws), makeCtx(null), { ocr: { foregroundMaxPages: 0 }, vision: {} },
	);
	assert.equal(r.ok, false);
	assert.notEqual(r.code, "E_FOREGROUND_LIMIT");
});

test("executeConvert: 后台启动被宿主拒绝 → 无主重试后前台降级 + warning(2026-10-05 事故回归)", async () => {
	const ws = tmpWorkspace("bgfail");
	const exec = makeExec(ws);
	const attempts = [];
	const hostileJobs = {
		start: (p) => {
			attempts.push(p);
			throw new Error('session "[object Object]" has no live agent (background job owner must be live)');
		},
	};
	const r = await executeConvert(
		{ file: "missing.pdf", background: "true", forceOcr: true },
		exec, makeCtx(hostileJobs), { ocr: {}, vision: {} },
	);
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_FILE_NOT_FOUND", "领域失败原样返回,不因后台启动失败而变形");
	assert.equal(r.background, false);
	assert.equal(attempts.length, 2, "降级链:带 owner → 无 owner 两次尝试");
	assert.equal(attempts[0].owner, exec.agent, "第一次带 owner");
	assert.equal("owner" in attempts[1], false, "重试不带 owner 键");
	assert.ok(
		(r.warnings ?? []).some((w) => w.includes("后台作业启动失败") && w.includes("no live agent")),
		"必须注明降级原因",
	);
});
