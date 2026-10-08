/**
 * 阶段 3 步骤 1:下载 OmniDocBench.json(40MB)并统计中文页真实分布。
 * ⚠️ 该数据集 README 声明"仅研究用途,禁止商用" -> **仅本地使用,不入库、不打包**。
 *    依据见 test/golden/samples/SOURCES.md。
 *
 * 本脚本只做"统计与选片",不下载图片(避免一次拉几个 GB)。
 */
import { writeFileSync, mkdirSync, statSync } from "node:fs";

const URL = "https://huggingface.co/datasets/opendatalab/OmniDocBench/resolve/main/OmniDocBench.json";
const CACHE = "test/golden/.cache";

mkdirSync(CACHE, { recursive: true });
let buf;
try {
	buf = (await import("node:fs")).readFileSync(`${CACHE}/OmniDocBench.json`);
	console.log(`命中本地缓存 ${CACHE}/OmniDocBench.json (${(buf.length / 1048576).toFixed(2)} MB)`);
} catch {
	console.log(`下载 ${URL} ...`);
	const res = await fetch(URL);
	if (!res.ok) {
		console.error(`下载失败 HTTP ${res.status}`);
		process.exit(2);
	}
	buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${CACHE}/OmniDocBench.json`, buf);
	console.log(`已下载并缓存 ${(buf.length / 1048576).toFixed(2)} MB`);
}

const pages = JSON.parse(buf.toString("utf8"));
console.log(`页数: ${pages.length}`);

const langCount = new Map();
const srcCount = new Map();
const zhPages = [];
for (const p of pages) {
	const pa = p.page_info?.page_attribute ?? {};
	const lang = pa.language ?? "(无)";
	langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
	srcCount.set(pa.data_source ?? "(无)", (srcCount.get(pa.data_source ?? "(无)") ?? 0) + 1);
	const img = p.page_info?.image_path ?? "";
	if (!img) continue;
	if (lang === "simplified_chinese") {
		zhPages.push({
			img,
			no: p.page_info?.page_no,
			w: p.page_info?.width,
			h: p.page_info?.height,
			src: pa.data_source,
			layout: pa.layout,
			fuzzy: pa.fuzzy_scan,
			blocks: (p.layout_dets ?? []).length,
			tables: (p.layout_dets ?? []).filter((d) => d.category_type === "table").length,
		});
	}
}
console.log("\n=== 语言分布 ===");
for (const [k, v] of [...langCount].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
console.log("\n=== 文档类型分布 ===");
for (const [k, v] of [...srcCount].sort((a, b) => b[1] - a[1]).slice(0, 12))
	console.log(`  ${String(k).padEnd(22)} ${v}`);
console.log(`\n=== 简体中文页: ${zhPages.length} 页 ===`);
for (const z of zhPages.slice(0, 20))
	console.log(
		`  ${z.img.split("/").pop().padEnd(52)} src=${String(z.src).padEnd(14)} layout=${String(z.layout).padEnd(16)} blocks=${String(z.blocks).padStart(3)} tables=${z.tables}`,
	);
writeFileSync(`${CACHE}/zh-pages.json`, JSON.stringify(zhPages, null, "\t"), "utf8");
console.log(`\n候选清单已写 ${CACHE}/zh-pages.json (${zhPages.length} 条)`);