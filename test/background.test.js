/**
 * T2 单测 — 后台作业契约:startBackgroundConvert(ctx.jobs 适配)
 *   - jobs 不可用 → null(优雅降级,调用方走前台)
 *   - exec.signal 预中止 → throw AbortError
 *   - run() 返回 {cancel, done, readOutput};done 永不 reject;cancel 走任务自有 controller
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBackgroundConvert } from "../lib/core/jobs.js";
import { ERROR_CODES } from "../lib/core/errors.js";

function stubJobs() {
	const started = [];
	return {
		started,
		start(params) {
			started.push(params);
			return `job-${started.length}`;
		},
	};
}

const okRunFn = async (signal, onEvent) => {
	onEvent?.({ event: "start", total: 2 });
	onEvent?.({ event: "page", no: 1, md: "x", stats: {} });
	return { ok: true, outFile: "out/doc.md", chain: "parallel-ocr", warnings: ["w1"] };
};

test("startBackgroundConvert: 正常启动 → {jobId,etaSec} + 契约三件套", async () => {
	const jobs = stubJobs();
	const ctx = { get: (k) => (k === "jobs" ? jobs : undefined) };
	const handle = startBackgroundConvert({ ctx, exec: undefined, label: "OCR a.pdf", etaSec: 33, runFn: okRunFn });
	assert.deepEqual(handle, { jobId: "job-1", etaSec: 33 });
	const p = jobs.started[0];
	assert.equal(p.kind, "md-convert");
	assert.equal(p.label, "OCR a.pdf");

	const view = p.run();
	assert.equal(typeof view.cancel, "function");
	assert.equal(typeof view.readOutput, "function");
	assert.ok(typeof view.done.then === "function");
	assert.ok(view.readOutput().text.includes("md_convert 后台作业"));

	const outcome = await view.done;
	assert.deepEqual(outcome, {
		ok: true,
		code: undefined,
		output: "out/doc.md",
		chain: "parallel-ocr",
		warnings: ["w1"],
		error: undefined,
		mode: undefined,
		background: false,
	});
});

test("startBackgroundConvert: owner 透传 exec.agent", () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	const agent = { id: "agent-1" };
	startBackgroundConvert({ ctx, exec: { agent }, label: "l", runFn: okRunFn });
	assert.equal(jobs.started[0].owner, agent);
});

test("startBackgroundConvert: cancel 触发任务自有 controller(不影响外层 exec.signal)", async () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	let capturedSignal = null;
	startBackgroundConvert({
		ctx, exec: undefined, label: "l",
		runFn: (signal) => { capturedSignal = signal; return okRunFn(signal); },
	});
	const view = jobs.started[0].run();
	const outerSignal = new AbortController().signal; // 外层信号保持未中止
	await view.done;
	view.cancel("job killed");
	assert.equal(capturedSignal.aborted, true);
	assert.equal(outerSignal.aborted, false);
});

test("startBackgroundConvert: runFn 抛异常 → done 收敛为结果对象(永不 reject)", async () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	startBackgroundConvert({
		ctx, exec: undefined, label: "l",
		runFn: async () => { throw new Error("boom"); },
	});
	const view = jobs.started[0].run();
	const outcome = await view.done; // 不得 reject
	assert.equal(outcome.ok, false);
	assert.equal(outcome.code, ERROR_CODES.E_UNKNOWN);
	assert.ok(outcome.error.includes("boom"));
});

test("startBackgroundConvert: jobs 服务缺失 → null(优雅降级)", () => {
	const ctx = { get: () => undefined };
	const handle = startBackgroundConvert({ ctx, exec: undefined, label: "l", runFn: okRunFn });
	assert.equal(handle, null);
	const ctx2 = {}; // 连 get 都没有
	assert.equal(startBackgroundConvert({ ctx: ctx2, exec: undefined, label: "l", runFn: okRunFn }), null);
});

test("startBackgroundConvert: exec.signal 已预中止 → throw AbortError", () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	const exec = { signal: AbortSignal.abort() };
	assert.throws(() => startBackgroundConvert({ ctx, exec, label: "l", runFn: okRunFn }), (e) => e.name === "AbortError");
});

test("startBackgroundConvert: etaSec 缺省时不携带该键", async () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	const handle = startBackgroundConvert({ ctx, exec: undefined, label: "l", runFn: okRunFn });
	assert.deepEqual(Object.keys(handle), ["jobId"]);
});
