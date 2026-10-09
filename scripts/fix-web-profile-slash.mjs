/**
 * 修正上一版修复引入的缺陷:路径少了 `/`。
 *
 * 原因:损坏序列 `銆怭lugin-development銆?` 把原文的 `【Plugin-development】/`
 * 整体吃成了乱码 —— 末尾的 `銆?` 对应 `】` + `/`。
 * 第一版按 `【Plugin-development】` 还原,结果丢了分隔斜杠,
 * 得到 `D:/WorkSpace/【Plugin-development】dsh-plugin-forge`(不存在的路径)。
 *
 * 这里按**完整依赖路径**精确还原,并校验目标目录真实存在。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const GOOD = "D:/WorkSpace/【Plugin-development】/dsh-plugin-forge";
const BROKEN = /D:\/WorkSpace\/【Plugin-development】dsh-plugin-forge/g;

const targets = [
	"D:/dsh/home/profiles/web/package.json",
	"D:/dsh/home/profiles/web/pnpm-lock.yaml",
];

let fixed = 0;
for (const p of targets) {
	const text = readFileSync(p, "utf8");
	const hits = text.match(BROKEN);
	if (!hits) {
		console.log(`OK   ${p}(无缺斜杠形态,未改动)`);
		continue;
	}
	const out = text.replace(BROKEN, GOOD);
	writeFileSync(p, out, "utf8"); // 无 BOM
	fixed += hits.length;
	console.log(`FIX  ${p}  补回 ${hits.length} 处的 "/"`);
}

console.log("\n=== 写后自检 ===");
let bad = 0;
for (const p of targets) {
	const b = readFileSync(p);
	const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
	const s = b.toString("utf8");
	let jsonOk = true;
	if (p.endsWith(".json")) {
		try {
			JSON.parse(s);
		} catch (e) {
			jsonOk = false;
		}
	}
	const missSlash = /【Plugin-development】dsh-/.test(s);
	const mojibake = /銆|怭|锛|鈥|馃/.test(s);
	console.log(`  ${p.split("/").pop().padEnd(18)} BOM=${bom ? "!!有" : "无"} JSON=${jsonOk ? "OK" : "!!失败"} 缺斜杠=${missSlash ? "!!有" : "无"} 乱码=${mojibake ? "!!有" : "无"}`);
	if (bom || !jsonOk || missSlash || mojibake) bad++;
}

const pkg = JSON.parse(readFileSync("D:/dsh/home/profiles/web/package.json", "utf8"));
const link = pkg.dependencies["@local/dsh-plugin-forge-preset"];
const asPath = String(link).replace(/^link:/, "");
console.log(`\n  web forge link = ${link}`);
console.log(`  该路径真实存在 = ${existsSync(asPath) ? "OK" : "!! 不存在"}`);

const desk = JSON.parse(readFileSync("D:/dsh/home/profiles/desktop/package.json", "utf8"));
console.log(`  与 desktop 一致 = ${link === desk.dependencies["@local/dsh-plugin-forge-preset"] ? "OK" : "!! 不一致"}`);

if (bad || !existsSync(asPath)) process.exit(1);
console.log(`\n共补回 ${fixed} 处,全部校验通过`);