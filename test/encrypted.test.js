/**
 * W4-5 加密 PDF — 专属错误码 + 不白跑扫描链路。
 *
 * 根因:加密 PDF 会让文字层抛"PDF 打开失败",上层继续走扫描件路由(探针+渲染白跑),
 * 最后报误导性的 E_OCR_RUN。现在应直接收敛为 E_ENCRYPTED。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFile } from "../lib/core/convert.js";
import { ERROR_CODES } from "../lib/core/errors.js";

/** 用 python+pymupdf 造真加密 PDF(user 密码);环境不可用则返回 null(测试跳过) */
function makeEncryptedPdf(dir) {
	const out = join(dir, "enc.pdf");
	const script = [
		"import pymupdf, sys",
		"d = pymupdf.open()",
		"p = d.new_page()",
		"p.insert_text((72, 72), 'SECRET')",
		"d.save(sys.argv[1], encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user')",
		"d.close()",
	].join("\n");
	try {
		execFileSync("python", ["-c", script, out], { timeout: 60_000, stdio: "ignore" });
	} catch {
		return null;
	}
	return existsSync(out) ? out : null;
}

test("W4-5: 加密 PDF → E_ENCRYPTED(明确不支持),且不落扫描件路由", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mdc-enc-pdf-"));
	const pdf = makeEncryptedPdf(dir);
	if (!pdf) {
		console.log("SKIP: 本机 python/pymupdf 不可用,无法构造加密 PDF 夹具");
		return;
	}
	const r = await convertFile(pdf, { outDir: dir });
	assert.equal(r.ok, false, "加密 PDF 不应成功");
	assert.equal(r.code, ERROR_CODES.E_ENCRYPTED, `应报 E_ENCRYPTED,实际: ${r.code} / ${r.error}`);
	assert.ok(String(r.error).includes("加密"), `错误文案应说明加密: ${r.error}`);
	assert.notEqual(r.code, ERROR_CODES.E_OCR_RUN, "不得报成本误导性的 E_OCR_RUN");
	// 未走扫描件路由:不得产出 state/progress/decision 等 OCR 痕迹
	assert.equal(r.mode, undefined, "不应进入 OCR 路由");
	assert.equal(r.statePath, undefined);
	assert.equal(r.decision, undefined);
	// attempts 应记录文字层为何不可用(可观测性不丢)
	assert.ok(Array.isArray(r.attempts) && r.attempts.length >= 1, JSON.stringify(r.attempts));
	assert.equal(r.attempts[0].via, "pypdfium2");
	assert.equal(r.attempts[0].ok, false);
});
