/**
 * 发版前**依赖闭合校验**。
 *
 * 为什么要单独做:v1.0.0 发版时踩到过 —— tgz 只含插件自身代码,**不含 node_modules**,
 * 运行时依赖(anytomd / markitdown-node)必须由包管理器装到 profile 层。
 * 漏装时插件**不会报错崩溃**,而是走兜底退回 markitdown:
 *   chain = "anytomd(不可用) → markitdown",xlsx 产物退化为
 *   6 处 [object Object] + 合并标题重复 4 次 —— 正是我们花力气修掉的缺陷。
 * **静默退化比崩溃危险**:功能还在,质量悄悄变差,没人会发现。
 *
 * 本脚本:对每个 profile,校验 package.json 的每个 dependencies 都在
 * node_modules 下真实存在。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PROFILES = ["desktop", "web"];
const ROOT = "D:/dsh/home/profiles";

let bad = 0;
for (const p of PROFILES) {
	const base = `${ROOT}/${p}`;
	if (!existsSync(base)) {
		console.log(`[${p}] profile 不存在,跳过`);
		continue;
	}
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(`${base}/package.json`, "utf8"));
	} catch (e) {
		console.log(`[${p}] !! package.json 解析失败:${e.message}`);
		bad++;
		continue;
	}
	const deps = Object.entries(pkg.dependencies ?? {});
	const missing = [];
	// ⚠️ 必须用 join() 逐段拼接:scoped 包名含 "/",直接拼进单段路径
	// 在 Windows 上查不通 —— 曾因此把**存在的** @local/dsh-plugin-forge-preset
	// 误报成缺失(符号链接目录)。link:/file: 形式的本地依赖同样按真实路径查。
	for (const [name, spec] of deps) {
		const target = String(spec).startsWith("link:") ? String(spec).slice(5) : join(base, "node_modules", name);
		if (!existsSync(target)) missing.push(name);
	}
	// 插件自身的运行时依赖也要查(它在 node_modules/dsh-md-convert 里)
	const pluginDir = join(base, "node_modules", "dsh-md-convert");
	if (existsSync(pluginDir)) {
		const plugPkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
		const pdeps = Object.entries(plugPkg.dependencies ?? {});
		for (const [name] of pdeps) {
			if (!existsSync(join(base, "node_modules", name))) missing.push(`dsh-md-convert -> ${name}`);
		}
	}
	const plugVer = existsSync(pluginDir)
		? JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version
		: "未安装";
	const ok = missing.length === 0;
	if (!ok) bad++;
	const state = ok ? "依赖闭合 OK" : "!! 缺失 " + missing.length + " 个";
	console.log(`[${p}] profile 依赖 ${deps.length} 个 | 插件 v${plugVer} | ${state}`);
	for (const m of missing) console.log(`     !! 缺失: ${m}`);
}
console.log(`\n${bad ? "!! 依赖未闭合 —— 插件会静默降级,禁止发版" : "两个 profile 依赖均闭合,可发版"}`);
process.exit(bad ? 1 : 0);