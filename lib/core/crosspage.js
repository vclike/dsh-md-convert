/**
 * 跨页表格安全合并(A1,v1.0.1)
 *
 * 背景:文字层链路把跨页大表拆成"每页一张表",续页重复表头,
 * 且**跨页那一行被拆成两半**(实测真实形态):
 *
 *   p1 末行: |企业风险数据库|…可提供企业相关的司|使用场景：Query 中…||   ← 末尾留空
 *   p2 首行: ||法诉讼、行政处罚等…|称，以及经营风险…|                    ← 开头留空
 *
 * ⚠️ **两行的列数都等于表头列数**(不是"变少")—— 被截断的单元格表现为
 * **一端留空、内容平移到下一行**,这与直觉相反,是实测纠正的关键认知。
 * 另:同一份样本走扫描件 OCR 链路**无此问题**(逐页整页识别,页内表格完整),
 * 说明这是**文字层链路特有**的缺陷。
 *
 * 为什么只做"安全子集":全量合并需要跨页上下文重建表格 —— 表格重建是**逐页独立**的,
 * 一页看不到下一页的表格边界,强行合并风险高于收益(实测还有列数漂移 p4→p6:4列变5列)。
 *
 * 三条判据全中才动手(宁可不合,不可错合):
 *   ① 上页末行**末列为空**且非全空(行尾被切断);
 *   ② 续页首行**首列为空**且非全空(它是上页末行的下半截);
 *   ③ 续页表头与上页表头一致(确实是同一张表的续页重建)。
 */

const isTableRow = (l) => {
	const t = String(l ?? "").trim();
	return t.startsWith("|") && t.endsWith("|") && t.length > 1;
};
const isSep = (l) => /^\|\s*:?-{2,}/.test(l.trim());

/** md 表格行 → 单元格数组(按 | 切分并去首尾空项) */
function cells(line) {
	const t = String(line ?? "").trim();
	if (!t.startsWith("|")) return [];
	return t.slice(1, t.endsWith("|") ? -1 : undefined).split("|").map((s) => s.trim());
}

/**
 * 取**指定分隔行上方**的表头(向上跳过空行)。
 * ⚠️ 不能直接取 lines[sep-1] —— 真实产物里表格前常有**空行**,
 * cells("") 返回 [] 会让 cols=0、整条链路静默失效(踩过一次)。
 * 也**不能**重扫找"最后一个分隔行" —— 一页有多个表格时那不是同一个。
 */
function headAbove(lines, sepIdx) {
	for (let i = sepIdx - 1; i >= 0; i--) {
		if (lines[i].trim() === "") continue;
		return isTableRow(lines[i]) ? cells(lines[i]) : [];
	}
	return [];
}

/** 单元格是否"空"(含全空白) */
const isBlank = (s) => String(s ?? "").trim() === "";

/** 该页**最后一个**表格块的位置(分隔行下标 + 数据行末下标) */
export function tableBlockOf(lines) {
	let sep = -1;
	for (let i = 0; i < lines.length; i++) {
		if (isSep(lines[i])) sep = i;
	}
	if (sep < 0) return null;
	let end = sep;
	for (let i = sep + 1; i < lines.length; i++) {
		if (isTableRow(lines[i])) end = i;
		else if (lines[i].trim() === "") continue;
		else break;
	}
	return { start: sep, end, head: headAbove(lines, sep) };
}

/**
 * 尝试合并相邻两页的跨页表格。纯函数;不满足判据返回 null。
 * @returns {{mergedRow:string, cols:number}|null}
 */
