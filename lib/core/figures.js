/**
 * 成品图片引用校验(纯函数,可单测)。
 *
 * v0.7.16 引入 `![…](images/xxx.png)` 后出现一个新的失效面:
 * 视觉转写 agent 引用 `images/p003_01.png`,而该文件可能**根本不存在** ——
 * 要么它编了名(提示词已尽量约束,但模型不总是听话),要么候选清单里就没有该页的图。
 * 结果:最终 md 里留下**断链图片**,渲染出来是个空框/破图,比没有图更糟。
 *
 * 处置原则:**宁可不引,不可断链**。找不到文件就降级成显式注释,让缺失**可见**,
 * 而不是静默留一个坏引用。findings 让调用方能进一步报警。
 *
 * @param {string} md
 * @param {{resolveFile: (p:string)=>boolean}} opts resolveFile 判定文件是否存在(注入以便测试)
 * @returns {{md:string, findings:Array, checked:number, broken:number}}
 */
const FIG = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

export function validateFigureRefs(md, { resolveFile } = {}) {
	const findings = [];
	const src = String(md ?? "");
	if (!src || !/!\[[^\]]*\]\(/.test(src)) {
		return { md: src, findings, checked: 0, broken: 0 };
	}
	let checked = 0;
	let broken = 0;
	const seen = new Set();
	const out = src.replace(FIG, (m, alt, path, title = "") => {
		const p = String(path).trim();
		if (!p) return m;
		if (/^(https?:|data:)/i.test(p)) return m; // 外链/data URI 不校验
		checked++;
		let ok = false;
		try {
			ok = resolveFile ? Boolean(resolveFile(p)) : false;
		} catch {
			ok = false;
		}
		if (ok) return m;
		broken++;
		if (!seen.has(p)) {
			seen.add(p);
			findings.push({
				level: "warn",
				code: "E_FIGURE_MISSING",
				message: `图片引用缺失:${p} —— 视觉转写引用了不存在的图片文件,已降级为注释(需人工补图)`,
			});
		}
		// 降级:保留替代文字,去掉坏引用
		return `<!-- 图片(缺失,需人工补图): ${alt || p} -->`;
	});
	return { md: out, findings, checked, broken };
}