/**
 * T2 单测 — NDJSON 消费端:锚点 upsert / 增量写 / 断点预播种 / 取消 / 超时 / 致命错误
 * 全部通过 spawnStreamImpl 测试替身注入,不启动真实 Python/进程池。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptiveEtaSec, assembleMd, createOcrRun, defaultWorkers, estimateEtaSec, mergeCrossPageTables, parseAnchoredPages, parseNdjsonLine, stateKeyFor } from "../lib/core/jobs.js";
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
 *   - signal 中止 → killTree(false);timeoutMs 到期 → killTree(true);
 *     (F8 保真度:真实 spawnStream 仅超时路径置 timedOut,中止路径不含该标记)
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
			killTree(timedOut = true) {
				if (api.killed) return;
				api.killed = true;
				script.onKill?.(timedOut);
				doResolve({ status: 1, signal: "SIGKILL", stderrTail: "terminated", timedOut });
			},
		};
		if (signal) {
			if (signal.aborted) api.killTree(false);
			else signal.addEventListener("abort", () => api.killTree(false), { once: true });
		}
		if (timeoutMs > 0) setTimeout(() => api.killTree(true), timeoutMs);
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

test("estimateEtaSec: 默认均耗已按实测中位重标定(27s/页)", () => {
	// v0.7.3 W3-8:实测 7 页真实扫描页 18.5~62.8s(中位 27.4),旧默认 15 偏乐观约 1.8×
	assert.equal(estimateEtaSec(97, 1), Math.ceil(97 * 27));
	assert.equal(estimateEtaSec(97, 4), Math.ceil((97 * 27) / 4) + 40);
	assert.ok(estimateEtaSec(97, 1) > estimateEtaSec(97, 1, 15), "重标定后必须比旧默认更保守");
});

test("adaptiveEtaSec: 用本次实测逐页耗时推算剩余;证据不足返回 null 不编数字", () => {
	// 3 页实测 20/30/40 → 均 30;剩 7 页 / 4 worker → ceil(7×30/4)=53
	assert.equal(adaptiveEtaSec({ 1: 20, 2: 30, 3: 40 }, 3, 10, 4), 53);
	assert.equal(adaptiveEtaSec({ 1: 25 }, 1, 1, 1), 0, "已全部完成 → 0");
	assert.equal(adaptiveEtaSec({}, 0, 10, 4), null, "无实测证据 → null");
	assert.equal(adaptiveEtaSec({ 1: 0, 2: -3 }, 0, 10, 4), null, "非正耗时不计入");
	assert.equal(adaptiveEtaSec({ 1: 20 }, 1, 0, 4), null, "总页数未知 → null");
	// workers=0 → 按资源感知默认口径(与实际执行的 worker 数一致)
	assert.equal(adaptiveEtaSec({ 1: 20 }, 1, 5, 0), Math.ceil((4 * 20) / defaultWorkers()));
});

test("速度:createOcrRun 给每个 worker 钉线程(默认 核数/worker 数,可显式 threads 覆盖)", async () => {
	// 不钉线程时 N 路 worker × 满核线程互相抢(实测 2 路单页 39.8s → 6 路 94.1s)
	const dir = tmpDir("threads");
	const script = {
		lines: [
			{ delay: 1, line: line({ event: "start", total: 1 }) },
			{ delay: 1, line: line({ event: "done", warnings: [] }) },
		],
	};
	const run = async (extra) => {
		let seen = null;
		const impl = makeFake(script);
		await createOcrRun({
			python: "python", script: "p.py", pdf: "doc.pdf", workers: 4,
			mdPath: join(dir, "d.md"), statePath: join(dir, "s.json"), progressPath: join(dir, "p.json"),
			spawnStreamImpl: (c, a, o) => { seen = o; return impl(c, a, o); },
			...extra,
		});
		return seen;
	};
	const cpu = os.cpus?.()?.length || 4;
	const opts = await run({});
	assert.equal(opts.env?.DSH_OCR_THREADS, String(Math.max(1, Math.floor(cpu / 4))));
	assert.equal(opts.env?.OMP_NUM_THREADS, opts.env?.DSH_OCR_THREADS);
	assert.equal(opts.env?.MKL_NUM_THREADS, opts.env?.DSH_OCR_THREADS);
	assert.ok(Object.keys(opts.env ?? {}).length > 4, "必须带上原进程环境(不能只给这几个变量)");
	// 显式覆盖
	const opts2 = await run({ workers: 8, threads: 3 });
	assert.equal(opts2.env?.DSH_OCR_THREADS, "3");
});

test("estimateEtaSec: workers=1 按页数×单页均耗;workers>1 加固定开销落标定区间;workers=0 按资源感知默认(F5)", () => {
	// workers=1: 97×15 = 1455(bench 实测 1398s,偏差 +4%)(显式传 15 保持旧标定用例可回归)
	assert.equal(estimateEtaSec(97, 1, 15), 1455);
	// workers=4: 线性 364 + 开销 40 = 404 ∈ captain 标定区间 400-420s
	const w4 = estimateEtaSec(97, 4, 15);
	assert.equal(w4, 404);
	assert.ok(w4 >= 400 && w4 <= 420, `workers=4 ETA ${w4}s 应落在 400-420s`);
	// 非法输入返回 null(调用方不承诺 etaSec)
	assert.equal(estimateEtaSec(0, 4), null);
	assert.equal(estimateEtaSec(-1, 4), null);
	assert.equal(estimateEtaSec(null, 4), null);
	// F5(v0.6.1): workers=0 → 按资源感知默认 defaultWorkers() 口径估算
	// (旧 min(CPU,8) 口径与实际执行的 worker 数脱节,2026-10-05 事故后收紧)
	const eff = defaultWorkers();
	assert.equal(estimateEtaSec(97, 0, 15), Math.ceil((97 * 15) / eff) + (eff > 1 ? 40 : 0));
	assert.ok(estimateEtaSec(97, 0, 15) < estimateEtaSec(97, 1, 15), "多核默认口径必须低于单 worker 口径");
});

/* ---------------- 资源感知默认 worker(v0.6.1) ---------------- */

