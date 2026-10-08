/**
 * 阶段 2:从 Docling(MIT) 拉取 golden 样本。
 * - 只挑小文件(避免 20MB 级);按**预期字节数逐个校验**,防止下到 HTML 错误页或截断。
 * - 落盘位置在 samples/ 下,已被 .gitignore 默认拒绝 -> 仅本地使用。
 */
import { mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://raw.githubusercontent.com/docling-project/docling/main/tests/data";
const OUT = "test/golden/samples";

// [相对路径, 期望字节数]
const FILES = [
	["docx/sources/word_tables.docx", 14247],
	["docx/sources/tablecell.docx", 15180],
	["docx/sources/docx_lists.docx", 16639],
	["docx/sources/unit_test_headers.docx", 13903],
	["docx/sources/docx_list_east_asian_num_fmt.docx", 24379],
	["docx/sources/docx_page_header_footer_first_page.docx", 38983],
	["docx/sources/word_sample.docx", 103966],
	["pdf/sources/normal_4pages.pdf", 359233],
	["pdf/sources/multi_page.pdf", 128322],
	["pdf/sources/table_mislabeled_as_picture.pdf", 45661],
	["pdf/sources/code_and_formula.pdf", 89031],
];

mkdirSync(OUT, { recursive: true });
let ok = 0;
let bad = 0;
for (const [rel, expect] of FILES) {
	const name = rel.split("/").pop().replace(/^(word|tablecell|docx_|unit_test|multi|normal|code_|table_mislabeled)/, (m) => m);
	const dest = join(OUT, `dl-${rel.split("/").pop()}`);
	try {
		const res = await fetch(`${BASE}/${rel}`);
		if (!res.ok) {
			console.log(`  FAIL ${rel}: HTTP ${res.status}`);
			bad++;
			continue;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length !== expect) {
			console.log(`  SIZE  ${rel}: 期望 ${expect} 实得 ${buf.length}`);
			bad++;
			continue;
		}
		// 魔数校验:docx/pptx/xlsx 是 zip;pdf 以 %PDF 开头 —— 防止把 HTML 错误页当样本存下来
		const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
		const isPdf = buf.subarray(0, 4).toString() === "%PDF";
		if (!isZip && !isPdf) {
			console.log(`  MAGIC ${rel}: 既非 zip 也非 pdf(可能是错误页)`);
			bad++;
			continue;
		}
		writeFileSync(dest, buf);
		console.log(`  OK    ${rel} -> ${dest} (${buf.length} B)`);
		ok++;
	} catch (e) {
		console.log(`  ERR   ${rel}: ${e.message}`);
		bad++;
	}
}
console.log(`\n成功 ${ok} / 失败 ${bad} / 共 ${FILES.length}`);
process.exit(bad === 0 ? 0 : 1);