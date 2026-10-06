/**
 * 基准库 v1(golden set) — 真实样本的结构增强断言(P1-C)
 *
 * 样本:环境变量 MDC_GOLDEN_PDF 指向文字层 PDF(缺省探测 Downloads 的火山方舟 PDF);
 * 样本缺失/python/pypdfium2 不可用 → SKIP(不阻塞 CI)。
 * 断言:协议字段完整性、页眉脚剥离、标题重建、链接保留、表格重建、开关生效、确定性。
 * 该文件是"每次动引擎/阈值/提示词后防退化"的守护资产——样本库随真实场景持续喂养。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXTRACT = join(here, "..", "lib", "py", "extract_text.py");

function detectSample() {
	if (process.env.MDC_GOLDEN_PDF) return process.env.MDC_GOLDEN_PDF;
	const candidates = [
		"D:\\Downloads\\火山方舟_Agent 进化_1789355515.pdf",
		join(here, "golden", "samples", "agent-evolve.pdf"),
	];
	return candidates.find((p) => existsSync(p)) ?? null;
}

function findPython() {
	for (const py of ["python", "C:\\Users\\jason\\AppData\\Local\\Programs\\Python\\Python311\\python.exe"]) {
		try {
			execFileSync(py, ["-c", "import pypdfium2"], { stdio: "ignore" });
			return py;
		} catch {
			/* try next */
		}
	}
	return null;
}

const sample = detectSample();
const py = findPython();

test("golden: 样本可用性门控(缺样本/缺依赖 → 显式跳过)", () => {
	if (!sample || !py) {
		console.log(`SKIP: sample=${sample ?? "无"} python=${py ?? "无"}`);
	}
	assert.ok(true);
});

if (sample && py) {
	const run = (args = []) => JSON.parse(execFileSync(py, [EXTRACT, sample, ...args], { timeout: 120_000, encoding: "utf8" }));

	test("golden: 协议完整 + 页数 + img_ratio 字段", () => {
		const d = run();
		assert.equal(d.total > 0, true);
		assert.ok(Array.isArray(d.pages) && d.pages.length === d.total);
		assert.ok(d.pages.every((p) => Number.isInteger(p.no) && typeof p.text === "string" && "img_ratio" in p));
	});

	test("golden: 页眉脚剥离 + 标题重建 + 链接保留", () => {
		const d = run();
		const all = d.pages.map((p) => p.text).join("\n");
		assert.ok(!all.includes("版权所有©"), "版权页脚行应被剥离");
		assert.ok(/^## /m.test(all), "应存在 ## 标题(标题重建)");
		assert.ok(all.includes("ark-self-evolve"), "install.sh 链接 URL 应保留(内联或脚注)");
	});

	test("golden: 表格重建(P1-A 核心断言)", () => {
		const d = run();
		assert.ok(d.notes.tables_rebuilt >= 1, `tables_rebuilt=${d.notes.tables_rebuilt}`);
		const hit = d.pages.some((p) => p.text.includes("| 运行时 | Connector"));
		assert.ok(hit, "P4 运行时表应重建为 md 表格");
		const all = d.pages.map((p) => p.text).join("\n");
		assert.ok(all.includes("| TraeCode | trae | 项目级 AGENTS.md |"), "表格数据行内容应完整");
	});

	test("golden: --no-tables 开关生效", () => {
		const d = run(["--no-tables"]);
		assert.equal(d.notes.tables_rebuilt, 0);
		const all = d.pages.map((p) => p.text).join("\n");
		assert.ok(!all.includes("| 运行时 | Connector"), "关闭后不应有表格");
	});

	test("golden: 确定性(两次运行一致)", () => {
		const a = JSON.stringify(run());
		const b = JSON.stringify(run());
		assert.equal(a, b);
	});
}
