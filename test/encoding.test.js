/**
 * W4-3 编码探测单测。
 *
 * 根因:此前 `readFileSync(path,"utf8")` 硬读 —— GBK 中文 txt 会静默变成乱码且报 ok:true。
 * 覆盖: GBK/GB18030 回落 + 告警；UTF-8 无 BOM；UTF-8 BOM(BOM 不得残留正文)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFile } from "../lib/core/convert.js";

// "中文测试：编码探测" 的 GB18030 字节(Node 的 TextEncoder 不会编 GBK,故内置)
const GBK_TEXT = "中文测试：编码探测";
const GBK_BYTES = [214, 208, 206, 196, 178, 226, 202, 212, 163, 186, 177, 224, 194, 235, 204, 189, 178, 226];

function tmp(tag) {
	return mkdtempSync(join(tmpdir(), `mdc-enc-${tag}-`));
}

function outOf(r) {
	return readFileSync(r.outFile, "utf8");
}

test("W4-3: GB18030 中文 txt 正确解码 + 编码告警(不再静默乱码)", async () => {
	const dir = tmp("gbk");
	const p = join(dir, "gbk.txt");
	writeFileSync(p, Buffer.from(GBK_BYTES));
	const r = await convertFile(p, { outDir: dir });
	assert.equal(r.ok, true, r.error ?? "");
	const md = outOf(r);
	assert.ok(md.includes(GBK_TEXT), `正文应正确解码,实际: ${md.slice(0, 160)}`);
	assert.ok(!md.includes("\uFFFD"), "不得出现替换符");
	assert.ok((r.warnings ?? []).some((w) => w.includes("gb18030")), `应有编码告警: ${JSON.stringify(r.warnings)}`);
});

test("W4-3: UTF-8 无 BOM 正常读取且无编码告警", async () => {
	const dir = tmp("utf8");
	const p = join(dir, "u8.txt");
	writeFileSync(p, `# 标题\n\n${GBK_TEXT} 正常 UTF-8。`, "utf8");
	const r = await convertFile(p, { outDir: dir });
	assert.equal(r.ok, true, r.error ?? "");
	assert.ok(outOf(r).includes(GBK_TEXT));
	assert.ok(!(r.warnings ?? []).some((w) => w.includes("[编码]")), `不应有编码告警: ${JSON.stringify(r.warnings)}`);
});

test("W4-3: UTF-8 BOM 正常读取且 BOM 不残留在正文", async () => {
	const dir = tmp("bom");
	const p = join(dir, "bom.txt");
	writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${GBK_TEXT} 带 BOM。`, "utf8")]));
	const r = await convertFile(p, { outDir: dir });
	assert.equal(r.ok, true, r.error ?? "");
	const md = outOf(r);
	assert.ok(md.includes(GBK_TEXT));
	assert.ok(!md.startsWith("\uFEFF"), "BOM 不得残留在正文开头");
	assert.ok(!md.includes("\uFEFF"), "BOM 不得出现在任何位置");
	// BOM 形态**仍是 UTF-8**:不得报"非 UTF-8"噪声告警
	assert.ok(!(r.warnings ?? []).some((w) => w.includes("[编码]")), `BOM 文件不应有编码告警: ${JSON.stringify(r.warnings)}`);
});
