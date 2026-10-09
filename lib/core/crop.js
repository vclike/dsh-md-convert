/**
 * vision 图片"自裁剪"落盘(v0.7.17 / P7)。
 *
 * 背景:此前 vision 转写只能**引用已抽好的候选图**(extract_text.py 预先枚举的图块)。
 * 但很多截图类 PDF 根本没有被 pdfium 枚举成独立图对象(整页就是一张大图),
 * 模型看得到图、却引用不了 —— 只能写文字描述。
 *
 * 做法:让 vision 转写输出**图块坐标**(页面 PNG 的像素坐标系),
 * 由本模块在装配阶段从**已渲染好的页面 PNG** 裁剪落盘。
 * 速度关键:页面 PNG 已在 vision 阶段渲染完毕,裁剪是像素搬运(毫秒级);
 * 且**一次 Python 调用批量裁全部**,不按图逐个起子进程。
 *
 * 引用语法:![简述](crop:页号:x0,y0,x1,y1)   坐标 = 渲染后页面 PNG 像素,左上角原点
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAsync } from "./spawn.js";
import { detectPython } from "./deps.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "py", "crop_images.py");

/** ![alt](crop:P:x0,y0,x1,y1) */
const CROP_RE = /!\[([^\]]*)\]\(\s*crop:\s*(\d+)\s*:\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g;

/**
 * 纯函数:解析并归一化所有 crop 引用(不裁剪)。
 * 质量闸(防止模型乱输出把 md 搞得面目全非):
 *   - 每页最多 maxPerPage 个裁剪(默认 4),超出直接拒绝;
 *   - 完全相同的框去重(只裁一次);
 *   - 退化框(宽或高 <= 0)直接判失败。
 * @returns {{items:Array, rejects:Array}}
 */
export function planCrops(md, { maxPerPage = 4 } = {}) {
	const items = [];
	const rejects = [];
	const seenBox = new Set();
	const perPage = new Map();
	const src = String(md ?? "");
	CROP_RE.lastIndex = 0;
	let m;
	while ((m = CROP_RE.exec(src)) !== null) {
		const [, alt, pageS, xs, ys, xe, ye] = m;
		const page = Number(pageS);
		const box = [Number(xs), Number(ys), Number(xe), Number(ye)];
		const key = `${page}:${box.join(",")}`;
		if (seenBox.has(key)) {
			rejects.push({ alt, page, box, reason: "与前一裁剪区完全相同,已去重" });
			continue;
		}
		if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) {
			rejects.push({ alt, page, box, reason: "裁剪区退化(宽或高<=0)" });
			continue;
		}
		const n = (perPage.get(page) ?? 0) + 1;
		perPage.set(page, n);
		if (n > maxPerPage) {
			rejects.push({ alt, page, box, reason: `超出每页上限 ${maxPerPage}` });
			continue;
		}
		seenBox.add(key);
		items.push({ alt: alt || "", page, box, seq: n, id: `p${String(page).padStart(3, "0")}_c${String(n).padStart(2, "0")}` });
	}
	return { items, rejects };
}

/** PNG 头解析尺寸(IHDR,24 字节)—— 零依赖,无需解码整图 */
export function pngSize(file) {
	try {
		const fd = readFileSync(file);
		if (fd.length < 24) return null;
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		for (let i = 0; i < 8; i++) if (fd[i] !== sig[i]) return null;
		return { width: fd.readUInt32BE(16), height: fd.readUInt32BE(20) };
	} catch {
		return null;
	}
}

/**
 * 批量裁剪并把 crop: 引用改写为 images/ 相对路径。
 *
 * @param {string} md
 * @param {object} opts
 *   pagesDir  vision 阶段渲染的页面 PNG 目录
 *   imagesDir 裁剪产物目录(与最终 md 同级 → 相对路径可用)
 *   pageList  本次覆盖的页号(用于定位第 N 页的 PNG 文件名)
 *   maxPerPage/maxCrops 安全闸
 * @returns {{md:string, stats:object, findings:Array}}
 */
