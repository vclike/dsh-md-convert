/**
 * T4 单测 — 装配与完整性校验:锚点覆盖/重复/越批/乱码/极短页/合并顺序/复查回写/致命路径
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePlan, countAnchors, decodeUtf8Strict, detectMojibake, visibleLength } from "../lib/core/assemble.js";
import { ERROR_CODES } from "../lib/core/errors.js";

function tmpWorkspace(tag) {
	return mkdtempSync(join(tmpdir(), `mdc-t4-${tag}-`));
}
function pad(no) {
	return String(no).padStart(2, "0");
}
function pageBlock(no, body) {
	return `<!--PAGE:${pad(no)}-->\n\n${body}\n\n<!--/PAGE:${pad(no)}-->`;
}
function range(from, to) {
	const out = [];
	for (let p = from; p <= to; p++) out.push(p);
	return out;
}

/** 构造 T3 形态的 plan.json + 批次 output(内容可注入) */
function buildFixture(ws, { totalPages = 6, batches = [[1, 4], [5, 6]], base = "测试文档", contentOf = null } = {}) {
	const workDir = join(ws, `${base}.vision`);
	const outputsDir = join(workDir, "outputs");
	mkdirSync(outputsDir, { recursive: true });
	const plan = {
		planVersion: 1,
		kind: "md-convert-vision-brief",
		createdAt: new Date().toISOString(),
		source: { pdf: join(ws, `${base}.pdf`), base, totalPages },
		render: { scale: 2, pagesDir: join(workDir, "pages") },
		promptTemplate: { path: "builtin", overridden: false },
		batches: batches.map(([from, to], i) => {
			const id = `batch-${pad(i + 1)}`;
			const pageList = range(from, to);
			return {
				id,
				pages: [from, to],
				pageList,
				imageFiles: pageList.map((p) => join(workDir, "pages", `p-${pad(p)}.png`)),
				promptFile: join(workDir, "prompts", `${id}.md`),
				outputFile: join(outputsDir, `${id}.md`),
				status: "pending",
			};
		}),
		outputContract: { anchorFormat: "<!--PAGE:NN--> … <!--/PAGE:NN-->" },
		assemble: { tool: "md_convert_assemble", planPath: join(workDir, "plan.json"), finalOutput: join(ws, `${base}.md`) },
	};
	const planPath = join(workDir, "plan.json");
	writeFileSync(planPath, JSON.stringify(plan, null, "\t"), "utf8");
	for (const b of plan.batches) {
		const body = b.pageList.map((p) => pageBlock(p, contentOf?.(p) ?? `第${p}页的正常内容,包含足够多的可见字符用于校验。`)).join("\n\n");
		writeFileSync(b.outputFile, body, "utf8");
	}
	return { plan, planPath, workDir, outputsDir };
}

/* ---------------- 纯函数 ---------------- */

test("countAnchors: 计数语义(重复可检出)+ 首块保留", () => {
	const map = countAnchors(`${pageBlock(3, "v1")}\n${pageBlock(1, "a")}\n${pageBlock(3, "v2")}`);
	assert.equal(map.size, 2);
	assert.equal(map.get(3).count, 2);
	assert.equal(map.get(3).block, pageBlock(3, "v1"), "重复时保留首次出现");
	assert.equal(map.get(1).count, 1);
});

test("detectMojibake: U+FFFD/锟斤拷/Latin-1 串三类特征", () => {
	assert.equal(detectMojibake("完全正常的中文内容,无任何乱码。").suspect, false);
	const r = detectMojibake("锟斤拷锟斤拷以及替换符��和 Latin 串 ä¸­æ–‡ 混合");
	assert.equal(r.suspect, true);
	assert.ok(r.hits.length >= 2);
	const onlyFffd = detectMojibake("前缀��后缀");
	assert.ok(onlyFffd.hits.some((h) => h.name.includes("U+FFFD")));
});

