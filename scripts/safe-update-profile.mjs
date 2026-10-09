/**
 * dsh-md-convert 安全部署脚本(**唯一允许的 profile 更新方式**)
 *
 * ============================ 事故背景(务必读) ============================
 * 2026-10-09 凌晨,我用 PowerShell 5.1 的
 *     $pj = Get-Content ...\package.json -Raw
 *     ... ; Set-Content ... -Encoding UTF8
 * 改写 desktop profile 的 package.json **至少 3 次**,造成两种损害:
 *
 *   1) **写入 BOM** —— PS 5.1 的 `-Encoding UTF8` 等于 "UTF-8 with BOM",
 *      文件头塞进 EF BB BF。宿主启动时 `readProfileManifest → JSON.parse`
 *      严格解析,**直接崩溃退出**,DSH 桌面版起不来:
 *        DesktopHostFatalError: Unexpected token '', "{ "name"... is not valid JSON
 *
 *   2) **GBK 乱码** —— `Get-Content` 不带 -Encoding 时按 ANSI(GBK) 读 UTF-8 文件,
 *      文件里的中文路径 `【Plugin-development】` 被读成 `銆怭lugin-development銆?`
 *      再原样写回 → `@local/dsh-plugin-forge-preset` 的 link 路径损坏,
 *      forge 插件断链(连续发生 3 次)。
 *
 * ⚠️ 这条教训 OpenViking 里**早就存着**,我仍然踩了 —— 知识存了没执行,比不知道更糟。
 *
 * ============================ 本脚本的约束 ============================
 *   - 全程 node 读写:读 utf8(自动剥离 BOM),写 utf8(**node 默认无 BOM**)
 *   - 只**替换版本字符串**,不重新序列化整个 JSON —— 避免键序/格式被动过
 *   - 写前备份,写后**强制自检**:BOM / JSON.parse / 乱码 / 中文路径 / 目标存在
 *   - 任一自检不过 → 立即回滚并 exit 1
 * =========================================================================
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DESKTOP = "D:/dsh/home/profiles/desktop/package.json";
const NEW_TGZ = process.argv[2]; // 例:dsh-md-convert-0.7.15.tgz

if (!NEW_TGZ) {
	console.error("用法: node scripts/safe-update-profile.mjs <新 tgz 文件名>");
	process.exit(2);
}

// —— 写前体检:先确认现在就是好的,否则拒绝在坏状态上叠加 ——
function inspect(p) {
	const b = readFileSync(p);
	return {
		bom: b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf,
		text: b.toString("utf8"),
	};
}
const pre = inspect(DESKTOP);
if (pre.bom) {
	console.error("!! 拒绝执行:目标文件当前已带 BOM,宿主已处于损坏状态。请先修复再部署。");
	process.exit(1);
}
try {
	JSON.parse(pre.text);
} catch (e) {
	console.error(`!! 拒绝执行:目标 JSON 解析失败(${e.message.slice(0, 80)})。`);
	process.exit(1);
}

// —— 备份 ——
const backup = `${DESKTOP}.bak-before-md-convert`;
copyFileSync(DESKTOP, backup, );
console.log(`已备份 -> ${backup}`);

// —— 只替换版本字符串(不重新序列化)——
// 写法必须是字符串字面量替换,保证其余字节完全不变
const re = /(dsh-md-convert"\s*:\s*"file:)[^"]*(\/dsh-md-convert-[\d.]+\.tgz)/;
if (!re.test(pre.text)) {
	console.error("!! 未找到 dsh-md-convert 依赖行,拒绝盲改。");
	process.exit(1);
}
const oldFile = re.exec(pre.text)[2];
const out = pre.text.replace(re, `$1D:/WorkSpace/Planing-Workdeck/.tmp/dsh-md-convert-dev/${NEW_TGZ}`);
console.log(`${oldFile}\n  -> ${NEW_TGZ}`);

writeFileSync(DESKTOP, out, "utf8"); // node utf8 = 无 BOM
console.log(`已写入 ${NEW_TGZ}`);

// —— 写后强制自检 ——
const post = inspect(DESKTOP);
const problems = [];
if (post.bom) problems.push("文件带 BOM(致命)");
try {
	JSON.parse(post.text);
} catch (e) {
	problems.push(`JSON.parse 失败:${e.message.slice(0, 80)}`);
}
if (/銆|怭|锛|鈥|馃/.test(post.text)) problems.push("出现 GBK 乱码特征");
if (!post.text.includes("【Plugin-development】")) problems.push("中文路径括号丢失(forge 链接会断)");
const m = /dsh-md-convert"\s*:\s*"file:([^"]+)"/.exec(post.text);
if (!m) problems.push("找不到 dsh-md-convert 依赖行");
else {
	const target = m[1];
	console.log(`  依赖指向: ${target}`);
	if (!existsSync(target)) problems.push(`tgz 不存在:${target}`);
}

if (problems.length) {
	console.error("\n!! 自检失败,正在回滚:");
	for (const p of problems) console.error(`   - ${p}`);
	copyFileSync(backup, DESKTOP);
	console.error("已回滚到备份。");
	process.exit(1);
}

console.log("\n✅ 自检全部通过:");
console.log("   BOM=无 | JSON 可解析 | 无乱码 | 中文路径完好 | tgz 存在");
console.log(`   (备份保留在 ${backup},确认无误后可删)`);