/**
 * dsh-md-convert — 表格噪声行清理(v1.0.5)
 *
 * ============================ 问题(2026-10-09 真实样本实测) ============================
 * 用户提供的 `会员客户管理登记表1.xlsx` 产物:
 *
 *     文件 2.43 MB | 表格行 82145 | **有效数据行仅 48** | 噪声行 82097(100%)
 *
 * 3 个 sheet 各只有 12~17 行真数据,其余全是 Excel 的**空行填充**
 * (``|  |  |  |  |  | 0 | 0 | 0 |  |`` —— 用户可能在表格外误触过,把 max_row 撑到 8 万)。
 *
 * 对 LLM 使用这是**灾难**:2.43 MB 里有效内容约 1 KB,其余全在烧 token。
 * anytomd 的行为是"忠实输出所有行",它没错 —— 这是**呈现层该做的裁剪**。
 *
 * ============================ 判据(保守) ============================
 *   - 只处理**表格数据行**(以 | 开头结尾、非分隔行)。
 *   - 「噪声」= 所有单元格**要么空、要么是纯 0**(`0` / `0.0` / `0.00`)。
 *     `| 1 | 稻壳1 | 1100 |  |` 有一个非 0 非空单元 → **保留**。
 *   - 分隔行(`|---|---|`)与表头行天然不会被误判(表头有列名)。
 *   - 纯函数、幂等;返回删除计数供观测。
 *
 * ============================ 为什么敢删 ============================
 * 「全空」的信息量是零;「仅含 0」在本样本里是 Excel 公式下拉产生的空槽
 * (充值/消费/剩余三列恒为 0),对下游同为噪声。
 * 若将来发现某类文档需要保留零值行,可经 `opts.trimNoiseRows=false` 关闭(默认开)。
 */

/** 纯 0 的书写形式:`0` / `0.0` / `0.00` / `+0` / `-0` */
const ZERO = /^[+-]?0+(?:\.0+)?$/;

/**
 * 该行是否属于"可剔除的表格噪声行"。
 * @param {string} line
 * @returns {boolean}
 */
export function isNoiseTableRow(line) {
	const t = String(line ?? "").trim();
	if (t.length < 2 || !t.startsWith("|") || !t.endsWith("|")) return false;
	// 分隔行(`|---|:--:|`)不是数据行,原样保留。
	// ⚠️ 必须要求**至少一个 `-`**:第一版只写 `/^\|[\s:|-]+\|$/`,
	// 而 `|  |  |  |  |` 只含 `|` 和空格,同样落在该字符类里 → 全空行被**误判成分隔行**
	// 而放过(单测当场抓出)。空行与分隔行的区别全在那个 `-`。
	if (t.includes("-") && /^\|[\s:|-]+\|$/.test(t)) return false;
	const cells = t.slice(1, -1).split("|").map((s) => s.trim());
	if (cells.length === 0) return false;
	return cells.every((c) => c === "" || ZERO.test(c));
}

/**
 * 剔除表格内的全空/全零行。
 * @param {string} md
 * @returns {{md: string, removed: number}}
 */
export function trimNoiseTableRows(md) {
	const text = String(md ?? "");
	if (!text || !text.includes("|")) return { md: text, removed: 0 };
	const out = [];
	let removed = 0;
	for (const line of text.split("\n")) {
		if (isNoiseTableRow(line)) {
			removed++;
			continue;
		}
		out.push(line);
	}
	return { md: out.join("\n"), removed };
}