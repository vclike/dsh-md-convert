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
 *      (v0.7.6 拆分:本函数只管行内空格;OCR 栏宽硬换行由下面的
 *       `joinWrappedCjkLines()` 负责 —— 两者是**不同**缺陷。)
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
	const injected = (text.match(SINGLE_SPACE_BETWEEN_CJK, "g") || []).length;
	return {
		cjkChars,
		injected,
		per1k: cjkChars ? Math.round((injected * 1000 * 100) / cjkChars) / 100 : 0,
		tornDigitRuns: (text.match(TORN_DIGITS) || []).length,
	};
}

/* ──────────────────────────────────────────────────────────────────────────
 * 段内硬换行合并(v0.7.6)
 *
 * 背景(2026-10-09 97 页真实扫描件实测,UTF-8 严格解码):
 *   扫描件 OCR 按**版面栏宽**硬换行,把中文词从中间切开:
 *     "…活动策划、执行与搭" ⟶换行⟶ "建,服务内容包含:…"
 *   实测 **415 处**,分布在 **55/72 有内容页**,占正文行 **39.6%**;
 *   非空行 1745 → 约 1330(−24%),字符数应几乎不变。
 *
 *   为什么 collapseCjkSpaces 治不了:它的 **R5 明确"绝不删换行/绝不跨行合并"**,
 *   R6 把跨行拼接推给调用方 —— 那是为"行内空格注入"设计的,没覆盖 OCR 栏宽换行。
 *
 * 实测的两个陷阱(不是推测):
 *   ① 415 处候选里 **113 处紧邻表格行/标题/列表行** → 必须先做结构保护,
 *      否则按"相邻两行"合并会**破坏表格结构**;
 *   ② 真正段首的行也以 CJK 开头,但实测其**前一行以句末标点收尾**,
 *      故"前一行不以句末标点收尾"这个判据足以区分硬换行与真段首。
 * ────────────────────────────────────────────────────────────────────────── */

// R0 结构保护(扩展到表格/标题/列表/分隔线/锚点/空行):这些行**绝不参与**合并
const STRUCT_LINE =
	/^\s*(\||#{1,6}\s|[-*+]\s|\d+[.)]\s|[-=*_]{3,}\s*$|>|<!--|`|~~~|:\s*$)/;
// 编号条款行(`4. 根据所制定活动流程，…以`):OCR 会把长条款硬换行,下一行接着同一句。
// 它长得像列表项,但**不是**结构行 —— 故对 `\d+[.)]\s` 起始且**不以句末标点收尾**的行放行,
// 否则实测会漏合 8 处(97 页扫描件 p32/p44 一带的联合体协议条款)。
// 真列表项一般很短且以句末标点收尾 → 仍受保护。
const STRUCT_LINE_JOINABLE = /^\s*(\d+[.)]\s)(?!.*[。！？；：!?;]$)/;
// 纯编号项(整行就是 `1.` / `1)` 这类无正文,或以句末标点收尾)仍按结构行处理
function isStructLine(line) {
	const t = line;
	if (!STRUCT_LINE.test(t)) return false;
	if (STRUCT_LINE_JOINABLE.test(t) && !/^\s*\d+[.)]\s*$/.test(t)) return false;
	return true;
}
// 行尾是句末标点 → 认为句子已完,不与下一行合并
const ENDS_SENTENCE = /[。！？；：、，,．.!?;:\n]$/;
// 行尾/行首为 CJK 侧(字,不把标点算进去,否则 `。` 后不该再接)
// 注意:必须用**正则字面量**构造 —— IDEO 里是 `\uXXXX` 转义文本,
// 交给 new RegExp() 会被当成字面的反斜杠+u 序列,导致 CJK 判据恒 false(实测踩过)。
const CJK_END = new RegExp(`[${IDEO}]$`);
const CJK_START = new RegExp(`^[${IDEO}]`);
const PAGE_ANCHOR = /^<!--\/?PAGE:\d+-->$/;

/**
 * 合并扫描件 OCR 的段内硬换行。纯函数、幂等、页内(不跨 PAGE 锚点)。
 * @param {string} md
 * @returns {{md: string, joined: number, protectedBreaks: number}}
 */
export function joinWrappedCjkLines(md) {
	const text = String(md ?? "");
	if (!text) return { md: text, joined: 0, protectedBreaks: 0 };
	const lines = text.split("\n");
	const out = [];
	let joined = 0;
	let protectedBreaks = 0;
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE.test(line)) inFence = !inFence;
		const prev = out.length ? out[out.length - 1] : null;
		// 只在"上一行是普通正文 + 本行是普通正文 + 都以 CJK 为界"时合并
		if (
			prev !== null &&
			!inFence &&
			!isStructLine(line) &&
			!isStructLine(prev) &&
			!PAGE_ANCHOR.test(line.trim()) &&
			!PAGE_ANCHOR.test(prev.trim()) &&
			CJK_END.test(prev.trimEnd()) &&
			CJK_START.test(line.trimStart()) &&
			!ENDS_SENTENCE.test(prev.trimEnd())
		) {
			// 去掉本行行首空白(OCR 缩进),直接接在上一行末尾
			out[out.length - 1] = prev.trimEnd() + line.trimStart();
			joined++;
			continue;
		}
		out.push(line);
		if (line.trim() !== "" && (isStructLine(line) || PAGE_ANCHOR.test(line.trim())))
			protectedBreaks++;
	}
	return { md: out.join("\n"), joined, protectedBreaks };
}
