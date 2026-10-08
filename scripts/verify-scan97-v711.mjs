/**
 * 0.7.11 全新整册跑批的验收脚本(与 0.7.4 基线逐项对比)。
 * 只读两份产物 + 纯函数,不启动 OCR。
 */
import { readFileSync, existsSync } from "node:fs";
import { wrapStats, tableStats } from "./golden-baseline.mjs";
import { cjkSpaceStats } from "../lib/core/cjk.js";

const NEW = "D:/WorkSpace/Planing-Workdeck/dsh-md-convert-改进研究/baseline/e2e-scan97-v711/采购文件.md";
const OLD = "D:/WorkSpace/Planing-Workdeck/dsh-md-convert-改进研究/baseline/e2e-scan97-v74/采购文件.md";

if (!existsSync(NEW)) {
	console.error(`!! 新产物不存在: ${NEW}`);
	process.exit(2);
}
const nw = readFileSync(NEW, "utf8");
const old = existsSync(OLD) ? readFileSync(OLD, "utf8") : "";

const M = (s) => ({
	chars: s.length,
	anchors: (s.match(/<!--PAGE:\d+-->/g) ?? []).length,
	closeTags: (s.match(/<!--\/PAGE:\d+-->/g) ?? []).length,
	tableSeps: (s.match(/^\|\s*:?-{2,}/gm) ?? []).length,
	tableRows: (s.match(/^\|.*\|$/gm) ?? []).length,
	nonEmpty: s.split("\n").filter((l) => l.trim() !== "").length,
	cjkPer1k: cjkSpaceStats(s).per1k,
	wraps: wrapStats(s).wraps,
	badRows: tableStats(s).badRows,
	mergedNote: (s.match(/本页内容为上页表格续接/g) ?? []).length,
});

const a = M(nw);
const b = old ? M(old) : null;
const row = (k, va, vb) =>
	console.log(`  ${k.padEnd(16)} ${String(va).padStart(7)}${b ? `   (0.7.4: ${String(vb).padStart(6)})` : ""}`);

console.log("=== 0.7.11 全新整册 vs 0.7.4 基线 ===");
row("字符", a.chars, b?.chars);
row("PAGE锚点", a.anchors, b?.anchors);
row("锚点闭合标签", a.closeTags, b?.closeTags);
row("表头分隔行", a.tableSeps, b?.tableSeps);
row("表格行数", a.tableRows, b?.tableRows);
row("非空行", a.nonEmpty, b?.nonEmpty);
row("CJK注入‰", a.cjkPer1k, b?.cjkPer1k);
row("段内硬换行", a.wraps, b?.wraps);
row("表格坏行", a.badRows, b?.badRows);
row("跨页合并标注", a.mergedNote, b?.mergedNote);

console.log("\n=== 判据 ===");
// 字符数判据的正确形式:**内容守恒**,不是"字符数不得下降"。
// 本次修复删掉了 415 处换行 + 528 个注入空格 —— 这些都是空白,字符数**必然**下降。
// 第一版把判据写成"字符数 ≥ 基线 99%",实测 -1.1% 判失败 —— 是判据写错了(与 0.7.6 同类错误)。
// 去掉全部空白后逐字符比较才是"有没有丢字"的真判据。
const stripWs = (s) => s.replace(/\s+/g, "");
// 0.7.5 有意给"因跨页表合并而变空的页块"插入一行说明注释,它是**非空白**内容,
// 因此去空白后必然比 0.7.4 多出 N × len(注释) 个字符(实测 11 × 23 = 253,精确对上)。
// 把这类**有意新增的注释**先剥掉再比,才是"有没有丢字"的真判据。
const ANNOTATION = /<!--\s*本页内容为上页表格续接\(已合并\)\s*-->/g;
// 产物尾部有"源文件 | 链路 | 工具 | 运行时间戳"的溯源注释 —— 时间戳**每次跑都不同**,
// 比对时必须剔除,否则永远判不等(实测:整册 46534/46549 字符完全相同,
// 唯一差异就是这个时间戳)。
const PROVENANCE = /<!--\s*源文件:[\s\S]*?-->/g;
const stripWsNoAnnot = (s) => stripWs(s.replace(ANNOTATION, "").replace(PROVENANCE, ""));
const annotCount = (nw.match(ANNOTATION) ?? []).length;
const contentIntact = old ? stripWsNoAnnot(nw) === stripWsNoAnnot(old) : true;
if (old) {
	console.log(`  去空白字符数: ${stripWs(old).length} (0.7.4) -> ${stripWs(nw).length} (0.7.11)`);
	console.log(`  有意新增的合并说明注释 ${annotCount} 条,合计 ${stripWs(nw).length - stripWs(old).length} 字符`);
	console.log(`  再剔除溯源注释(含运行时间戳)后: ${stripWsNoAnnot(old).length} -> ${stripWsNoAnnot(nw).length} (应相等)`);
}

const checks = [
	["锚点 97/97 且闭合标签相等", a.anchors === 97 && a.closeTags === a.anchors],
	["CJK 注入为 0", a.cjkPer1k === 0],
	["段内硬换行为 0(0.7.6 修复在真实链路上生效)", a.wraps === 0],
	["表格行数不少于 0.7.4", b ? a.tableRows >= b.tableRows : true],
	["表头分隔行不少于 0.7.4", b ? a.tableSeps >= b.tableSeps : true],
	["**内容守恒**:去空白后逐字符相同(零丢字)", contentIntact],
	["跨页合并空页块已标注(0.7.5)", a.mergedNote > 0],
];
let ok = true;
for (const [name, pass] of checks) {
	console.log(`  ${pass ? "OK  " : "FAIL"} ${name}`);
	ok = ok && pass;
}
console.log(`\n${ok ? "全部通过" : "存在未通过项"}`);
process.exit(ok ? 0 : 1);