test("defaultWorkers: min(CPU, 4, 内存预算),内存未知回退上限,预算不足钳 1", () => {
	const GB = 1024 ** 3;
	// 22 核/32GB → min(22, 4, 12) = 4(2026-10-05 事故机:旧口径会给出 8)
	assert.equal(defaultWorkers({ cpu: 22, totalMem: 32 * GB }), 4);
	// 4GB 小内存机 → floor(4/2.5)=1
	assert.equal(defaultWorkers({ cpu: 16, totalMem: 4 * GB }), 1);
	// 8GB → floor(3.2)=3
	assert.equal(defaultWorkers({ cpu: 8, totalMem: 8 * GB }), 3);
	// 内存探查失败(0)→ 退化为 min(CPU, 4)
	assert.equal(defaultWorkers({ cpu: 2, totalMem: 0 }), 2);
	assert.equal(defaultWorkers({ cpu: 16, totalMem: 0 }), 4);
	// 自定义上限
	assert.equal(defaultWorkers({ cpu: 22, totalMem: 64 * GB, cap: 2 }), 2);
	// 结果恒 ≥1
	assert.equal(defaultWorkers({ cpu: 1, totalMem: 1 * GB }), 1);
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
	// F8 保真度:中止路径不得携带 timedOut 标记(仅超时路径置位)
	assert.equal(r.timedOut, undefined);
});

