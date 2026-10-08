/**
 * dsh-md-convert — OCR 依赖检测与自动安装
 *
 * 扫描件 OCR 依赖(模块化路由引擎):Python + paddlepaddle + paddleocr + paddlex[ocr]
 * + pypdfium2 + rapidocr + onnxruntime,以及路由引擎各模型
 * (本地缓存 ~/.paddlex/official_models/,运行时完全离线)。
 *
 * 策略:
 *   - 检测:用 importlib.util.find_spec 快速探测(不实际 import,避免加载 paddle);
 *   - 已装 → 直接使用;缺失 → 按 autoInstall 决定自动 pip 安装或给出指引;
 *   - 安装幂等:只装缺失的包,已有跳过。
 *   - 模型:ensureOcrModels 联网预下载(安装期);运行时 routing_ocr.py 设了
 *     PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=true,模型缓存齐全即零网络。
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAsync } from "./spawn.js";

/** 模块名 → pip 包名 */
export const PY_MODULES = {
	paddle: "paddlepaddle",
	paddleocr: "paddleocr",
	paddlex: "paddlex[ocr]",
	pypdfium2: "pypdfium2",
	pymupdf4llm: "pymupdf4llm",
	rapidocr: "rapidocr",
	onnxruntime: "onnxruntime",
	// v0.7.14: 公式识别后处理依赖。paddleocr 的公式管线在**推理成功后**还要过
	// paddlex 的 token2str,内部 `import ftfy` —— 缺它则**每个公式都失败**,
	// 表现为 'NoneType' object has no attribute 'predict'(该报错信息极具误导性,
	// 真实原因是缺依赖)。ftfy 为 Apache-2.0 纯 Python 包,仅依赖 wcwidth。
	// **可选**:只有含公式的文档才需要,故不进 REQUIRED_MODULES,仅在诊断里提示。
	ftfy: "ftfy",
};

/** v0.7.14: 缺了会让"某项能力静默失效"的**可选**依赖(缺了不阻断转换,但功能不可用) */
export const OPTIONAL_MODULES = {
	ftfy: "公式识别($$...$$)。缺 ftfy 时公式位置会显示为 $$[公式未识别]$$ 占位",
};

/** 按平台排序的 python 解释器候选(win32 有 py 启动器;Linux/macOS 惯例 python3) */
function pythonCandidates() {
	return process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
}

/** v0.7.2 W3-6: 解释器/依赖探测结果缓存 —— 一次转换会命中 detectPython 2~3 次
 *  (文字层/闸门/探针),每次都是一次 spawnSync(实测 27ms);findMissingModules 68ms、
 *  ocrModelCacheStatus 30ms 亦为每转换一次。解释器在会话内被卸载属极端场景(重启即可)。 */
const PY_CACHE = new Map();
const MISSING_CACHE = new Map();
const MODEL_CACHE = new Map();

/** 清除探测缓存(pip 安装成功后必须调用,否则会拿到过期的"缺失"清单) */
export function resetDepsCache() {
	MISSING_CACHE.clear();
	MODEL_CACHE.clear();
}

/** 探测可用的 python 解释器(结果按 preferred 缓存) */
export function detectPython(preferred = "") {
	const key = String(preferred ?? "");
	if (PY_CACHE.has(key)) return PY_CACHE.get(key);
	let found = null;
	if (preferred && isPython(preferred)) {
		found = preferred;
	} else {
		for (const py of pythonCandidates()) {
			if (isPython(py)) { found = py; break; }
		}
	}
	PY_CACHE.set(key, found);
	return found;
}

