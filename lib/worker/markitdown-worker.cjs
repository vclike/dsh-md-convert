#!/usr/bin/env node
"use strict";
/**
 * dsh-md-convert — markitdown-node 子进程桥 worker(v0.6.5)
 *
 * 用法: node markitdown-worker.cjs <inputPath>
 * 协议(stdout 单行 JSON,UTF-8):
 *   {"ok":true,"md":"..."} | {"ok":false,"error":"..."}
 *
 * 设计动机(2026-10-06 真机实证): DSH/Electron 宿主进程内,插件侧
 * createRequire(...) 解析链抛「createRequire.resolve.paths is not a function」,
 * markitdown-node 进程内加载对全格式失败。本 worker 由父进程注入
 * ELECTRON_RUN_AS_NODE=1,以原生 Node 语义运行——require 解析链完整,
 * markitdown-node 及其依赖(turndown/mammoth/jsdom 等)全部可用。
 * 解析基准为本文件位置(lib/worker → 插件根 → node_modules),与安装布局兼容。
 */

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function slice(s, n) {
	return String(s ?? "").slice(0, n);
}

async function main() {
	const input = process.argv[2];
	if (!input) {
		emit({ ok: false, error: "缺少 inputPath 参数" });
		return 0;
	}

	let MarkItDown;
	try {
		({ MarkItDown } = require("markitdown-node"));
	} catch (e) {
		emit({ ok: false, error: "markitdown-node 加载失败:" + slice(e && e.message ? e.message : e, 200) });
		return 0;
	}

	try {
		const converter = new MarkItDown({
			defaultOptions: { ocrLanguages: "chi_sim+eng", extractTables: true, extractImages: false },
		});
		const result = await converter.convert(path.resolve(input));
		if (!result || result.status !== "success") {
			const errs = result && Array.isArray(result.errors) ? result.errors.join("; ") : "未知原因";
			emit({ ok: false, error: "markitdown 转换失败:" + slice(errs, 200) });
			return 0;
		}
		emit({ ok: true, md: String(result.markdown_content ?? "") });
		return 0;
	} catch (e) {
		emit({ ok: false, error: "markitdown 执行异常:" + slice(e && e.message ? e.message : e, 200) });
		return 0;
	}
}

const path = require("node:path");
main()
	.then((code) => process.exit(code || 0))
	.catch((e) => {
		emit({ ok: false, error: "worker 崩溃:" + slice(e, 200) });
		process.exit(0);
	});
