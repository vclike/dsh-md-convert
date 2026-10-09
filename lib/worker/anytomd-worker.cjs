#!/usr/bin/env node
"use strict";
/**
 * dsh-md-convert — anytomd 子进程桥 worker(v0.7.18)
 *
 * 用法: node anytomd-worker.cjs <inputPath>
 * 协议(stdout 单行 JSON,UTF-8):
 *   {"ok":true,"md":"...","warnings":[...]} | {"ok":false,"error":"..."}
 *
 * 设计动机: xlsx/xls 走 markitdown-node 存在**结构性缺陷**(2026-10-09 真机实测):
 *   ① 单元格内换行符原样透出 → 一个表格行被劈成多个物理行,渲染器直接崩;
 *   ② 无缓存值的公式格掉进 `String(cell)` 兜底 → 输出 84 处 `[object Object]`;
 *   ③ 合并单元格值被 ExcelJS 广播到整个跨列(标题重复 18 次),且从不折叠;
 *   ④ 双层表头被压平成两张互不相干的表。
 * anytomd(Apache-2.0)实测修复上述全部四项:换行→`<br>`、转义 `|`/`\`、
 * 合并区 empty-fill、公式取 calamine 计算值(非空则填值,无值则空,绝无垃圾)。
 *
 * 为什么仍走子进程桥而不是进程内:markitdown-node 的失败点是宿主内
 * `createRequire.resolve.paths` 解析链(CJS require);anytomd 用 ESM import,
 * 真机实测**宿主 Electron(Node 24.18.1 / Electron 44)内可直接加载**,
 * 但为与既有双引擎桥保持同一形状、且避免再次踩宿主解析链,此处统一走桥。
 * 探针实测:宿主冷启 27.8ms、热 ~2.0ms,输出与独立 Node SHA256 完全一致。
 */

const path = require("node:path");

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function slice(s, n) {
	return String(s ?? "").slice(0, n);
}

/** 取小写扩展名(不含点);无扩展名返回空串 */
function extOf(p) {
	const base = path.basename(String(p ?? ""));
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

async function main() {
	const input = process.argv[2];
	if (!input) {
		emit({ ok: false, error: "缺少 inputPath 参数" });
		return 0;
	}

	// anytomd 是纯 ESM 包(type:module),CJS 里只能动态 import()
	let convertBytes;
	try {
		({ convertBytes } = await import("anytomd"));
	} catch (e) {
		emit({ ok: false, error: "anytomd 加载失败:" + slice(e && e.message ? e.message : e, 200) });
		return 0;
	}

	try {
		const abs = path.resolve(input);
		const ext = extOf(abs);
		const bytes = new Uint8Array(require("node:fs").readFileSync(abs));
		const result = convertBytes(bytes, ext);
		if (!result || typeof result.markdown !== "string") {
			emit({ ok: false, error: "anytomd 返回结构异常(缺少 markdown 字段)" });
			return 0;
		}
		emit({
			ok: true,
			md: result.markdown,
			warnings: Array.isArray(result.warnings) ? result.warnings.map((w) => String(w)) : [],
		});
		return 0;
	} catch (e) {
		emit({ ok: false, error: "anytomd 执行异常:" + slice(e && e.message ? e.message : e, 200) });
		return 0;
	}
}

main()
	.then((code) => process.exit(code || 0))
	.catch((e) => {
		emit({ ok: false, error: "worker 崩溃:" + slice(e, 200) });
		process.exit(0);
	});
