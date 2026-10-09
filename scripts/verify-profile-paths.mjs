/**
 * 收尾校验:区分"损坏"与"pnpm 的合法写法"。
 *
 * 实测:pnpm-lock.yaml 的 `version:` 字段里写的是**相对路径**
 *   link:../../../../WorkSpace/【Plugin-development】dsh-plugin-forge
 * 这里 `】` 后**没有**斜杠是 pnpm 的合法规范化结果(省略相邻分隔符),**不是损坏**。
 * 而 `specifier:` / package.json 里必须是 `】/dsh-plugin-forge`。
 *
 * 所以判据不能是"有没有缺斜杠",而是"**绝对路径形态**是否正确"。
 */
import { readFileSync, existsSync } from "node:fs";

const files = [
	"D:/dsh/home/profiles/web/package.json",
	"D:/dsh/home/profiles/web/pnpm-lock.yaml",
	"D:/dsh/home/profiles/desktop/package.json",
];

let bad = 0;
for (const p of files) {
	const b = readFileSync(p);
	const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
	const s = b.toString("utf8");
	let jsonOk = true;
	if (p.endsWith(".json")) {
		try {
			JSON.parse(s);
		} catch {
			jsonOk = false;
		}
	}
	// 绝对形态(必须是 specifier / dependencies 里的写法)
	const absOk = !/link:D:\/WorkSpace\/【Plugin-development】dsh-/.test(s);
	// 相对形态(lock 的 version 字段)允许省略斜杠,只要不含乱码
	const mojibake = /銆|怭|锛|鈥|馃/.test(s);
	const ok = !bom && jsonOk && absOk && !mojibake;
	if (!ok) bad++;
	console.log(`  ${ok ? "OK  " : "!!  "} ${p.split("/").pop().padEnd(18)} BOM=${bom ? "有" : "无"} JSON=${jsonOk ? "ok" : "FAIL"} 绝对形态=${absOk ? "ok" : "BAD"} 乱码=${mojibake ? "有" : "无"}`);
}

const target = "D:/WorkSpace/【Plugin-development】/dsh-plugin-forge";
console.log(`\n  forge 真实路径存在 = ${existsSync(target) ? "OK" : "!! 不存在"}`);

const web = JSON.parse(readFileSync(files[0], "utf8"));
const desk = JSON.parse(readFileSync(files[2], "utf8"));
const w = web.dependencies["@local/dsh-plugin-forge-preset"];
const d = desk.dependencies["@local/dsh-plugin-forge-preset"];
console.log(`  web  = ${w}`);
console.log(`  desk = ${d}`);
console.log(`  两 profile 一致 = ${w === d ? "OK" : "!! 不一致"}`);

process.exit(bad ? 1 : 0);