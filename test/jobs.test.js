/**
 * T2 单测 — NDJSON 消费端:锚点 upsert / 增量写 / 断点预播种 / 取消 / 超时 / 致命错误
 * 全部通过 spawnStreamImpl 测试替身注入,不启动真实 Python/进程池。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleMd, createOcrRun, estimateEtaSec, parseAnchoredPages, parseNdjsonLine } from "../lib/core/jobs.js";
import { ERROR_CODES } from "../lib/core/errors.js";

function tmpDir(tag) {
	return mkdtempSync(join(tmpdir(), `mdc-t2-${tag}-`));
}

/** 构造 parallel_ocr.py 协议页块(与 Python page_anchor_md 同构) */
function pageBlock(no, body) {
	const a = String(no).padStart(2, "0");
	return `<!--PAGE:${a}-->\n\n${body}\n\n<!--/PAGE:${a}-->`;
}

/**
 * 假 spawn 流:脚本化事件序列(makeFake),复刻真实 spawnStream 的完整契约:
 *   (cmd, args, {onLine, signal, timeoutMs}) → {promise, killTree}
 *   - lines 全部发出后以 exitCode 结案(holdExit=true 时挂起,仅 killTree 可结案);
 *   - signal 中止 → killTree;timeoutMs 到期 → killTree(真实实现同样以 killTree 收口,
 *     timedOut 由 killTree 结案载荷携带);
 *   - createOcrRun 侧按 signal.aborted 优先分派 cancelled,再判 timedOut。
 * 注意:测试内计时器一律不 unref,保持事件循环存活直至断言完成。
 */
function makeFake(script) {
	return function spawnStreamImpl(cmd, args, { onLine, signal, timeoutMs = 0 }) {
		let doResolve = null;
		const promise = new Promise((resolve) => { doResolve = resolve; });
		const api = {
			cmd, args, killed: false,
			promise,
			killTree() {
				if (api.killed) return;
				api.killed = true;
				script.onKill?.();
				doResolve({ status: 1, signal: "SIGKILL", stderrTail: "terminated", timedOut: true });
			},
		};
		if (signal) {
			if (signal.aborted) api.killTree();
			else signal.addEventListener("abort", () => api.killTree(), { once: true });
		}
		if (timeoutMs > 0) setTimeout(() => api.killTree(), timeoutMs);
		let t = 0;
		for (const step of script.lines) {
			t += step.delay;
			setTimeout(() => { onLine(step.line); }, t);
		}
		if (!script.holdExit) {
			setTimeout(() => {
				doResolve({ status: script.exitCode ?? 0, signal: null, stderrTail: script.stderr ?? "" });
			}, t + 5);
		}
		return api;
	};
}

function line(obj) { return JSON.stringify(obj); }

/* ---------------- 纯函数 ---------------- */

test("parseNdjsonLine: 合法/非法/空行", () => {
	assert.deepEqual(parseNdjsonLine('{"event":"start","total":3}'), { event: "start", total: 3 });
	assert.equal(parseNdjsonLine("not json"), null);
	assert.equal(parseNdjsonLine(""), null);
	assert.equal(parseNdjsonLine("   "), null);
	assert.equal(parseNdjsonLine("[1,2]"), null); // 协议行只会是对象
	assert.equal(parseNdjsonLine('{"event":"page"'), null); // 截断行
});

test("parseAnchoredPages: 两位与三位页号 + 非锚点文本忽略", () => {
	const md = [
		"# 标题",
		pageBlock(1, "p1"),
		pageBlock(3, "p3"),
		"<!-- 源文件: x | 链路: parallel-ocr -->",
		pageBlock(100, "p100"),
	].join("\n");
	const map = parseAnchoredPages(md);
	assert.equal(map.size, 3);
	assert.ok(map.get(1).startsWith("<!--PAGE:01-->"));
	assert.ok(map.get(100).includes("p100"));
	assert.equal(map.get(2), undefined);
	assert.equal(parseAnchoredPages("").size, 0);
	assert.equal(parseAnchoredPages(undefined).size, 0);
});

test("assembleMd: 页号升序拼装 + 标题", () => {
	const map = new Map([[3, pageBlock(3, "c")], [1, pageBlock(1, "a")], [2, pageBlock(2, "b")]]);
	const md = assembleMd(map, "# t");
	assert.ok(md.startsWith("# t\n\n"));
	const order = [...md.matchAll(/<!--PAGE:(\d+)-->/g)].map((m) => m[1]);
	assert.deepEqual(order, ["01", "02", "03"]);
	assert.equal(assembleMd(new Map(), ""), "");
});

/* ---------------- ETA 标定(bench.md) ---------------- */