test("visibleLength: 剥离注释与锚点;极短判据", () => {
	const block = pageBlock(9, "<!-- 印章 -->正文八个字");
	assert.equal(visibleLength(block), "正文八个字".length);
	assert.equal(visibleLength(pageBlock(9, "<!-- 第9页无法辨认 -->")), 0);
	assert.equal(visibleLength(pageBlock(9, "ok")), 2);
});

test("decodeUtf8Strict: 非法字节序列返回 null", () => {
	assert.equal(decodeUtf8Strict(Buffer.from("正常中文", "utf8")), "正常中文");
	assert.equal(decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0xfd])), null);
});

/* ---------------- assemblePlan ---------------- */

test("assemblePlan: 全绿装配 → coverage 全覆盖 + 合并按页序 + 溯源注释", async () => {
	const ws = tmpWorkspace("ok");
	const { planPath } = buildFixture(ws);
	const r = await assemblePlan({ planPath });
	assert.equal(r.ok, true);
	assert.deepEqual(r.findings, []);
	assert.deepEqual(r.coverage, { found: 6, total: 6 });
	const md = readFileSync(r.output, "utf8");
	const order = [...md.matchAll(/<!--PAGE:(\d+)-->/g)].map((m) => Number(m[1]));
	assert.deepEqual(order, [1, 2, 3, 4, 5, 6], "必须按 PAGE 序合并");
	assert.ok(md.startsWith("# 测试文档"));
	assert.ok(md.includes("链路: vision(2批)+assemble"));
});

test("assemblePlan: 批次在 plan 中乱序 → 合并仍按页序", async () => {
	const ws = tmpWorkspace("order");
	const { planPath, plan } = buildFixture(ws);
	plan.batches.reverse();
	writeFileSync(planPath, JSON.stringify(plan), "utf8");
	const r = await assemblePlan({ planPath });
	assert.equal(r.ok, true);
	const md = readFileSync(r.output, "utf8");
	const order = [...md.matchAll(/<!--PAGE:(\d+)-->/g)].map((m) => Number(m[1]));
	assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
});

test("assemblePlan: 抽掉 1 页锚点 → findings 精确报告缺页 + 占位装配", async () => {
	const ws = tmpWorkspace("missing");
	const { planPath, plan } = buildFixture(ws);
	// 从 batch-02(output 含页 5,6)中抽掉页 5
	const b2 = plan.batches.find((b) => b.id === "batch-02");
	const text = readFileSync(b2.outputFile, "utf8");
	writeFileSync(b2.outputFile, text.replace(pageBlock(5, "第5页的正常内容,包含足够多的可见字符用于校验。"), "").trimStart(), "utf8");
	const r = await assemblePlan({ planPath });
	assert.equal(r.ok, true, "非致命问题仍装配");
	const miss = r.findings.filter((f) => f.problem === "缺页");
	assert.equal(miss.length, 1);
	assert.equal(miss[0].page, 5);
	assert.equal(miss[0].severity, "high");
	assert.deepEqual(r.coverage, { found: 5, total: 6 });
	const md = readFileSync(r.output, "utf8");
	assert.ok(md.includes("第5页缺失"));
	assert.ok(md.includes("<!--PAGE:05-->"), "缺页页仍有占位锚点(合并完整性)");
});

test("assemblePlan: 重复锚点 → findings 报告,装配取首次出现", async () => {
	const ws = tmpWorkspace("dup");
	const { planPath, plan } = buildFixture(ws, { contentOf: (p) => (p === 3 ? null : undefined) });
	const b1 = plan.batches.find((b) => b.id === "batch-01");
	// 重写 batch-01:页 3 出现两次
	const body = [pageBlock(1, "第一页内容,足够长。"), pageBlock(3, "第三页首次出现,内容足够长。"), pageBlock(3, "第三页二次出现,内容足够长。"), pageBlock(4, "第四页内容,足够长。")].join("\n\n");
	writeFileSync(b1.outputFile, body, "utf8");
	const r = await assemblePlan({ planPath });
	const dup = r.findings.filter((f) => f.problem === "重复锚点");
	assert.equal(dup.length, 1);
	assert.equal(dup[0].page, 3);
	assert.equal(dup[0].severity, "high");
	const md = readFileSync(r.output, "utf8");
	assert.equal(md.match(/<!--PAGE:03-->/g).length, 1, "重复锚点装配后只保留一份");
	assert.ok(md.includes("第三页首次出现"), "取首次出现");
	assert.ok(!md.includes("第三页二次出现"));
});

