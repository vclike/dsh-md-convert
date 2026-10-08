/**
 * dsh-md-convert — 中文行间空格归并(v0.7.2 W2-1)
 *
 * 背景(2026-10-08 实测 + 开源组件级研究):
 *   - pymupdf4llm 在 span 拼接处无条件插空格(`helpers/pymupdf_rag.py:676` 的 `" ".join`),
 *     逐字符定位文字层 / 字号微差会让 span 不合并 → 中文行间被插入空格
 *     (实测 `视觉 表现力` / `洽谈 记录` / `指向同 一片场地`,工具产物 5.04~6.18‰);
 *   - 自研链同样有(标题续行合并 `" ".join`、表格单元格几何词界),c2 实测 15.25‰;
 *   - 业界**没有**现成库专做这件事(jieba 判别力≈0:注入空格两侧本就是合法词),
 *     故纯规则实现,零新增依赖。
 *
 * 规则(R0-R7,来自研究结论):
 *   R0 结构先行: 受保护区不处理——fenced code / 行内 code。
 *      (**有意的偏离**: 研究建议连"表格行"一起跳过,但实测 c2 的 145 处注入中
 *       141 处在表格单元格内 → 跳过表格等于放过 97% 的问题。且"两侧均 CJK"的
 *       判据天然不会碰到 `| 内容 |` 这类单元格内边距,故表格行**照常处理**。)
 *   R1 CJK↔CJK 之间的**单个半角空格**删除;保留 `\t` 与连续 ≥2 空格(多空格多为真空白)。
 *   R2 CJK↔拉丁/数字 边界**不动**(`视觉 Transformer` / `194,000 元`)。
 *   R3 CJK 标点↔拉丁 **不动**(`：http`)。
 *   R4 数字被单空格打散(`1 9 4 , 0 0 0元`)→ **只观测不修改**(低置信,误伤并列数字)。
 *   R5 只处理行内空白,**绝不删换行**、绝不跨行合并。
 *   R6 跨页拼接不在本模块(由调用方/上游保证)。
 *   R7 幂等(二次运行零变化) + 返回可观测计数。
 */

// CJK 表意字(含扩展 A/兼容区)
const IDEO = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
// CJK 标点/全角符号(归并边界用;与拉丁相邻时不受影响,因边界要求两侧为 CJK 侧)
const PUNCT =
	"\\u3000-\\u303f" + // 、。〈〉《》「」『』【】〔〕…
	"\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65" + // ！＂＃…／：；＜＝＞？［＼］＾＿｀｛｜｝～
	"\\u2018\\u2019\\u201c\\u201d\\u2014\\u2026"; // ‘’“” — …
const CJK_SIDE = `[${IDEO}${PUNCT}]`;

// R1: 恰好一个半角空格,且两侧均为 CJK 侧 → 删除
const SINGLE_SPACE_BETWEEN_CJK = new RegExp(`(?<=${CJK_SIDE}) (?=${CJK_SIDE})`, "g");
// R4: 观测用 —— 被单空格打散的数字串(如 `1 9 4`)
const TORN_DIGITS = /(?:\d \d(?: \d)*)/g;

const FENCE = /^\s*(```|~~~)/;

/**
 * 归并中文行间空格。纯函数、幂等;只删行内"单个半角空格"。
 * @param {string} md
 * @returns {{md: string, removed: number, tornDigitRuns: number, protectedLines: number}}
 */
export function collapseCjkSpaces(md) {
	const text = String(md ?? "");
	if (!text) return { md: text, removed: 0, tornDigitRuns: 0, protectedLines: 0 };
	const lines = text.split("\n");
	let inFence = false;
	let removed = 0;
	let protectedLines = 0;
	const out = lines.map((line) => {
		if (FENCE.test(line)) {
			inFence = !inFence;
			protectedLines++;
			return line;
		}
		if (inFence) {
			protectedLines++;
			return line;
		}
		// R0: 行内 code 段受保护 —— 按反引号切成"正文/代码"交替段,只处理正文段
		const parts = line.split("`");
		const merged = parts.map((seg, i) => {
			if (i % 2 === 1) return seg; // 行内 code
			if (!seg) return seg;
			return seg.replace(SINGLE_SPACE_BETWEEN_CJK, () => {
				removed++;
				return "";
			});
		});
		return merged.join("`");
	});
	return {
		md: out.join("\n"),
		removed,
		tornDigitRuns: (text.match(TORN_DIGITS) || []).length,
		protectedLines,
	};
}

/**
 * 供质量评分使用的观测信号(W2-2 用):中文行间空格注入率。
 * 与 collapseCjkSpaces 同一判据,保证"能测的"与"能修的"一致。
 * @param {string} md
 * @returns {{cjkChars: number, injected: number, per1k: number, tornDigitRuns: number}}
 */
export function cjkSpaceStats(md) {
	const text = String(md ?? "");
	const cjkChars = (text.match(new RegExp(CJK_SIDE, "g")) || []).length;
	const injected = (text.match(SINGLE_SPACE_BETWEEN_CJK) || []).length;
	return {
		cjkChars,
		injected,
		per1k: cjkChars ? Math.round((injected * 1000 * 100) / cjkChars) / 100 : 0,
		tornDigitRuns: (text.match(TORN_DIGITS) || []).length,
	};
}
