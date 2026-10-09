/**
 * dsh-md-convert — 中文公文编号提升为 Markdown 标题(v1.0.6)
 *
 * ============================ 问题(2026-10-09 真实样本实测) ============================
 * 用户提供的 `个人工作总结.docx`,markitdown 产物层次信息**完全丢失**:
 *
 *     全文只有 1 个 `#`(文档标题);`一、2026年工作总结` / `(一)加强学习…` 全是正文
 *
 * **根因在文档本身**(不是 markitdown 的错):
 *   - `styles.xml` 里**定义了** `heading 1`,但 **40 个段落全部是"无样式/默认"**;
 *   - 编号(`一、` / `(一)`)是**手打**的,docx 里连 `numbering.xml` 都没有。
 *   即:没有任何"可识别的标题标记",解析器只能当正文 —— 想要层次,只能在**后处理**里恢复。
 *
 * ============================ 实测校准的三条关键约束 ============================
 * 1. **markitdown 会把段落包成 `**…**`**,行首不是编号 →
 *    匹配前必须先剥强调标记(第一版正则直接匹配行首,识别到 **0** 处)。
 * 2. 括号可能是**半角** `(一)` 而非全角 `（一）` → 两种都要支持。
 * 3. 真标题**可能带句号**(`(一)加强学习，努力增强鉴别力。`) →
 *    **不能**用"以句末标点结尾"排除,否则误杀真标题。
 *
 * ============================ 保守判据 ============================
 *   - 只处理**独立成行**的短行(≤ `MAX_LEN` 字);标题与正文挤在同一段的
 *     (`第一，在计划上注重有序。一年来,…`)**不猜** —— 行级启发式没有足够信息。
 *   - 编号后**必须紧跟分隔标点**:`第一，` 是标题,而 `一是加强学习` 是段落内分点(正文)。
 *   - 已是标题(`#`)、表格行、注释、引用、列表符、代码围栏 → 原样跳过。
 *   - 纯函数、幂等(二次运行零变化);返回提升计数供观测。
 *   - 实测该样本识别 10 处、长度 6~16 字、**零误判**。
 *
 * 误判风险与逃生口:若某类文档误判偏多,可用 `opts.cnHeadings=false` 整体关闭。
 */

/** 中文数字(用于 `一、` / `(一)` / `第一，` 三类编号) */
const CN = "一二三四五六七八九十";
const MAX_LEN = 40;

/** 从高到低;编号后必须紧跟分隔标点或直接接实义字 */
const LEVELS = [
	[new RegExp(`^[${CN}]{1,3}[、.．]`), 2], // 一、xxx   → ##
	[new RegExp(`^[（(][${CN}]{1,3}[）)]`), 3], // (一)xxx  → ###
	[new RegExp(`^第[${CN}]{1,3}[，,、]`), 4], // 第一，xxx → ####
	[/^\d{1,2}[、．]/, 5], // 1、xxx / 1．xxx → #####
	// ⚠️ **不含半角点**:`1. xxx` 在 Markdown 里就是**有序列表**,不是标题
	// (单测当场抓出这个冲突)。中文公文的顿号/全角点是另一回事,故只认 `、` 与 `．`。
	[/^[（(]\d{1,2}[）)]/, 5], // (1) xxx   → #####
];

/** 剥掉行首/行尾嵌套的强调标记(`**` / `*` / `_`),返回纯文本 */
function stripEmphasis(line) {
	let s = String(line ?? "").trim();
	let prev = null;
	while (prev !== s) {
		prev = s;
		s = s.replace(/^\*{1,3}\s*/, "").replace(/\s*\*{1,3}$/, "").trim();
	}
	return s;
}

/** 该行是否应提升为标题;返回标题层级(1-6)或 null */
export function cnHeadingLevel(line) {
	const raw = String(line ?? "");
	const t = raw.trim();
	if (!t) return null;
	// 已有结构行一律不动
	if (/^(#{1,6}\s|\||<!--|>|```|~~~|[-*+]\s|\d+\.\s)/.test(t)) return null;
	const s = stripEmphasis(t);
	if (!s) return null;
	// 用**可见字符数**判长度(中文一字即一字)
	if ([...s].length > MAX_LEN) return null;
	for (const [pat, lvl] of LEVELS) {
		if (pat.test(s)) return lvl;
	}
	return null;
}

/**
 * 把中文公文编号的提升为 Markdown 标题。
 * @param {string} md
 * @returns {{md: string, promoted: number}}
 */
export function promoteCnHeadings(md) {
	const text = String(md ?? "");
	if (!text) return { md: text, promoted: 0 };
	let promoted = 0;
	const out = text.split("\n").map((line) => {
		const lvl = cnHeadingLevel(line);
		if (!lvl) return line;
		promoted++;
		// 剥掉原有的 `**…**`(标题本身就是强调,再包一层是冗余)
		return "#".repeat(lvl) + " " + stripEmphasis(line);
	});
	return { md: out.join("\n"), promoted };
}