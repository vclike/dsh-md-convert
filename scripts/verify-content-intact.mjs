/** 核查 -1.55% 字符差是否**只有空白**,没有丢内容。 */
import { readFileSync } from "node:fs";
import { joinWrappedCjkLines, collapseCjkSpaces } from "../lib/core/cjk.js";

const SRC = "D:/WorkSpace/Planing-Workdeck/dsh-md-convert-改进研究/baseline/e2e-scan97-v74/采购文件.md";
const raw = readFileSync(SRC, "utf8");
const stripWs = (s) => s.replace(/\s+/g, "");
const pages = raw.split(/(?=<!--PAGE:\d+-->)/);
const out = pages.map((p) => collapseCjkSpaces(joinWrappedCjkLines(p).md).md).join("");

const a = stripWs(raw);
const b = stripWs(out);
console.log("去空白后字符数:", a.length, "->", b.length, " 差:", b.length - a.length);
if (a === b) console.log("内容完全一致 —— 掉的 1.55% 全部是空白/换行,零内容丢失");
else {
	// 找出第一个差异
	let i = 0;
	while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
	console.log("首个差异位置", i);
	console.log("原:", JSON.stringify(a.slice(Math.max(0, i - 60), i + 60)));
	console.log("新:", JSON.stringify(b.slice(Math.max(0, i - 60), i + 60)));
}

// 剩余 8 处可合并:它们的上一行是什么结构行?
const cjkEnd = /[一-鿿]$/;
const cjkStart = /^[一-鿿]/;
const term = /[。！？；：、，,．.!?;:]$/;
const STRUCT = /^\s*(\||#{1,6}\s|[-*+]\s|\d+[.)]\s|[-=*_]{3,}\s*$|>|<!--|`|~~~)/;
console.log("\n=== 剩余可合并处的上下文(看是否被结构行挡住) ===");
const lines = out.split("\n");
let shown = 0;
for (let i = 0; i < lines.length - 1 && shown < 8; i++) {
	const a2 = lines[i].trimEnd();
	const b2 = lines[i + 1].trimStart();
	if (cjkEnd.test(a2) && cjkStart.test(b2) && !term.test(a2)) {
		console.log(`  [${i}] prev=${STRUCT.test(lines[i]) ? "结构行" : "正文"} ${JSON.stringify(a2.slice(-28))}`);
		console.log(`        next=${STRUCT.test(lines[i + 1]) ? "结构行" : "正文"} ${JSON.stringify(b2.slice(0, 28))}`);
		shown++;
	}
}