test("createOcrRun: F3 收尾对账——state 标 done 而 md 缺页 → warning + progress 标注(防静默丢页)", async () => {
	const dir = tmpDir("recon");
	const mdPath = join(dir, "doc.md");
	const statePath = join(dir, "doc.state.json");
	const progressPath = join(dir, "doc.progress.json");
	// 预置 Python 侧断点状态:页 1/2/3 均标记 done(模拟在途事件丢失窗口后的状态)
	writeFileSync(statePath, JSON.stringify({ pdf: "doc.pdf", total: 3, scale: 2, pages: { 1: "done", 2: "done", 3: "done" }, pageWarnings: {} }), "utf8");
	// 本轮仅重发页 1(fake 不重写 state,预置状态保持原样)——页 2/3 即「state=done 而 md 无页」
	const script = {
		lines: [
			{ delay: 2, line: line({ event: "start", total: 3 }) },
			{ delay: 2, line: line({ event: "page", no: 1, md: pageBlock(1, "仅此页到达"), stats: {} }) },
			{ delay: 2, line: line({ event: "done", warnings: [] }) },
		],
	};
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: "doc.pdf",
		mdPath, statePath, progressPath,
		title: "# doc", resume: true, spawnStreamImpl: makeFake(script),
	});
	assert.equal(r.ok, true, "对账属警告级,不判致命");
	const reconWarning = (r.warnings ?? []).find((w) => w.includes("对账发现"));
	assert.ok(reconWarning, "必须产出对账 warning");
	assert.ok(reconWarning.includes("第 2、3 页"));
	assert.ok(reconWarning.includes("全新重跑"), "必须给出恢复指引(resume 会跳过 done 页)");
	// progress 镜像同步标注
	const progress = JSON.parse(readFileSync(progressPath, "utf8"));
	assert.deepEqual(progress.reconciliation.missingInMd, [2, 3]);
	// 收尾写盘已原子化:md 内容完整可解析(非截断)
	const md = readFileSync(mdPath, "utf8");
	assert.ok(md.includes("仅此页到达"));
	assert.ok(md.startsWith("# doc"));
});

test("createOcrRun(W3-2): 键不匹配 → 清旧状态且不预播种(绝不拿旧结果)", async () => {
	const dir = tmpDir("keymiss");
	const mdPath = join(dir, "doc.md");
	const statePath = join(dir, "doc.state.json");
	const progressPath = join(dir, "doc.progress.json");
	// 模拟"同名另存/上一版算法留下"的旧产物:md 有页 9,state 带不匹配的键
	writeFileSync(mdPath, `${pageBlock(9, "旧文档残留内容")}\n`, "utf8");
	writeFileSync(statePath, JSON.stringify({
		pdf: "old.pdf", total: 1, scale: 2, stateKey: "vOLD|s2|deadbeef",
		pages: { 9: "done" }, pageWarnings: {},
	}), "utf8");
	const script = {
		lines: [
			{ delay: 2, line: line({ event: "start", total: 1 }) },
			{ delay: 2, line: line({ event: "page", no: 1, md: pageBlock(1, "新内容"), stats: {} }) },
			{ delay: 2, line: line({ event: "done", warnings: [] }) },
		],
	};
	let seenArgs = null;
	const impl = makeFake(script);
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: join(dir, "指纹取不到的旧名.pdf"),
		mdPath, statePath, progressPath, title: "# doc",
		spawnStreamImpl: (c, a, o) => { seenArgs = a; return impl(c, a, o); },
	});
	assert.equal(r.ok, true);
	assert.ok(!(existsSync(statePath) && readFileSync(statePath, "utf8").includes("deadbeef")),
		"键不匹配的旧状态必须被清掉");
	const md = readFileSync(mdPath, "utf8");
	assert.ok(md.includes("新内容"), "新页必须写入");
	assert.ok(!md.includes("旧文档残留内容"), "绝不能从旧 md 预播种");
	assert.ok(!(seenArgs ?? []).includes("--state-key"), "取不到指纹时不得传键");
});

test("createOcrRun(W3-2): 键匹配 + md 有锚点页 → 默认复用(不重 OCR、不删状态)", async () => {
	const dir = tmpDir("keyhit");
	const pdfPath = join(dir, "doc.pdf");
	const mdPath = join(dir, "doc.md");
	const statePath = join(dir, "doc.state.json");
	const progressPath = join(dir, "doc.progress.json");
	writeFileSync(pdfPath, "PDF", "utf8"); // 只需可 stat 出指纹(fake spawn 不真读 PDF)
	writeFileSync(mdPath, `${pageBlock(1, "已完成页内容")}\n`, "utf8");
	writeFileSync(statePath, JSON.stringify({
		pdf: pdfPath, total: 1, scale: 2, stateKey: stateKeyFor(pdfPath, 2),
		pages: { 1: "done" }, pageWarnings: {},
	}), "utf8");
	// 复刻"Python 见 done 即跳过"→ 只发 start/done,不发 page
	const script = {
		lines: [
			{ delay: 2, line: line({ event: "start", total: 1 }) },
			{ delay: 2, line: line({ event: "done", warnings: [] }) },
		],
	};
	let seenArgs = null;
	const impl = makeFake(script);
	const r = await createOcrRun({
		python: "python", script: "p.py", pdf: pdfPath,
		mdPath, statePath, progressPath, title: "# doc",
		spawnStreamImpl: (c, a, o) => { seenArgs = a; return impl(c, a, o); },
	});
	assert.equal(r.ok, true);
	assert.ok(readFileSync(mdPath, "utf8").includes("已完成页内容"), "复用必须保留已完成页");
	assert.ok(existsSync(statePath), "键匹配的 state 不得被删除");
	assert.ok((seenArgs ?? []).includes("--state-key"), "键匹配时必须把键传给 Python");
});