test("assemblePlan: 乱码特征页 → findings 报告疑似乱码", async () => {
	const ws = tmpWorkspace("moji");
	const { planPath } = buildFixture(ws, { contentOf: (p) => (p === 2 ? "锟斤拷锟斤拷与替换符��以及ä¸­æ–‡连续串。" : undefined) });
	const r = await assemblePlan({ planPath });
	const moji = r.findings.filter((f) => f.problem === "疑似乱码");
	assert.equal(moji.length, 1);
	assert.equal(moji[0].page, 2);
	assert.equal(moji[0].severity, "medium");
	assert.ok(moji[0].evidence.includes("乱码") || moji[0].evidence.includes("U+FFFD") || moji[0].evidence.includes("Latin"));
});

test("assemblePlan: 极短页 → findings 报告(可见字符<10)", async () => {
	const ws = tmpWorkspace("short");
	const { planPath } = buildFixture(ws, { contentOf: (p) => (p === 6 ? "ok" : undefined) });
	const r = await assemblePlan({ planPath });
	const short = r.findings.filter((f) => f.problem === "极短页");
	assert.equal(short.length, 1);
	assert.equal(short[0].page, 6);
	assert.equal(short[0].severity, "medium");
	assert.ok(short[0].evidence.includes("2"));
});

test("assemblePlan: 纯注释页(可见 0 字符)同样列入极短页", async () => {
	const ws = tmpWorkspace("comment");
	const { planPath } = buildFixture(ws, { contentOf: (p) => (p === 1 ? "<!-- 第1页无法辨认 -->" : undefined) });
	const r = await assemblePlan({ planPath });
	const short = r.findings.filter((f) => f.problem === "极短页" && f.page === 1);
	assert.equal(short.length, 1);
});

test("assemblePlan: 越批锚点 → findings 报告(出现在不归属批次)", async () => {
	const ws = tmpWorkspace("cross");
	const { planPath, plan } = buildFixture(ws, { batches: [[1, 4], [5, 8]], totalPages: 8 });
	const b1 = plan.batches.find((b) => b.id === "batch-01");
	// 在 batch-01 文件尾塞一个页 7 的锚点(归属 batch-02)
	const extra = `\n\n${pageBlock(7, "越批混入的内容,足够长。")}`;
	const t = readFileSync(b1.outputFile, "utf8");
	writeFileSync(b1.outputFile, t + extra, "utf8");
	const r = await assemblePlan({ planPath });
	const cross = r.findings.filter((f) => f.problem === "越批锚点");
	assert.equal(cross.length, 1);
	assert.equal(cross[0].page, 7);
	assert.equal(cross[0].severity, "medium");
	assert.ok(cross[0].evidence.includes("batch-01"));
});

test("assemblePlan: 批次 output 文件缺失 → 批次级 finding + 覆盖缺口(不逐页刷屏)", async () => {
	const ws = tmpWorkspace("nofile");
	const { planPath, plan } = buildFixture(ws);
	const b2 = plan.batches.find((b) => b.id === "batch-02");
	const { rmSync } = await import("node:fs");
	rmSync(b2.outputFile, { force: true });
	const r = await assemblePlan({ planPath });
	assert.equal(r.ok, true);
	const batchMiss = r.findings.filter((f) => f.problem.includes("output 文件缺失"));
	assert.equal(batchMiss.length, 1);
	assert.equal(batchMiss[0].severity, "high");
	assert.equal(r.findings.filter((f) => f.problem === "缺页").length, 0, "缺页由批次级 finding 覆盖,不重复刷屏");
	assert.deepEqual(r.coverage, { found: 4, total: 6 });
	const md = readFileSync(r.output, "utf8");
	assert.ok(md.includes("第5页缺失") && md.includes("第6页缺失"));
});

