/**
 * T2 单测 — 后台作业契约:startBackgroundConvert(ctx.jobs 适配)
 *   - jobs 不可用 → null(优雅降级,调用方走前台)
 *   - exec.signal 预中止 → throw AbortError
 *   - run() 返回 {cancel, done, readOutput};done 永不 reject;cancel 走任务自有 controller
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBackgroundConvert } from "../lib/core/jobs.js";

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

test("startBackgroundConvert: 正常启动 → {ok,jobId,etaSec} + 契约三件套", async () => {
	const jobs = stubJobs();
	const ctx = { get: (k) => (k === "jobs" ? jobs : undefined) };
	const handle = startBackgroundConvert({ ctx, exec: undefined, label: "OCR a.pdf", etaSec: 33, runFn: okRunFn });
	assert.deepEqual(handle, { ok: true, jobId: "job-1", etaSec: 33 });
	const p = jobs.started[0];
	assert.equal(p.kind, "md-convert");
	assert.equal(p.label, "OCR a.pdf");

	const view = p.run();
	assert.equal(typeof view.cancel, "function");
	assert.equal(typeof view.readOutput, "function");
	assert.ok(typeof view.done.then === "function");
	// F2:readOutput 契约必须返回 string(对象会被 job_output 渲染成 [object Object])
	assert.equal(typeof view.readOutput(), "string");
	assert.ok(view.readOutput().includes("md_convert 后台作业"));

	// F1:done 必须结算为合法 JobOutcome{status,detail,output}——
	// 注册表 settle()/isTerminal 只认 status 三值,缺省=作业永非终态
	const outcome = await view.done;
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.output, "out/doc.md");
	assert.ok(outcome.detail.includes("out/doc.md"));
	assert.ok(outcome.detail.includes("parallel-ocr"));
	assert.ok(outcome.detail.includes("1 条警告"));
});

test("startBackgroundConvert: runFn 返回 cancelled → JobOutcome.status=killed", async () => {
	const jobs = stubJobs();
	const ctx = { get: (k) => (k === "jobs" ? jobs : undefined) };
	startBackgroundConvert({
		ctx, exec: undefined, label: "l",
		runFn: async () => ({ ok: false, cancelled: true, error: "OCR 已取消(进程树已终止)" }),
	});
	const view = jobs.started[0].run();
	const outcome = await view.done;
	assert.equal(outcome.status, "killed");
	assert.ok(outcome.detail.includes("已取消"));
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

test("startBackgroundConvert: runFn 抛异常 → done 收敛为 failed JobOutcome(永不 reject)", async () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	startBackgroundConvert({
		ctx, exec: undefined, label: "l",
		runFn: async () => { throw new Error("boom"); },
	});
	const view = jobs.started[0].run();
	const outcome = await view.done; // 不得 reject
	assert.equal(outcome.status, "failed");
	assert.ok(outcome.detail.includes("[E_UNKNOWN]"));
	assert.ok(outcome.detail.includes("boom"));
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
	assert.deepEqual(Object.keys(handle), ["ok", "jobId"]);
});

/* ---------------- v0.6.1 降级链(owner 被宿主拒绝的场景) ---------------- */

test("startBackgroundConvert: owner 启动被拒 → 无 owner 重试成功,标记 ownerDetached", () => {
	const started = [];
	const jobs = {
		start(params) {
			started.push(params);
			if (params.owner !== undefined) {
				throw new Error('session "[object Object]" has no live agent (background job owner must be live)');
			}
			return `job-${started.length}`;
		},
	};
	const ctx = { get: () => jobs };
	const agent = { id: "agent-1" };
	const handle = startBackgroundConvert({ ctx, exec: { agent }, label: "l", runFn: okRunFn });
	assert.deepEqual(handle, { ok: true, jobId: "job-2", ownerDetached: true }, "第二次尝试须成功并标记无主");
	assert.equal(started.length, 2, "必须重试");
	assert.equal(started[0].owner, agent, "第一次带 owner");
	assert.equal("owner" in started[1], false, "重试不得携带 owner 键(unowned bucket)");
	// 作业体契约在降级路径同样成立
	const view = started[1].run();
	assert.equal(typeof view.readOutput(), "string");
});

test("startBackgroundConvert: 全部启动尝试被拒 → {ok:false,reason},绝不外抛", () => {
	const jobs = { start: () => { throw new Error("host rejected"); } };
	const ctx = { get: () => jobs };
	const handle = startBackgroundConvert({ ctx, exec: { agent: { id: "a" } }, label: "l", runFn: okRunFn });
	assert.deepEqual(handle, { ok: false, reason: "host rejected" });
});

test("startBackgroundConvert: exec 无 agent 时单次无 owner 启动,不算降级", () => {
	const jobs = stubJobs();
	const ctx = { get: () => jobs };
	const handle = startBackgroundConvert({ ctx, exec: undefined, label: "l", runFn: okRunFn });
	assert.deepEqual(handle, { ok: true, jobId: "job-1" }, "无 agent 场景无 ownerDetached 标记");
	assert.equal("owner" in jobs.started[0], false);
});