function isPython(py) {
	// v0.7.2 W3-6(D1): 受限上下文(容器/沙箱)里 spawnSync 的**管道捕获**会 EPERM,
	// 导致 detectPython 恒 null → 整条文字层主链被静默跳过并降级 markitdown
	// (实测: encoding:'utf8' EPERM / stdio:'ignore' status=0)。
	// 先试无管道形态(只看退出码),失败再退回管道形态(可校验版本串),两种上下文都能判定。
	const quiet = spawnSync(py, ["--version"], { stdio: "ignore", timeout: 15_000, windowsHide: true });
	if (quiet.status === 0) return true;
	const r = spawnSync(py, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
	return r.status === 0 && /Python/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/**
 * 检测指定 python 中缺失的 OCR 模块。
 * @param {string} python
 * @returns {{ missing: string[] }} missing 为 PY_MODULES 的键列表
 */
export function findMissingModules(python) {
	if (MISSING_CACHE.has(python)) return MISSING_CACHE.get(python);
	const probe = `
import importlib.util, sys
mods = [${Object.keys(PY_MODULES).map((m) => `"${m}"`).join(", ")}]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
print(",".join(missing))
`;
	const r = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 60_000, windowsHide: true });
	const out = (r.stdout ?? "").trim();
	if (r.status !== 0) {
		// 无法探测:保守返回全部缺失(不缓存失败结果,下次仍会重试探测)
		return { missing: Object.keys(PY_MODULES) };
	}
	const missing = out ? out.split(",").filter(Boolean) : [];
	const result = { missing };
	MISSING_CACHE.set(python, result);
	return result;
}

/**
 * 安装缺失的 OCR 依赖(pip)。
 * PEP 668(Externally Managed Environment,常见于 Debian/Ubuntu 系统 Python)会拒绝
 * 全局 pip 安装,检测到该错误时自动追加 `--break-system-packages` 重试一次。
 * @param {string} python
 * @param {string[]} missing PY_MODULES 的键
 * @param {(msg: string) => void} [onLog]
 * @returns {{ ok: boolean, installed: string[], error?: string }}
 */
export async function installModules(python, missing, onLog) {
	const installed = [];
	for (const key of missing) {
		const pkg = PY_MODULES[key];
		const msg = `正在安装 ${pkg}(${key})...`;
		if (typeof onLog === "function") onLog(msg);
		let r = await runAsync(python, ["-m", "pip", "install", "--disable-pip-version-check", pkg], {
			timeout: 1_800_000, // 大包(paddlepaddle)下载可能较久
		});
		const combined = `${r.stderr ?? ""}${r.stdout ?? ""}`;
		if (r.status !== 0 && /externally-managed-environment/i.test(combined)) {
			// PEP 668:系统 Python 受管理,显式放行后重试一次
			if (typeof onLog === "function") onLog(`检测到 PEP 668(系统 Python 受管),追加 --break-system-packages 重试...`);
			r = await runAsync(
				python,
				["-m", "pip", "install", "--disable-pip-version-check", "--break-system-packages", pkg],
				{ timeout: 1_800_000 },
			);
		}
		if (r.status !== 0) {
			const detail = r.error
				? r.error
				: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-5).join("\n");
			return { ok: false, installed, error: `pip install ${pkg} 失败:${detail}` };
		}
		installed.push(pkg);
	}
	resetDepsCache(); // v0.7.2 W3-6: pip 装了新包 → 清探测缓存(否则拿过期缺失清单)
	return { ok: true, installed };
}

/**
 * 检查并(可选)安装 OCR 依赖。
 * @param {object} [opts]
 * @param {string} [opts.python] 指定解释器;空则自动探测
 * @param {boolean} [opts.autoInstall=true] 缺失时自动 pip 安装
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {Promise<{ ok: boolean, python?: string, installed?: string[], error?: string }>}
 */
export async function ensureOcrDeps(opts = {}) {
	const python = detectPython(opts.python);
	if (!python) {
		return {
			ok: false,
			error:
				process.platform === "win32"
					? "未找到 Python。请安装 Python(https://www.python.org/downloads/)后重试"
					: "未找到 Python。请安装后重试(Linux: apt install python3 python3-pip;macOS: brew install python)",
		};
	}
	const { missing } = findMissingModules(python);
	if (missing.length === 0) {
		return { ok: true, python, installed: [] };
	}
	if (opts.autoInstall === false) {
		return {
			ok: false,
			error: `Python 缺少 OCR 依赖(${missing.join(", ")})。请执行: python -m pip install ${missing.map((m) => PY_MODULES[m]).join(" ")}`,
		};
	}
	const r = await installModules(python, missing, opts.onLog);
	if (!r.ok) return { ok: false, python, error: r.error };
	return { ok: true, python, installed: r.installed };
}

/* ------------------------------------------------------------------ *
 * 路由 OCR 模型(安装期预下载 → 运行时离线)
 * ------------------------------------------------------------------ */

