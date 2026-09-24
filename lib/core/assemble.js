/**
 * dsh-md-convert — vision 链路装配与完整性校验(v0.6.0 T4)
 *
 * 消费 T3 的 plan.json(<名>.vision/plan.json),对各批 outputFile 做确定性校验:
 *   ① 文件存在且非空
 *   ② PAGE 锚点覆盖 1..totalPages:无缺页、无重复、无越批(锚点出现在不归属批次)
 *   ③ UTF-8 合法(严格解码,失败即致命)+ 乱码特征检测
 *      (GBK 双重编码高频 mojibake:U+FFFD/锟斤拷系/Latin-1 连续串)
 *   ④ 极短页统计(去注释后可见字符 <10 的页列入可疑)
 * 全部通过 → 按 PAGE 序合并写最终 md(标题 + 溯源注释:链路=vision(N批)+assemble);
 * 有问题 → 仍装配(缺页占位注释)并返回 findings(缺页/重复/越批/乱码/极短页),
 *          调用方据 findings 决定复查或重跑;致命(plan 缺失/损坏/非 UTF-8/写盘失败)→ ok:false。
 *
 * review:true → 对可疑页生成复查任务书 <名>-review.md(指向原 PNG + 逐字校正提示词),
 *   并把受影响批次的 outputFile 更新为复查输出路径(outputs/review-batch-NN.md,
 *   要求整批全部页重写以保持装配完整性),plan.json 同步更新(status:"review")。
 *
 * 复用 T2 的 ANCHOR_RE 锚点口径(<!--PAGE:NN--> … <!--/PAGE:NN-->),双链路装配同构。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ERROR_CODES } from "./errors.js";

/** 与 jobs.js 同口径的页锚点(本模块需要计数语义,独立编译正则) */
const ANCHOR_G = /<!--PAGE:(\d{2,})-->([\s\S]*?)<!--\/PAGE:\1-->/g;
const ANCHOR_SINGLE = /<!--PAGE:(\d{2,})-->([\s\S]*?)<!--\/PAGE:\1-->/;

/** 乱码特征规则(确定性,非 AI 判断;命中即列为可疑,severity=medium) */
const MOJIBAKE_RULES = [
	{ name: "U+FFFD 替换符(解码失败占位)", re: /\uFFFD+/g },
	{ name: "锟斤拷/烫烫烫/屯屯屯(GBK 双重编码经典)", re: /锟斤拷|烫烫烫|屯屯屯/g },
	{
		name: "Latin-1 连续串(UTF-8 字节流被按单字节编码误读)",
		re: /[\u00A0-\u00FF](?:[\u00A0-\uFFFF\u2013\u2014\u2018\u2019\u201C\u201D\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]){2,}/gu,
	},
];

/* ------------------------------------------------------------------ 纯函数(单测面) */

/**
 * 纯函数:统计文本中每个页锚点的出现次数与首块内容。
 * @param {string} text
 * @returns {Map<number, {count: number, block: string}>} 页号 → {count, block(含锚点)}
 */
export function countAnchors(text) {
	const map = new Map();
	if (typeof text !== "string" || !text) return map;
	ANCHOR_G.lastIndex = 0;
	let m;
	while ((m = ANCHOR_G.exec(text)) !== null) {
		const no = parseInt(m[1], 10);
		const prev = map.get(no);
		if (prev) prev.count += 1;
		else map.set(no, { count: 1, block: m[0] });
	}
	return map;
}

/**
 * 纯函数:GBK 双重编码等乱码特征检测(确定性规则)。
 * @returns {{suspect: boolean, hits: Array<{name: string, count: number, sample: string}>}}
 */
export function detectMojibake(text, sampleWidth = 12) {
	const hits = [];
	if (typeof text !== "string" || !text) return { suspect: false, hits };
	for (const rule of MOJIBAKE_RULES) {
		rule.re.lastIndex = 0;
		let m;
		let count = 0;
		let sample = "";
		while ((m = rule.re.exec(text)) !== null) {
			count += 1;
			if (!sample) {
				const start = Math.max(0, m.index - sampleWidth);
				sample = text.slice(start, m.index + m[0].length + sampleWidth).replace(/\s+/g, " ");
			}
			if (count >= 50) break; // 证据充分即可,不无限扫描
		}
		if (count > 0) hits.push({ name: rule.name, count, sample: sample || rule.name });
	}
	return { suspect: hits.length > 0, hits };
}