test("estimateEtaSec: workers=1 按页数×单页均耗;workers>1 加固定开销落标定区间", () => {
	// workers=1: 97×15 = 1455(bench 实测 1398s,偏差 +4%)
	assert.equal(estimateEtaSec(97, 1, 15), 1455);
	// workers=4: 线性 364 + 开销 40 = 404 ∈ captain 标定区间 400-420s
	const w4 = estimateEtaSec(97, 4, 15);
	assert.equal(w4, 404);
	assert.ok(w4 >= 400 && w4 <= 420, `workers=4 ETA ${w4}s 应落在 400-420s`);
	// 非法输入返回 null(调用方不承诺 etaSec)
	assert.equal(estimateEtaSec(0, 4), null);
	assert.equal(estimateEtaSec(-1, 4), null);
	assert.equal(estimateEtaSec(null, 4), null);
	// workers=0 视作 1
	assert.equal(estimateEtaSec(10, 0, 15), 150);
});

/* ---------------- createOcrRun ---------------- */

test("createOcrRun: 乱序 page 事件按锚点归位 + 同页重发覆盖(upsert)", async () => {
	const dir = tmpDir("upsert");
	const mdPath = join(dir, "doc.md");
	const script = {
		lines: [
			{ delay: 5, line: line({ event: "start", total: 3 }) },
			{ delay: 5, line: line({ event: "page", no: 3, md: pageBlock(3, "第三页v1"), stats: { tables: 0, formulas: 0, textChars: 10 } }) },
			{ delay: 5, line: line({ event: "page", no: 1, md: pageBlock(1, "第一页"), stats: { tables: 0, formulas: 0, textChars: 3 } }) },
			{ delay: 5, line: line({ event: "page", no: 2, md: pageBlock(2, "第二页v1"), stats: { tables: 0, formulas: 0, textChars: 5 } }) },
			// resume 重发场景:同页 2 二次到达(内容更新)——必须覆盖而非追加
			{ delay: 5, line: line({ event: "page", no: 2, md: pageBlock(2, "第二页v2-final"), stats: { tables: 1, formulas: 0, textChars: 9 } }) },
			{ delay: 5, line: line({ event: "done", warnings: [] }) },
		],
	};
	const r = await createOcrRun({
		python: "python", script: "parallel_ocr.py", pdf: "doc.pdf",
		mdPath, statePath: join(dir, "doc.state.json"), progressPath: join(dir, "doc.progress.json"),
		title: "# doc", spawnStreamImpl: makeFake(script),
	});
	assert.equal(r.ok, true);
	const md = readFileSync(mdPath, "utf8");
	const order = [...md.matchAll(/<!--PAGE:(\d+)-->/g)].map((m) => m[1]);
	assert.deepEqual(order, ["01", "02", "03"], "乱序事件必须按页号归位");
	assert.equal(md.match(/<!--PAGE:02-->/g).length, 1, "同锚点重发不得产生重复块");
	assert.ok(md.includes("第二页v2-final"), "重发内容必须覆盖旧内容");
	assert.ok(!md.includes("第二页v1"), "旧内容不得残留");
	assert.ok(md.startsWith("# doc"));
	const progress = JSON.parse(readFileSync(join(dir, "doc.progress.json"), "utf8"));
	assert.equal(progress.total, 3);
	assert.equal(progress.pageStats["2"].tables, 1);
});

test("createOcrRun: resume 预播种既有页,不丢不重", async () => {
	const dir = tmpDir("resume");
	const mdPath = join(dir, "doc.md");
	// 上次运行残留:页 1、2 已完成
	writeFileSync(mdPath, ["# doc", pageBlock(1, "旧第一页"), pageBlock(2, "旧第二页")].join("\n"), "utf8");
	const script = {
		lines: [
			{ delay: 5, line: line({ event: "start", total: 3 }) },
			{ delay: 5, line: line({ event: "page", no: 3, md: pageBlock(3, "新第三页"), stats: { tables: 0, formulas: 0, textChars: 4 } }) },
			{ delay: 5, line: line({ event: "done", warnings: [] }) },
		],
	};
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath, statePath: join(dir, "doc.state.json"), progressPath: join(dir, "doc.progress.json"),
		title: "# doc", resume: true, spawnStreamImpl: makeFake(script),
	});
	assert.equal(r.ok, true);
	const md = readFileSync(mdPath, "utf8");
	assert.equal(md.match(/<!--PAGE:\d+-->/g).length, 3, "预播种 2 页 + 新增 1 页");
	assert.ok(md.includes("旧第一页") && md.includes("新第三页"));
});

test("createOcrRun: resume=false 全新语义清旧状态/进度", async () => {
	const dir = tmpDir("fresh");
	const statePath = join(dir, "doc.state.json");
	const progressPath = join(dir, "doc.progress.json");
	writeFileSync(statePath, '{"pdf":"old","pages":{"1":"done"}}', "utf8");
	writeFileSync(progressPath, '{"total":99}', "utf8");
	const script = { lines: [{ delay: 5, line: line({ event: "done", warnings: [] }) }] };
	await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath, progressPath,
		spawnStreamImpl: makeFake(script), resume: false,
	});
	assert.equal(existsSync(statePath), false, "旧 state 必须被清(fake 不重建,真实 Python 会重建)");
	const progress = JSON.parse(readFileSync(progressPath, "utf8"));
	assert.notEqual(progress.total, 99, "旧进度必须被覆盖");
});

