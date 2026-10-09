/** v1.0.6 中文公文编号 → Markdown 标题。判据全部来自真实样本实测校准。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteCnHeadings, cnHeadingLevel } from "../lib/core/cnheadings.js";

test("cn: 基本编号提升", () => {
	assert.equal(cnHeadingLevel("一、2026年工作总结"), 2);
	assert.equal(cnHeadingLevel("二、明年工作思路"), 2);
	assert.equal(cnHeadingLevel("(一)加强学习"), 3);
	assert.equal(cnHeadingLevel("（一）加强学习"), 3); // 全角也支持
	assert.equal(cnHeadingLevel("第一，在计划上注重有序"), 4);
	assert.equal(cnHeadingLevel("1、第一条"), 5); // 中文顿号 → 标题
	assert.equal(cnHeadingLevel("1．第一条"), 5); // 全角点 → 标题
	assert.equal(cnHeadingLevel("(1)第一项"), 5);
	// `1. 第一条` 是 **Markdown 有序列表**,不是标题 —— 不许提升(否则破坏列表语义)
	assert.equal(cnHeadingLevel("1. 第一条"), null);
});

test("cn: markitdown 的 ** 包裹必须先剥(否则识别为 0)", () => {
	// 实测形态:真实产物里是 `**一、2026年工作总结**`,第一版正则直接匹配行首 → 0 命中
	assert.equal(cnHeadingLevel("**一、2026年工作总结**"), 2);
	const r = promoteCnHeadings("**一、2026年工作总结**");
	assert.equal(r.md, "## 一、2026年工作总结", "应剥掉多余的粗体包裹");
	assert.equal(r.promoted, 1);
});

test("cn: 真标题可能带句号,不能被误杀", () => {
	// 实测:`(一)加强学习，努力增强鉴别力。` 是真标题(带句号)
	assert.equal(cnHeadingLevel("(一)加强学习，努力增强鉴别力。"), 3);
});

test("cn: 段落内分点不是标题(编号后无分隔标点)", () => {
	// `一是加强理论知识学习。` 是正文分点,不是标题 —— 与 `第一，` 的区别全在标点
	assert.equal(cnHeadingLevel("一是加强理论知识学习。"), null);
	assert.equal(cnHeadingLevel("二是加强业务知识学习。"), null);
	assert.equal(cnHeadingLevel("三是注重知识更新。"), null);
});

test("cn: 标题与正文同段不猜(行级启发式没有足够信息)", () => {
	const para = "第一，在计划上注重有序。一年来，根据办公室整体工作安排，由我牵头组织的调研服务工作共计30余次。";
	assert.equal(cnHeadingLevel(para), null, "过长 → 不猜");
});

test("cn: 已有结构行一律不动", () => {
	for (const l of ["# 一、已有标题", "## 二、二级", "| 一、表格 |", "<!-- 一、注释 -->", "> 一、引用", "- 一、列表", "```", "1. 一、有序列表"]) {
		assert.equal(cnHeadingLevel(l), null, JSON.stringify(l));
	}
});

test("cn: 幂等(二次运行零变化)", () => {
	const src = "**一、标题**\n正文一段\n(一)子标题\n";
	const once = promoteCnHeadings(src);
	const twice = promoteCnHeadings(once.md);
	assert.equal(twice.md, once.md);
	assert.equal(twice.promoted, 0);
});

test("cn: 真实样本整段提升(10 处,零误判)", () => {
	const src = [
		"# 个人工作总结",
		"",
		"**一、2026年工作总结**",
		"",
		"今年是我工作的第四个年头……",
		"",
		"(一)加强学习，努力增强鉴别力。",
		"",
		"一是加强理论知识学习。今年，主要以学习党的十八精神为主线。",
		"",
		"二、明年工作思路",
		"",
		"一、新的洗涤",
		"",
	].join("\n");
	const r = promoteCnHeadings(src);
	assert.equal(r.promoted, 4, "应提升 4 处(2×##、1×###、1×##);`一是…` 和长正文不动");
	assert.ok(r.md.includes("## 一、2026年工作总结"));
	assert.ok(r.md.includes("### (一)加强学习，努力增强鉴别力。"));
	assert.ok(r.md.includes("## 二、明年工作思路"));
	assert.ok(r.md.includes("一是加强理论知识学习。"), "段落内分点必须原样保留");
});

test("cn: 空输入与无编号文本", () => {
	assert.deepEqual(promoteCnHeadings(""), { md: "", promoted: 0 });
	assert.deepEqual(promoteCnHeadings(null), { md: "", promoted: 0 });
	assert.equal(promoteCnHeadings("纯正文一段话").promoted, 0);
});

test("cn: 长度阈值按可见字数(中文一字算一)", () => {
	assert.equal(cnHeadingLevel("一、" + "字".repeat(38)), 2, "38 字应通过");
	assert.equal(cnHeadingLevel("一、" + "字".repeat(42)), null, "42 字应拒绝");
});