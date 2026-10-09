/**
 * 页数闸默认值 30 的依据(修正版)。
 *
 * 【先纠正上一版的错误】上一版把交叉点算成
 *   localPerPage*C*visionPerPage / visionPerPage = localPerPage*C = 18,
 * 那是自己把自己除掉了 —— 恒等于 localPerPage*C,与 visionPerPage 无关,是错的。
 *
 * 正确模型:设 n 页,本地耗时 T_local = n*L;vision 并发耗时 T_vis = n*V/C。
 * 要 T_vis < T_local  ⟺  V/C < L  ⟺  **与页数无关**,是个恒等判断。
 * 也就是说:**时间不是换轨的理由** —— 本地 OCR 只要比视觉单页快,并发也救不回来。
 *
 * 结论:页数阈值真正的依据不是速度,而是
 *   ① 宿主**前台作业门槛**(ocr.foregroundMaxPages = 30 页):超过必须转后台/换轨,
 *      而 vision 恰好"零本机负载、可并发",是长文档的正解;
 *   ② 表格/公式密集度(complexityRatio 40%)—— 复杂度才决定质量收益。
 * 所以 pagesThreshold 的语义是"长文档默认倾向 vision",它与 foregroundMaxPages 对齐,
 * 不是速度交叉点。这个语义必须在文档里说清楚,否则会被误当成性能旋钮。
 */
const L = 5.9;      // 本地 OCR 秒/页(0.7.15 实测 97 页 575s,上沿;0.7.11 为 4.1)
const V = 45;       // 视觉转写 单页秒数量级(保守,依赖所选模型)
const C = 3;        // 建议并发路数

console.log("== 事实1:时间对比(恒定结论,与页数无关)==");
console.log(`  本地 ${L}s/页 ; vision 单路 ${V}s/页,并发 ${C} 路 → ${(V / C).toFixed(1)}s/页`);
console.log(`  本地仍然更快:${L < V / C ? "是" : "否"}  → 时间不是换轨理由\n`);

console.log("== 事实2:真正的门槛是宿主前台作业上限 ==");
console.log("  ocr.foregroundMaxPages = 30 页(超过则前台拒绝,须 background / vision / resume)");
console.log("  → pagesThreshold 默认 30 与之对齐,语义 = '长文档倾向 vision',不是性能阈值\n");

console.log("== 页数闸的真实作用:覆盖范围预览 ==");
console.log("  页数   本地预计   并发3路预计   按本页数闸是否倾向vision");
for (const n of [10, 30, 31, 100]) {
	console.log(
		`  ${String(n).padStart(4)}  ${(n * L / 60).toFixed(1).padStart(7)}分  ${(n * V / C / 60).toFixed(1).padStart(10)}分   ${n > 30 ? "是" : "否"}`,
	);
}
console.log("\n注:vision 仍由 complexityRatio(40%)联合把关 —— 纯文字长文档复杂度低,不会盲目换轨。");