/**
 * 纯函数:页可见字符数(剥离 HTML 注释与首尾空白;锚点标记在解析时已剥离)。
 * @param {string} block 含锚点的页块
 * @returns {number}
 */
export function visibleLength(block) {
	if (typeof block !== "string") return 0;
	const inner = ANCHOR_SINGLE.exec(block)?.[2] ?? block;
	return inner
		.replace(/<!--[\s\S]*?-->/g, "") // 印章/页眉/占位等注释不计入可见内容
		.replace(/\s+/g, "")
		.length;
}

/**
 * 纯函数:严格 UTF-8 解码(非法字节序列 → null,由调用方判致命)。
 * @param {Buffer} buffer
 * @returns {string|null}
 */
export function decodeUtf8Strict(buffer) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 装配 vision 批次产出为最终 Markdown(含确定性校验;详见文件头)。
 * @param {object} opts
 * @param {string} opts.planPath T3 plan.json 路径(必填)
 * @param {boolean} [opts.review=false] 对可疑页生成复查任务书并改写 plan.json
 * @param {boolean} [opts.title=true] 最终 md 加标题行
 * @param {boolean} [opts.meta=true] 最终 md 加溯源注释
 * @returns {Promise<object>}
 *   ok:true  → { ok, output, coverage:{found,total}, findings:[{page,severity,problem,evidence}],
 *                review?:{briefPath,pages,batches}|null, planPath }
 *   ok:false → { ok:false, code, error, findings?, planPath }(致命:plan 缺失/损坏/非 UTF-8/写盘失败)
 */
