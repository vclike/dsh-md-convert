/**
 * dsh-md-convert — 输入展开(v0.7.2 W4-6)
 *
 * 背景:CLI 早已支持多文件(`convertMany`),但**目录**参数此前只会被当成不支持的扩展名
 * 拒绝;批量转换一个目录得靠调用方自己列文件。
 *
 * 纪律:**不静默丢文件**。跳过的每个条目都要能说出原因(不支持的扩展名/本工具产物/隐藏项),
 * 由 CLI 汇总打印。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_MAP, MARKITDOWN_EXT } from "./detect.js";

/** 插件自行处理的纯文本扩展(与 convert.js 的 PLAIN_EXT 保持一致) */
const PLAIN_LOCAL = new Set(["md", "markdown"]);
/**
 * 目录展开时额外跳过的扩展名:md/markdown。
 * 理由:目录里出现它们**几乎必然是本工具自己的产物**,再"转换"一次只是把 md 抄成 md,
 * 除了噪声没有价值。单文件显式传入时**不跳过**(用户明确要求就照做)。
 */
const SKIP_IN_DIR = new Set(["md", "markdown"]);
/** 本工具产物后缀 —— 它们同时是 .json,会被引擎当普通 JSON 输入 */
const ARTIFACT_SUFFIX = [".state.json", ".progress.json", ".probe.json"];

function extOfName(name) {
	const i = name.lastIndexOf(".");
	return i === -1 ? "" : name.slice(i + 1);
}

/** 该扩展名是否落在任一可转换链路(现代/插件纯文本/老格式) */
export function isConvertibleExt(ext) {
	const e = String(ext ?? "").toLowerCase();
	return MARKITDOWN_EXT.has(e) || PLAIN_LOCAL.has(e) || Object.prototype.hasOwnProperty.call(LEGACY_MAP, e);
}

/**
 * 把输入路径(文件或目录)展开成待转换文件列表。
 * @param {string[]} paths
 * @param {{recursive?: boolean}} [opts]
 * @returns {{files: string[], skipped: Array<{path: string, reason: string}>}}
 */
export function expandInputs(paths, opts = {}) {
	const recursive = opts.recursive === true;
	const files = [];
	const skipped = [];

	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			skipped.push({ path: dir, reason: `目录不可读:${String(e?.message ?? e).slice(0, 80)}` });
			return;
		}
		// 稳定顺序:同名不同批次的输出可复现(批量结果不随文件系统枚举顺序变化)
		for (const ent of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			if (ent.name.startsWith(".")) continue; // 隐藏项(含 .git 等)
			const p = join(dir, ent.name);
			if (ent.isDirectory()) {
				if (recursive) walk(p);
				continue;
			}
			if (!ent.isFile()) continue; // 符号链接/设备等
			if (ARTIFACT_SUFFIX.some((s) => ent.name.endsWith(s))) {
				skipped.push({ path: p, reason: "本工具产物(state/progress/probe)" });
				continue;
			}
			const ext = extOfName(ent.name).toLowerCase();
			if (!ext) {
				skipped.push({ path: p, reason: "无扩展名" });
				continue;
			}
			if (SKIP_IN_DIR.has(ext)) {
				skipped.push({ path: p, reason: "已是 Markdown(疑似本工具产物,跳过自我转换)" });
				continue;
			}
			if (!isConvertibleExt(ext)) {
				skipped.push({ path: p, reason: `不支持的扩展名 .${ext}` });
				continue;
			}
			files.push(p);
		}
	};

	for (const raw of paths ?? []) {
		const p = String(raw);
		let st = null;
		try {
			st = statSync(p);
		} catch {
			// 路径不存在:不在这里判死,交给 convertFile 给出稳定的 E_FILE_NOT_FOUND
			files.push(p);
			continue;
		}
		if (st.isDirectory()) walk(p);
		else files.push(p);
	}
	return { files, skipped };
}
