/**
 * v0.7.6 验收:在真实 97 页扫描件产物上离线重放段内硬换行合并。
 * 只读产物 + 纯函数,不启动 OCR。
 */
import { readFileSync } from "node:fs";
import { joinWrappedCjkLines, collapseCjkSpaces, cjkSpaceStats } from "../lib/core/cjk.js";

const SRC = "D:/WorkSpace/Planing-Workdeck/dsh-md-convert-改进研究/baseline/e2e-scan97-v74/采购文件.md";
const raw = readFileSync(SRC, "utf8");

const anchors = (s) => (s.match(/<!--PAGE:/g) ?? []).length;
const seps = (s) => (s.match(/^\|\s*:?-{2,}/gm) ?? []).length;
const rows = (s) => (s.match(/^\|.*\|$/gm) ?? []).length;
const nonEmpty = (s) => s.split("\n").filter((l) => l.trim() !== "").length;

const cjkEnd = /[一-鿿]$/;
const cjkStart = /^[一-鿿]/;
const term = /[。！？；：、，,．.!?;:]$/;
function countJoinable(s) {
	let n = 0;
	const lines = s.split("\n");
	for (let i = 0; i < lines.length - 1; i++) {
		const a = lines[i].trimEnd();
		const b = lines[i + 1].trimStart();
		if (cjkEnd.test(a) && cjkStart.test(b) && !term.test(a)) n++;
	}
	return n;
}

const before = {
	chars: raw.length,
	anchors: anchors(raw),
	seps: seps(raw),
	rows: rows(raw),
	nonEmpty: nonEmpty(raw),
	joinable: countJoinable(raw),
	injected: cjkSpaceStats(raw).injected,
};

// 逐页处理(与 jobs.js 的页处理器一致:页内合并,不跨锚点)
const pages = raw.split(/(?=<!--PAGE:\d+-->)/);
let joined = 0;
const out = pages
	.map((p) => {
		const j = joinWrappedCjkLines(p);
		joined += j.joined;
		return collapseCjkSpaces(j.md).md;
	})
	.join("");
const after = {
	chars: out.length,
	anchors: anchors(out),
	seps: seps(out),
	rows: rows(out),
	nonEmpty: nonEmpty(out),
	joinable: countJoinable(out),
	injected: cjkSpaceStats(out).injected,
};

const row = (k, b, a, expect) =>
	console.log(
		`  ${k.padEnd(12)} ${String(b).padStart(7)} -> ${String(a).padStart(7)}   ${expect}`,
	);

console.log("=== v0.7.6 段内硬换行合并:真实 97 页扫描件 ===");
row("字符数", before.chars, after.chars, `${(100 * (after.chars - before.chars) / before.chars).toFixed(2)}% (掉的是换行/缩进)`);

// 内容守恒才是硬判据:去掉所有空白后必须**逐字符相同**,否则就是丢字。
// (v0.7.6 第一版判据写成"字符数 |Δ|<0.5%",实测 -1.56% —— 那是**判据写错了**:
//  删掉 415 处换行必然让字符数下降。已改为内容守恒判据。)
const stripWs = (s) => s.replace(/\s+/g, "");
const contentIntact = stripWs(raw) === stripWs(out);
row("表格行数", before.rows, after.rows, before.rows === after.rows ? "OK 未变" : "!! 变了");
row("非空行", before.nonEmpty, after.nonEmpty, `${(100 * (after.nonEmpty - before.nonEmpty) / before.nonEmpty).toFixed(1)}% (期望约 -24%)`);
row("可合并处", before.joinable, after.joinable, after.joinable === 0 ? "OK 归零" : `!! 剩 ${after.joinable}`);
row("CJK注入", before.injected, after.injected, after.injected === 0 ? "OK 归零" : "!! 未归零");
console.log(`  内容守恒     ${contentIntact ? "OK 去空白后逐字符相同(零丢字)" : "!! 去空白后不一致 —— 丢内容了"}`);
console.log(`  合并处数     ${joined}`);

console.log("\n=== 判据 ===");
const pass =
	contentIntact &&
	after.anchors === before.anchors &&
	after.seps === before.seps &&
	after.rows === before.rows &&
	after.joinable === 0 &&
	after.injected === 0;
console.log(pass ? "全部通过" : "未通过");
process.exit(pass ? 0 : 1);