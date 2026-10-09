/** 从真实产物生成完整的 p1/p2 页夹具(不再手写任何表格行)。 */
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync("test/golden/.out/cs/_md.txt", "utf8");
const blocks = [...md.matchAll(/<!--PAGE:(\d+)-->([\s\S]*?)<!--\/PAGE:\1-->/g)];

const isSep = (l) => /^\|\s*:?-{2,}/.test(l.trim());
const isRow = (l) => {
	const t = l.trim();
	return t.startsWith("|") && t.endsWith("|") && t.length > 1;
};

/** 取某页表格块:表头/分隔行/全部数据行 */
function tableBlock(body) {
	const lines = body.split("\n");
	const sep = lines.findIndex(isSep);
	if (sep < 0) return null;
	let head = sep - 1;
	while (head >= 0 && lines[head].trim() === "") head--;
	const rows = [];
	for (let i = sep + 1; i < lines.length; i++) {
		if (isRow(lines[i])) rows.push(lines[i]);
		else if (lines[i].trim() === "") continue;
		else break;
	}
	return { head: lines[head], sep: lines[sep], rows };
}

const t1 = tableBlock(blocks[0][2]);
const t2 = tableBlock(blocks[1][2]);

const fixture = {
	head: t1.head,
	sep: t1.sep,
	p1rows: t1.rows,
	p2head: t2.head,
	p2sep: t2.sep,
	p2rows: t2.rows,
};

// 生成自检信息
const cellsOf = (l) => l.trim().slice(1, -1).split("|").map((s) => s.trim());
console.log("p1 表头 :", t1.head.slice(0, 50));
console.log("p1 行数 :", t1.rows.length, "| 末行列数 =", cellsOf(t1.rows.at(-1)).length,
	"| 末格空?", cellsOf(t1.rows.at(-1)).at(-1) === "");
console.log("p2 表头 :", t2.head.slice(0, 50));
console.log("p2 行数 :", t2.rows.length, "| 首行列数 =", cellsOf(t2.rows[0]).length,
	"| 首格空?", cellsOf(t2.rows[0])[0] === "");
console.log("p2 末行列数 =", cellsOf(t2.rows.at(-1)).length,
	"| 末格空?", cellsOf(t2.rows.at(-1)).at(-1) === "");

writeFileSync(
	"test/golden/crosspage-fixture.js",
	"// 由 scripts/gen-crosspage-fixture.mjs 从真实产物生成,勿手改\n" +
		"export const FIXTURE = " + JSON.stringify(fixture, null, "\t") + ";\n",
	"utf8",
);
console.log("\n已生成 test/golden/crosspage-fixture.js");