/**
 * 0.7.15 真实 97 页产物验收(对比 0.7.11 那次跑批)。
 * 注意:scripts/verify-scan97-v711.mjs 的路径是写死的,直接跑它验的是**旧产物**——
 *    那种"看起来通过"不算通过。这里显式指定两份产物。
 */
import { readFileSync, existsSync } from "node:fs";
import { wrapStats, tableStats } from "./golden-baseline.mjs";
import { cjkSpaceStats } from "../lib/core/cjk.js";

const NEW = "D:/WorkSpace/Planing-Workdeck/dsh-md-convert-改进研究/baseline/e2e-scan97-v715/采购文件.md";
const PREV = "D:/WorkSpace/Planing-Workdeck/dsh-md-convert-改进研究/baseline/e2e-scan97-v711/采购文件.md";

const M = (s) => ({
	chars: s.length,
	anchors: (s.match(/<!--PAGE:\d+-->/g) ?? []).length,
	closes: (s.match(/<!--\/PAGE:\d+-->/g) ?? []).length,
	seps: (s.match(/^\|\s*:?-{2,}/gm) ?? []).length,
	rows: (s.match(/^\|.*\|$/gm) ?? []).length,
	nonEmpty: s.split("\n").filter((l) => l.trim() !== "").length,
	cjk: cjkSpaceStats(s).per1k,
	wraps: wrapStats(s).wraps,
	badRows: tableStats(s).badRows,
	formulas: (s.match(/\$\$[^\n]*?\$\$/g) ?? []).filter((x) => !x.includes("未识别")).length,
	placeholder: (s.match(/\$\$\[公式未识别\]\$\$/g) ?? []).length,
	merged: (s.match(/本页内容为上页表格续接/g) ?? []).length,
});

const a = M(readFileSync(NEW, "utf8"));
const b = existsSync(PREV) ? M(readFileSync(PREV, "utf8")) : null;
const keys = ["chars", "anchors", "closes", "seps", "rows", "nonEmpty", "cjk", "wraps", "badRows", "formulas", "placeholder", "merged"];
console.log("指标".padEnd(14) + String(a.chars).padStart(9) + (b ? String(b.chars).padStart(9) + "   (0.7.11)" : ""));
for (const k of keys) console.log(`  ${k.padEnd(12)}${String(a[k]).padStart(9)}${b ? String(b[k]).padStart(9) : ""}`);

const checks = [
	["锚点 97/97 且闭合相等", a.anchors === 97 && a.closes === 97],
	["CJK 注入为 0", a.cjk === 0],
	["段内硬换行为 0", a.wraps === 0],
	["表格行数不少于 0.7.11", b ? a.rows >= b.rows : true],
	["表头分隔行不少于 0.7.11", b ? a.seps >= b.seps : true],
	["无公式占位(公式已真正识别)", a.placeholder === 0],
	["公式数不少于 0.7.11", b ? a.formulas >= b.formulas : true],
	["表格坏行不增加", b ? a.badRows <= b.badRows : true],
];
console.log("\n=== 判据 ===");
let ok = true;
for (const [n, p] of checks) {
	console.log(`  ${p ? "OK  " : "!!  "}${n}`);
	ok = ok && p;
}
console.log(`\n${ok ? "全部通过" : "存在未通过项"}`);
process.exit(ok ? 0 : 1);