/** 路由引擎实际加载的模型目录名(与 lib/py/routing_ocr.py 一致) */
export const REQUIRED_MODELS = [
	"PP-DocLayout-L",                          // 版面分析(阈值 0.3)
	"PP-LCNet_x1_0_table_cls",                 // 表格有线/无线分类
	"SLANeXt_wired",                           // 有线表格结构
	"SLANet_plus",                             // 无线表格结构
	"RT-DETR-L_wired_table_cell_det",          // 有线表格单元格定位
	"RT-DETR-L_wireless_table_cell_det",       // 无线表格单元格定位
	"PP-FormulaNet_plus-S",                    // 公式识别(轻量)
];

/** 模型缓存目录:~/ 下 .paddlex/official_models(与 paddlex CACHE_DIR 一致) */
function modelCacheDir() {
	return join(homedir(), ".paddlex", "official_models");
}

/**
 * 检查本地模型缓存状态(不 import paddle,快速)。
 * @param {string} python
 * @returns {{ ok: boolean, missing: string[], cacheDir: string }}
 */
export function ocrModelCacheStatus(python) {
	if (MODEL_CACHE.has(python)) return MODEL_CACHE.get(python);
	const probe = `
import os
from pathlib import Path
cache = Path(os.path.expanduser("~")) / ".paddlex" / "official_models"
models = ${JSON.stringify(REQUIRED_MODELS)}
missing = [m for m in models if not (cache / m).is_dir()]
print(json_out := ",".join(missing) if missing else "ALL_CACHED")
`;
	const r = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 60_000, windowsHide: true });
	const out = (r.stdout ?? "").trim();
	if (r.status !== 0 || !out) {
		// 探测失败:保守视为全部缺失(不缓存,下次重试探测)
		return { ok: false, missing: [...REQUIRED_MODELS], cacheDir: modelCacheDir() };
	}
	const status = {
		ok: out === "ALL_CACHED",
		missing: out === "ALL_CACHED" ? [] : out.split(",").filter(Boolean),
		cacheDir: modelCacheDir(),
	};
	MODEL_CACHE.set(python, status);
	return status;
}

/**
 * 确保路由 OCR 模型就绪(缺失时联网下载到本地缓存)。
 * 注意:此步骤**不设置** PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK(允许下载);
 * 运行时(routing_ocr.py)才启用离线模式。
 * @param {string} python
 * @param {(msg: string) => void} [onLog]
 * @returns {{ ok: boolean, downloaded: string[], error?: string }}
 */
export async function ensureOcrModels(python, onLog) {
	const status = ocrModelCacheStatus(python);
	if (status.ok) {
		return { ok: true, downloaded: [] };
	}
	if (typeof onLog === "function") {
		onLog(`模型未就绪,开始联网下载(${status.missing.length} 个,首次约数百 MB,请保持网络通畅)...`);
	}
	// 直接构造路由引擎各子模型 → 触发缺失模型下载(不设离线开关)
	const snippet = `
import time
from paddleocr import (
    LayoutDetection, TableClassification,
    TableStructureRecognition, TableCellsDetection, FormulaRecognition,
)
t = time.time()
LayoutDetection(model_name="PP-DocLayout-L", threshold=0.3)
TableClassification(model_name="PP-LCNet_x1_0_table_cls")
TableStructureRecognition(model_name="SLANeXt_wired")
TableStructureRecognition(model_name="SLANet_plus")
TableCellsDetection(model_name="RT-DETR-L_wired_table_cell_det")
TableCellsDetection(model_name="RT-DETR-L_wireless_table_cell_det")
FormulaRecognition(model_name="PP-FormulaNet_plus-S")
print("MODELS_READY in %.0fs" % (time.time() - t))
`;
	const r = await runAsync(python, ["-c", snippet], {
		timeout: 1_800_000, // 大模型下载可能较久
	});
	const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	if (r.status !== 0 || !/MODELS_READY/.test(text)) {
		const tail = r.error ? r.error : text.split("\n").slice(-6).join("\n");
		return {
			ok: false,
			downloaded: [],
			error: `OCR 模型就绪失败(需要网络):${tail || "(无输出)"}`,
		};
	}
	const after = ocrModelCacheStatus(python);
	return { ok: true, downloaded: after.missing.length === 0 ? [...status.missing] : [] };
}
