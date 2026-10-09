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
 * ============================ v1.0.1 变更 ============================
 * 原版**只处理 desktop**。历史上因此出现过"desktop 更新了、web 落后 2 个版本、
 * 依赖还指向旧 tgz"的不一致(2026-10-09 排查发现 web 停在 0.7.15、desktop 已 0.7.17)。
 * 用户明确要求**两端必须同步**,故本脚本改为**同时处理 desktop 与 web**:
 *   - 逐端独立走"体检 → 备份 → 替换 → 自检",任一端失败即**只回滚该端**并 exit 1;
 *   - 两端全部通过才 exit 0。
 * 这样"唯一允许的部署方式"本身就保证了同步,不再依赖我记着跑两次。
 *
 * ============================ 本脚本的约束 ============================
 *   - 全程 node 读写:读 utf8(自动剥离 BOM),写 utf8(**node 默认无 BOM**)
 *   - 只**替换版本字符串**,不重新序列化整个 JSON —— 避免键序/格式被动过
 *   - 写前备份,写后**强制自检**:BOM / JSON.parse / 乱码 / 中文路径 / 目标存在
 *   - 任一自检不过 → 立即回滚并 exit 1
 * =========================================================================
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

/** 需要同步的 profile(顺序无关;两端必须一致) */
const PROFILES = ["desktop", "web"];
const NEW_TGZ = process.argv[2]; // 例:dsh-md-convert-1.0.1.tgz
const TGZ_DIR = "D:/WorkSpace/Planing-Workdeck/.tmp/dsh-md-convert-dev";

if (!NEW_TGZ) {
	console.error("用法: node scripts/safe-update-profile.mjs <新 tgz 文件名>");
	console.error("  例: node scripts/safe-update-profile.mjs dsh-md-convert-1.0.1.tgz");
	process.exit(2);
}
if (!existsSync(`${TGZ_DIR}/${NEW_TGZ}`)) {
	console.error(`!! tgz 不存在:${TGZ_DIR}/${NEW_TGZ}(先 npm pack)`);
	process.exit(2);
}

function inspect(p) {
	const b = readFileSync(p);
	return {
		bom: b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf,
		text: b.toString("utf8"),
	};
}

const RE = /(dsh-md-convert"\s*:\s*"file:)[^"]*(\/dsh-md-convert-[\d.]+\.tgz)/;
let failed = 0;
const results = [];

for (const name of PROFILES) {
	const target = `D:/dsh/home/profiles/${name}/package.json`;
	console.log(`\n──── ${name} ────`);

	// —— 写前体检:先确认现在就是好的,否则拒绝在坏状态上叠加 ——
	const pre = inspect(target);
	if (pre.bom) {
		console.error(`!! [${name}] 拒绝执行:目标文件当前已带 BOM,宿主已处于损坏状态。请先修复再部署。`);
		failed++;
		continue;
	}
	try {
		JSON.parse(pre.text);
	} catch (e) {
		console.error(`!! [${name}] 拒绝执行:目标 JSON 解析失败(${e.message.slice(0, 80)})。`);
		failed++;
		continue;
	}
	if (!RE.test(pre.text)) {
		console.error(`!! [${name}] 未找到 dsh-md-convert 依赖行,拒绝盲改。`);
		failed++;
		continue;
	}

	const backup = `${target}.bak-before-md-convert`;
	copyFileSync(target, backup);
	const oldFile = RE.exec(pre.text)[2];
	const out = pre.text.replace(RE, `$1${TGZ_DIR}/${NEW_TGZ}`);
	writeFileSync(target, out, "utf8"); // node utf8 = 无 BOM

	// —— 写后强制自检 ——
	const post = inspect(target);
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
	else if (!existsSync(m[1])) problems.push(`tgz 不存在:${m[1]}`);

	if (problems.length) {
		console.error(`!! [${name}] 自检失败,正在回滚:`);
		for (const p of problems) console.error(`   - ${p}`);
		copyFileSync(backup, target);
		console.error("   已回滚到备份。");
		failed++;
		continue;
	}

	console.log(`   ${oldFile} → ${NEW_TGZ}`);
	console.log("   ✅ BOM=无 | JSON 可解析 | 无乱码 | 中文路径完好 | tgz 存在");
	results.push(name);
}

console.log("");
if (failed) {
	console.error(`!! ${failed} 个 profile 失败 —— 两端可能不一致,请先解决再继续。`);
	process.exit(1);
}
console.log(`✅ ${results.join(" + ")} 两端均已更新到 ${NEW_TGZ}`);
console.log("   备份保留在各自 package.json.bak-before-md-convert,确认无误后可删。");
console.log("   注意:本脚本只改 package.json 依赖指向,**还需安装**让 node_modules 生效:");
console.log("     pnpm --dir D:/dsh/home/profiles/<name> install");
console.log("   装完务必跑 scripts/verify-profile-deps.mjs(依赖闭合)与 audit-profiles.mjs(健康)。");