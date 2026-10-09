/**
 * 部署后校验:
 * ① 三方一致(dev == tgz 内容 == 安装副本)
 * ② **从安装副本**实测本版修复(不是从 dev —— 必须证明部署真的生效)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEV = "D:/WorkSpace/Planing-Workdeck/.tmp/dsh-md-convert-dev";
const PROFILES = ["desktop", "web"];

// ⚠️ tgz 路径**必须按 package.json 版本推导**,不能硬编码 ——
// 第一版写死 1.0.1,发 1.0.2 时它悄悄比对了**旧包**,把两侧一致报成"不一致"
// (dev/安装副本是新哈希,tgz 那列是旧哈希)。靠人记得改版本号 = 迟早出错。
const PKG = JSON.parse(readFileSync(`${DEV}/package.json`, "utf8"));
const TGZ = `${DEV}/dsh-md-convert-${PKG.version}.tgz`;
if (!existsSync(TGZ)) {
	console.error(`!! 找不到 ${TGZ} —— 请先 npm pack`);
	process.exit(2);
}

// ── ① 关键文件哈希三方比对 ──
const KEY = ["lib/core/crosspage.js", "lib/core/cjk.js", "lib/core/convert.js", "package.json"];
const h = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12) : "缺失");
console.log("=== 三方一致(dev / tgz / 安装副本) ===");
console.log("文件".padEnd(26) + "dev".padStart(14) + "tgz".padStart(14) + "desktop".padStart(14) + "web".padStart(14));
for (const f of KEY) {
	const dev = h(`${DEV}/${f}`);
	const desk = h(`D:/dsh/home/profiles/desktop/node_modules/dsh-md-convert/${f}`);
	const web = h(`D:/dsh/home/profiles/web/node_modules/dsh-md-convert/${f}`);
	// tgz 内文件用 tar 抽取比对
	let tgz = "?";
	try {
		const out = execFileSync("tar", ["-xzOf", TGZ, `package/${f}`], { maxBuffer: 1e8 });
		tgz = createHash("sha256").update(out).digest("hex").slice(0, 12);
	} catch { /* 保持 ? */ }
	const same = dev === tgz && dev === desk && dev === web;
	console.log(f.padEnd(26) + dev.padStart(14) + tgz.padStart(14) + desk.padStart(14) + web.padStart(14) + (same ? "  ✓" : "  !! 不一致"));
}

// ── ② 从**安装副本**实测 ──
console.log("\n=== 从安装副本实测(必须走安装路径,不能从 dev) ===");
const INST = "D:/dsh/home/profiles/desktop/node_modules/dsh-md-convert";
const instVer = JSON.parse(readFileSync(`${INST}/package.json`, "utf8")).version;
console.log("引擎来源: 安装副本 v" + instVer);

const { convertFile } = await import(pathToFileURL(`${INST}/lib/core/convert.js`).href);
const out = `${DEV}/test/golden/.out/deploy`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 用仓库内的样本(复制到临时位置,避免测试产物污染样本目录)
const SAMPLE = `${DEV}/test/golden/samples/pdf-crosspage-table.pdf`;
const r = await convertFile(SAMPLE, { outDir: out, engine: "auto" });
console.log("ok =", r.ok, "| chain =", r.chain);

const f = readdirSync(out).find((x) => x.endsWith(".md"));
const md = readFileSync(`${out}/${f}`, "utf8");

const br = (md.match(/<br\s*\/?>/gi) ?? []).length;
const seps = (md.match(/^\|\s*:?-{2,}/gm) ?? []).length;
const probes = ["行政处罚等企业异常", "期货，国内期权", "司法诉讼"];
console.log(`\n  ① <br> 数量: ${br}  (修复前 143,期望 < 10)`);
console.log(`  ② 表格分隔行: ${seps}  (期望 3 = 每页结构完整)`);
console.log(`  ③ 跨页告警: ${(r.warnings ?? []).filter((w) => String(w).includes("跨页")).join(" | ") || "(无)"}`);
console.log(`  ④ 换行归并告警: ${(r.warnings ?? []).filter((w) => String(w).includes("换行归并")).join(" | ") || "(无)"}`);
for (const p of probes) {
	const n = md.split(p).length - 1;
	console.log(`  ⑤ 检索 "${p}": ${n > 0 ? "✅ 命中 " + n : "❌ 0 命中"}`);
}
const ok = br < 10 && seps === 3 && probes.every((p) => md.split(p).length - 1 > 0);
console.log(`\n判定: ${ok ? "✅ 安装副本上本版修复全部生效" : "❌ 有项未达标"}`);