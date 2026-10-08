# -*- coding: utf-8 -*-
"""
dsh-md-convert — 页级并行 OCR 主程序(基于 routing_ocr.py 的 RoutingOCR 引擎)

解决「整 PDF 同步单调用被宿主中断」的结构性缺陷:逐页并行 + NDJSON 流式输出 +
断点续跑,供 Node 侧后台作业(lib/core/jobs.js)逐行消费。

CLI:
  python parallel_ocr.py <pdf> [--scale 2] [--workers N]
                             [--resume <state.json>] [--limit-pages N]
                             [--probe "1,5,50"]

NDJSON stdout 协议(逐行 JSON,每行立即 flush;**禁止最后一次性输出**):
  {"event":"start","total":97}
  {"event":"page","no":3,"md":"<!--PAGE:03-->...<!--/PAGE:03-->","stats":{"tables":2,"formulas":0,"textChars":1834}}
  {"event":"done","warnings":["第 5 页处理失败:..."]}
  --probe 模式则只输出: {"event":"probe","pages":[{"no":1,"tables":n,"formulas":n,"textRegions":n,"stamps":n}, ...]}

协议约定:
  - 页号 no 从 1 起;页锚点统一 <!--PAGE:NN-->...<!--/PAGE:NN-->(两位补零,
    >99 页自然扩展为三位);page 事件**完成即发、乱序到达**(并行语义,消费端
    按锚点归位/幂等覆盖,不得假设顺序)
  - 单页失败**不中断整体**:该页仍发 page 事件,md 为锚点内失败占位注释,
    同时记入 done.warnings,state.json 标 failed(--resume 时自动重试)
  - 退出码: 0=正常跑完(含页级降级警告);1=致命错误(打不开 PDF/进程池崩溃,
    此时 done.warnings 末尾附「致命错误」条目,已完成的页仍可 --resume 接续)
  - 诊断/计时一律走 stderr,stdout 只允许协议行
  - stdout/stderr 强制 UTF-8(Windows 管道默认 GBK,必须 reconfigure)

断点续跑(--resume <state.json>):
  - state.json 每页完成立即原子落盘(临时文件 + os.replace),崩溃后重跑
    同命令即跳过 done 页;failed 页自动重试
  - state 与当前任务不匹配(pdf/scale/total 不一致)时忽略旧状态并告警

复杂度探针(--probe "1,5,50",供 auto 路由换轨决策,目标 ≤8s):
  - 仅加载 PP-DocLayout-L 版面模型(不加载表格/公式/RapidOCR),仅渲染抽中页
  - 页码从 1 起、逗号分隔;输出分类区域计数后即退出(不发 start/done)

Windows spawn 语义:全部并行逻辑(multiprocessing.Pool)位于 __main__ 保护内;
worker 进程经 initializer 首次加载一次 RoutingOCR 模型并跨任务复用;
本模块顶层只做轻量 import,可被 spawn 安全地再导入。
--workers 1 特例:进程内顺序执行(不启进程池/不依赖命名管道),行为语义与
Pool(1) 一致,适用于禁用命名管道的受限环境(容器/沙箱)与单机调试。

依赖与环境: 与 routing_ocr.py 相同(paddleocr/paddlex/rapidocr/pypdfium2);
模型缓存于 ~/.paddlex/official_models,齐全后离线可用。
"""
import argparse
import json
import multiprocessing
import os
import sys
import tempfile
import time

os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "true")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "false")

import numpy as np
import pypdfium2 as pdfium
from PIL import Image

# routing_ocr.py 是参考实现,保留不动;此处复用其引擎与渲染口径
from routing_ocr import (
    ROUTE_TEXT_ALL,
    ROUTE_TITLE,
    LAYOUT_THRESHOLD,
    RoutingOCR,
    _cap_max_side,
    adaptive_pad,
    dedup_regions,
)

FORMULA_LABELS = ("formula", "formula_title")
STAMP_LABELS = ("seal", "stamp")


# ---------------------------------------------------------------- stdio

