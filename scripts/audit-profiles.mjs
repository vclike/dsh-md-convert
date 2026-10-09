/**
 * profile 目录健康审计(只读)
 *
 * 背景:2026-10-09 凌晨我用 PowerShell 5.1 的 Set-Content -Encoding UTF8 改写过
 * desktop profile 的 package.json 至少 3 次,在文件头留下 UTF-8 BOM,
 * 导致宿主启动时 readProfileManifest → JSON.parse 严格解析失败、
 * DSH 桌面版直接起不来。OpenViking 里**早就存着这条硬规则**,我仍然踩了。
 *
 * 本脚本检查 profile 下所有 JSON/JS/TS 文件:
 *   1) 是否带 UTF-8 BOM(宿主对该文件致命)
 *   2) JSON 文件能否被 JSON.parse
 *   3) 是否含 GBK 误读特征(銆怭 等)
 *   4) 依赖里的 link: 路径中文括号是否完好
 * 只读,不修改任何东西。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["D:/dsh/home/profiles/desktop", "D:/dsh/home/profiles/web"];
const SKIP_DIR = new Set(["node_modules", ".git", ".cache", "cache", "tmp"]);
const TEXT_EXT = new Set([".json", ".jsonc", ".js", ".cjs", ".mjs", ".ts", ".yml", ".yaml"]);

function* walk(dir, depth = 0) {
	if (depth > 6) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIR.has(e.name)) continue;
			yield* walk(p, depth + 1);
		} else if (e.isFile() && TEXT_EXT.has(extname(e.name).toLowerCase())) {
			yield p;
		}
	}
}

let bomFiles = [];
let badJson = [];
let mojibake = [];
let scanned = 0;

for (const root of ROOTS) {
	for (const p of walk(root)) {
		scanned++;
		let buf;
		try {
			buf = readFileSync(p);
		} catch {
			continue;
		}
		const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
		if (hasBom) bomFiles.push(p);
		const text = buf.toString("utf8");
		if (/銆|怭|锛|鈥|馃/.test(text)) mojibake.push(p);
		if (p.endsWith(".json")) {
			try {
				JSON.parse(text);
			} catch (e) {
				badJson.push(`${p}  ->  ${e.message.slice(0, 90)}`);
			}
		}
	}
}

console.log(`扫描 ${scanned} 个文本文件 (排除 node_modules/.git/cache)\n`);
console.log(`① 带 UTF-8 BOM(对宿主致命): ${bomFiles.length}`);
for (const p of bomFiles.slice(0, 20)) console.log(`   ${p}`);
console.log(`\n② JSON 解析失败: ${badJson.length}`);
for (const p of badJson.slice(0, 20)) console.log(`   ${p}`);
console.log(`\n③ 含 GBK 误读特征: ${mojibake.length}`);
for (const p of mojibake.slice(0, 20)) console.log(`   ${p}`);

console.log(`\n=== desktop profile 关键依赖抽查 ===`);
const pkgPath = "D:/dsh/home/profiles/desktop/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
for (const [k, v] of Object.entries(pkg.dependencies ?? {})) {
	if (String(v).includes("link:") || String(v).includes("file:"))
		console.log(`   ${k} -> ${v}`);
}
const all = JSON.stringify(pkg);
console.log(`中文路径括号完好: ${all.includes("【Plugin-development】") ? "OK" : "!! 缺失"}`);

process.exit(bomFiles.length || badJson.length || mojibake.length ? 1 : 0);