test("W-跨页续接: 片段首行是数据行 → 并回上一页表(保留该行, 丢弃片段分隔线)", () => {
	// 真实形态(采购文件 p4→p5):上一页表尾 + 下一页片段(首行是被提升成表头的**数据行**)
	const md = [
		"<!--PAGE:04-->", "", "| 条款号 | 条款名称 | 编列内容 |", "| --- | --- | --- |",
		"| 3.3.1 | 申请文件有效期 | 自申请文件递交截止之日起90天 |",
		"| 3.4.1 | 投标保证金 | 不收取 |", "", "<!--/PAGE:04-->", "",
		"<!--PAGE:05-->", "", "| 备注：如需缴纳投标保证金,可选择下列两种形式之一提交 |  |  |",
		"| --- | --- | --- |", "| 不适用 | 投标保证金的退还 | 3.4.3 |", "", "<!--/PAGE:05-->",
	].join("\n");
	const out = mergeCrossPageTables(md);
	assert.equal(out.split("| --- | --- | --- |").length - 1, 1, "只应剩一个分隔行(一张表)");
	assert.ok(out.includes("| 备注：如需缴纳投标保证金"), "被提升的数据行必须保留, 不能丢");
	assert.ok(out.includes("| 不适用 | 投标保证金的退还 | 3.4.3 |"), "片段数据行保留");
	assert.ok(out.includes("| 3.4.1 | 投标保证金 | 不收取 |"), "上一页表尾保留");
	// 锚点语义不被破坏
	for (const a of ["<!--PAGE:04-->", "<!--/PAGE:04-->", "<!--PAGE:05-->", "<!--/PAGE:05-->"]) {
		assert.ok(out.includes(a), `锚点 ${a} 必须保留`);
	}
	// 顺序: 上一页表头 → 它的行 → 续接行 → 上一页闭合锚点
	assert.ok(out.indexOf("| 3.4.1 |") < out.indexOf("| 备注："), "续接行应在上一页表之后");
	assert.ok(out.indexOf("| 备注：") < out.indexOf("<!--/PAGE:04-->"), "续接行应并入上一页块内(闭合锚点之前)");
	assert.equal(mergeCrossPageTables(out), out, "幂等:再并一次结果不变");
});

test("W-跨页续接: 片段重复表头 → 丢弃重复表头(不出现两个表头)", () => {
	const md = [
		"<!--PAGE:01-->", "", "| A | B |", "| --- | --- |", "| a1 | b1 |", "", "<!--/PAGE:01-->", "",
		"<!--PAGE:02-->", "", "| A | B |", "| --- | --- |", "| a2 | b2 |", "", "<!--/PAGE:02-->",
	].join("\n");
	const out = mergeCrossPageTables(md);
	assert.equal((out.match(/\| A \| B \|/g) ?? []).length, 1, "重复表头只能出现一次");
	assert.equal(out.split("| --- | --- |").length - 1, 1);
	assert.ok(out.includes("| a1 | b1 |") && out.includes("| a2 | b2 |"), "两页数据行都保留");
});

