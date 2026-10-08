/**
 * dsh-md-convert — 页范围解析(v0.7.3 W4-4)
 *
 * 语法:`"1-20"` / `"1-20,25,30-32"`(1 起页号,逗号分隔,容忍空白)。
 * 设计:解析在 JS 侧做一次(单一解析器),python 侧只接受**已规范化的逗号列表**,
 * 避免两套语法各自漂移;但两个 python 入口也各自支持范围展开,便于单独调用。
 *
 * 纪律:**越界必须报错而不是静默丢弃** —— 用户要第 200 页而文档只有 30 页时,
 * 静默输出 30 页会让人以为"转换成功但没有第 200 页"。
 */

/**
 * @param {string} spec 页范围描述;空/null 表示全部页
 * @param {number} [total] 文档总页数(0/未知则不校验上界)
 * @returns {{ok: boolean, pages: number[]|null, error?: string}} pages 为 1 起页号(升序去重)
 */
export function parsePageSpec(spec, total = 0) {
	const raw = String(spec ?? "").trim();
	if (!raw) return { ok: true, pages: null }; // 全部页
	const out = new Set();
	for (const seg of raw.split(",")) {
		const s = seg.trim();
		if (!s) continue;
		const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
		if (m) {
			const a = Number(m[1]), b = Number(m[2]);
			if (a < 1 || b < 1) return { ok: false, pages: null, error: `页码必须从 1 开始:"${s}"` };
			if (a > b) return { ok: false, pages: null, error: `范围起止颠倒:"${s}"` };
			for (let n = a; n <= b; n++) out.add(n);
			continue;
		}
		if (/^\d+$/.test(s)) {
			const n = Number(s);
			if (n < 1) return { ok: false, pages: null, error: `页码必须从 1 开始:"${s}"` };
			out.add(n);
			continue;
		}
		return { ok: false, pages: null, error: `无法识别的页范围片段:"${s}"(示例:"1-20,25")` };
	}
	if (!out.size) return { ok: false, pages: null, error: `页范围为空:"${raw}"` };
	const pages = [...out].sort((a, b) => a - b);
	if (total > 0) {
		const bad = pages.filter((n) => n > total);
		if (bad.length) {
			return {
				ok: false,
				pages: null,
				error: `请求的页码超出文档页数(共 ${total} 页):${bad.slice(0, 8).join("、")}${bad.length > 8 ? " 等" : ""}`,
			};
		}
	}
	return { ok: true, pages };
}

/** 规范化成 python 侧吃的逗号串(`null` → 空串=全部页) */
export function pageSpecToArg(pages) {
	return Array.isArray(pages) && pages.length ? pages.join(",") : "";
}

/** 是否"从第 1 页起的前 N 页"前缀形态(OCR 链路只支持这种) */
export function prefixPageCount(pages) {
	if (!Array.isArray(pages) || !pages.length) return 0;
	for (let i = 0; i < pages.length; i++) {
		if (pages[i] !== i + 1) return 0;
	}
	return pages.length;
}