export async function assemblePlan(opts = {}) {
	const { planPath: planPathArg, review = false, title = true, meta = true } = opts;
	const findings = [];
	try {
		if (typeof planPathArg !== "string" || !planPathArg.trim()) {
			return { ok: false, code: ERROR_CODES.E_ASSEMBLE, error: "缺少 planPath 参数", findings, planPath: planPathArg ?? "" };
		}
		const planPath = resolve(planPathArg);
		if (!existsSync(planPath)) {
			return { ok: false, code: ERROR_CODES.E_FILE_NOT_FOUND, error: `plan.json 不存在: ${planPath}`, findings, planPath };
		}
		let plan;
		try {
			plan = JSON.parse(readFileSync(planPath, "utf8"));
		} catch (e) {
			return { ok: false, code: ERROR_CODES.E_ASSEMBLE, error: `plan.json 解析失败:${e?.message ?? e}`, findings, planPath };
		}
		const totalPages = plan?.source?.totalPages;
		const base = plan?.source?.base;
		if (!Number.isInteger(totalPages) || totalPages <= 0 || typeof base !== "string" || !Array.isArray(plan.batches) || plan.batches.length === 0) {
			return { ok: false, code: ERROR_CODES.E_ASSEMBLE, error: "plan.json 结构无效(需 source.totalPages/source.base/非空 batches)", findings, planPath };
		}

		// 归一化批次页归属:pageList 优先,缺省用 [from,to]
		const batches = plan.batches.map((b) => {
			const pageList = Array.isArray(b.pageList) && b.pageList.length
				? b.pageList
				: (Array.isArray(b.pages) && b.pages.length === 2
					? range(b.pages[0], b.pages[1])
					: []);
			return { ...b, pageList };
		});
		const ownerOf = new Map(); // 页号 → 批次 id
		for (const b of batches) for (const p of b.pageList) if (!ownerOf.has(p)) ownerOf.set(p, b.id);

		// ① 逐批读文件(存在/非空/UTF-8 严格解码)+ ② 锚点计数(重复/越批)
		const pageContents = new Map(); // 页号 → block(首次出现优先)
		const brokenBatches = new Set(); // 文件缺失/为空的批次(其页不逐页报缺,由批次级 finding 覆盖)
		for (const b of batches) {
			if (typeof b.outputFile !== "string" || !b.outputFile) {
				brokenBatches.add(b.id);
				findings.push(finding(b.pageList[0] ?? null, "high", `批次 ${b.id} output 未指定`, "plan.batches[].outputFile 缺失"));
				continue;
			}
			if (!existsSync(b.outputFile)) {
				brokenBatches.add(b.id);
				findings.push(finding(b.pageList[0] ?? null, "high", `批次 ${b.id} output 文件缺失`, b.outputFile));
				continue;
			}
			const buf = readFileSync(b.outputFile);
			const text = decodeUtf8Strict(buf);
			if (text === null) {
				// 非法 UTF-8:致命(无法确定性解析,继续装配只会产出损坏文档)
				findings.push(finding(null, "blocker", `批次 ${b.id} 文件非合法 UTF-8`, b.outputFile));
				return { ok: false, code: ERROR_CODES.E_ASSEMBLE, error: `批次 ${b.id} output 非合法 UTF-8:${b.outputFile}`, findings, planPath };
			}
			if (!text.trim()) {
				brokenBatches.add(b.id);
				findings.push(finding(b.pageList[0] ?? null, "high", `批次 ${b.id} output 为空文件`, b.outputFile));
				continue;
			}
			const counts = countAnchors(text);
			for (const [no, info] of counts) {
				const owner = ownerOf.get(no);
				if (owner !== b.id) {
					findings.push(finding(no, "medium", "越批锚点", `第 ${no} 页锚点出现在批次 ${b.id}(归属批次:${owner ?? "无(超出 totalPages)"}):${basename(b.outputFile)}`));
				}
				if (info.count > 1) {
					findings.push(finding(no, "high", "重复锚点", `第 ${no} 页锚点出现 ${info.count} 次(${basename(b.outputFile)}),装配取首次出现`));
				}
				if (!pageContents.has(no)) pageContents.set(no, info.block);
			}
		}

		// ③ 覆盖率与缺页(批次文件本身缺失/为空的页由批次级 finding 覆盖,不逐页刷屏)
		let found = 0;
		for (let p = 1; p <= totalPages; p++) {
			if (pageContents.has(p)) {
				found++;
				continue;
			}
			const owner = ownerOf.get(p);
			if (owner && brokenBatches.has(owner)) continue; // 已有批次级 finding
			const ownerNote = owner ? `(应属批次 ${owner})` : "(plan 未声明归属批次)";
			findings.push(finding(p, "high", "缺页", `第 ${p} 页锚点未出现在任何批次 output${ownerNote}`));
		}
		const coverage = { found, total: totalPages };

		// ④ 内容质量:极短页 + 乱码特征
		for (const [no, block] of pageContents) {
			const visible = visibleLength(block);
			if (visible < 10) {
				findings.push(finding(no, "medium", "极短页", `第 ${no} 页可见内容仅 ${visible} 字符(剥离注释后)`));
			}
			const mj = detectMojibake(block);
			if (mj.suspect) {
				const summary = mj.hits.map((h) => `${h.name}×${h.count}(样例: ${h.sample})`).join("; ");
				findings.push(finding(no, "medium", "疑似乱码", `第 ${no} 页 ${summary}`));
			}
		}
		findings.sort((a, b) => (a.page ?? -1) - (b.page ?? -1) || severityRank(b.severity) - severityRank(a.severity));

		// 合并:按 PAGE 序;缺页页写占位锚点块(与并行 OCR 失败页占位同风格)
		const parts = [];
		for (let p = 1; p <= totalPages; p++) {
			const a = String(p).padStart(2, "0");
			parts.push(pageContents.get(p) ?? `<!--PAGE:${a}-->\n\n<!-- 第${p}页缺失:见装配 findings -->\n\n<!--/PAGE:${a}-->`);
		}
		const head = title ? `# ${base}\n\n` : "";
		const tail = meta
			? `\n\n<!-- 源文件: ${base}.pdf | 链路: vision(${batches.length}批)+assemble | dsh-md-convert | ${new Date().toISOString()} -->\n`
			: "";
		const finalMd = `${head}${parts.join("\n\n")}\n${tail}`;

		const finalOutput = plan?.assemble?.finalOutput
			?? join(dirname(dirname(planPath)), `${base}.md`); // 兜底:<outDir>/<名>.md
		try {
			mkdirSync(dirname(finalOutput), { recursive: true });
			writeFileSync(finalOutput, finalMd, "utf8");
		} catch (e) {
			return { ok: false, code: ERROR_CODES.E_OUTPUT, error: `最终 md 写入失败:${e?.message ?? e}`, findings, planPath };
		}

		// 复查任务书:可疑页(高/中级 finding)→ 重写受影响批次
		let reviewInfo = null;
		if (review) {
			const suspicious = [...new Set(findings.filter((f) => (f.severity === "high" || f.severity === "medium") && typeof f.page === "number").map((f) => f.page))].sort((a, b) => a - b);
			if (suspicious.length > 0) {
				reviewInfo = await writeReviewBrief(plan, planPath, batches, suspicious, findings);
			}
		}

		return { ok: true, output: finalOutput, coverage, findings, review: reviewInfo, planPath };
	} catch (e) {
		return { ok: false, code: ERROR_CODES.E_UNKNOWN, error: e?.message ?? String(e), findings, planPath: planPathArg ?? "" };
	}
}

