/**
 * 阶段 3 步骤 3:下载选中的中文页图片,并**封装成 PDF** 供扫描件链路测试。
 * OmniDocBench 只提供图片(无 PDF),我们的插件吃 PDF -> 必须自己封装。
 *
 * 封装规则:页面尺寸 = 图片像素尺寸(pt),即 1px = 1pt(72dpi),
 *   这样插件按 scale=2 渲染时得到 2 倍分辨率,OCR 识别率有保障。
 * ⚠️ 仅本地使用(数据集"仅研究用途,禁止商用"),不入库、不打包。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CACHE = "test/golden/.cache";
const BASE = "https://huggingface.co/datasets/opendatalab/OmniDocBench/resolve/main/";
const manifest = JSON.parse(readFileSync(`${CACHE}/zh-manifest.json`, "utf8"));

mkdirSync(`${CACHE}/zh-img`, { recursive: true });
let ok = 0;
for (const m of manifest) {
	const name = m.img.split("/").pop();
	if (existsSync(m.file) && statSync(m.file).size > 1000) {
		ok++;
		continue;
	}
	try {
		// ⚠️ JSON 的 image_path 不带目录前缀,HF 上的真实路径是 images/<name> —— 补前缀,
		//    否则全部 404(已踩过一次)。
		const res = await fetch(`${BASE}images/${m.img}`);
		if (!res.ok) {
			console.log(`  FAIL ${name}: HTTP ${res.status}`);
			continue;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		// 魔数校验:jpeg ffd8ff / png 89504e47 —— 防止把 LFS 指针或错误页存下来
		const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
		const png = buf.subarray(0, 4).toString("hex") === "89504e47";
		if (!jpg && !png) {
			console.log(`  MAGIC ${name}: 不是有效图片(${buf.length} B)`);
			continue;
		}
		writeFileSync(m.file, buf);
		ok++;
	} catch (e) {
		console.log(`  ERR ${name}: ${e.message}`);
	}
}
console.log(`图片就绪 ${ok}/${manifest.length}`);

// 封装成单个多页 PDF
const outPdf = "test/golden/samples/zh-omnidocbench-12p.pdf";
const py = `
import json, sys
import pymupdf
man = json.load(open(r"${CACHE}/zh-manifest.json", encoding="utf-8"))
doc = pymupdf.open()
for m in man:
    # 页面尺寸 = 像素尺寸(pt);上限 1400pt,避免 scale=2 渲染出超大位图
    w, h = float(m["w"]), float(m["h"])
    MAX = 1400.0
    if max(w, h) > MAX:
        k = MAX / max(w, h); w, h = w * k, h * k
    page = doc.new_page(width=w, height=h)
    page.insert_image(pymupdf.Rect(0, 0, w, h), filename=m["file"])
doc.save(r"${outPdf}", deflate=True, garbage=3)
print("pages =", doc.page_count, "| size =", __import__("os").path.getsize(r"${outPdf}"))
`;
const pyFile = join(CACHE, "wrap_pdf.py");
writeFileSync(pyFile, py, "utf8");
const r = spawnSync("python", [pyFile], { encoding: "utf8", cwd: process.cwd() });
console.log(r.stdout || r.stderr);
process.exit(ok === manifest.length ? 0 : 1);