test("createOcrRun: 成功时追加溯源注释", async () => {
	const dir = tmpDir("meta");
	const mdPath = join(dir, "doc.md");
	const script = {
		lines: [
			{ delay: 2, line: line({ event: "page", no: 1, md: pageBlock(1, "x"), stats: {} }) },
			{ delay: 2, line: line({ event: "done", warnings: [] }) },
		],
	};
	await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath, statePath: join(dir, "s.json"), progressPath: join(dir, "p.json"),
		title: "", metaComment: "\n\n<!-- 源文件: doc.pdf | 链路: parallel-ocr -->\n",
		spawnStreamImpl: makeFake(script),
	});
	const md = readFileSync(mdPath, "utf8");
	assert.ok(md.includes("<!-- 源文件: doc.pdf | 链路: parallel-ocr -->"));
});

test("createOcrRun: signal 中止 → 进程树终止 + cancelled", async () => {
	const dir = tmpDir("abort");
	const controller = new AbortController();
	let killed = false;
	const script = {
		holdExit: true,
		onKill: () => { killed = true; },
		lines: [
			{ delay: 5, line: line({ event: "start", total: 100 }) },
			{ delay: 20, line: line({ event: "page", no: 1, md: pageBlock(1, "a"), stats: {} }) },
		],
	};
	const run = createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath: join(dir, "s.json"), progressPath: join(dir, "p.json"),
		signal: controller.signal, spawnStreamImpl: makeFake(script),
	});
	setTimeout(() => controller.abort(new Error("job killed")), 30);
	const r = await run;
	assert.equal(killed, true, "中止必须触发 killTree");
	assert.equal(r.cancelled, true);
	assert.equal(r.ok, false);
	assert.ok(r.error.includes("resume"));
});

test("createOcrRun: 超时 → E_OCR_TIMEOUT(无 signal 场景)", async () => {
	const dir = tmpDir("timeout");
	const script = { holdExit: true, lines: [{ delay: 1, line: line({ event: "start", total: 5 }) }] };
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath: join(dir, "s.json"), progressPath: join(dir, "p.json"),
		timeoutMs: 20, spawnStreamImpl: makeFake(script),
	});
	assert.equal(r.ok, false);
	assert.equal(r.timedOut, true);
	assert.equal(r.code, ERROR_CODES.E_OCR_TIMEOUT);
});

test("createOcrRun: Python 致命错误(exit 1 + done 含致命错误) → E_OCR_RUN + resume 指引", async () => {
	const dir = tmpDir("fatal");
	const script = {
		exitCode: 1,
		lines: [
			{ delay: 2, line: line({ event: "start", total: 3 }) },
			{ delay: 2, line: line({ event: "page", no: 1, md: pageBlock(1, "ok"), stats: {} }) },
			{ delay: 2, line: line({ event: "done", warnings: ["进程池异常: WinError 5", "致命错误: 进程池异常 (已完成页可 --resume 接续)"] }) },
		],
	};
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath: join(dir, "s.json"), progressPath: join(dir, "p.json"),
		spawnStreamImpl: makeFake(script),
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_OCR_RUN);
	assert.ok(r.error.includes("致命错误"));
	assert.ok(r.error.includes("resume"));
	assert.deepEqual(r.warnings.length, 2);
	// 已完成的页仍在 md 中(增量落盘不回滚)
	const md = readFileSync(join(dir, "doc.md"), "utf8");
	assert.ok(md.includes(pageBlock(1, "ok")));
});

test("createOcrRun: 无 done 事件非 0 退出 → 进程级异常", async () => {
	const dir = tmpDir("noexit");
	const script = { exitCode: 2, lines: [], stderr: "Traceback ..." };
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath: join(dir, "s.json"), progressPath: join(dir, "p.json"),
		spawnStreamImpl: makeFake(script),
	});
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_OCR_RUN);
	assert.ok(r.error.includes("exit 2"));
});

test("createOcrRun: 缺必填参数 → 收敛为结果对象(永不 reject)", async () => {
	const r = await createOcrRun({ python: "python", script: "p.py" });
	assert.equal(r.ok, false);
	assert.ok(r.error.includes("required"));
});

test("createOcrRun: --resume 传给 Python 且 workers 透传", async () => {
	const dir = tmpDir("argv");
	let captured = null;
	const impl = (cmd, args, { onLine }) => {
		captured = { cmd, args };
		let doResolve;
		const promise = new Promise((res) => { doResolve = res; });
		setTimeout(() => { doResolve({ status: 0, signal: null, stderrTail: "" }); }, 5).unref?.();
		return { promise, killTree() {} };
	};
	await createOcrRun({
		python: "py.exe", script: "parallel_ocr.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath: join(dir, "doc.state.json"), progressPath: join(dir, "doc.progress.json"),
		workers: 3, scale: 2, spawnStreamImpl: impl,
	});
	assert.ok(captured.args.includes("--resume"));
	assert.equal(captured.args[captured.args.indexOf("--resume") + 1], join(dir, "doc.state.json"));
	assert.equal(captured.args[captured.args.indexOf("--workers") + 1], "3");
	assert.equal(captured.args[captured.args.indexOf("--scale") + 1], "2");
	assert.equal(captured.cmd, "py.exe");
});
