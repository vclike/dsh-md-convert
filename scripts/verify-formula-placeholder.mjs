/**
 * 证明:chars 下降是因为**删掉了内部报错文本**,不是丢了文档内容。
 * 方法:把新产物里的中性占位替换回旧版错误文本,再去空白比较 —— 若两者一致,
 *      说明唯一变化就是那 16 处错误文本。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (dir) => {
	const f = readdirSync(dir).find((x) => x.endsWith(".md"));
	return readFileSync(join(dir, f), "utf8");
};
const oldMd = read("test/golden/.out/zh12"); // 修复前
const newMd = read("test/golden/.out/zh-fix-full"); // 修复后(需重跑全量)

// 旧版错误文本的实际形态(从旧产物里抓)
const errTexts = [...oldMd.matchAll(/\$\$\s*\[公式识别失败:[^\n]*?\]\s*\$\$/g)].map((m) => m[0]);
console.log(`旧产物中错误文本处数: ${errTexts.length}`);
console.log(`示例: ${JSON.stringify(errTexts[0] ?? "")}`);

const stripWs = (s) => s.replace(/\s+/g, "");
// ⚠️ 必须剔除尾部溯源注释:里面有**运行时间戳**,每次跑都不同 ——
//    这是本轮第三次踩到(0.7.6 验收、97 页验收、这里)。凡"产物比对"都该先剔它。
const PROVENANCE = /<!--\s*源文件:[\s\S]*?-->/g;
const stripWsNoProv = (s) => stripWs(s.replace(PROVENANCE, ""));
// 新产物:把所有中性占位替换成对应的旧错误文本(按出现顺序)
let i = 0;
let restored = newMd.replace(/\$\$\[公式未识别\]\$\$/g, () => errTexts[i++] ?? "$$[公式未识别]$$");
console.log(`替换回错误文本: ${i} 处`);

const a = stripWsNoProv(restored);
const b = stripWsNoProv(oldMd);
console.log(`\n去空白长度: 还原后=${a.length}  旧产物=${b.length}  差=${b.length - a.length}`);
if (a === b) {
	console.log("=> **完全一致**:唯一变化就是那 16 处内部错误文本 -> 中性占位。零内容丢失 ✓");
	process.exit(0);
} else {
	let k = 0;
	while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
	console.log(`=> 不一致,首个差异在第 ${k} 字符`);
	console.log("  还原后:", JSON.stringify(a.slice(Math.max(0, k - 60), k + 60)));
	console.log("  旧产物:", JSON.stringify(b.slice(Math.max(0, k - 60), k + 60)));
	process.exit(1);
}