/**
 * dsh-md-convert — 文字层产物质量信号检测器(v0.6.12 P1)
 *
 * 背景(2026-10-06 双链路对照实证):文字层直提对"文本框/线框错位"类 PDF 会产出
 * 碎片化表格(工业富联:323 表格行中 264 行含空单元格,"citation"切碎、"2025年Ca|pEx"
 * 断裂),此类产物肉眼难判,本模块给出确定性信号,让"该走 vision 路由"的决策有据。
 *
 * 信号(真机校准):
 *   tableFragmentation  含空单元格的表格行占比 ≥50% 触发
 *      (工业富联 82% vs 火山 0%,区分度完美)
 *   charFragmentation   逐字符/竖排文字层:短行(≤4字符)占比 ≥90% 触发
 *      (五粮液采购文件实测 100%——Word 导出逐字符定位,直提完全不可读,
 *       vision 路由是唯一可靠解;正常区间 25-38%,距离 3 倍非过拟合)
 *   colJitter           相邻表格行列数抖动(监控字段,低权重)
 *   shortLineRatio      短行占比(**仅观测字段,0.9 以下不触发**)
 * 输出: { score(0-100), signals, issues[], suggestVision, reason? }
 * 纯函数、链路无关:可评估任何 md 产物。
 */

/**
 * 评估 md 产物质量。
 * @param {string} md
 * @returns {{score: number, signals: object, issues: string[], suggestVision: boolean, reason?: string}}
 */
export function assessMdQuality(md) {
	const lines = String(md ?? "").split("\n");
	const issues = [];

	// ---- 表格碎片化:逐表格行统计 ----
	const tableRows = lines.filter((l) => {
		const s = l.trim();
		return s.startsWith("|") && s.endsWith("|") && !/^\|[\s:-]+\|$/.test(s); // 排除分隔行
	});
	let rowsWithEmpty = 0;
	let totalCells = 0;
	let emptyCells = 0;
	let colJitter = 0;
	let prevCols = null;
	for (const row of tableRows) {
		const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
		const filled = cells.filter((c) => c.trim() !== "").length;
		totalCells += cells.length;
		emptyCells += cells.length - filled;
		if (filled < cells.length) rowsWithEmpty++;
		if (prevCols !== null && cells.length !== prevCols) colJitter++;
		prevCols = cells.length;
	}
	const fragRatio = tableRows.length >= 4 ? rowsWithEmpty / tableRows.length : 0;
	const emptyCellRatio = totalCells > 0 ? emptyCells / totalCells : 0;
	const colJitterRatio = tableRows.length >= 4 ? colJitter / tableRows.length : 0;

	// ---- 短行占比(仅观测,不触发——真机校准无区分度) ----
	const contentLines = lines.filter((l) => {
		const s = l.trim();
		return s && !s.startsWith("|") && !s.startsWith("#") && !s.startsWith("<!--") && !/^(-{3,}|\*{3,})$/.test(s);
	});
	const shortLines = contentLines.filter((l) => l.trim().length <= 4);
	const shortLineRatio = contentLines.length >= 6 ? shortLines.length / contentLines.length : 0;

	// ---- 评分与建议 ----
	let score = 100;
	let triggered = tableRows.length >= 4 && fragRatio >= 0.5;
	if (triggered) {
		score -= Math.min(50, Math.round((fragRatio - 0.3) * 80));
		issues.push(
			`表格碎片化:${tableRows.length} 行表格中 ${rowsWithEmpty} 行(${Math.round(fragRatio * 100)}%)含空单元格(总空单元格率 ${Math.round(emptyCellRatio * 100)}%),疑为文本框/线框错位`,
		);
	}
	// v0.6.12 极端档:逐字符/竖排文字层(短行占比 ≥90%;正常区间 25-38%,距离 3 倍非过拟合)
	const charFrag = contentLines.length >= 20 && shortLineRatio >= 0.9;
	if (charFrag) {
		triggered = true;
		score = Math.min(score, 20);
		issues.push(
			`逐字符/竖排文字层:内容行 ${contentLines.length} 行中 ${shortLines.length} 行(${Math.round(shortLineRatio * 100)}%)≤4 字符,文字层为逐字符定位,直提不可读`,
		);
	}
	if (colJitterRatio > 0.3 && tableRows.length >= 4) {
		score -= Math.min(15, Math.round((colJitterRatio - 0.3) * 40));
		issues.push(`表格列数抖动:${tableRows.length} 行中 ${colJitter} 行与相邻行列数不一致`);
	}
	score = Math.max(0, score);

	const suggestVision = triggered;
	return {
		score,
		signals: {
			tableRows: tableRows.length,
			tableFragRatio: Math.round(fragRatio * 100) / 100,
			emptyCellRatio: Math.round(emptyCellRatio * 100) / 100,
			colJitterRatio: Math.round(colJitterRatio * 100) / 100,
			contentLines: contentLines.length,
			shortLineRatio: Math.round(shortLineRatio * 100) / 100,
			charFragmentation: charFrag,
		},
		issues,
		suggestVision,
		...(suggestVision
			? {
					reason: charFrag
						? "文字层为逐字符/竖排定位(直提不可读),建议整册走 engine:\"vision\" 视觉转写"
						: "文字层产物存在表格碎片化信号,建议对受影响页走 engine:\"vision\" 视觉重转后按锚点合并",
				}
			: {}),
	};
}