export async function applyCropRefs(md, opts = {}) {
	const {
		pagesDir = "",
		imagesDir = "",
		pageList = [],
		maxPerPage = 4,
		maxCrops = 200,
		python = "",
	} = opts;
	const src = String(md ?? "");
	const empty = { md: src, stats: { requested: 0, cropped: 0, rejected: 0, failed: 0 }, findings: [] };
	if (!CROP_RE.test(src)) {
		CROP_RE.lastIndex = 0;
		return empty;
	}
	CROP_RE.lastIndex = 0;

	// 找页面 PNG:优先按页号匹配文件名(p001.png / p001_*.png),否则按序号
	const files = existsSync(pagesDir)
		? readdirSync(pagesDir).filter((f) => /\.(png|jpe?g)$/i.test(f))
		: [];
	const findPageFile = (page) => {
		const stem = String(page).padStart(3, "0");
		const exact = files.find((f) => new RegExp(`^${stem}[._-]`).test(f) || new RegExp(`^${stem}\\d*\\.`, "i").test(f));
		if (exact) return join(pagesDir, exact);
		const idx = pageList.indexOf(page);
		if (idx >= 0 && files[idx]) return join(pagesDir, files[idx]);
		return "";
	};

	const { items, rejects } = planCrops(src, { maxPerPage });
	const findings = [];
	for (const r of rejects) findings.push({
		level: "warn", code: "E_CROP_REJECTED",
		message: `第 ${r.page} 页裁剪请求被拒(${r.reason}): ![${r.alt}]`,
	});

	let work = items.slice(0, Math.max(0, maxCrops));
	for (const it of items.slice(maxCrops)) {
		findings.push({ level: "warn", code: "E_CROP_REJECTED", message: `裁剪总数超上限 ${maxCrops},第 ${it.page} 页的请求被拒` });
	}

	const spec = [];
	for (const it of work) {
		const srcPage = findPageFile(it.page);
		if (!srcPage || !existsSync(srcPage)) {
			it.error = "页面 PNG 未找到";
			continue;
		}
		it.out = join(imagesDir, `${it.id}.png`);
		spec.push({ id: it.id, page: it.page, src: srcPage, box: it.box, out: it.out });
	}
	if (!spec.length) {
		return { md: src, stats: { requested: items.length, cropped: 0, rejected: rejects.length, failed: work.length }, findings };
	}

	mkdirSync(imagesDir, { recursive: true });
	const specPath = join(imagesDir, "__crop_spec.json");
	writeFileSync(specPath, JSON.stringify({ items: spec }, null, "\t"), "utf8");

	let done = [];
	try {
		const py = python || detectPython("");
		// runAsync 返回 {status, stdout, stderr} —— **不是字符串**(曾误当字符串用,
		// 导致 JSON.parse("[object Object]") 失败、裁剪其实成功了却被记为失败)
		const res = await runAsync(py, [SCRIPT, specPath], { timeout: 120_000 });
		const raw = typeof res === "string" ? res : String(res?.stdout ?? "");
		const line = raw.trim().split("\n").filter(Boolean).pop() ?? "";
		const j = JSON.parse(line);
		done = Array.isArray(j?.done) ? j.done : [];
		for (const f of j?.failed ?? []) findings.push({ level: "warn", code: "E_CROP_FAILED", message: `裁剪失败(${f.reason}):${f.id}` });
	} catch (e) {
		findings.push({ level: "warn", code: "E_CROP_FAILED", message: `裁剪服务异常:${String(e?.message ?? e).slice(0, 120)}` });
	}
	const okIds = new Set(done.map((d) => d.id));

	// 改写引用:成功 → images/xxx.png;失败 → 降级为注释(与 P6 断链处理同风格)
	const rel = (p) => `images/${p.split(/[\\/]/).pop()}`;
	let outMd = src.replace(CROP_RE, (m, alt, pageS, xs, ys, xe, ye) => {
		const page = Number(pageS);
		const box = [Number(xs), Number(ys), Number(xe), Number(ye)];
		const hit = work.find((w) => w.page === page && w.box.join(",") === box.join(",") && okIds.has(w.id));
		if (hit) return `![${alt || `第 ${page} 页插图`}](${rel(hit.out)})`;
		return `<!-- 图片(未能裁剪,需人工补图): ${alt || `第 ${page} 页插图`} -->`;
	});

	return {
		md: outMd,
		stats: { requested: items.length, cropped: okIds.size, rejected: rejects.length, failed: items.length - okIds.size - rejects.length },
		findings,
	};
}