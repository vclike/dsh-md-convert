/**
 * 修复 web profile 被 GBK 误读损坏的中文路径(【】 → 銆怭…銆?)
 *
 * 严格外科式操作:
 *   - 只替换出现该损坏序列的字节,其余内容**逐字节不变**
 *   - 读: utf8(自动剥离 BOM);写: utf8 **无 BOM**
 *   - 写后立即自检:BOM / JSON.parse / 乱码残留 / 目标路径存在
 * 用 node 而非 PowerShell —— PS 5.1 的 Set-Content -Encoding UTF8 就是本次事故的元凶。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";

const GOOD = "【Plugin-development】";
// 损坏形态:銆怭lugin-development銆? —— 首尾全角括号被按 GBK 读成乱码,且"【"后多出一个 U+FFFD
const BAD_RE = /銆怭lugin-development銆\?/g;

const targets = [
	"D:/dsh/home/profiles/web/package.json",
	"D:/dsh/home/profiles/web/pnpm-lock.yaml",
];

let changed = 0;
for (const p of targets) {
	if (!existsSync(p)) {
		console.log(`SKIP ${p}(不存在)`);
		continue;
	}
	const before = readFileSync(p);
	const text = before.toString("utf8");
	const hits = text.match(BAD_RE);
	if (!hits) {
		console.log(`OK   ${p}  (无损坏,未改动)`);
		continue;
	}
	const fixed = text.replace(BAD_RE, GOOD);
	writeFileSync(p, fixed, "utf8"); // node 的 utf8 不写 BOM
	changed++;
	console.log(`FIX  ${p}  修复 ${hits.length} 处`);

	// —— 写后自检 ——
	const after = readFileSync(p);
	const bom = after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf;
	const s = after.toString("utf8");
	const mojibakeLeft = /銆|怭|锛|鈥|馃/.test(s);
	let jsonOk = true;
	if (p.endsWith(".json")) {
		try {
			JSON.parse(s);
		} catch (e) {
			jsonOk = false;
			console.log(`     !! JSON.parse 失败: ${e.message.slice(0, 90)}`);
		}
	}
	const hasGood = s.includes(GOOD);
	console.log(
		`     自检: BOM=${bom ? "!!有" : "无"} JSON=${jsonOk ? "OK" : "!!失败"} 乱码残留=${mojibakeLeft ? "!!有" : "无"} 正常路径=${hasGood ? "OK" : "!!缺失"}`,
	);
}

console.log(`\n共修复 ${changed} 个文件`);
process.exit(changed > 0 ? 0 : 0);