def _utf8_stdio():
    """Windows 管道默认编码跟随 ANSI 代码页(GBK),协议输出必须强制 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _emit(obj):
    """stdout 协议行:单行 JSON + 立即 flush(流式语义的关键)。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg):
    sys.stderr.write("[parallel-ocr] %s\n" % msg)
    sys.stderr.flush()


# ---------------------------------------------------------------- 资源感知默认 worker(v0.6.1)

_WORKER_MEM_BUDGET = 2.5 * 1024 ** 3  # 每 worker 内存预算: PP-DocLayout+SLANet+RapidOCR 实测 ~2.45GB 起(docs/bench.md)
_WORKERS_HARD_CAP = 4                 # bench 只标定到 4;8 路并发曾致内存饱和+整机卡顿(2026-10-05 事故)


def _total_mem_bytes():
    """物理内存总量;取不到返回 0(调用方回退仅按 CPU/上限钳制)。"""
    try:
        if sys.platform == "win32":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullTotalPhys)
            return 0
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except Exception:
        return 0


def _default_workers():
    """资源感知默认: min(CPU, 4, 内存预算)。与 Node 侧 jobs.js defaultWorkers 同口径。"""
    cpu = os.cpu_count() or 4
    mem = _total_mem_bytes()
    by_mem = max(1, int(mem // _WORKER_MEM_BUDGET)) if mem > 0 else _WORKERS_HARD_CAP
    return max(1, min(cpu, _WORKERS_HARD_CAP, by_mem))


# ---------------------------------------------------------------- 协议内容

def page_anchor_md(no, body):
    """页 markdown: 统一锚点包裹。失败/空白页 body 为占位注释或空串。"""
    a = "%02d" % no
    if body:
        return "<!--PAGE:%s-->\n\n%s\n\n<!--/PAGE:%s-->" % (a, body, a)
    return "<!--PAGE:%s-->\n\n<!--/PAGE:%s-->" % (a, a)


def _failed_page_md(no, err):
    return page_anchor_md(no, "<!-- 第%d页OCR失败: %s -->" % (no, str(err).replace("-->", "")[:120]))


# ---------------------------------------------------------------- worker

_ENGINE = None  # worker 进程内全局,initializer 加载一次,跨任务复用


def _init_worker():
    """Pool initializer:每个 worker 进程**先钉住线程数**,再加载模型(Windows spawn 安全)。

    v0.7.3 速度修复(实测,8 页真实扫描片段 / 22 核):
      2 路: 单页中位 39.8s,页耗时合计 296s
      4 路: 单页中位 70.9s,合计 521s
      6 路: 单页中位 94.1s,合计 715s   ← worker 越多、单页越慢、总 CPU 工时越大
    根因:此前本目录**完全没有线程控制** —— paddle/MKL/OpenMP 默认各自吃满所有核,
    N 路 worker 就是 N×核数 线程互相抢(典型超订)。

    线程数由父进程(Node)经 `DSH_OCR_THREADS` 下发,默认 floor(核数 / worker 数);
    OMP/MKL 必须在 **import numpy/paddle 之前**生效,父进程 spawn 时就设好环境变量,
    这里再兜底一次(直接命令行运行本脚本时没有父进程下发)。
    """
    n = int(os.environ.get("DSH_OCR_THREADS") or 0)
    if n > 0:
        for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            os.environ.setdefault(k, str(n))
        try:
            import paddle
            paddle.set_num_threads(n)
        except Exception:
            pass
    global _ENGINE
    t0 = time.time()
    _ENGINE = RoutingOCR()
    _log("worker pid=%d 线程=%s 模型加载完成 (%.1fs)" % (os.getpid(), n or "auto", time.time() - t0))


def route_page_stats(engine, img_pil, boxes):
    """RoutingOCR.route_page 的镜像实现(参考实现保持不动),逐区域路由并
    顺带收集 stats: tables/formulas=区域计数(与 --probe 同口径),
    textChars=文字+标题区域识别出的字符总数。

    逻辑必须与 routing_ocr.route_page 保持一致;改动路由行为时两处同步。

    v0.7.3 速度修复:整页先做**一次** RapidOCR(begin_page),所有区域/单元格复用这批行。
    实测整改前文本页 36 次区域调用/2 页、每次 1.44s(每次都在重做 DBNet 检测),
    占单页耗时 44.6%;而 worker 扩展实验证明"加 worker 完全无效"(2~8 路墙钟 168~179s),
    故唯一的提速杠杆就是砍掉这份重复检测。
    """
    parts = []
    stats = {"tables": 0, "formulas": 0, "textChars": 0}
    engine.begin_page(img_pil)
    try:
        for b in sorted(boxes, key=lambda x: (x["coordinate"][1], x["coordinate"][0])):
            label = b["label"]
            rx1, ry1, rx2, ry2 = [int(v) for v in b["coordinate"]]
            pad = adaptive_pad(b, boxes) if label in ROUTE_TEXT_ALL else 5
            x1, y1 = max(0, rx1 - pad), max(0, ry1 - pad)
            x2, y2 = min(img_pil.width, rx2 + pad), min(img_pil.height, ry2 + pad)
            crop = img_pil.crop((x1, y1, x2, y2))
            if label in ROUTE_TEXT_ALL:
                text = engine.ocr_text_region(crop, b["coordinate"], x1, y1)
                if text.strip():
                    stats["textChars"] += len(text.strip())
                    if label in ROUTE_TITLE:
                        parts.append("## " + text.strip().replace("\n", " ").strip())
                    else:
                        parts.append(text.strip())
            elif label == "table":
                stats["tables"] += 1
                try:
                    cls_res = engine.table_cls.predict(np.array(crop))[0]
                    scores = cls_res["scores"][0]
                    idx = int(np.argmax(scores))
                    names = cls_res["label_names"]
                    wired = bool(names[idx].startswith("wired")) if names and len(names) > idx else True
                    parts.append(engine.table_full(crop, wired, 0, page_offset=(x1, y1)))
                except Exception as e:
                    parts.append("[表格识别失败: %s]" % str(e)[:80])
            elif label in FORMULA_LABELS:
                stats["formulas"] += 1
                try:
                    fres = engine.formula.predict(np.array(crop))
                    latex = fres[0]["rec_formula"]
                    parts.append("$$ %s $$" % latex)
                except Exception as e:
                    # v0.7.13: 同 routing_ocr —— 产物只留中性占位,原因进 warnings。
                    # 实测缺 `ftfy` 时每个公式都会失败,原文会变成
                    # "$$ [公式识别失败: 'NoneType' object has no attribute 'predict' $$"
                    # 这类内部实现细节,对用户毫无意义。
                    parts.append("$$[公式未识别]$$")
                    stats["formula_failed"] = stats.get("formula_failed", 0) + 1
                    stats.setdefault("formula_first_error", type(e).__name__ + ": " + str(e)[:120])
            elif label in STAMP_LABELS:
                parts.append("<!-- 印章 -->")
    finally:
        engine.end_page()
    return parts, stats


def _ocr_page(task):
    """worker 任务: 渲染好的 PNG 路径 → 单页 md + stats。失败返回 error 字段。"""
    no, png_path = task
    t0 = time.time()
    try:
        img = Image.open(png_path).convert("RGB")
        boxes = dedup_regions(_ENGINE.layout.predict(np.array(img))[0]["boxes"])
        parts, stats = route_page_stats(_ENGINE, img, boxes)
        res = {
            "no": no,
            "md": page_anchor_md(no, "\n\n".join(parts)),
            "stats": stats,
            "duration": round(time.time() - t0, 2),  # v0.6.8 可观测性:单页 OCR 耗时(秒)
        }
        _log("page %d 完成: tables=%d formulas=%d textChars=%d (%.2fs)"
             % (no, stats["tables"], stats["formulas"], stats["textChars"],
                time.time() - t0))
        return res
    except Exception as e:
        _log("page %d 失败: %s" % (no, str(e)[:200]))
        return {"no": no, "error": str(e)[:300], "duration": round(time.time() - t0, 2)}


# ---------------------------------------------------------------- state

def _load_state(path, pdf_abs, total, scale, state_key=None):
    """读取并校验 state.json;不匹配/损坏时返回 None(旧状态被忽略)。

    v0.7.2 W3-2: 新增 state_key(插件版本+渲染倍率+文档指纹,由 Node 侧计算)。
    键不同 = 文档内容/参数/插件版本已变 → 绝不复用旧页
    (避免"另存为同名 PDF"或"升级后改算法"仍拿旧结果)。
    key 缺失(旧 state 或 CLI 直调)时退回 pdf/scale/total 校验。
    """
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            st = json.load(f)
        if state_key is not None and st.get("stateKey") != state_key:
            _log("state.json 校验键不匹配(文档/参数/插件版本已变),忽略旧状态")
            return None
        if (st.get("pdf") != pdf_abs or int(st.get("total", -1)) != total
                or float(st.get("scale", -1)) != float(scale)):
            _log("state.json 与当前任务不匹配(pdf/scale/total),忽略旧状态")
            return None
        if not isinstance(st.get("pages"), dict):
            return None
        return st
    except Exception as e:
        _log("state.json 读取失败(%s),忽略旧状态" % str(e)[:120])
        return None


def _save_state(path, st):
    """原子落盘: 临时文件 + os.replace(Windows 原子覆盖)。"""
    st["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------- probe

def _parse_probe_pages(spec, total):
    """"1,5,50" → 排序去重并钳制到 [1,total] 的页号列表;空/非法返回 []。"""
    out = []
    for piece in str(spec).split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            n = int(piece)
        except ValueError:
            _log("probe 忽略非法页号: %r" % piece)
            continue
        if 1 <= n <= total:
            out.append(n)
        else:
            _log("probe 忽略越界页号: %d (total=%d)" % (n, total))
    return sorted(set(out))


def _run_probe(pdf_path, pages_spec, scale):
    """复杂度探针: 仅版面分析,不跑区域 OCR。只加载 LayoutDetection 单模型。"""
    try:
        pdf = pdfium.PdfDocument(pdf_path)
        total = len(pdf)
    except Exception as e:
        _emit({"event": "probe", "pages": [], "error": "PDF 打开失败: %s" % str(e)[:300]})
        return 1
    wanted = _parse_probe_pages(pages_spec, total)
    if not wanted:
        _emit({"event": "probe", "pages": [], "error": "无有效抽样页号"})
        return 1
    t0 = time.time()
    try:
        from paddleocr import LayoutDetection
        layout = LayoutDetection(model_name="PP-DocLayout-L", threshold=LAYOUT_THRESHOLD)
    except Exception as e:
        _emit({"event": "probe", "pages": [], "error": "版面模型加载失败: %s" % str(e)[:300]})
        return 1
    _log("探针版面模型加载完成 (%.1fs)" % (time.time() - t0))
    pages_out = []
    for no in wanted:
        pt0 = time.time()
        counts = {"tables": 0, "formulas": 0, "textRegions": 0, "stamps": 0}
        try:
            img = _cap_max_side(pdf[no - 1].render(scale=scale).to_pil().convert("RGB"))
            boxes = dedup_regions(layout.predict(np.array(img))[0]["boxes"])
            for b in boxes:
                label = b["label"]
                if label == "table":
                    counts["tables"] += 1
                elif label in FORMULA_LABELS:
                    counts["formulas"] += 1
                elif label in ROUTE_TEXT_ALL:
                    counts["textRegions"] += 1
                elif label in STAMP_LABELS:
                    counts["stamps"] += 1
            _log("probe page %d: %s (%.2fs)" % (no, counts, time.time() - pt0))
        except Exception as e:
            # 单页探针失败记为全零 + error 字段(附加字段不影响消费端已知键)
            counts["error"] = str(e)[:200]
            _log("probe page %d 失败: %s" % (no, str(e)[:200]))
        pages_out.append({"no": no, **counts})
    _log("探针总耗时 %.1fs (含模型加载)" % (time.time() - t0))
    _emit({"event": "probe", "pages": pages_out})
    return 0


# ---------------------------------------------------------------- 主流程

def _run_ocr(pdf_path, args):
    try:
        pdf = pdfium.PdfDocument(pdf_path)
        total = len(pdf)
    except Exception as e:
        msg = str(e)[:300]
        # v0.7.2 W4-5: 加密 PDF 明确文案(此前与普通打开失败混在一起)
        if "password" in msg.lower() or "encrypt" in msg.lower():
            _emit({"event": "done", "warnings": ["致命错误: PDF 已加密,需要密码(本插件暂不支持加密 PDF): %s" % msg]})
            return 1
        _emit({"event": "done", "warnings": ["致命错误: PDF 打开失败: %s" % msg]})
        return 1

    total_eff = min(total, args.limit_pages) if args.limit_pages and args.limit_pages > 0 else total
    workers = args.workers or _default_workers()
    workers = max(1, int(workers))
    _emit({"event": "start", "total": total_eff})

    # -- 断点续跑状态
    state = None
    if args.resume:
        state = _load_state(args.resume, os.path.abspath(pdf_path), total_eff, args.scale,
                            getattr(args, "state_key", None))
        if state is None:
            state = {"pdf": os.path.abspath(pdf_path), "total": total_eff,
                     "scale": args.scale, "stateKey": getattr(args, "state_key", None),
                     "pages": {}, "pageWarnings": {}}
        try:
            _save_state(args.resume, state)
        except Exception as e:
            _log("state.json 初始化写入失败(续跑不可用): %s" % str(e)[:160])
            args.resume = None
    page_status = state["pages"] if state else {}
    page_warnings = state["pageWarnings"] if state else {}
    # v0.7.13: 公式失败汇总 [总数, 首个原因](用可变容器,便于 _handle 内 nonlocal 之外的累加)
    _formula_failed_total = [0, None]

    def done_no(n):
        page_status[str(n)] = "done"
        page_warnings.pop(str(n), None)

    def failed_no(n, msg):
        page_status[str(n)] = "failed"
        page_warnings[str(n)] = msg

    def persist():
        if args.resume and state is not None:
            try:
                _save_state(args.resume, state)
            except Exception as e:
                _log("state.json 写入失败: %s" % str(e)[:160])

    todo = [n for n in range(1, total_eff + 1) if page_status.get(str(n)) != "done"]
    skipped = total_eff - len(todo)
    if skipped:
        _log("resume: 跳过已完成 %d 页,待处理 %d 页" % (skipped, len(todo)))

    # -- 渲染阶段(主进程,复用 routing_ocr 的 _cap_max_side 口径)
    t_render = time.time()
    tasks = []
    with tempfile.TemporaryDirectory(prefix="mdc-ocr-") as tmp_dir:
        for no in range(1, total_eff + 1):
            if page_status.get(str(no)) == "done":
                continue
            try:
                img = _cap_max_side(pdf[no - 1].render(scale=args.scale).to_pil().convert("RGB"))
                png = os.path.join(tmp_dir, "p-%02d.png" % no)
                img.save(png, "PNG")
                tasks.append((no, png))
            except Exception as e:
                msg = "第 %d 页渲染失败:%s" % (no, str(e)[:200])
                _log(msg)
                failed_no(no, msg)
                _emit({"event": "page", "no": no,
                       "md": _failed_page_md(no, e),
                       "stats": {"tables": 0, "formulas": 0, "textChars": 0}})
        persist()
        _log("渲染完成 %d 页 (%.1fs),%d workers 模型加载中..."
             % (len(tasks), time.time() - t_render, workers))

        # -- 并行 OCR 阶段: imap_unordered + chunksize=1 逐页流式回传
        #    --workers 1 走进程内顺序快速路径: 与 Pool(1) 语义一致但免去
        #    spawn+管道开销,且兼容禁用命名管道的受限环境(容器/沙箱)与调试
        t_ocr = time.time()
        fatal = None
        completed = 0

        def _handle(res):
            nonlocal completed
            no = res["no"]
            # v0.7.13: 公式失败在**主进程**汇总(逐页 stats 随 page 事件回来,
            # worker 是独立进程,模块级累加器回不来)。
            st = res.get("stats") or {}
            if st.get("formula_failed"):
                _formula_failed_total[0] += int(st["formula_failed"])
                if not _formula_failed_total[1] and st.get("formula_first_error"):
                    _formula_failed_total[1] = st["formula_first_error"]
            if "error" in res:
                msg = "第 %d 页处理失败:%s" % (no, res["error"][:200])
                failed_no(no, msg)
                _emit({"event": "page", "no": no,
                       "md": _failed_page_md(no, res["error"]),
                       "stats": {"tables": 0, "formulas": 0, "textChars": 0},
                       "duration": res.get("duration")})
            else:
                done_no(no)
                _emit({"event": "page", "no": no,
                       "md": res["md"], "stats": res["stats"],
                       "duration": res.get("duration")})
            persist()
            completed += 1

        if tasks:
            if workers == 1:
                try:
                    _init_worker()
                    for res in (_ocr_page(t) for t in tasks):
                        _handle(res)
                except KeyboardInterrupt:
                    raise
                except Exception as e:
                    fatal = "单进程执行异常: %s" % str(e)[:300]
                    _log(fatal)
            else:
                try:
                    with multiprocessing.Pool(processes=workers, initializer=_init_worker) as pool:
                        for res in pool.imap_unordered(_ocr_page, tasks, chunksize=1):
                            _handle(res)
                except KeyboardInterrupt:
                    raise
                except Exception as e:
                    fatal = "进程池异常: %s" % str(e)[:300]
                    _log(fatal)
        _log("OCR 阶段完成: 本轮处理 %d/%d 页 (%.1fs)"
             % (completed, len(tasks), time.time() - t_ocr))

    # done.warnings 取自实时状态视图: 当前仍处 failed 的页(历史失败页若本轮
    # 重试成功,其警告已随 done_no 移除,不再出现)
    done_warnings = list(page_warnings.values())
    if fatal:
        done_warnings.append("致命错误: %s (已完成页可 --resume 接续)" % fatal)
    # v0.7.13: 公式识别失败汇总(产物里已改为中性占位,原因在这里说明)
    ff, first_err = _formula_failed_total
    if ff:
        done_warnings.append(
            "[公式] %d 处公式未能识别(产物中以 $$[公式未识别]$$ 占位);首个原因:%s"
            % (ff, first_err or "未知")
        )
    _emit({"event": "done", "warnings": done_warnings})
    persist()
    return 1 if fatal else 0


def main():
    _utf8_stdio()
    ap = argparse.ArgumentParser(
        prog="parallel_ocr.py",
        description="页级并行路由 OCR: NDJSON 流式输出 + 断点续跑 + 复杂度探针")
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("--scale", type=float, default=2.0,
                    help="渲染倍率(1=72dpi,默认 2≈144dpi)")
    ap.add_argument("--workers", type=int, default=0,
                    help="并行 worker 数(默认资源感知 min(CPU,4,内存预算);0=取默认;"
                         "1=进程内顺序执行,不启进程池,兼容受限环境与调试)")
    ap.add_argument("--resume", metavar="STATE_JSON", default=None,
                    help="断点续跑状态文件路径(每页完成即原子落盘)")
    ap.add_argument("--state-key", default=None, metavar="KEY",
                    help="state 复用校验键(插件版本+倍率+文档指纹,由 Node 侧计算);"
                         "键不同则忽略旧状态,缺失则退回 pdf/scale/total 校验")
    ap.add_argument("--limit-pages", type=int, default=0, metavar="N",
                    help="只处理前 N 页(冒烟/抽样用;0=不限)")
    ap.add_argument("--probe", metavar="PAGES", default=None,
                    help='复杂度探针: 仅版面分析,如 --probe "1,33,65" (1 起页号,逗号分隔)')
    args = ap.parse_args()

    if args.probe:
        if args.resume or args.limit_pages:
            _log("--probe 模式忽略 --resume/--limit-pages")
        return _run_probe(args.pdf, args.probe, args.scale)
    return _run_ocr(args.pdf, args)


if __name__ == "__main__":
    multiprocessing.freeze_support()  # 无害;冻结打包场景必需
    sys.exit(main())
