/**
 * dsh-md-convert — 格式检测与分类
 *
 * 将输入文件按处理链路分类:
 *  - modern   : markitdown 原生支持(docx/xlsx/pptx/pdf 文字层等)
 *  - legacy   : 老二进制格式,需先经 WPS/Office COM 另存为现代格式(doc/xls/ppt)
 *  - scanned  : 无文字层的 PDF(扫描件),需 OCR 后再进入 markitdown / 直接出 md
 *  - image    : 图片,直接交给 markitdown 的 OCR 能力(或标记为扫描页来源)
 */

/**
 * markitdown-node 原生支持的扩展名(v0.7.2 W4-1)。
 *
 * **必须镜像**引擎自己的 `extensionToFormat`(`markitdown-node/dist/index.cjs:2032-2057`),
 * 不得手写臆测 —— 白名单与引擎能力不一致时,用户看到的是"Unable to detect document format"
 * 这类**误导性**错误(以为文件坏了),而真相是插件放行了一个引擎不会解析的扩展名。
 */
export const MARKITDOWN_EXT = new Set([
	"docx", "xlsx", "pptx",
	"pdf", "html", "htm", "csv", "json", "xml", "rss", "atom",
	"ipynb", "txt", "srt", "vtt",
	"png", "jpg", "jpeg", "tif", "tiff",
	// v0.7.2 W4-1: 引擎有 ZIPBackend(unzipper 已在依赖内)且 mapping 里有 zip,
	// 此前被本白名单误挡 → 现在放行。注意它会**递归转换**包内每个文件
	// (`dist:1193` 调 parentConverter),由 markitdown 子进程桥 180s 超时兜底。
	"zip",
]);

/** 插件自行处理的纯文本扩展(不经 markitdown;读取带编码探测,见 convert.js decodeText) */
const PLUGIN_PLAIN_EXT = new Set(["md", "markdown"]);

/**
 * v0.7.2 W4-1: 曾被误列白名单、但引擎**没有**对应 backend 的扩展名。
 * 实测引擎对它们的内容嗅探返回 null → 报 "Unable to detect document format"。
 * 现在不放进白名单,改由 convert.js 给出带可操作提示的明确错误。
 */
export const ENGINE_UNSUPPORTED_EXT = new Set(["gif", "bmp", "webp"]);

/**
 * v0.7.11 P4/W4-8 + W4-10: 同样"引擎无后端",但**错误提示必须不同** ——
 * 对 gif/bmp/webp 说"转为 png/jpg"是对的,对 docm 说"转为 png/jpg"是荒谬的。
 *
 * ⚠️ 计划原写"W4-8 补宏格式白名单(docm/xlsm/pptm)",**实测后判定为错误**:
 * 引擎 `extensionToFormat`(`markitdown-node/dist/index.cjs`)实测只含
 * docx/xlsx/pptx/pdf/html/htm/vtt/srt/png/jpg/jpeg/tiff/tif/csv/json/txt/xml/rss/atom/zip/ipynb,
 * **没有 docm/xlsm/pptm,也没有 epub**;直接调 `detectFormat` 实测三者均无法解析成格式。
 * 若把它们放进白名单,用户会看到 "Unable to detect document format" ——
 * 正是本文件顶部警告的那种**误导性错误**(以为文件坏了)。
 * 故正确做法是列入"引擎无后端"并给出**针对该格式**的补救建议。
 */
export const NO_BACKEND_HINT = {
	docm: "宏文档(Word);解析引擎无该后端。请用 Word/WPS 另存为 .docx(去掉宏)后再试",
	xlsm: "宏表格(Excel);解析引擎无该后端。请另存为 .xlsx(去掉宏)后再试",
	pptm: "宏演示(PPT);解析引擎无该后端。请另存为 .pptx(去掉宏)后再试",
	epub: "EPUB 电子书;解析引擎无该后端。请先转为 .pdf 或 .html 再试",
};

/** 引擎无后端的扩展名全集(宏格式 + EPUB + 图片三类缺后端者) */
export const ENGINE_NO_BACKEND_EXT = new Set([
	...ENGINE_UNSUPPORTED_EXT,
	...Object.keys(NO_BACKEND_HINT),
]);

const MODERN_EXT = new Set([...MARKITDOWN_EXT, ...PLUGIN_PLAIN_EXT]);

/** 老二进制 Office 格式 → 目标现代格式 */
export const LEGACY_MAP = {
	doc: "docx",
	xls: "xlsx",
	ppt: "pptx",
};

/** 现代 Office/PDF 格式(核心目标) */
export const OFFICE_MODERN = new Set(["docx", "xlsx", "pptx", "pdf"]);

/** 图片扩展名(v0.7.2 W4-2: 走本地 RapidOCR 优先,markitdown/tesseract 兜底) */
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "tif", "tiff"]);

export function extOf(file) {
	const base = String(file).split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * 分类输入文件。
 * @param {string} file 文件路径
 * @param {object} [info] 可选的附加信息,如 { hasTextLayer: boolean }(PDF)
 * @returns {{ kind: "modern"|"legacy"|"scanned"|"unsupported", ext: string, targetExt?: string }}
 */
export function classify(file, info = {}) {
	const ext = extOf(file);
	if (Object.prototype.hasOwnProperty.call(LEGACY_MAP, ext)) {
		return { kind: "legacy", ext, targetExt: LEGACY_MAP[ext] };
	}
	if (ext === "pdf" && info.hasTextLayer === false) {
		return { kind: "scanned", ext };
	}
	if (MODERN_EXT.has(ext)) {
		return { kind: "modern", ext };
	}
	return { kind: "unsupported", ext };
}

/** markitdown 是否原生支持该扩展名 */
export function isModernExt(ext) {
	return MODERN_EXT.has(ext.toLowerCase());
}