export function tryMergeCrossPage(prevPageLines, nextPageLines) {
	const A = tableBlockOf(prevPageLines);
	const B = tableBlockOf(nextPageLines);
	if (!A || !B) return null;

	const cols = A.head.length;
	if (cols < 2) return null;

	const lastRow = prevPageLines[A.end];
	const firstRow = nextPageLines[B.start + 1];
	if (!isTableRow(lastRow) || !isTableRow(firstRow)) return null;

	const a = cells(lastRow);
	const b = cells(firstRow);
	if (a.length !== cols || b.length !== cols) return null;

	// ① 上页末行末列为空且非全空
	//    注意用 trim() 判空:真实产物是纯空格,手写夹具常写成 " " ——
	//    只判 ==="" 会在空格上失效,表现为"判据手工全对、函数却拒绝"。
	if (!(isBlank(a[cols - 1]) && a.some((x) => !isBlank(x)))) return null;
	// ② 续页首行首列为空且非全空
	if (!(isBlank(b[0]) && b.some((x) => !isBlank(x)))) return null;
	// ③ 两页表头一致(用 | 作分隔符:用 "" 会让 ["a","bc"] 与 ["ab","c"] 判为相同)
	const bHead = headAbove(nextPageLines, B.start);
	const norm = (xs) => xs.map((x) => x.replace(/\s+/g, "")).join("|");
	if (bHead.length !== cols || norm(bHead) !== norm(A.head)) return null;

	// 合并 = **逐列拼接**(a[i] 与 b[i] 属于同一列)。
	// ⚠️ 我第一版写成"只有次末列拼接、末列取 b、其余取 a" —— 那是**错的**,
	// 被独立 vision 评审抓出:续页首行的 b[1](="法诉讼、行政处罚等企业异常与风险相关信息数据。")
	// **整格被丢弃**,产物里检索不到"法诉讼"。正确做法就是同列上下两半相连:
	//   a = [名称, 能力说明前半, 使用场景前半, ""]
	//   b = ["",   能力说明后半, 使用场景后半, 调用限制]      ← b[i] 就属于第 i 列
	//   合并 = [a0+b0, a1+b1, a2+b2, a3+b3]
	const mergedCells = [];
	for (let i = 0; i < cols; i++) {
		const left = a[i] ?? "";
		const right = b[i] ?? "";
		if (isBlank(right)) mergedCells.push(left);
		else if (isBlank(left)) mergedCells.push(right);
		else mergedCells.push(`${left}<br>${right}`);
	}
	// 内容守恒(评审建议第 3 条):被合并掉的字符必须一个不少 —— **只校验原文内容**。
	// ⚠️ 校验式不能含 `<br>`:拼接时我们主动插了 `<br>` 作为分隔,那不是原文。
	//    所以要比"去掉 <br> 后的 merged" 与 "a[i]+b[i]"(原文里本来就有 <br> 的部分保留)。
	//    (第一版式子写反了 —— 既从 merged 删 <br>、expect 又含 <br>,把正确结果误判成丢字。)
	for (let i = 0; i < cols; i++) {
		const mergedPlain = mergedCells[i].split("<br>").join("");
		const expect = (a[i] ?? "").split("<br>").join("") + (b[i] ?? "").split("<br>").join("");
		if (mergedPlain !== expect) {
			if (process?.env?.MDC_CROSSPAGE_DEBUG) {
				// eslint-disable-next-line no-console
				console.error(`[crosspage] 守恒失败 列${i}\n    merged=${JSON.stringify(mergedPlain.slice(0, 50))}\n    expect=${JSON.stringify(expect.slice(0, 50))}`);
			}
			// 宁可不合并,也不产出缺字的产物
			return null;
		}
	}
	return { mergedRow: `|${mergedCells.join("|")}|`, cols };
}

/**
 * 诊断:返回每条判据的实际值(供排查"外部算全对、函数却返回 null"这类问题)。
 * @param {string[]} prevPageLines
 * @param {string[]} nextPageLines
 */
export function explainMerge(prevPageLines, nextPageLines) {
	const A = tableBlockOf(prevPageLines);
	const B = tableBlockOf(nextPageLines);
	if (!A || !B) return { error: "A 或 B 为 null", A: !!A, B: !!B };
	const cols = A.head.length;
	const lastRow = prevPageLines[A.end];
	const firstRow = nextPageLines[B.start + 1];
	const a = cells(lastRow);
	const b = cells(firstRow);
	const bHead = headAbove(nextPageLines, B.start);
	const norm = (xs) => xs.map((x) => x.replace(/\s+/g, "")).join("|");
	return {
		cols,
		aLen: a.length,
		bLen: b.length,
		isRowA: isTableRow(lastRow),
		isRowB: isTableRow(firstRow),
		cutTail: a[cols - 1] === "" && a.some((x) => x !== ""),
		cutHead: b[0] === "" && b.some((x) => x !== ""),
		bHeadLen: bHead.length,
		headEqual: norm(bHead) === norm(A.head),
		Ahead: A.head,
		Bhead: bHead,
	};
}

/**
 * 对含页锚点的 md 做跨页表格合并(纯函数,可单测)。
 * 只处理"上一页末尾表格 + 下一页开头表格"这一种明确形态。
 * @param {string} md
 * @returns {{md:string, merged:number}}
 */
export function mergeCrossPageTables(md) {
	const src = String(md ?? "");
	if (!/<!--PAGE:\d+-->/.test(src)) return { md: src, merged: 0 };

	const blocks = [];
	const re = /<!--PAGE:(\d+)-->([\s\S]*?)<!--\/PAGE:\1-->/g;
	let m;
	while ((m = re.exec(src)) !== null) blocks.push({ no: Number(m[1]), body: m[2] });

	let merged = 0;
	for (let i = 0; i < blocks.length - 1; i++) {
		const A = blocks[i];
		const B = blocks[i + 1];
		// 页号必须相邻(子集计划可能跳跃,跳过不连续的对)
		if (B.no !== A.no + 1) continue;
		const aLines = A.body.split("\n");
		const bLines = B.body.split("\n");
		const r = tryMergeCrossPage(aLines, bLines);
		if (!r) continue;
		const ta = tableBlockOf(aLines);
		const tb = tableBlockOf(bLines);
		aLines[ta.end] = r.mergedRow;
		// 只删**续页首行**(已并入上行);**表头与分隔行必须保留**。
		// ⚠️ 曾写成 splice(tb.start - 1, 3) 把 [表头, 分隔行, 首行] 一起删 ——
		// 续页剩下十几行数据因此失去表格结构,GFM 下渲染成纯文本
		// (由独立 vision 评审抓出:page2 块无表头无分隔行,退化成段落)。
		// 表头重复是可接受的(视觉上每页都印着它),结构丢失才是不可接受的。
		bLines.splice(tb.start + 1, 1);
		A.body = aLines.join("\n");
		B.body = bLines.join("\n");
		merged++;
	}
	if (!merged) return { md: src, merged: 0 };
	const out = blocks
		.map((b) => {
			const n = String(b.no).padStart(2, "0");
			return `<!--PAGE:${n}-->\n${b.body}\n<!--/PAGE:${n}-->`;
		})
		.join("\n\n");
	return { md: out, merged };
}