/** 「模板字符串里写了裸反引号」—— 一次语法错，已经犯过三次。
 *
 * ## 这个坑长什么样
 *
 * `scripts/browser/douyin-code.mjs` 里那些「代码段」都是**模板字符串**：
 *
 * ```js
 * export const DY_MODULE_DATES = `
 *   ...代码...
 *    * 注释里提到 `from` 这样的名字      ← 这个反引号会**提前闭合模板串**
 *   ...代码...
 * `
 * ```
 *
 * 模板串里出现**未转义的反引号** = 到那儿就闭合了，后面的注释与代码被当成
 * 语句层的 JS → **整份文件语法错**。症状是别的测试**在 import 阶段就失败**
 * （不是断言红，是 `SyntaxError`），报错行号还指向一段看起来完全正常的注释。
 *
 * ## 已经犯过三次（所以值得一个常驻测试）
 *
 *   1. t21：「跳过时 `dates` 是空数组」「`from > R` 说明…」
 *   2. t21 收尾：`DY_ROUND_GUARD` 与 `ok` 那两处
 *   3. t22：`from = L+1`、`to`、`{{from}}` 三处
 *
 * 每次都是同一句话：**注释里提到代码名字时顺手加反引号**。
 * 三次都靠人肉发现，所以这里把判据变成机器检查。
 *
 * ## 判据怎么算（做真正的词法扫描，不用正则拍脑袋）
 *
 * 从头扫一遍源码，跟踪：普通代码 / 单引号串 / 双引号串 / 模板串 / 行注释 / 块注释。
 * 落在**模板串内部**且是**注释行**（`*` / `/*` / `//` 开头）的行里，
 * 一旦出现未转义的反引号，就是问题。
 *
 * ⚠️ 只查注释行是**故意的**：模板串里的**代码正文**本来就可以有反引号
 * （比如嵌套模板）。真正的坑是「我以为在写注释、其实那反引号也在模板串里」。
 *
 * 跑法：node tests/no-backtick-in-template.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * 扫一份文件，返回「模板串内部的注释行里出现的裸反引号」。
 *
 * @param src - 文件内容。
 * @returns 问题行（1 起的行号 + 行文本）。
 */
function scan(src) {
  /* 先算出所有模板串的行范围。 */
  const templates = []
  let i = 0
  let line = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') { line += 1; i += 1; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1 }
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      i += 1
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '\n') { line += 1; break }
        i += 1
      }
      i += 1
      continue
    }
    if (c === '`') {
      const startLine = line
      i += 1
      while (i < src.length) {
        const ch = src[i]
        if (ch === '\n') { line += 1; i += 1; continue }
        if (ch === '\\') { i += 2; continue }
        if (ch === '$' && src[i + 1] === '{') {
          let depth = 1
          i += 2
          while (i < src.length && depth > 0) {
            if (src[i] === '\n') line += 1
            if (src[i] === '{') depth += 1
            else if (src[i] === '}') depth -= 1
            i += 1
          }
          continue
        }
        if (ch === '`') { i += 1; break }
        i += 1
      }
      templates.push({ startLine, endLine: line })
      continue
    }
    i += 1
  }

  /* 再逐行检查：注释行 + 落在模板串范围内 + 有未转义反引号。 */
  const lines = src.split(/\r?\n/)
  const inTemplate = (ln) => templates.some(t => ln >= t.startLine && ln <= t.endLine)
  const hits = []
  for (let ln = 1; ln <= lines.length; ln++) {
    const l = lines[ln - 1]
    if (!inTemplate(ln)) continue
    if (!/^\s*(\*|\/\*|\/\/)/.test(l)) continue
    /* 去掉已转义的（`\``），剩下的反引号就是裸的。 */
    const stripped = l.split('\\`').join('')
    if (stripped.includes('`')) hits.push({ line: ln, text: l.trim() })
  }
  return hits
}

console.log('=== 模板字符串里不许有裸反引号（语法错，已犯三次）===')

const FILES = [
  'scripts/browser/douyin-code.mjs',
  'scripts/browser/douyin-shell.mjs',
  'scripts/browser/build-douyin.mjs',
  'scripts/ingest/shell-steps.mjs',
]

for (const rel of FILES) {
  const p = join(ROOT, rel)
  let src = ''
  try { src = readFileSync(p, 'utf8') } catch { console.log('  （跳过：读不到 ' + rel + '）'); continue }
  const hits = scan(src)
  check(rel + ' 里没有裸反引号', hits.length === 0,
    hits.length === 0 ? '' : '第 ' + hits.map(h => String(h.line)).join('、') + ' 行：' + hits[0].text.slice(0, 70))
}

/* 反证：扫描器本身要能抓到问题 —— 否则「查不到」也可能只是它不会查。
 * 造一段**故意写坏**的代码喂给它，必须报出来。 */
console.log('')
console.log('—— 反证：扫描器真能抓到（不然「查不到」可能是它不会查）——')
{
  const BAD = [
    'export const X = `',
    '   * 注释里写了 `dates` 这个名字',
    '`',
  ].join('\n')
  check('★ 故意写坏的一段 → 扫描器必须报出来', scan(BAD).length === 1,
    JSON.stringify(scan(BAD).map(h => h.line)))

  const GOOD = [
    'export const X = `',
    '   * 注释里写了 \\`dates\\` 这个名字（转义过，合法）',
    '`',
  ].join('\n')
  check('★ 转义过的 → 不报（否则会把对的判成错的）', scan(GOOD).length === 0,
    JSON.stringify(scan(GOOD)))

  const OUTSIDE = [
    '/* 模板串外面 */',
    'const a = `ok`',
    '/* 这里写 `dates` 完全没问题 —— 不在模板串里 */',
    'const b = 1',
  ].join('\n')
  check('★ 模板串外面的注释里写反引号 → 不报（不该管那么宽）', scan(OUTSIDE).length === 0,
    JSON.stringify(scan(OUTSIDE)))
}

console.log('')
console.log(failed === 0
  ? '结论：没有「模板串里写裸反引号」✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
