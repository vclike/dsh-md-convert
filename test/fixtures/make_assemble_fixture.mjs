#!/usr/bin/env node
/**
 * T4 冒烟 fixture 生成器:构造 T3 形态的 plan.json + 全部批次 output(默认 97 页/批 8)。
 *
 * 用法:
 *   node test/fixtures/make_assemble_fixture.mjs [outDir] [pages] [batchSize] [--remove-page N] [--base NAME]
 *
 * 效果:
 *   <outDir>/<NAME>.vision/plan.json          # T3 形态任务书
 *   <outDir>/<NAME>.vision/outputs/batch-*.md # 全部页合规的批次 output
 *   --remove-page N:从对应批次 output 中抽掉第 N 页锚块(演练缺页 findings)
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args.splice(i, 2)[1] : null;
};
const removePage = Number(flag("--remove-page") ?? 0);
const baseName = flag("--base") ?? "采购文件";
const outDir = resolve(args[0] ?? ".tmp/plan-test");
const pages = Number(args[1] ?? 97);
const batchSize = Number(args[2] ?? 8);

const pad = (n) => String(n).padStart(2, "0");
const workDir = join(outDir, `${baseName}.vision`);
const outputsDir = join(workDir, "outputs");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(outputsDir, { recursive: true });

const batches = [];
for (let from = 1; from <= pages; from += batchSize) {
	const to = Math.min(pages, from + batchSize - 1);
	const seq = batches.length + 1;
	const id = `batch-${pad(seq)}`;
	const pageList = [];
	for (let p = from; p <= to; p++) pageList.push(p);
	batches.push({
		id,
		pages: [from, to],
		pageList,
		imageFiles: pageList.map((p) => join(workDir, "pages", `p-${pad(p)}.png`)),
		promptFile: join(workDir, "prompts", `${id}.md`),
		outputFile: join(outputsDir, `${id}.md`),
		status: "pending",
	});
}

const plan = {
	planVersion: 1,
	kind: "md-convert-vision-brief",
	createdAt: new Date().toISOString(),
	source: { pdf: join(outDir, `${baseName}.pdf`), base: baseName, totalPages: pages },
	render: { scale: 2, pagesDir: join(workDir, "pages") },
	promptTemplate: { path: "builtin", overridden: false },
	batches,
	outputContract: {
		anchorFormat: "<!--PAGE:NN--> … <!--/PAGE:NN-->(NN 两位补零,>99 页自然扩展)",
		anchorRegex: "<!--PAGE:(\\d{2,})-->([\\s\\S]*?)<!--/PAGE:\\1-->",
		rules: ["每页一对锚点", "逐字保真", "只输出 Markdown 正文"],
	},
	assemble: { tool: "md_convert_assemble", planPath: join(workDir, "plan.json"), finalOutput: join(outDir, `${baseName}.md`) },
};

for (const b of batches) {
	const body = b.pageList
		.map((p) => {
			if (removePage === p) return null; // 演练缺页:该页锚块不写入
			return `<!--PAGE:${pad(p)}-->\n\n第${p}页转写内容。本行为确定性冒烟文本,包含足够多的可见字符,用于装配校验的覆盖率与极短页检查。章节「${Math.ceil(p / 8)}」测试样本 ${baseName}。\n\n<!--/PAGE:${pad(p)}-->`;
		})
		.filter(Boolean)
		.join("\n\n");
	writeFileSync(b.outputFile, body, "utf8");
}

const planPath = join(workDir, "plan.json");
writeFileSync(planPath, JSON.stringify(plan, null, "\t"), "utf8");
console.log(`fixture written: ${planPath}`);
console.log(`pages=${pages} batches=${batches.length} removePage=${removePage || "none"}`);