test("W-跨页续接: 不该并的情形不并(列数不同/中间有正文/夹在非锚点内容后)", () => {
	const base = (p1, p2, mid = ["", "<!--/PAGE:01-->", "", "<!--PAGE:02-->", ""]) =>
		[["<!--PAGE:01-->", "", ...p1].join("\n"), mid.join("\n"), [...p2, "", "<!--/PAGE:02-->"].join("\n")].join("\n");
	const t2 = ["| A | B |", "| --- | --- |", "| a | b |"];
	const t3 = ["| A | B | C |", "| --- | --- | --- |", "| a | b | c |"];
	// 列数不同 → 两张表各自保留(2 列分隔行 1 个、3 列分隔行 1 个)
	const widthMismatch = mergeCrossPageTables(base(t2, t3));
	assert.equal(widthMismatch.split("\n").filter((l) => l.trim() === "| --- | --- |").length, 1);
	assert.equal(widthMismatch.split("\n").filter((l) => l.trim() === "| --- | --- | --- |").length, 1);
	// 中间夹正文 → 不并(两个同形分隔行)
	const withHeading = base(t2, t2, ["", "## 小节标题", "", "<!--/PAGE:01-->", "", "<!--PAGE:02-->", ""]);
	assert.equal(withHeading.split("| --- | --- |").length - 1, 2, "中间有正文时不得合并");
	// 表头/分隔行不全 → 不并
	const noSep = base(["| A | B |", "| a | b |"], t2);
	assert.equal(noSep.split("| --- | --- |").length - 1, 1, "上一页无分隔行时不并");
	// 无表格 → 原文返回
	const plain = "<!--PAGE:01-->\n\n纯文本\n\n<!--/PAGE:01-->";
	assert.equal(mergeCrossPageTables(plain), plain);
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
	// v0.6.1: workers=0 → Node 侧解析为资源感知默认并显式下传(单一事实源,Python 独立默认仅兜底 CLI)
	await createOcrRun({
		python: "py.exe", script: "parallel_ocr.py", pdf: "doc.pdf",
		mdPath: join(dir, "doc.md"), statePath: join(dir, "doc.state.json"), progressPath: join(dir, "doc.progress.json"),
		workers: 0, scale: 2, spawnStreamImpl: impl,
	});
	assert.equal(captured.args[captured.args.indexOf("--workers") + 1], String(defaultWorkers()));
});

/* ---------------- spawnStream 本体直测(F8;真实子进程,受限沙箱自动跳过) ---------------- */

test("spawnStream 直测:分帧/超时/终止(禁管道环境自动 skip,部署阶段真跑)", async (t) => {
	const { spawnStream } = await import("../lib/core/jobs.js");
	// 环境探针:能否 spawn 带管道 stdio 的子进程(sandbox EPERM → skip)
	const probe = spawnStream(process.execPath, ["-e", "process.stdout.write('ok\\n')"], { onLine: () => {} });
	const probeResult = await probe.promise;
	if (probeResult.error && /EPERM/i.test(probeResult.error)) {
		t.skip("当前环境禁命名管道(开发沙箱);部署阶段(dsh web 进程)自动真跑");
		return;
	}
	assert.equal(probeResult.status, 0, `环境探针应正常退出:${JSON.stringify(probeResult).slice(0, 200)}`);

	// ① 分帧:三行协议逐行回调
	const lines = [];
	const frame = spawnStream(process.execPath, ["-e", "for (const l of ['{\\\"a\\\":1}','{\\\"b\\\":2}','{\\\"c\\\":3}']) console.log(l)"], { onLine: (l) => lines.push(l) });
	const frameResult = await frame.promise;
	assert.equal(frameResult.status, 0);
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'], "chunked stdout 必须按行分帧");

	// ② 超时:永驻进程被杀,timedOut=true
	const timeout = spawnStream(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { onLine: () => {}, timeoutMs: 300 });
	const timeoutResult = await timeout.promise;
	assert.equal(timeoutResult.timedOut, true);
	// F8-2 保真度修正:killed 在结案结果对象上(句柄只暴露 {promise,killTree},无 .killed 属性;
	// 旧断言照测试替身形状写,开发沙箱 EPERM skip 从未真跑,2026-10-05 部署级环境首次暴露)
	assert.equal(timeoutResult.killed, true);

	// ③ 终止:abort → killTree,promise 结案且 timedOut 不置位
	const controller = new AbortController();
	const aborted = spawnStream(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { onLine: () => {}, signal: controller.signal });
	setTimeout(() => controller.abort(new Error("test")), 150);
	const abortResult = await aborted.promise;
	assert.equal(abortResult.killed, true);
	assert.notEqual(abortResult.timedOut, true, "中止路径不得置 timedOut(仅超时置位)");
});