/* ------------------------------------------------------------------ 复查任务书 */

/**
 * 生成复查任务书 <名>-review.md 并更新 plan.json:
 *   - 受影响批次 outputFile → outputs/review-<batchId>.md(整批全部页重写,保持装配完整)
 *   - 批次 status → "review";plan.review 记录复查元数据
 */
async function writeReviewBrief(plan, planPath, batches, suspiciousPages, findings) {
	const workDir = dirname(planPath);
	const outputsDir = join(workDir, "outputs");
	const base = plan.source.base;
	const pagesDir = plan.render?.pagesDir ?? join(workDir, "pages");
	const briefPath = join(workDir, `${base}-review.md`);
	const pageToFinding = new Map();
	for (const f of findings) {
		if (typeof f.page === "number" && (f.severity === "high" || f.severity === "medium") && !pageToFinding.has(f.page)) {
			pageToFinding.set(f.page, f);
		}
	}
	const affected = batches.filter((b) => b.pageList.some((p) => suspiciousPages.includes(p)));
	const updatedBatchIds = [];
	const section = [];
	section.push(`# vision 转写复查任务书 — ${base}`);
	section.push("");
	section.push(`> 生成时间: ${new Date().toISOString()}`);
	section.push(`> 装配校验发现 ${suspiciousPages.length} 个可疑页:第 ${suspiciousPages.join("、")} 页。`);
	section.push(`> 请对照**原始页面图像**逐字校正,校正后**整批重写**(该批全部页都要出现在输出中,缺页会再次被装配校验拦截)。`);
	section.push("");
	for (const b of affected) {
		const reviewOutput = join(outputsDir, `review-${b.id}.md`);
		const focus = b.pageList.filter((p) => suspiciousPages.includes(p));
		section.push(`## 批次 ${b.id}(页 ${b.pageList[0]}-${b.pageList.at(-1)},共 ${b.pageList.length} 页)`);
		section.push("");
		section.push(`- 批次页面图像(绝对路径):`);
		for (const p of b.pageList) {
			section.push(`  - 第 ${p} 页: ${join(pagesDir, `p-${String(p).padStart(2, "0")}.png`)}`);
		}
		section.push(`- 重点校对页: ${focus.join("、")}`);
		for (const p of focus) {
			const f = pageToFinding.get(p);
			if (f) section.push(`  - 第 ${p} 页问题: ${f.problem} — ${f.evidence}`);
		}
		section.push(`- 校正提示词: 对照页面图像逐字校对——保留原有正确内容,仅修正识别错误;`);
		section.push(`  无法辨认处用 <!-- 第N页…无法辨认 --> 占位,禁止臆造;保持 <!--PAGE:NN--> … <!--/PAGE:NN--> 锚点格式;`);
		section.push(`  只输出 Markdown 正文,不用代码围栏包裹全文。`);
		section.push(`- 输出文件(整批重写,含本批全部页): **${reviewOutput}**`);
		section.push("");
		// 归一化副本与原始 plan.batches 都要更新(写回 plan.json 的是原始对象)
		b.outputFile = reviewOutput;
		b.status = "review";
		const orig = plan.batches.find((x) => x && x.id === b.id);
		if (orig) {
			orig.outputFile = reviewOutput;
			orig.status = "review";
		}
		updatedBatchIds.push(b.id);
	}
	section.push("---");
	section.push("");
	section.push(`复查完成后重新执行装配: \`md_convert_assemble({ planPath: "${planPath}" })\`,`);
	section.push(`装配工具会读取更新后的 plan.json(各批 output 已指向复查输出)并再次做完整性校验。`);
	const brief = section.join("\n") + "\n";
	writeFileSync(briefPath, brief, "utf8");

	// plan.json 同步:outputFile/status + review 元数据
	plan.review = { briefPath, pages: suspiciousPages, batches: updatedBatchIds, updatedAt: new Date().toISOString() };
	writeFileSync(planPath, JSON.stringify(plan, null, "\t"), "utf8");

	return { briefPath, pages: suspiciousPages, batches: updatedBatchIds };
}

/* ------------------------------------------------------------------ 小工具 */

function finding(page, severity, problem, evidence) {
	return { page, severity, problem, evidence };
}

function severityRank(s) {
	return { blocker: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}

function range(from, to) {
	const out = [];
	for (let p = Math.max(1, from); p <= to; p++) out.push(p);
	return out;
}
