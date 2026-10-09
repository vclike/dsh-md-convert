/**
 * 阶段 3 步骤 2:按**多样性**挑选中文页,下载 PNG,封装成 PDF 供扫描件链路测试。
 *
 * 选片原则(不是随手抓前 N 页):
 *  1. 尽量覆盖不同 `data_source`(book / newspaper / exam_paper / PPT2PDF / note / magazine / research_report …)
 *  2. 优先含**表格**的页 —— 表格是我们已知的弱项(列序/列数)
 *  3. 版式覆盖:single_column / other_layout / 多栏
 *  4. 优先 `fuzzy_scan=true`(模糊扫描)—— 更接近真实扫描件
 *
 * ⚠️ OmniDocBench 数据集"仅研究用途,禁止商用" -> 产物**仅本地**,不入库、不打包。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CACHE = "test/golden/.cache";
const PAGES = JSON.parse(readFileSync(`${CACHE}/zh-pages.json`, "utf8"));
const BASE = "https://huggingface.co/datasets/opendatalab/OmniDocBench/resolve/main/";
const WANT = 12;

// ⚠️ 实测发现两处坑(都已踩过,写下来防复发):
//  1. JSON 里的 `image_path` **不带目录前缀**(如 `page-xxx.png`),而 HF 上的实际路径是
//     `images/<name>` → 拼 URL 时必须补 `images/`,否则全部 404。
//  2. 需按**文件名**去重(而非整条 image_path):不同条目可能落到同名文件,
//     而本地落盘名与下载 URL 都只用文件名,同名即冲突。
const seenName = new Set();
const UNIQ = PAGES.filter((p) => {
	const name = p.img.split("/").pop();
	if (!name || seenName.has(name)) return false;
	seenName.add(name);
	return true;
});
console.log(`候选 ${PAGES.length} 页 -> 按文件名去重后 ${UNIQ.length} 页`);

const picked = [];
const usedSrc = new Set();
const usedLayout = new Set();
// **选择过程内也必须查重**。全池去重挡不住"同一张图被多个标注条目引用"的情况:
// 三轮补充(铺类型 -> 补版式 -> 补表格页)会再次选到已选过的图。
// 实测(修复前):12 页里只有 9 张不同的图,p1/p6 与 p2/p9 各自重复一次,
// 白白多跑 3 页 OCR(约 30 秒),且样本代表性下降。
const usedName = new Set();

// 先按优先级排序:含表格 > 模糊扫描 > 少
const score = (p) => (p.tables > 0 ? 100 : 0) + (p.fuzzy ? 40 : 0) + Math.min(p.blocks, 40) / 40;
const pool = [...UNIQ].sort((a, b) => score(b) - score(a));

const tryTake = (p, { requireNewSrc, requireNewLayout }) => {
	if (picked.length >= WANT) return false;
	const name = p.img.split("/").pop();
	if (usedName.has(name)) return false; // 同一张图只取一次
	if (requireNewSrc && usedSrc.has(p.src)) return false;
	if (requireNewLayout && usedLayout.has(p.layout)) return false;
	picked.push(p);
	usedName.add(name);
	usedSrc.add(p.src);
	usedLayout.add(p.layout);
	return true;
};

for (const p of pool) tryTake(p, { requireNewSrc: true, requireNewLayout: true }); // 先铺开类型
for (const p of pool) tryTake(p, { requireNewSrc: false, requireNewLayout: true }); // 再补版式
for (const p of pool) tryTake(p, { requireNewSrc: false, requireNewLayout: false }); // 最后补表格页

console.log(`选中 ${picked.length} 页`);
console.log("覆盖来源:", [...usedSrc].join(", "));
console.log("覆盖版式:", [...usedLayout].join(", "));
console.log("含表格页:", picked.filter((p) => p.tables > 0).length);
console.log("模糊扫描页:", picked.filter((p) => p.fuzzy).length);

mkdirSync(`${CACHE}/zh-img`, { recursive: true });
const manifest = [];
for (const p of picked) {
	const name = p.img.split("/").pop();
	const dest = `${CACHE}/zh-img/${name}`;
	manifest.push({ ...p, file: dest });
	// 下载在下一步做(此处只写清单),避免一次拉太多
}
writeFileSync(`${CACHE}/zh-manifest.json`, JSON.stringify(manifest, null, "\t"), "utf8");
console.log(`\n清单已写 ${CACHE}/zh-manifest.json`);
for (const m of manifest)
	console.log(`  ${m.file.split("/").pop().padEnd(44)} ${String(m.w)}x${String(m.h)} src=${m.src} tables=${m.tables} fuzzy=${m.fuzzy}`);
console.log(`\n下载基址: ${BASE}`);