# dsh-md-convert

[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

Convert Office documents and PDFs (including scanned ones) to Markdown with **structurally preserved formatting**, powered by [MarkItDown](https://github.com/microsoft/markitdown). Ships both a **CLI** and a **dsh agent tool** (`md_convert`).

- **AI Agent usage guide**: [README.agent.md](README.agent.md) (error-code handling / batch rules / call conventions)
- 中文说明(Chinese): [README.md](README.md)

## Supported formats & conversion pipelines

| Input | Pipeline | Notes |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | MarkItDown direct | Headings/lists/tables/paragraphs kept as Markdown |
| `.pdf` (with text layer) | **PyMuPDF4LLM merged-paragraph extraction** (primary) → self-built pypdfium2 structural chain compared by quality score | Both candidates are **CJK-space-merged before scoring**; tables use PyMuPDF `find_tables()` (clean cells, fake tables filtered) and `--legacy-tables` restores the geometric rebuilder |
| `.pdf` (scanned) | **Three-tier engine routing** (v0.6.0): ① complexity probe samples 3 pages → ② table/formula ratio over threshold → vision briefs, otherwise ③ **page-parallel local OCR** (NDJSON streaming + resume, any page count) | Headings/body/tables/formulas/stamps, CPU-only, lightweight models; repeat conversions of the same file reuse the checkpoint and the probe result (key = plugin version + render scale + document fingerprint) |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM (Windows) or LibreOffice (other platforms) re-save to modern format → MarkItDown | Backend auto-detected, configurable |
| `.png` / `.jpg` / `.jpeg` / `.tif` / `.tiff` | **Local RapidOCR first** (v0.7.2) | Models ship inside the package → fully offline, zero CDN, writes nothing to the working directory; falls back to MarkItDown/tesseract (first run needs the CDN) with the reason in `warnings` |
| `.html` / `.csv` / `.json` / `.xml` / `.rss` / `.atom` / `.ipynb` / `.srt` / `.vtt` / `.zip` | MarkItDown | Everything MarkItDown supports. `.zip` **recursively converts every entry** (bounded by the bridge timeout) |
| `.md` / `.markdown` / `.txt` | Direct read with **encoding detection** (v0.7.2) | UTF-8 / UTF-16 BOM → strict UTF-8 → **GB18030 fallback**; non-UTF-8 is surfaced in `warnings` (a BOM is valid UTF-8: stripped, not warned) |

> **Not supported**: `.gif` / `.bmp` / `.webp` — the engine has no backend for them (they used to be
> allowlisted, which surfaced a misleading `Unable to detect document format`); they now return
> `E_UNSUPPORTED_FORMAT` with a hint to convert the file first.

> **Encrypted PDFs**: files needing a **user password** return `E_ENCRYPTED` (no password channel yet);
> owner-password (permissions-only) files convert normally.

> **"Structural formatting"** = heading levels (H1–H6), lists, tables (pipe tables), paragraph order are preserved.
> Markdown cannot express visual details (fonts/sizes/colors/indentation); no converter preserves them — that is inherent to the format.

## Environment & dependencies

- **Node.js ≥ 18**
- Legacy formats (`.doc/.xls/.ppt`): on **Windows** require **WPS Office** or **Microsoft Office** (COM auto-detected); on **Linux/macOS** require **LibreOffice** (`apt install libreoffice`; auto-detects `soffice`)
- **Scanned-PDF OCR is CPU-first, lightweight-model-first, cost/performance-oriented**: a modular routing pipeline — `PP-DocLayout-L` layout analysis (lightweight) routes each region: **text → RapidOCR (PP-OCRv6 ONNX, fastest)**, tables → SLANet + RT-DETR, **formulas → FormulaNet-Plus-S (lightweight)**; heading levels come from the layout model. Quality is reasonably guaranteed, but speed takes priority (complex layouts / tiny text may be incomplete)
- On headless Linux servers install CJK fonts (`fonts-noto-cjk`)
- **Local models**: OCR models are downloaded once to the local cache (`~/.paddlex/official_models/`, a few hundred MB) via `dsh-md-convert deps`; **after that, runs are fully offline** — no network checks, OCR works without internet

**Auto-install of dependencies (default on)**: on first scanned-PDF conversion the plugin
detects Python and the OCR packages (`paddlepaddle` `paddleocr` `paddlex[ocr]` `pypdfium2` `rapidocr` `onnxruntime`);
if present it uses them, if missing it runs `pip install` automatically. Disable with
`--no-auto-install-deps`, or pre-install manually:

```sh
pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2 rapidocr onnxruntime
```

> Routing OCR = PP-DocLayout-L layout (threshold 0.3) + region routing: text→RapidOCR,
> tables→SLANet structure + RT-DETR cells + OCR fill, formulas→FormulaNet-S, stamps→comments.

## Installation

### As a DSH plugin

```sh
dsh plugin --profile web add github:yakoylp/dsh-md-convert
```

After installing, restart `dsh web`; the agent gains the `md_convert` tool. The `dsh-md-convert` CLI command is exposed via the profile's `node_modules/.bin`.

### Background-job deployment (v0.6.0; required for unattended long OCR)

With `background=auto|true`, OCR-class long tasks run as **ctx.jobs background jobs**: the call
returns `{ok, background:true, jobId, etaSec}` immediately; poll with `job_output(jobId)`;
`job_kill` cancels (process tree killed, finished pages kept in `.state.json`, resumable).

**Prerequisite**: load the official job controllers into the composition:

```sh
dsh plugin --profile web add github:deepseek-ai/dsh-jobs
dsh plugin --profile web add github:deepseek-ai/dsh-tool-jobs
```

**Graceful fallback**: without these controllers, `background=auto|true` **does not fail** —
it falls back to foreground execution with `background:false` plus a warning. The foreground
path still streams incremental writes (`.md` per page + `.state.json` checkpoints) and honors
`exec.signal`, but stays bound to a single call's lifetime — **install the controllers for
long documents**.

### Standalone CLI (without DSH)

```sh
git clone https://github.com/yakoylp/dsh-md-convert.git
cd dsh-md-convert
npm install
npm link          # global dsh-md-convert command
# or run directly
node lib/cli.js <files...> -o <output-dir>
```

## CLI usage

```sh
# Basic: batch convert
dsh-md-convert a.docx b.pdf -o ./md

# Legacy formats (auto: WPS→Office on Windows, LibreOffice on Linux/macOS)
dsh-md-convert old.doc old.xls old.ppt -o ./md

# Force a specific legacy backend
dsh-md-convert old.doc -o ./md --legacy-backend wps

# Scanned PDF: automatic three-tier routing (complexity probe → vision briefs / page-parallel OCR; deps auto-installed)
dsh-md-convert scan.pdf -o ./md

# v0.6.0: background mode (prints jobId immediately, per-page progress on stderr, .md/.progress.json pollable)
dsh-md-convert convert scan.pdf -o ./md --background true --workers 2

# v0.6.0: resume from checkpoints (skip finished pages, retry failed ones only)
dsh-md-convert convert scan.pdf -o ./md --resume

# v0.6.0: force an engine (skips the probe)
dsh-md-convert convert scan.pdf -o ./md --engine local     # or --engine vision

# --workers 1: in-process fast path, no process pool (sandboxes/containers without named pipes)
dsh-md-convert convert scan.pdf -o ./md --workers 1

# v0.6.0: assemble vision batch outputs into the final Markdown (+ integrity checks)
dsh-md-convert assemble "md/scan.vision/plan.json" [--review]

# Pin a Python interpreter (multi-Python setups)
dsh-md-convert scan.pdf -o ./md --ocr-python "C:\path\to\python.exe"

# v0.7.2: directory input (expands to the supported files inside; every skipped file states why)
dsh-md-convert ./assets -o ./md
dsh-md-convert ./assets -o ./md -r     # -r/--recursive recurses into subdirectories

# v0.7.2: disable CJK inter-character space merging (on by default)
dsh-md-convert c2.pdf -o ./md --no-cjk-merge

# v0.7.2: use the self-built geometric table rebuilder instead of PyMuPDF find_tables (A/B and rollback)
python lib/py/extract_text.py c2.pdf --legacy-tables

# Check / install OCR deps and models
dsh-md-convert check        # status only, no install
dsh-md-convert deps         # install missing deps and pre-download OCR models (one network run; offline afterwards)
```

Full options: `dsh-md-convert --help`.

## Error codes & exit codes

Every failure carries a **stable error code** so callers (CLI / agent tool / SDK) can classify it:

| Code | Meaning | Handling |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | Source file missing | Check the path |
| `E_UNSUPPORTED_FORMAT` | Extension not supported | Use another format |
| `E_MARKITDOWN` | MarkItDown conversion failed | Usually a corrupt file or a format the engine has no backend for; retry once |
| `E_ENCRYPTED` | PDF is encrypted and needs a **user password** (v0.7.2) | Ask the user to remove the protection; retrying will not help (owner-password files are unaffected) |
| `E_LEGACY_CONVERT` | Legacy re-save failed (COM/LibreOffice) | WPS/Office on Windows, LibreOffice elsewhere; built-in retry on busy |
| `E_OCR_DEPS` | OCR deps missing (install failed/disabled) | Run `dsh-md-convert deps` |
| `E_OCR_RUN` | OCR execution failed (process-level/fatal) | Finished pages kept in `.state.json`; resume with `--resume` |
| `E_OCR_TIMEOUT` | Foreground OCR/probe timed out (background jobs are unbounded) | Pages already persisted; resume with `--resume` |
| `E_OCR_EMPTY` | Scanned page yielded no text | Check scan quality |
| `E_VISION_PLAN` | Vision-brief pipeline failed | Check vision config; or fall back to `engine=local` |
| `E_ASSEMBLE` | Assembly failed (plan corrupt/invalid/non-UTF-8) | Regenerate the plan; check batch output encodings |
| `E_OUTPUT` | Output write failed | Check outDir permission/disk |
| `E_UNKNOWN` | Any other error | Read the error message |

**CLI output format** (each failed line names the exact file):

```
✓ markitdown  → ./md/a.md
✗ [E_OCR_EMPTY] No text recognized in scanned page  C:\docs\scan.pdf
✗ [E_FILE_NOT_FOUND] File not found:...  C:\docs\missing.docx
```

**Exit codes**: `0` all ok / `1` some failed (lines carry `[CODE]` + source path) / `2` usage error.

## Agent tool

After installing the plugin, agents can use the `md_convert` tool:

```
md_convert({ file: "report.docx", outDir: "./md" })
→ { ok: true, background: false, output: "./md/report.md", chain: "markitdown", warnings: [] }

md_convert({ file: "97-page-scan.pdf", background: "auto" })
→ { ok: true, background: true, jobId: "…", etaSec: 404,
    statePath: "…/97-page-scan.state.json", progressPath: "…/97-page-scan.progress.json" }
// poll: job_output(jobId); cancel: job_kill(jobId) (finished pages kept, resumable)

md_convert({ file: "scan.pdf", resume: true })            // resume from checkpoints
md_convert({ file: "scan.pdf", engine: "vision" })        // force vision briefs
```

**Parameters** (`background`/`engine` default from plugin config):

| Param | Values | Notes |
| --- | --- | --- |
| `file` | path (required) | Source file |
| `outDir` | dir | Output directory (default: plugin config or session workspace) |
| `forceOcr` | boolean | Force the OCR route for PDFs |
| `background` | `auto`(default)/`true`/`false` | OCR-class long tasks run as background jobs; **falls back to foreground with a warning when controllers are missing — never fails**; fast text-layer paths stay synchronous |
| `engine` | `auto`(default)/`local`/`vision` | Scanned-PDF engine; auto = complexity-probe routing (table/formula ratio over threshold → vision) |
| `resume` | boolean | Resume from `.state.json`: skip finished pages, retry failed ones only |
| `pages` | string, e.g. `"1-20,25"` | **v0.7.3**: convert only these pages (1-based; anchors keep the original page numbers). Text-layer PDFs and the vision route accept any set; local scan OCR supports only a `1-N` prefix (anything else warns explicitly). Out-of-range fails instead of silently converting everything |

Second tool: `md_convert_assemble({ planPath, review? })` — validates vision batch outputs
(anchor coverage 1..N, no duplicates/cross-batch anchors, strict UTF-8, mojibake signatures,
very-short pages), merges the final Markdown, and with `review:true` emits a recheck brief
pointing at the original PNGs. CLI equivalent: `dsh-md-convert assemble <plan.json> [--review]`.

Plugin config (`cordis.patch.yml`, validated by Schemastery, no hardcoding):

```yaml
- insert:
    - id: dsh-md-convert
      name: dsh-md-convert
      config:
        outDir: ""              # output dir; empty = session workspace
        forceOcr: false         # force OCR for PDFs
        ocrScale: 2             # PDF render scale
        autoInstallDeps: true   # auto pip-install missing OCR deps
        cjkMerge: true          # v0.7.2: merge CJK inter-character spaces (pure rules, zero new deps)
        background: "auto"      # background jobs for OCR-class tasks: auto | true | false
        engine: "auto"          # scanned-PDF engine routing: auto | local | vision
        etaPerPageSec: 27       # v0.7.3: sec/page used by the pre-run ETA (measured median; was 15)
        ocr:
          python: ""            # Python interpreter (empty = auto-detect)
          workers: 0            # parallel workers; 0 = resource-aware min(CPU,4,RAM budget); 1 = in-process fast path (sandbox/containers)
          foregroundMaxPages: 30 # foreground OCR page gate; 0 = unlimited (over-limit rejects with background/vision/resume guidance)
          probeTimeoutMs: 120000
          runTimeoutMs: 7200000 # foreground OCR timeout (background jobs unbounded)
          etaPerPageSec: 15     # ETA estimate per page
        vision:
          pagesThreshold: 0     # optional forced switch gate (page count); 0 = complexity-only routing
          complexityRatio: 0.4  # table+formula region ratio threshold for the vision switch
          batchSize: 8          # pages per vision batch
          renderScale: 2        # vision PNG render scale (≈144dpi)
          promptTemplate: ""    # custom prompt template path (empty = built-in lib/py/prompts/vision-ocr.md)
        legacy:
          backend: "auto"       # auto | wps | office | libreoffice
```

## Legacy format backends

`.doc/.xls/.ppt` are re-saved to modern formats before MarkItDown. The backend is chosen per platform:

| Platform | auto backend | Implementation |
| --- | --- | --- |
| Windows | **WPS → MS Office** | COM (PowerShell scripts); auto-retries when Office/WPS is busy (never kills user processes) |
| Linux / macOS | **LibreOffice** | `soffice --headless --convert-to`; requires LibreOffice (auto-detects `soffice`/`libreoffice`) |

Use `--legacy-backend wps | office | libreoffice` to force a specific backend (e.g. Windows without WPS/Office but with LibreOffice installed: `--legacy-backend libreoffice`).

## Temp-file cleanup

- Each conversion uses a dedicated temp dir (`%TEMP%/dsh-md-convert-*`), removed when done
- On abnormal exit, `exit`/signal hooks clean up; the next run sweeps any leftovers
- v0.6.0 parallel OCR: page PNGs are managed by the Python-side temp dir (auto-cleaned);
  persistent artifacts live next to the output — `<name>.md` (incremental per page),
  `<name>.state.json` (checkpoint state), `<name>.progress.json` (progress mirror)
- **Checkpoint ownership**: `.state.json` is written **exclusively by the Python side**
  (authoritative: pdf/scale/total matching + atomic writes); the Node consumer only reads it.
  Node writes its per-page progress (with aggregated stats) to the separate `.progress.json`
  mirror. The two sides never write the same file — double writers would race on the atomic
  replace window; this ownership split is deliberate
- The vision work dir `<name>.vision/` (PNGs/plan/prompts/batch outputs) persists for review
  and re-assembly; delete it once no recheck is needed
- Use `--keep-temp` to keep intermediate files for debugging

## Tests

```sh
npm test                       # unit tests: node --test (routing thresholds / NDJSON parsing & anchor
                               # upsert / state.json resume / background-job outcome contract / graceful
                               # degradation / batch splitting / mojibake rules / assembly & review)
node lib/cli.js convert test/fixtures/sample3.pdf -o .tmp/smoke --force-ocr --background true --workers 1
                               # 3-page pure-image fixture smoke: prints jobId immediately → progress → anchors complete
                               # (workers 1 = in-process fast path; named-pipe-free for sandboxes/containers)
```

> Multi-worker (`--workers 2`) uses a multiprocessing.Pool and needs named pipes;
> in restricted environments use `--workers 1` (semantically equal to Pool(1)).
> The spawnStream direct test auto-skips in pipe-less environments and runs for real on deployment.

## Known issues

- **v0.6.0**: real Pool parallelism and the ctx.jobs background chain are pending deployment-phase
  verification — development sandboxes forbid named pipes (`--workers 2+` and piped node→python
  spawns fail with EPERM there; pipe=EPERM vs inherit=OK has been scoped, not a code defect).
  Deployment verification: `dsh-md-convert convert scan.pdf -o ./md --background true --workers 2`
  (97 pages ≈ 6-7 min, ETA calibrated 400-420s).
- **paddlepaddle ≥3.3 has a oneDNN/PIR static-graph incompatibility** that crashes inference; the plugin
  disables it automatically (`FLAGS_use_mkldnn=0` + `enable_mkldnn=False`), no manual action needed.
- Scanned-PDF OCR quality depends on page clarity; for complex layouts / tiny text raise `--ocr-scale`
  (e.g. 3) or route to `engine:"vision"` — accuracy improves, time/cost increases.

## Limitations

- **Encrypted PDFs** (user password) return `E_ENCRYPTED`; owner-password/permissions-only files convert
  normally. Corrupt files also carry explicit error codes.
- Images use **local RapidOCR** (offline); when the OCR deps are missing they fall back to
  MarkItDown/tesseract (**first run needs the network** and writes traineddata into the working directory)
- Formats MarkItDown does not support (e.g. `.pages/.key`) are reported explicitly as unsupported
- **Speed-first trade-offs**: routing OCR uses lightweight models (layout PP-DocLayout-L, text RapidOCR, formula FormulaNet-S); quality is reasonably guaranteed, but complex tables (multi-level merges / slanted headers), complex multi-column layouts, and very small fonts may be incomplete
- OCR models need a one-time network download (a few hundred MB to `~/.paddlex/`); afterwards fully offline, fast loads

## License

[MIT](LICENSE) © 2026 yakoylp