test("assemblePlan: plan 缺失 → E_FILE_NOT_FOUND;损坏 → E_ASSEMBLE;非法 UTF-8 → E_ASSEMBLE(blocker)", async () => {
	const ws = tmpWorkspace("fatal");
	const missing = await assemblePlan({ planPath: join(ws, "无.plan.json") });
	assert.equal(missing.ok, false);
	assert.equal(missing.code, ERROR_CODES.E_FILE_NOT_FOUND);

	const badDir = join(ws, "bad.vision");
	mkdirSync(badDir, { recursive: true });
	const badPath = join(badDir, "plan.json");
	writeFileSync(badPath, "{ 不是 JSON", "utf8");
	const corrupt = await assemblePlan({ planPath: badPath });
	assert.equal(corrupt.ok, false);
	assert.equal(corrupt.code, ERROR_CODES.E_ASSEMBLE);

	const { planPath, plan } = buildFixture(ws, { base: "utf8坏" });
	const buf = Buffer.concat([Buffer.from(pageBlock(1, "x"), "utf8").slice(0, 10), Buffer.from([0xff, 0xfe])]);
	writeFileSync(plan.batches[0].outputFile, buf);
	const r = await assemblePlan({ planPath });
	assert.equal(r.ok, false);
	assert.equal(r.code, ERROR_CODES.E_ASSEMBLE);
	assert.ok((r.findings ?? []).some((f) => f.severity === "blocker" && f.problem.includes("UTF-8")));
});

test("assemblePlan: review:true → 复查任务书 + plan.json 各批 output 回写为复查路径", async () => {
	const ws = tmpWorkspace("review");
	const { planPath, plan } = buildFixture(ws, {
		contentOf: (p) => (p === 2 ? "锟斤拷乱码页��。" : p === 5 ? null : undefined),
	});
	// 页 5 缺锚点
	const b2 = plan.batches.find((b) => b.id === "batch-02");
	const t = readFileSync(b2.outputFile, "utf8");
	writeFileSync(b2.outputFile, t.replace(pageBlock(5, "第5页的正常内容,包含足够多的可见字符用于校验。"), "").trimStart(), "utf8");

	const r = await assemblePlan({ planPath, review: true });
	assert.equal(r.ok, true);
	assert.ok(r.review, "有可疑页必须生成复查");
	assert.deepEqual(r.review.pages.sort(), [2, 5]);
	assert.equal(existsSync(r.review.briefPath), true);

	const brief = readFileSync(r.review.briefPath, "utf8");
	assert.ok(brief.includes("复查任务书"));
	assert.ok(brief.includes("逐字校正"));
	assert.ok(brief.includes("p-02.png"), "复查任务书必须指向原 PNG");
	assert.ok(brief.includes("review-batch-01.md"));
	assert.ok(brief.includes("review-batch-02.md"));
	assert.ok(brief.includes("整批重写"));

	// plan.json 回写:受影响批次 output → review 路径,status=review
	const updated = JSON.parse(readFileSync(planPath, "utf8"));
	assert.equal(updated.batches[0].status, "review");
	assert.ok(updated.batches[0].outputFile.includes("review-batch-01.md"));
	assert.equal(updated.batches[1].status, "review");
	assert.ok(updated.batches[1].outputFile.includes("review-batch-02.md"));
	assert.deepEqual(updated.review.pages, [2, 5]);
});

test("assemblePlan: review:true 但全绿 → review 为 null", async () => {
	const ws = tmpWorkspace("review-clean");
	const { planPath } = buildFixture(ws);
	const r = await assemblePlan({ planPath, review: true });
	assert.equal(r.ok, true);
	assert.equal(r.review, null);
});
